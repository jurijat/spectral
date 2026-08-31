#!/usr/bin/env node
/**
 * Deterministic corpus synthesizer.
 *
 * Grows a real OpenAPI document to a target byte size by replicating `paths`
 * entries under numbered prefixes while KEEPING `components` shared. This
 * raises N (nodes) and $ref fan-in the way a real large enterprise spec does,
 * and keeps the doc a valid OpenAPI 3.x document so the oas ruleset actually
 * fires (a malformed doc would only measure the unrecognized-format path).
 *
 * Fully deterministic: no RNG, sorted key iteration, fixed prefixes, noRefs
 * (no YAML anchors, so byte size is honest and parse cost is not hidden).
 * Same input + same --target => byte-identical output (verified by sha256).
 *
 *   node scripts/bench/synth.mjs --in corpora/github.yaml --out corpora/synth-22mb.yaml --target 22
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const yaml = require('js-yaml');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const IN = arg('in'), OUT = arg('out'), TARGET_MB = Number(arg('target', '22'));
if (!IN || !OUT) { console.error('usage: synth.mjs --in <spec> --out <file> [--target 22]'); process.exit(2); }

const raw = readFileSync(IN, 'utf8');
const doc = IN.endsWith('.json') ? JSON.parse(raw) : yaml.load(raw);
const TARGET = TARGET_MB * 1048576;

const basePaths = doc.paths ?? {};
const baseKeys = Object.keys(basePaths).sort();          // deterministic order
const dump = o => yaml.dump(o, { noRefs: true, lineWidth: -1, sortKeys: false });

// measure one replica's marginal cost to pick the replica count without O(n) dumps
const oneCopy = {};
for (const k of baseKeys) oneCopy[`/r0${k}`] = basePaths[k];
const bytesPerCopy = Buffer.byteLength(dump({ paths: oneCopy }));
const baseBytes = Buffer.byteLength(dump({ ...doc, paths: {} }));
let copies = Math.max(1, Math.ceil((TARGET - baseBytes) / bytesPerCopy));

const build = n => {
  const paths = { ...basePaths };
  for (let i = 0; i < n; i++) for (const k of baseKeys) paths[`/synth${String(i).padStart(3, '0')}${k}`] = basePaths[k];
  return { ...doc, paths };
};

// converge to <= target with a small deterministic descent
let out = build(copies);
let text = dump(out);
while (Buffer.byteLength(text) > TARGET && copies > 0) { copies--; out = build(copies); text = dump(out); }

writeFileSync(OUT, text);
const n = (o, c = 0) => { if (o && typeof o === 'object') { c++; for (const k of Object.keys(o)) c += n(o[k]); } else c++; return c; };
console.log(`in       : ${IN} (${(Buffer.byteLength(raw) / 1048576).toFixed(2)} MB)`);
console.log(`replicas : ${copies} x ${baseKeys.length} path items`);
console.log(`out      : ${OUT} (${(Buffer.byteLength(text) / 1048576).toFixed(2)} MB)`);
console.log(`paths    : ${Object.keys(out.paths).length}`);
console.log(`nodes N  : ~${n(out).toLocaleString()}`);
console.log(`sha256   : ${createHash('sha256').update(text).digest('hex')}`);
