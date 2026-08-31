#!/usr/bin/env node
/**
 * Attribution harness: splits the `run` phase into
 *   nimma compile | nimma traversal | rule functions | processTargetResults(range/refmap)
 * by monkeypatching live CJS export properties. No source edits required.
 *
 * node --expose-gc --max-old-space-size=8192 scripts/bench/bench-attrib.mjs --doc <file>
 */
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { readFileSync } from 'node:fs';
import { resolve as pathResolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = pathResolve(dirname(fileURLToPath(import.meta.url)), '../..');
const C = `${ROOT}/packages/core/dist`;

const { Document } = require(`${C}/document.js`);
const { DocumentInventory } = require(`${C}/documentInventory.js`);
const { Runner } = require(`${C}/runner/runner.js`);
const { Ruleset } = require(`${C}/ruleset/ruleset.js`);
const lintNodeMod = require(`${C}/runner/lintNode.js`);
const Parsers = require(`${ROOT}/packages/parsers/dist/index.js`);
const { Resolver } = require(`${ROOT}/packages/ref-resolver/dist/index.js`);
const Rulesets = require(`${ROOT}/packages/rulesets/dist/index.js`);
const Nimma = require('nimma/legacy').default ?? require('nimma/legacy');
const { jsonPathPlus } = require('nimma/fallbacks');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const DOC = arg('doc');
const MB = b => +(b / 1048576).toFixed(1);

// ------------------------------------------------- counters
const S = {
  lintNodeMs: 0, lintNodeCalls: 0,
  fnMs: 0, fnCalls: 0,
  findAssocMs: 0, findAssocCalls: 0,
  rangeMs: 0, rangeCalls: 0,
  perFn: new Map(),
};

// patch lintNode (runner.js:42 reads lintNode_1.lintNode at call time)
const origLint = lintNodeMod.lintNode;
lintNodeMod.lintNode = function (ctx, node, rule) {
  const t = performance.now();
  S.lintNodeCalls++;
  try { return origLint(ctx, node, rule); } finally { S.lintNodeMs += performance.now() - t; }
};

// patch the two hot per-finding helpers used by processTargetResults
const origFind = DocumentInventory.prototype.findAssociatedItemForPath;
DocumentInventory.prototype.findAssociatedItemForPath = function (p, r) {
  const t = performance.now(); S.findAssocCalls++;
  try { return origFind.call(this, p, r); } finally { S.findAssocMs += performance.now() - t; }
};
const origRange = Document.prototype.getRangeForJsonPath;
Document.prototype.getRangeForJsonPath = function (p, c) {
  const t = performance.now(); S.rangeCalls++;
  try { return origRange.call(this, p, c); } finally { S.rangeMs += performance.now() - t; }
};

// ------------------------------------------------- setup
const abs = pathResolve(process.cwd(), DOC);
const text = readFileSync(abs, 'utf8');
const ruleset = new Ruleset({ extends: [Rulesets.oas] });

// patch every rule's then.function to attribute time per function name
for (const rule of Object.values(ruleset.rules)) {
  for (const then of rule.then) {
    const f = then.function;
    const name = f.name || 'anon';
    const wrapped = function (input, opts, ctx) {
      const t = performance.now(); S.fnCalls++;
      try { return f(input, opts, ctx); }
      finally {
        const d = performance.now() - t;
        S.fnMs += d;
        const e = S.perFn.get(name) ?? { ms: 0, n: 0 };
        e.ms += d; e.n++; S.perFn.set(name, e);
      }
    };
    Object.defineProperty(wrapped, 'name', { value: name });
    then.function = wrapped;
  }
}

const t0 = performance.now();
const document = new Document(text, Parsers.Yaml, abs);
const tParse = performance.now() - t0;

const inventory = new DocumentInventory(document, new Resolver());
const t1 = performance.now();
await inventory.resolve();
const tResolve = performance.now() - t1;

const found = [...ruleset.formats].filter(f => f(inventory.resolved, document.source));
document.formats = found.length ? new Set(found) : null;

// reproduce runner's given-expression collection (runner.ts:46-57) to time nimma compile alone
const formats = document.formats ?? null;
const givens = { resolved: new Set(), unresolved: new Set() };
const relevant = Object.values(ruleset.rules).filter(r => r.enabled && r.matchesFormat(inventory.formats));
for (const rule of relevant) for (const g of rule.getGivenForFormats(formats)) givens[rule.resolved ? 'resolved' : 'unresolved'].add(g);

const compile = set => {
  if (set.size === 0) return { ms: 0, n: 0 };
  const exprs = [...set];
  const t = performance.now();
  new Nimma(exprs, { fallback: jsonPathPlus, unsafe: false, output: 'auto', customShorthands: {} });
  return { ms: performance.now() - t, n: exprs.length };
};
const cRes = compile(givens.resolved);
const cUnres = compile(givens.unresolved);

// now the real run
const runner = new Runner(inventory);
const t2 = performance.now();
await runner.run(ruleset);
const tRun = performance.now() - t2;
const results = runner.getResults();

const traversal = tRun - S.lintNodeMs - cRes.ms - cUnres.ms;
const processResults = S.lintNodeMs - S.fnMs;

console.log(`doc ${abs}  ${MB(Buffer.byteLength(text))}MB  node ${process.version}`);
console.log(`rules relevant: ${relevant.length}   distinct given (P): resolved=${cRes.n} unresolved=${cUnres.n}`);
console.log('');
console.log(`parse                    ${tParse.toFixed(0).padStart(8)} ms`);
console.log(`resolve                  ${tResolve.toFixed(0).padStart(8)} ms`);
console.log(`run TOTAL                ${tRun.toFixed(0).padStart(8)} ms`);
console.log(`  nimma compile(resolved)${cRes.ms.toFixed(0).padStart(8)} ms   (P=${cRes.n})`);
console.log(`  nimma compile(unresolv)${cUnres.ms.toFixed(0).padStart(8)} ms   (P=${cUnres.n})`);
console.log(`  nimma traversal        ${traversal.toFixed(0).padStart(8)} ms   (run - lintNode - compile)`);
console.log(`  lintNode TOTAL         ${S.lintNodeMs.toFixed(0).padStart(8)} ms   calls=${S.lintNodeCalls.toLocaleString()}`);
console.log(`    rule functions       ${S.fnMs.toFixed(0).padStart(8)} ms   calls=${S.fnCalls.toLocaleString()}`);
console.log(`    processTargetResults ${processResults.toFixed(0).padStart(8)} ms   (lintNode - functions)`);
console.log(`      findAssociatedItem ${S.findAssocMs.toFixed(0).padStart(8)} ms   calls=${S.findAssocCalls.toLocaleString()}`);
console.log(`      getRangeForJsonPath${S.rangeMs.toFixed(0).padStart(8)} ms   calls=${S.rangeCalls.toLocaleString()}`);
console.log('');
console.log(`findings F = ${results.length.toLocaleString()}`);
console.log(`peak RSS   = ${MB(process.resourceUsage().maxRSS * 1024)} MB`);
console.log('\ntop rule functions by self time:');
for (const [n, e] of [...S.perFn].sort((a, b) => b[1].ms - a[1].ms).slice(0, 12)) {
  console.log(`  ${n.padEnd(26)} ${e.ms.toFixed(0).padStart(8)} ms   ${e.n.toLocaleString().padStart(10)} calls   ${(e.ms / e.n * 1000).toFixed(1)} us/call`);
}
