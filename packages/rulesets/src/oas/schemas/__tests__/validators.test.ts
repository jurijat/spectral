import * as fs from 'fs';
import * as path from 'path';
import type { ErrorObject, ValidateFunction } from 'ajv';
import { oas3_0 } from '../validators';

jest.unmock('fs');

const validDocument = {
  openapi: '3.0.0',
  info: {
    title: 'Valid API',
    version: '1.0.0',
  },
  paths: {},
};
const validator = oas3_0 as typeof oas3_0 & Pick<ValidateFunction, 'errors'>;

describe('generated OAS validators', () => {
  test('rewrites every generated error-array accumulation site', () => {
    const source = fs.readFileSync(path.join(__dirname, '../validators.ts'), 'utf8');

    expect(source).not.toMatch(/[A-Za-z_$][\w$]*\s*\.concat\s*\([^)]*\.errors\s*\)/);
    expect(source).not.toContain('push.apply');
  });

  test('preserves accumulated error order', () => {
    const document = {
      openapi: '3.0.0',
      paths: {
        '/first': { bogus: true },
        '/second': { alsoBogus: true },
      },
    };

    expect(validator(document)).toBe(false);
    expect(
      validator.errors?.map(({ instancePath, schemaPath, keyword, params, message }: ErrorObject) => ({
        instancePath,
        schemaPath,
        keyword,
        params,
        message,
      })),
    ).toEqual([
      {
        instancePath: '',
        schemaPath: '#/required',
        keyword: 'required',
        params: { missingProperty: 'info' },
        message: "must have required property 'info'",
      },
      {
        instancePath: '/paths/~1first',
        schemaPath: '#/additionalProperties',
        keyword: 'additionalProperties',
        params: { additionalProperty: 'bogus' },
        message: 'must NOT have additional properties',
      },
      {
        instancePath: '/paths/~1second',
        schemaPath: '#/additionalProperties',
        keyword: 'additionalProperties',
        params: { additionalProperty: 'alsoBogus' },
        message: 'must NOT have additional properties',
      },
    ]);
  });

  test('accumulates more errors than V8 can pass as function arguments', () => {
    const invalidPathCount = 130_000;
    const paths: Record<string, { unexpected: boolean }> = {};
    for (let index = 0; index < invalidPathCount; index++) {
      paths[`/path-${index}`] = { unexpected: true };
    }

    try {
      expect(validator({ openapi: '3.0.0', paths })).toBe(false);

      const errors = validator.errors;
      expect(errors).toHaveLength(invalidPathCount + 1);
      expect(errors?.[0]).toMatchObject({
        instancePath: '',
        keyword: 'required',
        params: { missingProperty: 'info' },
      });
      expect(errors?.[invalidPathCount]).toMatchObject({
        instancePath: `/paths/~1path-${invalidPathCount - 1}`,
        keyword: 'additionalProperties',
        params: { additionalProperty: 'unexpected' },
      });
    } finally {
      // Drop the large generated error array before this Jest worker runs another suite.
      validator(validDocument);
    }
  });
});
