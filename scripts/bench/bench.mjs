#!/usr/bin/env node
/**
 * Spectral phase-split performance harness.
 *
 * Measures wall time and memory for each lifecycle phase of a lint run,
 * mirroring Spectral.runWithResolved() (packages/core/src/spectral.ts:41-77)
 * but with instrumentation points between phases.
 *
 * Usage:
 *   node --expose-gc scripts/bench/bench.mjs --doc <file> [--ruleset oas] [--repeat 3] [--json out.json]
 *
 * Recommended full invocation (see README in this dir):
 *   node --expose-gc --max-old-space-size=8192 scripts/bench/bench.mjs --doc corpora/synth-22mb.yaml
 */
import { createRequire } from 'node:module';
import { performance, PerformanceObserver } from 'node:perf_hooks';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve as pathResolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { arch, cpus, platform, release, totalmem } from 'node:os';
import { Worker } from 'node:worker_threads';
import v8 from 'node:v8';
import { assertExecutableProvenanceUnchanged, collectProvenance, sha256 } from './provenance.mjs';
import { prepareRunner, rulesetForDocument } from './spectral-run-parity.mjs';

const require = createRequire(import.meta.url);
const ROOT = pathResolve(dirname(fileURLToPath(import.meta.url)), '../..');

// Deep-require CJS dist by absolute path: bypasses the package "exports" map,
// which does not expose documentInventory/runner (packages/core/package.json).
const { Document } = require(`${ROOT}/packages/core/dist/document.js`);
const { DocumentInventory } = require(`${ROOT}/packages/core/dist/documentInventory.js`);
const { Runner } = require(`${ROOT}/packages/core/dist/runner/runner.js`);
const { Ruleset } = require(`${ROOT}/packages/core/dist/ruleset/ruleset.js`);
const Parsers = require(`${ROOT}/packages/parsers/dist/index.js`);
const { Resolver, createHttpAndFileResolver } = require(`${ROOT}/packages/ref-resolver/dist/index.js`);
const Rulesets = require(`${ROOT}/packages/rulesets/dist/index.js`);

// ---------------------------------------------------------------- args
const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? dflt : argv[i + 1];
};
const flag = name => argv.includes(`--${name}`);

const DOC = arg('doc');
const RULESET_NAME = arg('ruleset', 'oas');
const REPEAT = Number(arg('repeat', '3'));
const JSON_OUT = arg('json');
const OFFLINE = !flag('allow-remote'); // default offline => deterministic
if (!DOC) {
  console.error(
    'usage: bench.mjs --doc <file> [--ruleset oas|asyncapi|arazzo] [--repeat N] [--json out.json] [--allow-remote]',
  );
  process.exit(2);
}
if (!['oas', 'asyncapi', 'arazzo'].includes(RULESET_NAME)) {
  console.error('--ruleset must be oas, asyncapi, or arazzo');
  process.exit(2);
}
if (!Number.isInteger(REPEAT) || REPEAT <= 0) {
  console.error('--repeat must be a positive integer');
  process.exit(2);
}

// ---------------------------------------------------------------- GC + RSS instrumentation
let gcTotalMs = 0;
let gcCount = 0;
const gcByKind = {};
const GC_KIND = { 1: 'minor', 2: 'major', 4: 'incremental', 8: 'weakcb', 16: 'major' };
const consume = entries => {
  for (const e of entries) {
    gcTotalMs += e.duration;
    gcCount++;
    const k = GC_KIND[e.detail?.kind] ?? String(e.detail?.kind);
    gcByKind[k] = (gcByKind[k] ?? 0) + e.duration;
  }
};
const resetGcStats = () => {
  gcTotalMs = 0;
  gcCount = 0;
  for (const kind of Object.keys(gcByKind)) delete gcByKind[kind];
};
const obs = new PerformanceObserver(list => consume(list.getEntries()));
obs.observe({ entryTypes: ['gc'] });
// IMPORTANT: the lint phases are CPU-bound and synchronous, so the observer
// callback never gets a turn. Drain the buffer explicitly at each phase mark.
// V8 only queues gc entries to the observer when the loop yields; takeRecords()
// alone returns nothing during a synchronous CPU-bound phase (verified on Node 24).
// So: yield one macrotask, THEN drain. Costs ~0.1ms per phase boundary.
const drainGc = async () => {
  await new Promise(r => setImmediate(r));
  consume(obs.takeRecords());
};

