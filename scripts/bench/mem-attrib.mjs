#!/usr/bin/env node
/**
 * Memory attribution by destructive probing.
 *
 * Measures the RETAINED size of each big structure by dropping the only
 * reference to it and forcing GC. Delta in heapUsed == what that structure was
 * holding. This is far cheaper and more precise than eyeballing retainer paths
 * in a heap snapshot, and it needs no DevTools.
 *
 * MUST be run with --expose-gc.
 *   node --expose-gc --max-old-space-size=12288 scripts/bench/mem-attrib.mjs --doc <file>
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve as pathResolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = pathResolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { Document } = require(`${ROOT}/packages/core/dist/document.js`);
const { DocumentInventory } = require(`${ROOT}/packages/core/dist/documentInventory.js`);
const Parsers = require(`${ROOT}/packages/parsers/dist/index.js`);
const { Resolver } = require(`${ROOT}/packages/ref-resolver/dist/index.js`);

if (typeof global.gc !== 'function') {
  console.error('run with --expose-gc');
  process.exit(2);
}
const argv = process.argv.slice(2);
const DOC = argv[argv.indexOf('--doc') + 1];
const MB = b => +(b / 1048576).toFixed(1);
const settle = () => {
  for (let i = 0; i < 4; i++) global.gc();
  return process.memoryUsage().heapUsed;
};

const abs = pathResolve(process.cwd(), DOC);
const text = readFileSync(abs, 'utf8');
const srcMB = MB(Buffer.byteLength(text));
let h = settle();
const step = (label, fn) => {
  fn();
  const n = settle();
  console.log(`${label.padEnd(34)} ${String(MB(h - n)).padStart(8)} MB freed   (heapUsed now ${MB(n)} MB)`);
  h = n;
};
const grow = async (label, fn) => {
  const r = await fn();
  const n = settle();
  console.log(`${label.padEnd(34)} ${String(MB(n - h)).padStart(8)} MB added   (heapUsed now ${MB(n)} MB)`);
  h = n;
  return r;
};

console.log(`doc ${abs}  source ${srcMB} MB  node ${process.version}`);
console.log(`baseline heapUsed ${MB(h)} MB\n--- growth ---`);

let document = await grow('parse -> Document (all)', () => new Document(text, Parsers.Yaml, abs));
const inventory = new DocumentInventory(document, new Resolver());
await grow('resolve -> inventory.resolved', () => inventory.resolve());

console.log('\n--- destructive attribution (drop ref, force GC) ---');
const pr = document.parserResult;
step('drop inventory.resolved (2nd copy)', () => {
  inventory.resolved = null;
});
step('drop inventory.graph', () => {
  inventory.graph = null;
});
step('drop parserResult.ast (YAML AST)', () => {
  pr.ast = null;
});
step('drop parserResult.lineMap', () => {
  pr.lineMap = null;
});
step('drop parserResult.comments', () => {
  pr.comments = null;
});
step('drop parserResult.data (unresolved)', () => {
  pr.data = null;
});
step('drop source text', () => {
  document.input = null;
});

console.log(`\nsource bytes ${srcMB} MB -> peak heapUsed observed above.`);
console.log(`peak RSS ${MB(process.resourceUsage().maxRSS * 1024)} MB`);
