import type { SchemaObject, ValidateFunction } from 'ajv';
import { createAjvInstances } from '../schema/ajv';

const DIALECT = 'draft7';

describe('schema validator cache', () => {
  let assignValidator: ReturnType<typeof createAjvInstances>;

  beforeEach(() => {
    assignValidator = createAjvInstances();
  });

  function compile(schema: SchemaObject, dialect = DIALECT, allErrors = false, optimize?: 0): ValidateFunction {
    return assignValidator(schema, dialect, allErrors, optimize);
  }

  function expectIdentityFallback(first: SchemaObject, second: SchemaObject): void {
    const firstValidator = compile(first);

    expect(compile(first)).toBe(firstValidator);
    expect(compile(second)).not.toBe(firstValidator);
  }

  it('reuses validators for structurally equal JSON schemas', () => {
    const first: SchemaObject = {
      type: 'object',
      required: ['value'],
      properties: {
        value: {
          type: 'number',
          minimum: -1.5,
          maximum: 10,
          enum: [null, true, 'value', 2],
        },
      },
      additionalProperties: false,
    };
    const second = JSON.parse(JSON.stringify(first)) as SchemaObject;

    const firstValidator = compile(first);
    const secondValidator = compile(second);

    expect(secondValidator).toBe(firstValidator);
  });

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
  ])('does not confuse %s with null', (_name, value) => {
    const nonFiniteValidator = compile({ const: value });
    const nullValidator = compile({ const: null });

    expect(nullValidator).not.toBe(nonFiniteValidator);
    expect(nullValidator(null)).toBe(true);
    expect(nonFiniteValidator(null)).toBe(false);
  });

  it('uses identity caching for Date and RegExp values', () => {
    const date = new Date('2020-01-01T00:00:00.000Z');
    const dateValidator = compile({ const: date });
    const stringValidator = compile({ const: date.toJSON() });

    expect(dateValidator).not.toBe(stringValidator);
    expect(dateValidator(date)).toBe(true);
    expect(dateValidator(date.toJSON())).toBe(false);
    expect(stringValidator(date.toJSON())).toBe(true);

    const regexp = /value/;
    const regexpValidator = compile({ const: regexp });
    const objectValidator = compile({ const: {} });

    expect(regexpValidator).not.toBe(objectValidator);
    expect(regexpValidator(regexp)).toBe(true);
    expect(regexpValidator({})).toBe(false);
    expect(objectValidator({})).toBe(true);
  });

  it('does not ignore inherited schema properties', () => {
    const inherited = Object.create({ type: 'string' }) as SchemaObject;
    const inheritedValidator = compile(inherited);
    const emptyValidator = compile({});

    expect(inheritedValidator).not.toBe(emptyValidator);
    expect(inheritedValidator(1)).toBe(false);
    expect(emptyValidator(1)).toBe(true);
  });

  it('falls back when Object.prototype contains inherited schema keywords', () => {
    const baseline = compile({});
    const originalId = Object.getOwnPropertyDescriptor(Object.prototype, '$id');

    Object.defineProperty(Object.prototype, '$id', {
      configurable: true,
      value: 'urn:spectral:test:inherited-id',
    });

    try {
      const pollutedSchema: SchemaObject = {};
      const optimized = compile(pollutedSchema);

      expect(optimized).not.toBe(baseline);
      expect(compile(pollutedSchema, DIALECT, false, 0)).toBe(optimized);
      expect(compile({})).toBe(optimized);
    } finally {
      if (originalId === void 0) {
        Reflect.deleteProperty(Object.prototype, '$id');
      } else {
        Object.defineProperty(Object.prototype, '$id', originalId);
      }
    }
  });

  it('falls back when Proxy descriptors disagree with property reads', () => {
    const proxiedSchema = new Proxy<SchemaObject>(
      {},
      {
        get(target, property, receiver) {
          return property === 'type' ? 'number' : (Reflect.get(target, property, receiver) as unknown);
        },
        getOwnPropertyDescriptor(_target, property) {
          if (property !== 'type') return;
          return {
            configurable: true,
            enumerable: true,
            value: 'string',
            writable: true,
          };
        },
        ownKeys() {
          return ['type'];
        },
      },
    );

    const proxiedValidator = compile(proxiedSchema);
    const stringValidator = compile({ type: 'string' });

    expect(compile(proxiedSchema)).toBe(proxiedValidator);
    expect(stringValidator).not.toBe(proxiedValidator);
    expect(proxiedValidator(1)).toBe(true);
    expect(proxiedValidator('value')).toBe(false);
    expect(stringValidator('value')).toBe(true);
  });

  it('uses identity caching when toJSON changes or suppresses serialization', () => {
    const changedByToJSON = {
      const: null,
      toJSON: () => ({ const: 'changed' }),
    } as SchemaObject;
    const changedValidator = compile(changedByToJSON);
    const serializedValidator = compile({ const: 'changed' });

    expect(changedValidator).not.toBe(serializedValidator);
    expect(changedValidator(null)).toBe(true);
    expect(serializedValidator('changed')).toBe(true);

    const stringSchema = {
      type: 'string',
      toJSON: () => void 0,
    } as SchemaObject;
    const numberSchema = {
      type: 'number',
      toJSON: () => void 0,
    } as SchemaObject;
    const stringValidator = compile(stringSchema);
    const numberValidator = compile(numberSchema);

    expect(numberValidator).not.toBe(stringValidator);
    expect(stringValidator('value')).toBe(true);
    expect(numberValidator(1)).toBe(true);
  });

  it('uses identity caching for undefined values and sparse arrays', () => {
    const withUndefined = {
      type: 'string',
      extension: void 0,
    } as SchemaObject;
    expectIdentityFallback(withUndefined, { type: 'string' });

    const sparse = Array(1);
    const withSparseArray = {
      type: 'string',
      extension: sparse,
    } as SchemaObject;
    const withNull = {
      type: 'string',
      extension: [null],
    } as SchemaObject;
    expectIdentityFallback(withSparseArray, withNull);
  });

  it('uses identity caching for accessors, non-enumerable properties, and symbols', () => {
    const withAccessor = {} as SchemaObject;
    Object.defineProperty(withAccessor, 'type', {
      enumerable: true,
      get: () => 'string',
    });
    expectIdentityFallback(withAccessor, { type: 'string' });

    const withHiddenProperty = {} as SchemaObject;
    Object.defineProperty(withHiddenProperty, 'description', {
      enumerable: false,
      value: 'hidden',
    });
    expectIdentityFallback(withHiddenProperty, {});

    const withSymbol = { type: 'string' } as SchemaObject;
    Object.defineProperty(withSymbol, Symbol('extension'), { enumerable: true, value: true });
    expectIdentityFallback(withSymbol, { type: 'string' });
  });

  it('uses identity caching for circular, function, bigint, and class values', () => {
    const firstCircular: Record<string, unknown> = {};
    firstCircular.self = firstCircular;
    const secondCircular: Record<string, unknown> = {};
    secondCircular.self = secondCircular;
    expectIdentityFallback({ const: firstCircular }, { const: secondCircular });

    expectIdentityFallback({ type: 'string', extension: () => true }, { type: 'string' });
    const bigint = (globalThis as unknown as { BigInt(value: number): unknown }).BigInt(1);
    expectIdentityFallback({ type: 'string', extension: bigint }, { type: 'string' });

    class Extension {
      public readonly value = 'value';
    }

    expectIdentityFallback(
      { type: 'string', extension: new Extension() },
      {
        type: 'string',
        extension: { value: 'value' },
      },
    );
  });

  it('isolates normal and null-prototype objects at every schema depth', () => {
    const nullRoot = Object.assign(Object.create(null) as SchemaObject, { enum: [1, 2, 3] });
    const normalRoot: SchemaObject = { enum: [1, 2, 3] };

    expect(compile(normalRoot)).not.toBe(compile(nullRoot));

    const nullProperties = Object.assign(Object.create(null) as Record<string, SchemaObject>, {
      value: { type: 'string' },
    });
    const withNullProperties: SchemaObject = {
      type: 'object',
      properties: nullProperties,
    };
    const withNormalProperties: SchemaObject = {
      type: 'object',
      properties: {
        value: { type: 'string' },
      },
    };

    expect(compile(withNormalProperties)).not.toBe(compile(withNullProperties));
  });

  it('isolates structural entries by dialect and allErrors mode', () => {
    const schema: SchemaObject = {
      type: 'object',
      required: ['first', 'second'],
    };

    const draft4 = compile(schema, 'draft4');
    const draft2020 = compile({ ...schema }, 'draft2020-12');
    const defaultErrors = compile({ ...schema }, DIALECT, false);
    const allErrors = compile({ ...schema }, DIALECT, true);

    expect(draft2020).not.toBe(draft4);
    expect(allErrors).not.toBe(defaultErrors);

    expect(defaultErrors({})).toBe(false);
    expect(defaultErrors.errors).toHaveLength(1);
    expect(allErrors({})).toBe(false);
    expect(allErrors.errors).toHaveLength(2);
  });

  describe('unoptimized validator pool', () => {
    it('uses a separate pool and reuses structurally equal schemas within it', () => {
      const first: SchemaObject = {
        type: 'object',
        properties: {
          value: { type: 'string' },
        },
      };
      const second = JSON.parse(JSON.stringify(first)) as SchemaObject;

      const optimized = compile(first);
      const unoptimized = compile(first, DIALECT, false, 0);

      expect(unoptimized).not.toBe(optimized);
      expect(compile(second, DIALECT, false, 0)).toBe(unoptimized);
      expect(unoptimized({ value: 'valid' })).toBe(true);
      expect(unoptimized({ value: 1 })).toBe(false);
    });

    it('does not mistake a property named id for the draft-4 id keyword', () => {
      const schema: SchemaObject = {
        type: 'object',
        properties: {
          id: { type: 'string' },
        },
      };

      expect(compile(schema, DIALECT, false, 0)).not.toBe(compile(schema));
    });

    it('isolates dialects and allErrors modes within the unoptimized pool', () => {
      const schema: SchemaObject = {
        type: 'object',
        required: ['first', 'second'],
      };

      const draft4 = compile({ ...schema }, 'draft4', false, 0);
      const draft2020 = compile({ ...schema }, 'draft2020-12', false, 0);
      const defaultErrors = compile({ ...schema }, DIALECT, false, 0);
      const allErrors = compile({ ...schema }, DIALECT, true, 0);

      expect(draft2020).not.toBe(draft4);
      expect(allErrors).not.toBe(defaultErrors);

      expect(defaultErrors({})).toBe(false);
      expect(defaultErrors.errors).toHaveLength(1);
      expect(allErrors({})).toBe(false);
      expect(allErrors.errors).toHaveLength(2);
    });

    it('keeps $id and draft-4 id schemas in the optimized registry', () => {
      const dollarIdSchema: SchemaObject = {
        $id: 'urn:spectral:test:unoptimized-dollar-id',
        type: 'string',
      };
      const draft4IdSchema: SchemaObject = {
        id: 'urn:spectral:test:unoptimized-id',
        type: 'string',
      };

      const dollarIdValidator = compile(dollarIdSchema);
      const draft4IdValidator = compile(draft4IdSchema, 'draft4');

      expect(compile(dollarIdSchema, DIALECT, false, 0)).toBe(dollarIdValidator);
      expect(compile(draft4IdSchema, 'draft4', false, 0)).toBe(draft4IdValidator);
    });

    it('keeps identifiers hidden below extension keywords in the optimized registry', () => {
      const schema: SchemaObject = {
        type: 'string',
        example: {
          $id: 'https://example.test/hidden-schema',
          type: 'string',
        },
      };
      const optimized = compile(schema);

      expect(compile(schema, DIALECT, false, 0)).toBe(optimized);
    });

    it.each(['$anchor', '$dynamicAnchor', '$recursiveAnchor'] as const)(
      'keeps schemas containing %s in the optimized registry',
      keyword => {
        const schema = {
          type: 'string',
          [keyword]: 'spectralAnchor',
        } as SchemaObject;
        const optimized = compile(schema);

        expect(compile(schema, DIALECT, false, 0)).toBe(optimized);
      },
    );

    it.each(['$dynamicRef', '$recursiveRef'] as const)(
      'keeps schemas containing a non-fragment %s in the optimized registry',
      keyword => {
        const schema = {
          type: 'string',
          [keyword]: 'https://example.test/external',
        } as SchemaObject;
        const optimized = compile(schema);

        expect(compile(schema, DIALECT, false, 0)).toBe(optimized);
      },
    );

    it('uses the optimized registry to resolve an external $ref', () => {
      const externalId = 'https://example.test/external-schema';
      compile({ $id: externalId, type: 'string' });

      const schema: SchemaObject = { $ref: externalId };
      const optimized = compile(schema);

      expect(compile(schema, DIALECT, false, 0)).toBe(optimized);
      expect(optimized('valid')).toBe(true);
      expect(optimized(1)).toBe(false);
    });

    it('keeps local references in the optimized registry because they can reach arbitrary objects', () => {
      const externalId = 'https://example.test/local-pointer-target';
      compile({ $id: externalId, type: 'string' });

      const schema: SchemaObject = {
        $ref: '#/example',
        example: {
          $ref: externalId,
        },
      };
      const optimized = compile(schema);

      expect(compile(schema, DIALECT, false, 0)).toBe(optimized);
      expect(optimized('valid')).toBe(true);
      expect(optimized(1)).toBe(false);
    });

    it('keeps custom meta-schema lookup in the optimized registry', () => {
      const metaSchemaId = 'https://example.test/spectral-meta';
      compile({
        $id: metaSchemaId,
        type: 'object',
        required: ['spectralMarker'],
        properties: {
          spectralMarker: { const: true },
        },
      });

      const schema: SchemaObject = {
        $schema: metaSchemaId,
        spectralMarker: true,
        type: 'string',
      };
      const optimized = compile(schema);

      expect(compile(schema, DIALECT, false, 0)).toBe(optimized);
      expect(optimized('valid')).toBe(true);
      expect(optimized(1)).toBe(false);
    });
  });

  it('preserves the registered validator for repeated $id values', () => {
    const first: SchemaObject = {
      $id: 'urn:spectral:test:schema',
      type: 'string',
    };
    const validator = compile(first);

    expect(compile({ ...first })).toBe(validator);
    expect(
      compile({
        $id: first.$id,
        type: 'number',
      }),
    ).toBe(validator);
    expect(validator('value')).toBe(true);
    expect(validator(1)).toBe(false);
  });

  it('uses draft-4 id rather than $id as the schema identifier', () => {
    const id = 'urn:spectral:test:draft4-schema';
    const byId = compile({ id, type: 'string' }, 'draft4');

    expect(() => compile({ id, type: 'number' }, 'draft4')).toThrow(/already exists/);

    const byDollarId = compile({ $id: id, type: 'number' }, 'draft4');
    expect(byDollarId).toBe(byId);
    expect(byId('value')).toBe(true);
    expect(byId(1)).toBe(false);
  });
});