// The measured phases block the main event loop, so a timer in this thread misses
// their intra-phase peaks. process.memoryUsage.rss() is process-wide even when
// called from a worker_thread; keep the sampler on a thread that can run while the
// lint thread is blocked.
const rssSampler = new Worker(
  `
  const { parentPort } = require('node:worker_threads');
  let peak = process.memoryUsage.rss();
  const sample = () => { const rss = process.memoryUsage.rss(); if (rss > peak) peak = rss; };
  const timer = setInterval(sample, 2);
  parentPort.on('message', message => {
    sample();
    if (message === 'reset') {
      peak = process.memoryUsage.rss();
      parentPort.postMessage(peak);
    } else if (message === 'take') {
      parentPort.postMessage(peak);
    } else if (message === 'stop') {
      clearInterval(timer);
      parentPort.postMessage(peak);
    }
  });
`,
  { eval: true, execArgv: [] },
);
const sampleRss = command =>
  new Promise((resolve, reject) => {
    const onError = error => {
      rssSampler.off('message', onMessage);
      reject(error);
    };
    const onMessage = value => {
      rssSampler.off('error', onError);
      resolve(value);
    };
    rssSampler.once('error', onError);
    rssSampler.once('message', onMessage);
    rssSampler.postMessage(command);
  });

let peakRss = 0;

const MB = b => +(b / 1048576).toFixed(1);
function mem(label) {
  const m = process.memoryUsage();
  const h = v8.getHeapStatistics();
  const r = process.memoryUsage.rss();
  if (r > peakRss) peakRss = r;
  return {
    label,
    rssMB: MB(m.rss),
    heapUsedMB: MB(m.heapUsed),
    heapTotalMB: MB(m.heapTotal),
    externalMB: MB(m.external),
    arrayBuffersMB: MB(m.arrayBuffers),
    mallocedMB: MB(h.malloced_memory),
    peakMallocedMB: MB(h.peak_malloced_memory),
  };
}
const gc = () => {
  if (typeof global.gc === 'function') {
    global.gc();
    global.gc();
  }
};

// ---------------------------------------------------------------- ruleset
function buildRuleset(name) {
  const def = name === 'asyncapi' ? Rulesets.asyncapi : name === 'arazzo' ? Rulesets.arazzo : Rulesets.oas;
  return new Ruleset({ extends: [def] });
}

// Offline resolver: local $refs only. Deterministic, no network variance.
const makeResolver = () => (OFFLINE ? new Resolver() : createHttpAndFileResolver());

// ---------------------------------------------------------------- one run
async function once(text, source, ruleset) {
  const marks = [];
  const phaseStartRssMB = {};
  const phasePeakRssMB = {};
  const phaseRssGrowthMB = {};
  const mems = [];
  let t = performance.now();
  let phaseStartRss = 0;
  const mark = async (name, memoryLabel) => {
    const n = performance.now();
    marks.push([name, n - t]);
    const phasePeak = await sampleRss('take');
    if (phasePeak > peakRss) peakRss = phasePeak;
    phaseStartRssMB[name] = MB(phaseStartRss);
    phasePeakRssMB[name] = MB(phasePeak);
    phaseRssGrowthMB[name] = MB(Math.max(0, phasePeak - phaseStartRss));
    if (memoryLabel !== undefined) mems.push(mem(memoryLabel));
    await drainGc();
    phaseStartRss = await sampleRss('reset');
    t = performance.now();
  };

  gc();
  // Exclude the explicit baseline GC and its observer delivery from the lint's
  // GC totals and phase timings.
  await drainGc();
  resetGcStats();
  mems.push(mem('start'));
  phaseStartRss = await sampleRss('reset');
  t = performance.now();

  // ---- PHASE: parse  (Document ctor parses eagerly - document.ts:38)
  const document = new Document(text, Parsers.Yaml, source);
  await mark('parse', 'afterParse');

  // ---- PHASE: source-specific ruleset selection (spectral.ts:49)
  const activeRuleset = rulesetForDocument(ruleset, document);
  await mark('ruleset');

  // ---- PHASE: resolve (documentInventory.ts:65-81)
  const inventory = new DocumentInventory(document, makeResolver());
  await inventory.resolve();
  await mark('resolve', 'afterResolve');

  // ---- PHASE: format detection (spectral.ts:58-68)
  const runner = new Runner(inventory);
  prepareRunner(document, inventory, activeRuleset, runner);
  await mark('formats');

  // ---- PHASE: run (nimma compile + query + functions + awaited promises)
  await runner.run(activeRuleset);
  await mark('run', 'afterRun');

  // ---- PHASE: prepareResults (runner.ts:72-74)
  const results = runner.getResults();
  await mark('prepareResults', 'afterResults');

  const detected = document.formats ? [...document.formats].map(f => f.displayName ?? f.name) : null;
  return {
    marks,
    phaseStartRssMB,
    phasePeakRssMB,
    phaseRssGrowthMB,
    mems,
    findings: results.length,
    formats: detected,
  };
}

