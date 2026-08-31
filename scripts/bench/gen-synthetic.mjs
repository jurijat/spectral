#!/usr/bin/env node
/**
 * Self-contained deterministic corpus generator.
 *
 * Unlike synth.mjs (which grows a REAL spec you supply), this needs no input:
 * it emits a valid OpenAPI 3.0 document of a requested size with the $ref
 * fan-in shape that large enterprise specs have -- every operation references
 * a shared pool of 200 schemas plus 3 shared responses. That fan-in is what
 * drives the quadratic behaviour in the resolver, so it is the shape that
 * matters for this benchmark.
 *
 * Fully deterministic (no RNG): same --target => byte-identical output.
 *
 *   node scripts/bench/gen-synthetic.mjs --target 22 --out corpora/synth-22mb.yaml
 */
import { writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i === -1 ? d : argv[i + 1];
};
const TARGET_MB = Number(arg('target', 22));
const OUT = arg('out');
if (OUT === undefined) {
  console.error('usage: gen-synthetic.mjs --out <file> [--target 22] [--dirty]');
  process.exit(2);
}
// --dirty strips descriptions/operationIds so the ruleset produces ~4 findings per
// operation. Use it to measure the per-finding cost of the result pipeline.
const DIRTY = argv.includes('--dirty');

const SCHEMA_POOL = 200;
const TAGS = 40;
const L = [];
const p = s => L.push(s);
const desc = s => {
  if (!DIRTY) p(s);
};

p('openapi: "3.0.3"');
p('info:');
p('  title: Big Bench API');
p('  version: 1.0.0');
p('  description: Generated deterministic large spec for performance benchmarking.');
p('  contact:');
p('    name: Bench');
p('    url: https://example.com');
p('    email: bench@example.com');
p('  license:');
p('    name: Apache-2.0');
p('    url: https://www.apache.org/licenses/LICENSE-2.0.html');
p('servers:');
p('  - url: https://api.example.com/v1');
p('tags:');
for (let t = 0; t < TAGS; t++) {
  p(`  - name: tag${t}`);
  p(`    description: Tag number ${t} used for grouping operations.`);
}
p('paths:');

let i = 0;
const emitPath = () => {
  const r = `resource${i}`;
  p(`  /${r}:`);
  for (const m of ['get', 'post']) {
    p(`    ${m}:`);
    p(`      tags: [tag${i % TAGS}]`);
    p(`      summary: ${m.toUpperCase()} ${r}`);
    desc(`      description: Long form description for the ${m} operation on ${r}.`);
    if (!DIRTY) p(`      operationId: ${m}${r}`);
    p('      parameters:');
    p('        - $ref: "#/components/parameters/Limit"');
    p('        - $ref: "#/components/parameters/Offset"');
    p(`        - name: filter${i}`);
    p('          in: query');
    desc('          description: A filter expression applied to the collection.');
    p('          required: false');
    p('          schema:');
    p('            type: string');
    if (m === 'post') {
      p('      requestBody:');
      p('        required: true');
      p('        content:');
      p('          application/json:');
      p('            schema:');
      p(`              $ref: "#/components/schemas/Model${i % SCHEMA_POOL}"`);
    }
    p('      responses:');
    p("        '200':");
    p(`          description: Successful response for ${r}`);
    p('          content:');
    p('            application/json:');
    p('              schema:');
    p('                type: array');
    p('                items:');
    p(`                  $ref: "#/components/schemas/Model${i % SCHEMA_POOL}"`);
    p("        '400':");
    p('          $ref: "#/components/responses/BadRequest"');
    p("        '404':");
    p('          $ref: "#/components/responses/NotFound"');
    p("        '500':");
    p('          $ref: "#/components/responses/ServerError"');
  }
  i++;
};

const bytes = () => Buffer.byteLength(L.join('\n'), 'utf8');
const TARGET = TARGET_MB * 1024 * 1024;
while (bytes() < TARGET * 0.92) emitPath();

p('components:');
p('  parameters:');
p('    Limit:');
p('      name: limit');
p('      in: query');
desc('      description: Maximum number of items to return.');
p('      schema: { type: integer, minimum: 1, maximum: 100 }');
p('    Offset:');
p('      name: offset');
p('      in: query');
desc('      description: Number of items to skip.');
p('      schema: { type: integer, minimum: 0 }');
p('  responses:');
for (const [n, d] of [
  ['BadRequest', 'Bad request'],
  ['NotFound', 'Not found'],
  ['ServerError', 'Internal server error'],
]) {
  p(`    ${n}:`);
  p(`      description: ${d}`);
  p('      content:');
  p('        application/json:');
  p('          schema:');
  p('            $ref: "#/components/schemas/Error"');
}
p('  schemas:');
p('    Error:');
p('      type: object');
desc('      description: Standard error envelope.');
p('      properties:');
p('        code: { type: integer }');
p('        message: { type: string }');
for (let s = 0; s < SCHEMA_POOL; s++) {
  p(`    Model${s}:`);
  p('      type: object');
  desc(`      description: Model number ${s} describing a domain entity.`);
  p('      required: [id]');
  p('      properties:');
  p('        id: { type: string, format: uuid }');
  for (let f = 0; f < 12; f++) p(`        field${f}: { type: string }`);
  p(`        nested: { $ref: "#/components/schemas/Model${(s + 1) % SCHEMA_POOL}" }`);
}

const out = L.join('\n') + '\n';
writeFileSync(OUT, out);
console.log(`wrote ${OUT} ${(Buffer.byteLength(out) / 1048576).toFixed(1)}MB (${i} paths, ${i * 2} operations)`);
