import { default as AjvBase, ValidateFunction, SchemaObject } from 'ajv';
import type AjvCore from 'ajv/dist/core';
import Ajv2019 from 'ajv/dist/2019';
import Ajv2020 from 'ajv/dist/2020';
import AjvDraft4 from 'ajv-draft-04';
import addFormats from 'ajv-formats';
import ajvErrors from 'ajv-errors';
import * as draft6MetaSchema from 'ajv/dist/refs/json-schema-draft-06.json';
import * as draft4MetaSchema from './draft4.json';

import type { Options } from './index';

const logger = {
  warn(...args: unknown[]): void {
    const firstArg = args[0];
    if (typeof firstArg === 'string') {
      if (firstArg.startsWith('unknown format')) return;
      // eslint-disable-next-line no-console
      console.warn(...args);
    }
  },
  // eslint-disable-next-line no-console
  log: console.log,
  // eslint-disable-next-line no-console
  error: console.error,
};

function createAjvInstance(Ajv: typeof AjvCore, allErrors: boolean, optimize?: 0): AjvCore {
  const ajv = new Ajv({
    allErrors,
    meta: true,
    messages: true,
    strict: false,
    allowUnionTypes: true,
    logger,
    unicodeRegExp: false,
    code: optimize === 0 ? { optimize } : undefined,
  });
  addFormats(ajv);
  if (allErrors) {
    ajvErrors(ajv);
  }

  if (Ajv === AjvBase) {
    ajv.addSchema(draft4MetaSchema);
    ajv.addSchema(draft6MetaSchema);
  }

  return ajv;
}

function _createAjvInstances(Ajv: typeof AjvCore, optimize?: 0): { default: AjvCore; allErrors: AjvCore } {
  let _default: AjvCore;
  let _allErrors: AjvCore;

  return {
    get default(): AjvCore {
      _default ??= createAjvInstance(Ajv, false, optimize);
      return _default;
    },
    get allErrors(): AjvCore {
      _allErrors ??= createAjvInstance(Ajv, true, optimize);
      return _allErrors;
    },
  };
}

type AssignAjvInstance = (schema: SchemaObject, dialect: string, allErrors: boolean, optimize?: 0) => ValidateFunction;

const standardObjectPrototypeKeys = new Set([
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
  '__proto__',
  'constructor',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
  'toString',
  'valueOf',
]);

function hasSafeObjectPrototype(): boolean {
  try {
    if (Object.getPrototypeOf(Object.prototype) !== null) return false;

    for (const key of Reflect.ownKeys(Object.prototype)) {
      if (typeof key !== 'string' || !standardObjectPrototypeKeys.has(key)) return false;
      const descriptor = Object.getOwnPropertyDescriptor(Object.prototype, key);
      if (descriptor === void 0 || descriptor.enumerable !== false) return false;
    }

    return true;
  } catch {
    return false;
  }
}

function isJsonSafeData(
  value: unknown,
  seen: WeakMap<object, boolean>,
  objectPrototypeIsSafe = hasSafeObjectPrototype(),
): boolean {
  if (value === null) return true;

  switch (typeof value) {
    case 'string':
    case 'boolean':
      return true;
    case 'number':
      return Number.isFinite(value);
    case 'object':
      break;
    default:
      return false;
  }

  const objectValue = value as object;
  const known = seen.get(objectValue);
  if (known !== void 0) return known;

  // Mark the value unsafe until its descendants have been checked. Encountering
  // it again before then means that the graph is circular and cannot be JSON.
  seen.set(objectValue, false);

  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) return false;

    const keys = Reflect.ownKeys(value);
    // A JSON-safe array has exactly one own key per element plus `length`.
    // Checking the count first also rejects huge sparse arrays without walking
    // every missing index.
    if (keys.length !== value.length + 1) return false;

    for (const key of keys) {
      if (key === 'length') continue;
      if (typeof key !== 'string') return false;

      const index = Number(key);
      if (!Number.isInteger(index) || index < 0 || index >= value.length || String(index) !== key) return false;

      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === void 0 || descriptor.enumerable !== true || !('value' in descriptor)) return false;
      const item: unknown = descriptor.value;
      if (!Object.is(Reflect.get(value, key), item)) return false;
      if (!isJsonSafeData(item, seen, objectPrototypeIsSafe)) return false;
    }
  } else {
    const prototype: unknown = Object.getPrototypeOf(objectValue);
    if (prototype !== Object.prototype && prototype !== null) return false;
    if (prototype === Object.prototype && !objectPrototypeIsSafe) return false;

    for (const key of Reflect.ownKeys(objectValue)) {
      if (typeof key !== 'string') return false;

      const descriptor = Object.getOwnPropertyDescriptor(objectValue, key);
      if (descriptor === void 0 || descriptor.enumerable !== true || !('value' in descriptor)) return false;
      const property: unknown = descriptor.value;
      if (!Object.is(Reflect.get(objectValue, key), property)) return false;
      if (!isJsonSafeData(property, seen, objectPrototypeIsSafe)) return false;
    }
  }

  seen.set(objectValue, true);
  return true;
}