// ---------------------------------------------------------------- main
const abs = pathResolve(process.cwd(), DOC);
let sourceBytes = readFileSync(abs);
const bytes = sourceBytes.byteLength;
const documentSha256 = sha256(sourceBytes);
const text = sourceBytes.toString('utf8');
sourceBytes = null;
const ruleset = buildRuleset(RULESET_NAME);
const enabled = Object.values(ruleset.rules).filter(r => r.enabled);
const provenance = {
  ...collectProvenance(ROOT),
  documentSha256,
  platform: `${platform()} ${release()} ${arch()}`,
  cpu: cpus()[0]?.model ?? null,
  cpuCount: cpus().length,
  totalMemoryMB: MB(totalmem()),
};

console.log(`doc      : ${abs}`);
console.log(`bytes    : ${bytes.toLocaleString()} (${MB(bytes)} MB)`);
console.log(`ruleset  : ${RULESET_NAME} — ${Object.keys(ruleset.rules).length} rules, ${enabled.length} enabled`);
console.log(`resolver : ${OFFLINE ? 'offline (local $refs only)' : 'http+file'}`);
console.log(`node     : ${process.version}  repeat=${REPEAT}\n`);
console.log(`git      : ${provenance.git.commit?.slice(0, 12) ?? 'unknown'}${provenance.git.dirty ? ' (dirty)' : ''}`);
console.log(`worktree : ${provenance.git.worktreeSha256 ?? 'unknown'}`);
console.log(`dist     : ${provenance.loadedPackageDist.sha256}`);
console.log(`sha256   : ${provenance.documentSha256}\n`);

const runs = [];
for (let i = 0; i < REPEAT; i++) {
  resetGcStats();
  peakRss = 0;
  const t0 = performance.now();
  const r = await once(text, abs, ruleset);
  const harnessWallMs = performance.now() - t0;
  const total = r.marks.reduce((sum, [, ms]) => sum + ms, 0);
  await drainGc();
  runs.push({ ...r, total, harnessWallMs, gcTotalMs, gcCount, gcByKind: { ...gcByKind }, peakRssMB: MB(peakRss) });

  const line = r.marks.map(([n, ms]) => `${n} ${ms.toFixed(0)}ms`).join('  ');
  console.log(`run ${i + 1}: total ${total.toFixed(0)}ms | ${line}`);
  console.log(
    `       peakRSS ${MB(peakRss)}MB  gc ${gcTotalMs.toFixed(0)}ms/${gcCount}  findings ${r.findings}  formats ${r.formats}`,
  );
  console.log(
    `       phaseRSS ${Object.keys(r.phasePeakRssMB)
      .map(name => `${name}=${r.phaseStartRssMB[name]}→${r.phasePeakRssMB[name]}MB (+${r.phaseRssGrowthMB[name]}MB)`)
      .join('  ')}`,
  );
  for (const m of r.mems) {
    console.log(
      `       ${m.label.padEnd(13)} rss ${String(m.rssMB).padStart(7)}MB  heapUsed ${String(m.heapUsedMB).padStart(7)}MB  heapTotal ${String(m.heapTotalMB).padStart(7)}MB  ext ${m.externalMB}MB`,
    );
  }
  console.log('');
}

assertExecutableProvenanceUnchanged(provenance, collectProvenance(ROOT), 'bench');

// median of the per-phase timings
const phases = runs[0].marks.map(([n]) => n);
const med = a => {
  const s = [...a].sort((x, y) => x - y);
  const half = s.length >> 1;
  return s.length % 2 ? s[half] : (s[half - 1] + s[half]) / 2;
};
console.log('--- median over %d runs ---', REPEAT);
for (const p of phases) {
  const v = med(runs.map(r => r.marks.find(([n]) => n === p)[1]));
  console.log(`  ${p.padEnd(16)} ${v.toFixed(0).padStart(7)} ms`);
}
console.log(
  `  ${'TOTAL'.padEnd(16)} ${med(runs.map(r => r.total))
    .toFixed(0)
    .padStart(7)} ms`,
);
console.log(
  `  ${'peak RSS'.padEnd(16)} ${med(runs.map(r => r.peakRssMB))
    .toFixed(0)
    .padStart(7)} MB`,
);
console.log(
  `  ${'GC time'.padEnd(16)} ${med(runs.map(r => r.gcTotalMs))
    .toFixed(0)
    .padStart(7)} ms`,
);
console.log(
  `  maxRSS(process)  ${MB(process.resourceUsage().maxRSS * 1024)
    .toFixed(0)
    .padStart(7)} MB`,
);

if (JSON_OUT) {
  writeFileSync(
    JSON_OUT,
    JSON.stringify(
      {
        doc: abs,
        bytes,
        node: process.version,
        ruleset: RULESET_NAME,
        rules: Object.keys(ruleset.rules).length,
        enabledRules: enabled.length,
        maxRssMB: MB(process.resourceUsage().maxRSS * 1024),
        provenance,
        runs,
      },
      null,
      2,
    ),
  );
  console.log(`\nwrote ${JSON_OUT}`);
}

await sampleRss('stop');
await rssSampler.terminate();
