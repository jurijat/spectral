import { isObject } from './utils/isObject';
import type { Dictionary, JsonPath, Optional } from '@stoplight/types';
import oasSchema, { Options as SchemaOptions } from './oasSchema';
import { createRulesetFunction, IFunctionResult } from '@stoplight/spectral-core';
import { oas2 } from '@stoplight/spectral-formats';
import traverse from 'json-schema-traverse';

export type Options = {
  oasVersion: 2 | 3;
  schemaField: string;
  type: 'media' | 'schema';
};

const schemaCompilationMode: unique symbol = Symbol.for('@stoplight/spectral-functions/schemaCompilationMode');
type InternalSchemaOptions = SchemaOptions & {
  [schemaCompilationMode]: 0;
};

type HasRequiredProperties = traverse.SchemaObject & {
  required?: string[];
};

type MediaValidationItem = {
  field: string;
  multiple: boolean;
  keyed: boolean;
};

const MEDIA_VALIDATION_ITEMS: Dictionary<MediaValidationItem[], 2 | 3> = {
  2: [
    {
      field: 'examples',
      multiple: true,
      keyed: false,
    },
  ],
  3: [
    {
      field: 'example',
      multiple: false,
      keyed: false,
    },
    {
      field: 'examples',
      multiple: true,
      keyed: true,
    },
  ],
};

const REQUEST_MEDIA_PATHS: Dictionary<JsonPath[], 2 | 3> = {
  2: [],
  3: [
    ['components', 'requestBodies'],
    ['paths', '*', '*', 'requestBody'],
  ],
};

const RESPONSE_MEDIA_PATHS: Dictionary<JsonPath[], 2 | 3> = {
  2: [['responses'], ['paths', '*', '*', 'responses']],
  3: [
    ['components', 'responses'],
    ['paths', '*', '*', 'responses'],
  ],
};

const SCHEMA_VALIDATION_ITEMS: Dictionary<string[], 2 | 3> = {
  2: ['example', 'x-example', 'default'],
  3: ['example', 'default'],
};

type ValidationItem = {
  value: unknown;
  path: JsonPath;
};

function hasRequiredProperties(schema: traverse.SchemaObject): schema is HasRequiredProperties {
  return schema.required === undefined || Array.isArray(schema.required);
}

function isSubpath(path: JsonPath, subPaths: JsonPath[]): boolean {
  return subPaths.some(subPath => subPath.every((segment, idx) => segment === '*' || segment === path[idx]));
}

function isMediaRequest(path: JsonPath, oasVersion: 2 | 3): boolean {
  return isSubpath(path, REQUEST_MEDIA_PATHS[oasVersion]);
}

function isMediaResponse(path: JsonPath, oasVersion: 2 | 3): boolean {
  return isSubpath(path, RESPONSE_MEDIA_PATHS[oasVersion]);
}

function* getMediaValidationItems(
  items: MediaValidationItem[],
  targetVal: Dictionary<unknown>,
  givenPath: JsonPath,
  oasVersion: 2 | 3,
): Iterable<ValidationItem> {
  for (const { field, keyed, multiple } of items) {
    if (!(field in targetVal)) {
      continue;
    }

    const value = targetVal[field];

    if (multiple) {
      if (!isObject(value)) continue;

      for (const exampleKey of Object.keys(value)) {
        const exampleValue = value[exampleKey];
        if (oasVersion === 3 && keyed && (!isObject(exampleValue) || 'externalValue' in exampleValue)) {
          // should be covered by oas3-examples-value-or-externalValue
          continue;
        }

        const targetPath = [...givenPath, field, exampleKey];

        if (keyed) {
          targetPath.push('value');
        }

        yield {
          value: keyed && isObject(exampleValue) ? exampleValue.value : exampleValue,
          path: targetPath,
        };
      }

      return;
    } else {
      return yield {
        value,
        path: [...givenPath, field],
      };
    }
  }
}

function* getSchemaValidationItems(
  fields: string[],
  targetVal: Record<string, unknown>,
  givenPath: JsonPath,
): Iterable<ValidationItem> {
  for (const field of fields) {
    if (!(field in targetVal)) {
      continue;
    }

    yield {
      value: targetVal[field],
      path: [...givenPath, field],
    };
  }
}

