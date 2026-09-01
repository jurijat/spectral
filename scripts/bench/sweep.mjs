#!/usr/bin/env node
/**
 * sweep.mjs -- corpus-wide lint sweep for Spectral.
 *
 * Lints every document in a directory and emits one row per document with the
 * numbers needed to classify its *performance regime*:
 *
 *   size            bytes on disk (and MB)
 *   refs            number of `$ref` keys in the UNRESOLVED parsed document
 *   refsPerKB       refs / (bytes/1024)      -- "ref density"
 *   examples        number of oasExample() invocations during the lint
 *                   (i.e. resolved nodes matched by the four *-valid-*-example
 *                   rules; this is the population that can drive ajv work)
 *   parseMs/resolveMs/lintMs/totalMs
 *   peakRssMB       kernel high-water mark (getrusage maxRSS) of the child
 *   findings        prepareResults() output length -- what the user sees
 *   rawFindings     pre-dedup length; findings + dropped == rawFindings
 *   ajvCompiles     calls to Ajv.prototype.compile (patched on ajv/dist/core.js)
 *   visits/distinct DFS over the RESOLVED object graph: total object-node
 *                   visits vs distinct object identities. redundancy =
 *                   visits/distinct. Also reported for the unresolved doc.
 *
 * WHY A CHILD PROCESS PER DOCUMENT
 * Peak RSS is a per-process high-water mark, so several documents in one
 * process would report the max of all of them. Isolation also means a crash or
 * OOM on one document is a data point rather than the end of the sweep.
 *
 * WHY TWO CHILDREN PER DOCUMENT
 *   pass A ("lint")       timed. Only two hooks, both O(1) per call on paths
 *                         that are already expensive (ajv compile, oasExample),
 *                         so the timing is not meaningfully perturbed.
 *   pass B ("structure")  untimed. parse + resolve only, then a DFS that
 *                         allocates a Set of every distinct node. That Set
 *                         would inflate pass A's peak RSS, so it lives here.
 * Pass B is skipped with --no-structure.
 *
 * TIMING FIDELITY
 * Documents are processed strictly serially (one child at a time). Do not add
 * a --jobs flag: on a shared box the point of this tool is comparable numbers,
 * not throughput. The reported `loadavg` in the JSON is the 1-minute load at
 * sweep start and end -- if those differ a lot, distrust absolute ms.
 *
 * USAGE
 *   node scripts/bench/sweep.mjs [options]
 *
 *   --dir <path>       corpus directory       (default corpora/real)
 *   --out <file.json>  write the full result set as JSON
 *   --max-mb <n>       skip files larger than n MB (default 64)
 *   --min-mb <n>       skip files smaller than n MB (default 0)
 *   --only <substr>    only documents whose filename contains <substr>
 *                      (repeatable)
 *   --ruleset <name>   oas | asyncapi | arazzo  (default oas)
 *   --heap-mb <n>      child --max-old-space-size (default 8192). Keep this
 *                      IDENTICAL across a comparison: it changes GC pressure
 *                      and therefore RSS.
 *   --timeout-s <n>    kill a child after n seconds (default 900)
 *   --repeat <n>       run pass A n times, report the median (default 1).
                      NOTE: peakRssMB is a whole-process high-water mark, so it
                      is only comparable at --repeat 1 -- with n>1 the retained
                      graphs of earlier runs inflate it.
 *   --no-structure     skip pass B (visits/distinct/refs)
 *   --sort <key>       sort the printed table: name|size|lint|rss|density
 *   --quiet            table only, no per-document progress
 *
 * EXAMPLES
 *   node scripts/bench/sweep.mjs --out /tmp/sweep.json
 *   node scripts/bench/sweep.mjs --only microsoft --repeat 3
 *   node scripts/bench/sweep.mjs --max-mb 10 --sort lint
 *
 * The script is also its own worker: `--worker-lint` / `--worker-struct` are
 * internal and are what the parent spawns. They print one line of JSON
 * prefixed with `##SWEEP##` on stdout so that any noise the linter writes to
 * stdout/stderr cannot corrupt the result.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve as pathResolve, dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const require = createRequire(import.meta.url);
const SELF = fileURLToPath(import.meta.url);
const ROOT = pathResolve(dirname(SELF), '../..');
const MARKER = '##SWEEP##';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const args = n => argv.reduce((a, v, i) => (v === `--${n}` ? [...a, argv[i + 1]] : a), []);
const flag = n => argv.includes(`--${n}`);
const MB = b => +(b / 1048576).toFixed(1);

// ===================================================================== WORKERS
// Both workers deep-require the CJS dist by absolute path: the package
// "exports" map does not expose documentInventory/runner.
function loadCore() {
  return {
    Document: require(`${ROOT}/packages/core/dist/document.js`).Document,
    DocumentInventory: require(`${ROOT}/packages/core/dist/documentInventory.js`).DocumentInventory,
    Runner: require(`${ROOT}/packages/core/dist/runner/runner.js`).Runner,
    Ruleset: require(`${ROOT}/packages/core/dist/ruleset/ruleset.js`).Ruleset,
    Parsers: require(`${ROOT}/packages/parsers/dist/index.js`),
    Resolver: require(`${ROOT}/packages/ref-resolver/dist/index.js`).Resolver,
  };
}

const emit = obj => process.stdout.write(`\n${MARKER}${JSON.stringify(obj)}\n`);

/** Pass A: the timed lint. */
async function workerLint() {
  const DOC = arg('doc');
  const RULESET_NAME = arg('ruleset', 'oas');
  const REPEAT = Number(arg('repeat', '1'));

  // --- hook 1: ajv compile counter. ajv/dist/ajv.js does `class Ajv extends
  // core_1.default` and never overrides compile(), so patching the core
  // prototype catches every instance the process makes.
  let ajvCompiles = 0;
  const NOHOOK = process.env.SWEEP_NO_HOOKS === '1';
  try {
    if (NOHOOK) throw new Error('hooks disabled');
    const ajvCore = require(`${ROOT}/node_modules/ajv/dist/core.js`);
    const proto = (ajvCore.default ?? ajvCore).prototype;
    const orig = proto.compile;
    proto.compile = function (...a) { ajvCompiles++; return orig.apply(this, a); };
  } catch (e) { /* counted as -1 below */ ajvCompiles = -1; }

  // --- hook 2: oasExample invocation counter. The ruleset object literal in
  // packages/rulesets/dist/oas/index.js captures functions_1.oasExample at
  // module-eval time, so the wrapper must be installed on the functions module
  // BEFORE the ruleset module is first required.
  let exampleNodes = 0;
  try {
    if (NOHOOK) throw new Error('hooks disabled');
    const fns = require(`${ROOT}/packages/rulesets/dist/oas/functions/index.js`);
    const orig = fns.oasExample;
    // A Proxy with only an `apply` trap: every own property, symbol and the
    // prototype of the createRulesetFunction-wrapped original stay reachable,
    // so ruleset option validation behaves identically.
    const wrapped = new Proxy(orig, {
      apply(t, thisArg, a) { exampleNodes++; return Reflect.apply(t, thisArg, a); },
    });
    Object.defineProperty(fns, 'oasExample', { value: wrapped, configurable: true, enumerable: true });
  } catch { exampleNodes = -1; }

  const { Document, DocumentInventory, Runner, Ruleset, Parsers, Resolver } = loadCore();
  const Rulesets = require(`${ROOT}/packages/rulesets/dist/index.js`);
  const def = RULESET_NAME === 'asyncapi' ? Rulesets.asyncapi : RULESET_NAME === 'arazzo' ? Rulesets.arazzo : Rulesets.oas;
  const ruleset = new Ruleset({ extends: [def] });

  const text = readFileSync(DOC, 'utf8');
  const runs = [];
  let out = null;

  for (let i = 0; i < REPEAT; i++) {
    ajvCompiles = Math.max(0, ajvCompiles); exampleNodes = Math.max(0, exampleNodes);
    const a0 = ajvCompiles, e0 = exampleNodes;
    const t0 = performance.now();

    const document = new Document(text, Parsers.Yaml, DOC);
    const t1 = performance.now();

    // Offline resolver: local $refs only. Deterministic, no network variance.
    const inventory = new DocumentInventory(document, new Resolver());
    await inventory.resolve();
    const t2 = performance.now();

    const runner = new Runner(inventory);
    if (document.formats === undefined) {
      const found = [...ruleset.formats].filter(f => f(inventory.resolved, document.source));
      document.formats = found.length ? new Set(found) : null;
    }
    const t3 = performance.now();

    // CPU vs wall for the lint phase. On a shared box these diverge when the
    // process is descheduled; a lintCpuRatio well under 1 means the wall time
    // is contention, not work, and the number should not be compared.
    const cpu0 = process.cpuUsage();
    await runner.run(ruleset);
    const cpu1 = process.cpuUsage(cpu0);
    const t4 = performance.now();

    const rawFindings = runner.results.length;
    const results = runner.getResults();
    const t5 = performance.now();

    runs.push({
      lintCpuUserMs: cpu1.user / 1000, lintCpuSysMs: cpu1.system / 1000,
      lintCpuRatio: +(((cpu1.user + cpu1.system) / 1000) / (t4 - t3)).toFixed(3),
      parseMs: t1 - t0, resolveMs: t2 - t1, formatsMs: t3 - t2,
      lintMs: t4 - t3, resultsMs: t5 - t4, totalMs: t5 - t0,
      ajvCompiles: ajvCompiles - a0, exampleNodes: exampleNodes - e0,
      findings: results.length, rawFindings,
      parserDiagnostics: document.diagnostics.length,
    });
    out = {
      formats: document.formats ? [...document.formats].map(f => f.displayName ?? f.name) : null,
      enabledRules: Object.values(ruleset.rules).filter(r => r.enabled).length,
    };
  }

  const med = k => {
    const s = runs.map(r => r[k]).sort((x, y) => x - y), h = s.length >> 1;
    return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
  };
  const keys = Object.keys(runs[0]);
  const median = Object.fromEntries(keys.map(k => [k, med(k)]));
  emit({ ok: true, ...out, ...median, runs: runs.length,
         peakRssMB: MB(process.resourceUsage().maxRSS * 1024) });
}

