#!/usr/bin/env node
/**
 * Output-equivalence checker.
 *
 * Any performance change MUST leave lint output byte-identical. This runs the
 * ruleset over a document and prints a sha256 over the normalised findings
 * (code, path, severity, range, message -- sorted), so a before/after pair of
 * runs can be compared with a single string.
 *
 *   node scripts/bench/verify-equivalence.mjs --doc corpora/synth-22mb.yaml [--out findings.txt]
 *
 * Use a --dirty corpus (see gen-synthetic.mjs) so there are actually findings
 * to compare; a clean document yields zero and proves nothing.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = pathResolve(dirname(fileURLToPath(import.meta.url)), '../..');

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i === -1 ? d : argv[i + 1];
};
const DOC = arg('doc');
const OUT = arg('out');
if (DOC === undefined) {
  console.error('usage: verify-equivalence.mjs --doc <file> [--out <file>]');
  process.exit(2);
}

const { Spectral, Document } = require(`${ROOT}/packages/core/dist/index.js`);
const Parsers = require(`${ROOT}/packages/parsers/dist/index.js`);
const rulesets = require(`${ROOT}/packages/rulesets/dist/oas/index.js`);

const spectral = new Spectral();
spectral.setRuleset(rulesets.default?.default ?? rulesets.default);

const results = await spectral.run(new Document(readFileSync(DOC, 'utf8'), Parsers.Yaml));
const normalised = results
  .map(
    r =>
      `${r.code}|${JSON.stringify(r.path)}|${r.severity}|` +
      `${r.range.start.line}:${r.range.start.character}-${r.range.end.line}:${r.range.end.character}|${r.message}`,
  )
  .sort();

console.log('findings:', results.length);
console.log('sha256:  ', createHash('sha256').update(normalised.join('\n')).digest('hex'));
if (OUT !== undefined) {
  writeFileSync(OUT, normalised.join('\n'));
  console.log('wrote:   ', OUT);
}
