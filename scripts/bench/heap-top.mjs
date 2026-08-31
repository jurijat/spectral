#!/usr/bin/env node
/**
 * Writes a heap snapshot at a chosen phase and reports the top object
 * constructors by aggregate shallow size + count -- i.e. "what is the heap
 * actually made of". Answers "AST vs resolved graph" without DevTools.
 *
 *   node --expose-gc scripts/bench/heap-top.mjs --doc <file> --phase parse|resolve
 */
import { createRequire } from 'node:module';
import { readFileSync, statSync } from 'node:fs';
import { resolve as pathResolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import v8 from 'node:v8';

const require = createRequire(import.meta.url);
const ROOT = pathResolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { Document } = require(`${ROOT}/packages/core/dist/document.js`);
const { DocumentInventory } = require(`${ROOT}/packages/core/dist/documentInventory.js`);
const Parsers = require(`${ROOT}/packages/parsers/dist/index.js`);
const { Resolver } = require(`${ROOT}/packages/ref-resolver/dist/index.js`);

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const DOC = pathResolve(process.cwd(), arg('doc'));
const PHASE = arg('phase', 'resolve');
const OUT = arg('out', `/tmp/spectral-${PHASE}.heapsnapshot`);
const MB = b => +(b / 1048576).toFixed(1);

const text = readFileSync(DOC, 'utf8');
const document = new Document(text, Parsers.Yaml, DOC);
if (PHASE === 'resolve') { const inv = new DocumentInventory(document, new Resolver()); await inv.resolve(); globalThis.__inv = inv; }
globalThis.__doc = document;
if (typeof global.gc === 'function') { global.gc(); global.gc(); }

console.log(`heapUsed at ${PHASE}: ${MB(process.memoryUsage().heapUsed)} MB — writing snapshot...`);
v8.writeHeapSnapshot(OUT);
console.log(`snapshot ${OUT} (${MB(statSync(OUT).size)} MB on disk)\n`);

// ---- analyze: aggregate shallow size by constructor/type
// GOTCHA: a .heapsnapshot over ~250MB cannot be JSON.parse'd in Node — its
// `nodes` array exceeds V8's max FixedArray length and the process dies with
// "Fatal JavaScript invalid size error". Snapshot a SMALLER corpus (the
// constructor mix is scale-invariant) or open the file in Chrome DevTools.
const snapBytes = statSync(OUT).size;
if (snapBytes > 250 * 1048576) {
  console.error(`snapshot is ${MB(snapBytes)} MB — too large to JSON.parse in Node.`);
  console.error('Use a smaller corpus for shape analysis, or load this file in Chrome DevTools > Memory.');
  process.exit(3);
}
const snap = JSON.parse(readFileSync(OUT, 'utf8'));
const { node_fields, node_types } = snap.snapshot.meta;
const F = node_fields.length;
const TYPE = node_fields.indexOf('type'), NAME = node_fields.indexOf('name'), SIZE = node_fields.indexOf('self_size');
const types = node_types[TYPE];
const agg = new Map();
for (let i = 0; i < snap.nodes.length; i += F) {
  const t = types[snap.nodes[i + TYPE]];
  // string/code node "name" IS the payload; bucket by type so one huge string
  // literal cannot dominate the report.
  const key = t.includes('string') || t === 'code' || t === 'hidden' || t === 'array'
    ? t
    : `${t}:${snap.strings[snap.nodes[i + NAME]]}`;
  const e = agg.get(key) ?? { n: 0, b: 0 };
  e.n++; e.b += snap.nodes[i + SIZE];
  agg.set(key, e);
}
const total = [...agg.values()].reduce((s, e) => s + e.b, 0);
console.log(`total shallow across ${(snap.nodes.length / F).toLocaleString()} heap nodes: ${MB(total)} MB`);
console.log('\n  MB      count        type:constructor');
for (const [k, e] of [...agg].sort((a, b) => b[1].b - a[1].b).slice(0, 22)) {
  console.log(`${String(MB(e.b)).padStart(7)}  ${e.n.toLocaleString().padStart(11)}   ${k}`);
}