/** Pass B: parse + resolve + structural DFS. Untimed on purpose. */
async function workerStruct() {
  const DOC = arg('doc');
  const CAP = Number(arg('visit-cap', '80000000'));
  const { Document, DocumentInventory, Parsers, Resolver } = loadCore();
  const text = readFileSync(DOC, 'utf8');
  const document = new Document(text, Parsers.Yaml, DOC);
  const inventory = new DocumentInventory(document, new Resolver());
  await inventory.resolve();

  const isObj = v => typeof v === 'object' && v !== null;

  /**
   * Iterative DFS over an object graph.
   *  - `visits`   every time an object/array node is reached along any path
   *  - `distinct` distinct object identities
   *  - a node already on the current path is counted as a visit but not
   *    descended into, so genuine `$ref` cycles terminate
   *  - an explicit stack (not recursion) because a resolved graph can chain
   *    far deeper than the JS stack allows
   */
  function dfs(root, cap) {
    if (!isObj(root)) return { visits: 0, distinct: 0, capped: false, refs: 0 };
    let visits = 0, refs = 0, exampleKeys = 0, capped = false;
    const distinct = new Set(), onPath = new Set(), stack = [];
    const push = n => {
      visits++; distinct.add(n);
      if (onPath.has(n)) return;            // cycle: count, do not descend
      onPath.add(n);
      stack.push({ n, ks: Array.isArray(n) ? null : Object.keys(n), i: 0 });
    };
    push(root);
    while (stack.length) {
      if (visits >= cap) { capped = true; break; }
      const f = stack[stack.length - 1];
      const len = f.ks ? f.ks.length : f.n.length;
      if (f.i >= len) { onPath.delete(f.n); stack.pop(); continue; }
      const k = f.ks ? f.ks[f.i] : f.i;
      const v = f.n[k];
      f.i++;
      if (k === '$ref' && typeof v === 'string') refs++;
      if (k === 'example' || k === 'examples') exampleKeys++;
      if (isObj(v)) push(v);
    }
    return { visits, distinct: distinct.size, capped, refs, exampleKeys };
  }

  const un = dfs(document.data, CAP);
  const res = dfs(inventory.resolved, CAP);
  emit({ ok: true,
    unresolvedVisits: un.visits, unresolvedDistinct: un.distinct, refs: un.refs,
    exampleKeys: un.exampleKeys, resolvedExampleKeys: res.exampleKeys,
    resolvedVisits: res.visits, resolvedDistinct: res.distinct,
    capped: un.capped || res.capped,
    peakRssMB: MB(process.resourceUsage().maxRSS * 1024) });
}

