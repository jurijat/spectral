/* eslint-disable no-console */
import * as fs from 'fs';
import * as path from 'path';
import * as process from 'process';
import Ajv2020 from 'ajv/dist/2020.js';
import standaloneCode from 'ajv/dist/standalone/index.js';
import ajvErrors from 'ajv-errors';
import ajvFormats from 'ajv-formats';
import chalk from 'chalk';
import { minify } from 'terser';
import { sync } from 'gzip-size';

const cwd = path.join(__dirname, '../src');

const schemas = [
  'oas/schemas/json-schema/draft-04.json',
  'oas/schemas/json-schema/draft-2020-12/index.json',
  'oas/schemas/json-schema/draft-2020-12/validation.json',
  'oas/schemas/oas/v2.0.json',
  'oas/schemas/oas/v3.0.json',
  'oas/schemas/oas/v3.1/dialect.schema.json',
  'oas/schemas/oas/v3.1/meta.schema.json',
  'oas/schemas/oas/v3.1/index.json',
  'arazzo/schemas/arazzo/v1.0/index.json',
].map(async schema => JSON.parse(await fs.promises.readFile(path.join(cwd, schema), 'utf8')));

const log = process.argv.includes('--quiet')
  ? (): void => {
      /* no-op */
    }
  : console.log.bind(console);

/**
 * `allErrors: true` makes ajv accumulate sub-schema errors with
 *
 *   acc = acc === null ? sub.errors : acc.concat(sub.errors)
 *
 * at every one of ~600 generated sites. `concat` copies the whole accumulator,
 * so validating a document with E errors costs O(E^2) time and allocates O(E^2)
 * array slots. Measured on OAS 3.0 with N operations carrying two unexpected
 * properties each: 20k errors 207ms, 40k errors 994ms, 80k errors 3,509ms
 * (fitted exponent 2.04), peaking at 137MB.
 *
 * Rewriting the accumulation to append in place makes it linear -- 107ms / 212ms /
 * 423ms for the same inputs, peak 28MB -- and produces a byte-identical error
 * array in the same order. `.slice()` on the seed keeps the accumulator from
 * aliasing ajv's own `errors` array.
 *
 * Do not use `push.apply` (or spread) for the append: V8 limits the number of
 * function arguments, so a child validator returning roughly 130k errors would
 * throw a RangeError instead of returning the validation errors.
 */
function deconcatenateErrorAccumulation(code: string): string {
  const appendErrorsHelper = '__spectralAppendErrors';
  if (code.includes(appendErrorsHelper)) {
    throw new Error(`compile-schemas: generated code already contains reserved helper name ${appendErrorsHelper}`);
  }

  // Whitespace-tolerant: terser emits this without spaces, other pipelines reformat it.
  // The sub-validator can be a local function (`validate.errors`) or a member
  // expression (`schema.validate.errors`).
  const pattern =
    /([A-Za-z_$][\w$]*)\s*=\s*null\s*===\s*\1\s*\?\s*((?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$][\w$]*)\.errors\s*:\s*\1\.concat\(\2\.errors\)/g;
  let rewritten = 0;
  const out = code.replace(pattern, (_match, acc: string, sub: string) => {
    rewritten++;
    return `(${acc} = ${appendErrorsHelper}(${acc}, ${sub}.errors))`;
  });

  // If ajv or terser changes the emitted shape this silently stops applying and
  // the quadratic comes back, so fail the build instead.
  if (rewritten < 100) {
    throw new Error(
      `compile-schemas: expected to rewrite ajv's error accumulation at many sites, rewrote ${rewritten}. ` +
        `The generated shape has changed -- update the pattern in deconcatenateErrorAccumulation().`,
    );
  }

  const leftoverErrorConcat = /[A-Za-z_$][\w$]*\s*\.concat\s*\([^)]*\.errors\s*\)/;
  if (leftoverErrorConcat.test(out)) {
    throw new Error(
      'compile-schemas: generated code still contains error-array concat accumulation. ' +
        'Update the pattern in deconcatenateErrorAccumulation().',
    );
  }

  const helper =
    `function ${appendErrorsHelper}(target,source){` +
    'if(target===null)return source.slice();' +
    'for(let index=0;index<source.length;index++)target.push(source[index]);' +
    'return target}' +
    '\n';

  log('rewrote %d ajv error-accumulation sites from concat to an argument-safe append loop', rewritten);
  return helper + out;
}

Promise.all(schemas)
  .then(async schemas => {
    const ajv = new Ajv2020({
      schemas,
      allErrors: true,
      messages: true,
      strict: false,
      inlineRefs: false,
      formats: {
        'media-range': true,
      },
      code: {
        esm: true,
        source: true,
      },
    });

    ajvFormats(ajv);
    ajvErrors(ajv);

    const target = path.join(cwd, 'oas/schemas/validators.ts');
    const arazzoTarget = path.join(cwd, 'arazzo/schemas/validators.ts');
    const basename = path.basename(target);
    const code = standaloneCode(ajv, {
      oas2_0: 'http://swagger.io/v2/schema.json',
      oas3_0: 'https://spec.openapis.org/oas/3.0/schema/2019-04-02',
      oas3_1: 'https://spec.openapis.org/oas/3.1/schema/2021-09-28',
      arazzo1_0: 'https://spec.openapis.org/arazzo/1.0/schema/2024-08-01',
    });

    const minified = (
      await minify(code, {
        compress: {
          passes: 2,
        },
        ecma: 2020,
        module: true,
        format: {
          comments: false,
        },
      })
    ).code as string;

    const deconcatenated = deconcatenateErrorAccumulation(minified);

    log(
      'writing %s size is %dKB (original), %dKB (minified) %dKB (minified + gzipped)',
      path.join(target, '..', basename),
      Math.round((code.length / 1024) * 100) / 100,
      Math.round((minified.length / 1024) * 100) / 100,
      Math.round((sync(minified) / 1024) * 100) / 100,
    );

    await fs.promises.writeFile(path.join(target, '..', basename), ['// @ts-nocheck', deconcatenated].join('\n'));

    log(
      'writing %s size is %dKB (original), %dKB (minified) %dKB (minified + gzipped)',
      path.join(arazzoTarget, '..', basename),
      Math.round((code.length / 1024) * 100) / 100,
      Math.round((minified.length / 1024) * 100) / 100,
      Math.round((sync(minified) / 1024) * 100) / 100,
    );

    await fs.promises.writeFile(path.join(arazzoTarget, '..', basename), ['// @ts-nocheck', deconcatenated].join('\n'));
  })
  .then(() => {
    log(chalk.green('Validators generated.'));
  })
  .catch(e => {
    console.error(chalk.red('Error generating validators %s'), e.message);
    process.exit(1);
  });