function getStructuralKey(schema: SchemaObject): string | null {
  try {
    if (!isJsonSafeData(schema, new WeakMap<object, boolean>())) return null;
    return serializeJsonSafeData(schema);
  } catch {
    // Proxies, excessive nesting, or otherwise unserialisable input must not
    // affect correctness. Ajv can still handle or report it via identity caching.
    return null;
  }
}

function serializeJsonSafeData(value: unknown): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'string':
    case 'boolean':
    case 'number': {
      const serialized = JSON.stringify(value);
      if (serialized === void 0) throw new TypeError('Expected a JSON primitive');
      return serialized;
    }
    case 'object':
      break;
    default:
      throw new TypeError('Expected JSON-safe data');
  }

  if (Array.isArray(value)) {
    const items: string[] = [];
    for (let index = 0; index < value.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === void 0 || !('value' in descriptor)) throw new TypeError('Expected a dense data array');
      items.push(serializeJsonSafeData(descriptor.value));
    }

    return `a[${items.join(',')}]`;
  }

  const objectValue = value as object;
  const prototype: unknown = Object.getPrototypeOf(objectValue);
  const properties: string[] = [];
  for (const key of Reflect.ownKeys(objectValue)) {
    if (typeof key !== 'string') throw new TypeError('Expected string property names');
    const descriptor = Object.getOwnPropertyDescriptor(objectValue, key);
    if (descriptor === void 0 || !('value' in descriptor)) throw new TypeError('Expected a data property');
    properties.push(`${JSON.stringify(key)}:${serializeJsonSafeData(descriptor.value)}`);
  }

  // Ajv reads inherited schema keywords. A null-prototype schema and a normal
  // object with the same own properties are therefore not interchangeable if
  // Object.prototype has been extended.
  return `${prototype === null ? 'n' : 'o'}{${properties.join(',')}}`;
}

const schemaArrayKeywords = new Set(['allOf', 'anyOf', 'items', 'oneOf', 'prefixItems']);
const schemaMapKeywords = new Set([
  '$defs',
  'definitions',
  'dependencies',
  'dependentSchemas',
  'patternProperties',
  'properties',
]);
const schemaDataKeywords = new Set([
  'const',
  'default',
  'dependentRequired',
  'enum',
  'exclusiveMaximum',
  'exclusiveMinimum',
  'format',
  'maximum',
  'maxItems',
  'maxLength',
  'maxProperties',
  'minimum',
  'minItems',
  'minLength',
  'minProperties',
  'multipleOf',
  'pattern',
  'required',
  'uniqueItems',
]);
const registryDependentKeywords = [
  '$anchor',
  '$dynamicAnchor',
  '$dynamicRef',
  '$id',
  '$recursiveAnchor',
  '$recursiveRef',
  '$ref',
  '$schema',
  'id',
] as const;

function canUseUnoptimizedPool(schema: SchemaObject): boolean {
  try {
    // OAS examples are cloned through JSON, but keep this internal option safe
    // if it is ever used by another caller with programmatic schema values.
    if (!isJsonSafeData(schema, new WeakMap<object, boolean>())) return false;

    const visited = new WeakSet<object>();
    return visitSchema(schema);

    function visitSchema(value: unknown): boolean {
      if (typeof value === 'boolean') return true;
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
      if (visited.has(value)) return true;
      visited.add(value);

      const schemaObject = value as Record<string, unknown>;
      for (const keyword of registryDependentKeywords) {
        if (keyword in schemaObject) return false;
      }

      for (const [keyword, nestedValue] of Object.entries(schemaObject)) {
        if (schemaDataKeywords.has(keyword)) continue;

        if (schemaArrayKeywords.has(keyword)) {
          if (Array.isArray(nestedValue)) {
            if (!nestedValue.every(visitSchema)) return false;
          } else if (!visitSchema(nestedValue)) {
            return false;
          }

          continue;
        }

        if (schemaMapKeywords.has(keyword)) {
          if (nestedValue === null || typeof nestedValue !== 'object' || Array.isArray(nestedValue)) return false;

          for (const nestedSchema of Object.values(nestedValue)) {
            if (keyword === 'dependencies' && Array.isArray(nestedSchema)) {
              if (!nestedSchema.every(item => typeof item === 'string')) return false;
            } else if (!visitSchema(nestedSchema)) {
              return false;
            }
          }

          continue;
        }

        // Ajv discovers identifiers and anchors with json-schema-traverse's
        // `allKeys` mode, so objects below extension keywords are schema-like
        // for registry purposes as well. Keep the same distinction for known
        // data keywords and schema maps (for example, `properties.id` is a map
        // key, not the draft-4 `id` keyword).
        if (nestedValue !== null && typeof nestedValue === 'object' && !Array.isArray(nestedValue)) {
          if (!visitSchema(nestedValue)) return false;
        }
      }

      return true;
    }
  } catch {
    return false;
  }
}