if (flag('worker-lint')) { await workerLint(); process.exit(0); }
if (flag('worker-struct')) { await workerStruct(); process.exit(0); }

// ====================================================================== PARENT
if (flag('help')) {
  // The banner comment at the top of this file IS the manual.
  const doc = readFileSync(SELF, 'utf8');
  console.log(doc.slice(doc.indexOf('/**'), doc.indexOf('*/'))
    .split('\n').map(l => l.replace(/^\s*\/?\*+ ?/, '')).join('\n').trim());
  process.exit(0);
}
const DIR = pathResolve(process.cwd(), arg('dir', join(ROOT, 'corpora/real')));
const OUT = arg('out');
const MAX_MB = Number(arg('max-mb', '64'));
const MIN_MB = Number(arg('min-mb', '0'));
const ONLY = args('only');
const RULESET = arg('ruleset', 'oas');
const HEAP_MB = arg('heap-mb', '8192');
const TIMEOUT_S = Number(arg('timeout-s', '900'));
const REPEAT = arg('repeat', '1');
const STRUCTURE = !flag('no-structure');
const SORT = arg('sort', 'size');
const QUIET = flag('quiet');

function runChild(mode, doc, extra = []) {
  return new Promise(res => {
    const started = Date.now();
    const child = spawn(process.execPath, [
      `--max-old-space-size=${HEAP_MB}`, SELF, `--${mode}`, '--doc', doc, ...extra,
    ], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });

    let out = '', err = '', killed = false;
    const timer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, TIMEOUT_S * 1000);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d.slice(0, 4000); });
    child.on('error', e => { clearTimeout(timer); res({ ok: false, error: `spawn: ${e.message}` }); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const wallMs = Date.now() - started;
      const line = out.split('\n').find(l => l.startsWith(MARKER));
      if (line !== undefined) {
        try { return res({ ...JSON.parse(line.slice(MARKER.length)), wallMs }); } catch { /* fallthrough */ }
      }
      const tail = err.trim().split('\n').slice(-6).join(' | ').slice(0, 500);
      const oom = /heap out of memory|Allocation failed|OOM/i.test(err);
      res({ ok: false, wallMs,
        error: killed ? `TIMEOUT >${TIMEOUT_S}s` : oom ? 'OOM' : signal ? `signal ${signal}` : `exit ${code}`,
        stderr: tail });
    });
  });
}