const SCHEMA_VALUE_KEYWORDS = new Set([
  'additionalItems',
  'additionalProperties',
  'contains',
  'contentSchema',
  'else',
  'if',
  'not',
  'propertyNames',
  'then',
  'unevaluatedItems',
  'unevaluatedProperties',
]);
const SCHEMA_ARRAY_KEYWORDS = new Set(['allOf', 'anyOf', 'items', 'oneOf', 'prefixItems']);
const SCHEMA_MAP_KEYWORDS = new Set([
  '$defs',
  'definitions',
  'dependencies',
  'dependentSchemas',
  'patternProperties',
  'properties',
]);
const SCHEMA_DATA_KEYWORDS = new Set([
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

/**
 * Modifies 'schema' (and all its sub-schemas) to remove id fields from non-schema objects
 * In this context, "sub-schemas" refers to all schemas reachable from 'schema'
 * (e.g. properties, additionalProperties, allOf/anyOf/oneOf, not, items, etc.)
 * @param schema the schema to be sanitized
 * @returns 'schema' with id fields removed
 */
function cleanSchema(schema: Record<string, unknown>): void {
  visitObject(schema, true);

  function visitObject(fragment: Record<string, unknown>, schemaPosition: boolean): void {
    if (!schemaPosition) {
      delete fragment.id;
      delete fragment.$id;
    }

    for (const [keyword, value] of Object.entries(fragment)) {
      if (SCHEMA_DATA_KEYWORDS.has(keyword)) continue;

      if (SCHEMA_ARRAY_KEYWORDS.has(keyword)) {
        if (Array.isArray(value)) {
          for (const item of value) visitSchemaValue(item);
        } else {
          visitSchemaValue(value);
        }

        continue;
      }

      if (SCHEMA_MAP_KEYWORDS.has(keyword)) {
        if (isObject(value) && !Array.isArray(value)) {
          for (const nestedSchema of Object.values(value)) visitSchemaValue(nestedSchema);
        }

        continue;
      }

      if (SCHEMA_VALUE_KEYWORDS.has(keyword)) {
        visitSchemaValue(value);
        continue;
      }

      if (isObject(value) && !Array.isArray(value)) {
        visitObject(value, false);
      }
    }
  }

  function visitSchemaValue(value: unknown): void {
    if (isObject(value) && !Array.isArray(value)) visitObject(value, true);
  }
}

/**
 * Modifies 'schema' (and all its sub-schemas) to make all
 * readOnly or writeOnly properties optional.
 * In this context, "sub-schemas" refers to all schemas reachable from 'schema'
 * (e.g. properties, additionalProperties, allOf/anyOf/oneOf, not, items, etc.)
 * @param schema the schema to be modified
 * @param readOnlyProperties make readOnly properties optional
 * @param writeOnlyProperties make writeOnly properties optional
 */
function relaxRequired(
  schema: Record<string, unknown>,
  readOnlyProperties: boolean,
  writeOnlyProperties: boolean,
): void {
  if (readOnlyProperties || writeOnlyProperties)
    traverse(schema, {}, <traverse.Callback>((
      fragment,
      jsonPtr,
      rootSchema,
      parentJsonPtr,
      parentKeyword,
      parent,
      propertyName,
    ) => {
      if ((fragment.readOnly === true && readOnlyProperties) || (fragment.writeOnly === true && writeOnlyProperties)) {
        if (parentKeyword == 'properties' && parent && hasRequiredProperties(parent)) {
          parent.required = parent.required?.filter(p => p !== propertyName);
          if (parent.required?.length === 0) {
            delete parent.required;
          }
        }
      }
    }));
}

// Keyed on the source schema object, which is a stable node of the (resolved)
// document, so this is bounded by the document and dies with it.
const preparedSchemas = new WeakMap<object, Map<string, SchemaOptions['schema']>>();

export default createRulesetFunction<Record<string, unknown>, Options>(
  {
    input: {
      type: 'object',
    },
    options: {
      type: 'object',
      properties: {
        oasVersion: {
          enum: [2, 3],
        },
        schemaField: {
          type: 'string',
        },
        type: {
          enum: ['media', 'schema'],
        },
      },
      additionalProperties: false,
    },
  },
  function oasExample(targetVal, opts, context) {
    const formats = context.document.formats;
    const schemaOpts: InternalSchemaOptions = {
      [schemaCompilationMode]: 0,
      schema: opts.schemaField === '$' ? targetVal : (targetVal[opts.schemaField] as SchemaOptions['schema']),
    };

    let results: Optional<IFunctionResult[]> = void 0;

    const validationItems =
      opts.type === 'schema'
        ? getSchemaValidationItems(SCHEMA_VALIDATION_ITEMS[opts.oasVersion], targetVal, context.path)
        : getMediaValidationItems(MEDIA_VALIDATION_ITEMS[opts.oasVersion], targetVal, context.path, opts.oasVersion);

    const isRequest = opts.type === 'media' && isMediaRequest(context.path, opts.oasVersion);
    const isResponse = opts.type === 'media' && isMediaResponse(context.path, opts.oasVersion);
    const stripRequired =
      formats?.has(oas2) === true && 'required' in schemaOpts.schema && typeof schemaOpts.schema.required === 'boolean';

    // The cloned+cleaned+relaxed schema is a pure function of the source schema
    // object and these three flags, but it used to be rebuilt on every call --
    // and because `prepareResults`' validator cache (packages/functions/src/schema/ajv.ts)
    // is a WeakMap keyed on schema IDENTITY, a fresh clone guaranteed a miss and
    // ajv recompiled the validator every time. On github.com@1.1.4 (8.4MB) that
    // was 122,324 compilations for 634 findings; ajv's own `_cache` is a strong
    // Map, so every one of them was also retained. Caching the processed schema
    // on the source object makes both caches hit.
    const variant = `${opts.oasVersion}|${stripRequired ? 1 : 0}|${isRequest ? 1 : 0}|${isResponse ? 1 : 0}`;
    const source = schemaOpts.schema;
    let byVariant = preparedSchemas.get(source);
    if (byVariant === void 0) {
      byVariant = new Map();
      preparedSchemas.set(source, byVariant);
    }

    let prepared = byVariant.get(variant);
    if (prepared === void 0) {
      let base = source;
      if (stripRequired) {
        base = { ...base };
        delete base.required;
      }

      // Make a deep copy of the schema and then remove all objects containing id or $id and that are not schema objects.
      // This is to avoid problems down in "ajv" which does the actual schema validation.
      prepared = JSON.parse(JSON.stringify(base)) as SchemaOptions['schema'];
      cleanSchema(prepared);
      relaxRequired(prepared, isRequest, isResponse);
      byVariant.set(variant, prepared);
    }

    schemaOpts.schema = prepared;

    for (const validationItem of validationItems) {
      const result = oasSchema(validationItem.value, schemaOpts, {
        ...context,
        path: validationItem.path,
      });

      if (Array.isArray(result)) {
        if (results === void 0) results = [];
        results.push(...result);
      }
    }

    return results;
  },
);