type AjvInstances = Partial<Record<NonNullable<Options['dialect']>, ReturnType<typeof _createAjvInstances>>>;

function createDialectInstances(optimize?: 0): AjvInstances {
  return {
    auto: _createAjvInstances(AjvBase, optimize),
    draft4: _createAjvInstances(AjvDraft4, optimize),
    'draft2019-09': _createAjvInstances(Ajv2019, optimize),
    'draft2020-12': _createAjvInstances(Ajv2020, optimize),
  };
}

export function createAjvInstances(): AssignAjvInstance {
  const optimizedInstances = createDialectInstances();
  const unoptimizedInstances = createDialectInstances(0);
  const unoptimizedEligibility = new WeakMap<SchemaObject, boolean>();

  const compiledSchemas = new WeakMap<AjvCore, WeakMap<SchemaObject, ValidateFunction>>();
  // This cache is only used for schemas proven to contain plain JSON data.
  // JSON.stringify is not collision-safe for values such as NaN, undefined,
  // sparse arrays, accessors, inherited properties, Date, or RegExp.
  //
  // It intentionally lives for the Ajv instance's lifetime. Ajv already keeps
  // every compiled schema in its strong `_cache`; evicting only this lookup key
  // cannot release a validator and can instead cause it to be compiled again.
  const structuralCache = new WeakMap<AjvCore, Map<string, ValidateFunction>>();

  return function (schema, dialect, allErrors, optimize): ValidateFunction {
    let useUnoptimizedPool = false;
    if (optimize === 0) {
      const cachedEligibility = unoptimizedEligibility.get(schema);
      if (cachedEligibility === void 0) {
        useUnoptimizedPool = canUseUnoptimizedPool(schema);
        unoptimizedEligibility.set(schema, useUnoptimizedPool);
      } else {
        useUnoptimizedPool = cachedEligibility;
      }
    }

    const ajvInstances = useUnoptimizedPool ? unoptimizedInstances : optimizedInstances;
    const instances = (ajvInstances[dialect] ?? ajvInstances.auto) as ReturnType<typeof _createAjvInstances>;
    const ajv = instances[allErrors ? 'allErrors' : 'default'];

    // Preserve the long-standing registry behavior for explicit `$id` values:
    // once an ID is registered, later schemas with that ID resolve to the
    // registered validator. Structural caching must not turn that into a new
    // duplicate-ID exception (including under the draft-4 adapter).
    const $id = schema.$id;
    if (typeof $id === 'string') {
      return ajv.getSchema($id) ?? ajv.compile(schema);
    }

    let actualCompiledSchemas = compiledSchemas.get(ajv);
    if (actualCompiledSchemas === void 0) {
      actualCompiledSchemas = new WeakMap<SchemaObject, ValidateFunction>();
      compiledSchemas.set(ajv, actualCompiledSchemas);
    }

    const byIdentity = actualCompiledSchemas.get(schema);
    if (byIdentity !== void 0) return byIdentity;

    let structural = structuralCache.get(ajv);
    if (structural === void 0) {
      structural = new Map<string, ValidateFunction>();
      structuralCache.set(ajv, structural);
    }

    const key = getStructuralKey(schema);

    if (key !== null) {
      const hit = structural.get(key);
      if (hit !== void 0) {
        actualCompiledSchemas.set(schema, hit);
        return hit;
      }
    }

    const validate = ajv.compile(schema);
    actualCompiledSchemas.set(schema, validate);
    if (key !== null) {
      structural.set(key, validate);
    }

    return validate;
  };
}