let files = readdirSync(DIR)
  .filter(f => /\.(ya?ml|json)$/i.test(f))
  .map(f => ({ name: f, path: join(DIR, f), size: statSync(join(DIR, f)).size }));

const skipped = [];
if (ONLY.length) files = files.filter(f => ONLY.some(o => f.name.includes(o)));
files = files.filter(f => {
  if (f.size > MAX_MB * 1048576) { skipped.push({ ...f, reason: `>${MAX_MB}MB` }); return false; }
  if (f.size < MIN_MB * 1048576) { skipped.push({ ...f, reason: `<${MIN_MB}MB` }); return false; }
  return true;
});
files.sort((a, b) => a.size - b.size);

const meta = {
  dir: DIR, node: process.version, ruleset: RULESET, heapMB: HEAP_MB, repeat: Number(REPEAT),
  cpus: os.cpus().length, totalMemGB: +(os.totalmem() / 2 ** 30).toFixed(1),
  loadavgStart: os.loadavg().map(n => +n.toFixed(2)),
  startedAt: new Date().toISOString(), structure: STRUCTURE,
};
console.error(`sweep: ${files.length} documents (${skipped.length} skipped) from ${DIR}`);
console.error(`node ${meta.node} heap=${HEAP_MB}MB ruleset=${RULESET} repeat=${REPEAT} loadavg=${meta.loadavgStart.join(' ')}`);
console.error(`NOTE: shared machine -- treat absolute ms as indicative, ratios as real.\n`);

const rows = [];
for (let i = 0; i < files.length; i++) {
  const f = files[i];
  if (!QUIET) process.stderr.write(`[${String(i + 1).padStart(3)}/${files.length}] ${f.name} (${MB(f.size)}MB) ... `);
  const lint = await runChild('worker-lint', f.path, ['--ruleset', RULESET, '--repeat', REPEAT]);
  const struct = STRUCTURE ? await runChild('worker-struct', f.path) : { ok: false, error: 'skipped' };
  const row = {
    name: f.name, bytes: f.size, sizeMB: MB(f.size),
    ...(lint.ok ? lint : { lintError: lint.error, lintStderr: lint.stderr, lintWallMs: lint.wallMs }),
    ...(struct.ok
      ? { unresolvedVisits: struct.unresolvedVisits, unresolvedDistinct: struct.unresolvedDistinct,
          refs: struct.refs, exampleKeys: struct.exampleKeys, resolvedExampleKeys: struct.resolvedExampleKeys,
          resolvedVisits: struct.resolvedVisits, resolvedDistinct: struct.resolvedDistinct,
          structCapped: struct.capped, structPeakRssMB: struct.peakRssMB }
      : { structError: struct.error }),
  };
  if (row.refs !== undefined) row.refsPerKB = +(row.refs / (f.size / 1024)).toFixed(3);
  if (row.resolvedDistinct) row.redundancy = +(row.resolvedVisits / row.resolvedDistinct).toFixed(1);
  // Regime discriminator. A document whose lint cost is explained by graph
  // walking alone sits at the floor cost of one nimma visit; anything well
  // above it is paying for per-node work (schema prep / ajv) on top.
  if (row.resolvedVisits) row.usPerVisit = +((row.lintMs * 1000) / row.resolvedVisits).toFixed(2);
  if (row.resolvedVisits && row.exampleNodes !== undefined) {
    row.examplePerKVisit = +((row.exampleNodes * 1000) / row.resolvedVisits).toFixed(1);
  }
  if (row.rawFindings !== undefined) row.dropped = row.rawFindings - row.findings;
  rows.push(row);
  if (!QUIET) {
    process.stderr.write(lint.ok
      ? `lint ${lint.lintMs.toFixed(0)}ms rss ${lint.peakRssMB}MB findings ${lint.findings}\n`
      : `FAILED: ${lint.error}\n`);
  }
}
meta.loadavgEnd = os.loadavg().map(n => +n.toFixed(2));
meta.finishedAt = new Date().toISOString();

// ------------------------------------------------------------------- printing
const n = (v, d = 0) => (v === undefined || v === null ? '-' : Number(v).toFixed(d));
const k = v => (v === undefined || v === null ? '-' : Number(v).toLocaleString('en-US'));
const sorters = {
  name: (a, b) => a.name.localeCompare(b.name),
  size: (a, b) => b.bytes - a.bytes,
  lint: (a, b) => (b.lintMs ?? -1) - (a.lintMs ?? -1),
  rss: (a, b) => (b.peakRssMB ?? -1) - (a.peakRssMB ?? -1),
  density: (a, b) => (b.refsPerKB ?? -1) - (a.refsPerKB ?? -1),
};
const view = [...rows].sort(sorters[SORT] ?? sorters.size);

const COLS = [
  ['document', 42, r => r.name.length > 42 ? r.name.slice(0, 39) + '...' : r.name, 'l'],
  ['MB', 7, r => n(r.sizeMB, 1)],
  ['refs', 7, r => k(r.refs)],
  ['ref/KB', 7, r => n(r.refsPerKB, 2)],
  ['exKeys', 7, r => k(r.exampleKeys)],
  ['exCall', 9, r => k(r.exampleNodes)],
  ['parse', 7, r => n(r.parseMs)],
  ['resolv', 7, r => n(r.resolveMs)],
  ['lint', 8, r => n(r.lintMs)],
  ['ms/MB', 7, r => n(r.lintMs / r.sizeMB)],
  ['RSS', 7, r => n(r.peakRssMB)],
  ['find', 6, r => k(r.findings)],
  ['drop', 5, r => k(r.dropped)],
  ['ajv', 7, r => k(r.ajvCompiles)],
  ['visits', 11, r => k(r.resolvedVisits)],
  ['distinct', 10, r => k(r.resolvedDistinct)],
  ['redun', 6, r => (r.redundancy ? r.redundancy + 'x' : '-')],
  ['us/vis', 7, r => n(r.usPerVisit, 2)],
];
const line = cells => cells.join(' ');
console.log(line(COLS.map(([h, w, , al]) => (al === 'l' ? h.padEnd(w) : h.padStart(w)))));
console.log(line(COLS.map(([, w]) => '-'.repeat(w))));
for (const r of view) {
  if (r.lintError) {
    console.log(`${(r.name.length > 42 ? r.name.slice(0, 39) + '...' : r.name).padEnd(42)} ${n(r.sizeMB, 1).padStart(7)}  !! ${r.lintError}${r.lintStderr ? ' :: ' + r.lintStderr.slice(0, 120) : ''}`);
    continue;
  }
  console.log(line(COLS.map(([, w, fn, al]) => { let v; try { v = String(fn(r)); } catch { v = '-'; } return al === 'l' ? v.padEnd(w) : v.padStart(w); })));
}

const ok = rows.filter(r => !r.lintError);
const sum = key => ok.reduce((a, r) => a + (r[key] ?? 0), 0);
console.log(`\n${ok.length} ok, ${rows.filter(r => r.lintError).length} failed, ${skipped.length} skipped (cap ${MAX_MB}MB)`);
console.log(`totals: ${MB(sum('bytes'))}MB  lint ${(sum('lintMs') / 1000).toFixed(1)}s  resolve ${(sum('resolveMs') / 1000).toFixed(1)}s  parse ${(sum('parseMs') / 1000).toFixed(1)}s  findings ${sum('findings').toLocaleString()}  ajv ${sum('ajvCompiles').toLocaleString()}`);
console.log(`loadavg start ${meta.loadavgStart.join(' ')} -> end ${meta.loadavgEnd.join(' ')}`);
for (const s of skipped) console.log(`skipped: ${s.name} (${MB(s.size)}MB) ${s.reason}`);

if (OUT) { writeFileSync(OUT, JSON.stringify({ meta, rows, skipped }, null, 2)); console.log(`\nwrote ${OUT}`); }
