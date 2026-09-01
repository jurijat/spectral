#!/usr/bin/env node
/**
 * Throughput / latency load test for the Spectral library API.
 *
 * A "request" is one lint of one document through the library (NOT the CLI).
 * Documents are drawn round-robin from a corpus directory in sorted order, so a
 * given profile always issues the same request sequence.
 *
 * CONCURRENCY IS REAL. Spectral's run() is async but its work is almost entirely
 * synchronous CPU, so Promise-based "concurrency" in one process would interleave
 * at await points and parallelise nothing -- it would report a throughput gain
 * that does not exist. Each concurrent slot is therefore a worker_thread with its
 * own Spectral instance and its own heap.
 *
 *   node scripts/bench/loadtest.mjs --profile light --dir corpora/small
 *   node scripts/bench/loadtest.mjs --profile all --dir corpora/small --json out.json
 *
 * Profiles (requests x concurrency), each preceded by a 10-request warmup at
 * concurrency 5 whose results are discarded:
 *
 *   light    50 x 5
 *   medium  100 x 10
 *   heavy   200 x 20
 *   spike   200, split 50/50: 100 x 5 then 100 x 50   (a concurrency step, not a
 *                                                      document-size split)
 *   tp1k   1000 x 50
 *   tp5k   5000 x 50
 *   tp10k 10000 x 50
 *
 * Reports throughput and latency percentiles. On a shared machine, compare
 * RATIOS between two builds, not absolute numbers.
 *
 * CONCURRENCY IS CAPPED BY DOCUMENT SIZE. Peak RSS during a lint runs roughly
 * 40-60x the source bytes, so the requested concurrency is only safe for small
 * documents: 50 workers on a 25MB corpus would ask for ~75GB. The cap is derived
 * from the corpus's mean document size and --budget-gb (default 8), and the
 * effective concurrency is printed. Raise the budget deliberately, not by
 * accident.
 *
 *   node scripts/bench/loadtest.mjs --profile tp1k --dir corpora/bands/b100k
 *   node scripts/bench/loadtest.mjs --profile heavy --bands            # every band
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { dirname, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cpus, loadavg } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = pathResolve(HERE, '../..');

const PROFILES = {
  light: [{ requests: 50, concurrency: 5 }],
  medium: [{ requests: 100, concurrency: 10 }],
  heavy: [{ requests: 200, concurrency: 20 }],
  spike: [
    { requests: 100, concurrency: 5, label: 'base' },
    { requests: 100, concurrency: 50, label: 'spike' },
  ],
  tp1k: [{ requests: 1000, concurrency: 50 }],
  tp5k: [{ requests: 5000, concurrency: 50 }],
  tp10k: [{ requests: 10000, concurrency: 50 }],
};
const WARMUP = { requests: 10, concurrency: 5 };

// ---------------------------------------------------------------- worker side
if (!isMainThread) {
  const { root } = workerData;
  const { Spectral, Document } = await import(`${root}/packages/core/dist/index.js`);
  const Parsers = await import(`${root}/packages/parsers/dist/index.js`);
  const mod = await import(`${root}/packages/rulesets/dist/oas/index.js`);
  const { readFileSync } = await import('node:fs');

  // One Spectral per worker, reused across requests -- the way a long-lived
  // library consumer would use it.
  const spectral = new Spectral();
  spectral.setRuleset(mod.default?.default ?? mod.default);

  parentPort.on('message', async msg => {
    if (msg.type === 'stop') {
      parentPort.postMessage({ type: 'bye', rss: process.memoryUsage().rss });
      process.exit(0);
    }
    const started = performance.now();
    let findings = 0;
    let error = null;
    try {
      const src = readFileSync(msg.file, 'utf8');
      findings = (await spectral.run(new Document(src, Parsers.Yaml, msg.file))).length;
    } catch (e) {
      error = e instanceof Error ? e.message.slice(0, 120) : String(e).slice(0, 120);
    }
    parentPort.postMessage({
      type: 'done',
      id: msg.id,
      ms: performance.now() - started,
      findings,
      error,
      warmup: msg.warmup === true,
    });
  });
  parentPort.postMessage({ type: 'ready' });
}

// ------------------------------------------------------------------ main side
if (isMainThread) {
  const argv = process.argv.slice(2);
  const arg = (n, d) => {
    const i = argv.indexOf(`--${n}`);
    return i === -1 ? d : argv[i + 1];
  };
  const BUDGET_GB = Number(arg('budget-gb', 8));
  // Request counts are calibrated for small documents. tp10k over a 25MB band is
  // days of work, so --scale divides every stage's request count (warmup aside)
  // and the pre-flight estimate below refuses to start a stage silently.
  const SCALE = Number(arg('scale', 1));
  const MAX_STAGE_S = Number(arg('max-stage-s', 0)); // 0 = no limit, just warn
  const RSS_PER_BYTE = 60; // measured: lint peak RSS is ~40-60x source size
  const DIR = pathResolve(ROOT, arg('dir', 'corpora/small'));
  const WANT = arg('profile', 'light');
  const JSON_OUT = arg('json');
  const names = WANT === 'all' ? Object.keys(PROFILES) : WANT.split(',');
  for (const n of names) {
    if (!(n in PROFILES)) {
      console.error(`unknown profile "${n}" -- have: ${Object.keys(PROFILES).join(', ')}, or all`);
      process.exit(2);
    }
  }

  // --bands: run the same profile against every corpora/bands/* directory and
  // print one comparison table, so a size effect is visible rather than averaged away.
  if (argv.includes('--bands')) {
    const base = pathResolve(ROOT, 'corpora/bands');
    const dirs = readdirSync(base).sort();
    const self = fileURLToPath(import.meta.url);
    const { spawnSync } = await import('node:child_process');
    const collected = [];
    for (const d of dirs) {
      const tmp = `/tmp/loadtest-${d}.json`;
      const r = spawnSync(
        process.execPath,
        [self, '--profile', WANT, '--dir', `${base}/${d}`, '--json', tmp, '--budget-gb', String(BUDGET_GB)],
        { stdio: ['ignore', 'inherit', 'inherit'] },
      );
      if (r.status !== 0) {
        console.error(`band ${d} failed`);
        continue;
      }
      const j = JSON.parse(readFileSync(tmp, 'utf8'));
      for (const [p, stages] of Object.entries(j.profiles))
        for (const st of stages) collected.push({ band: d, profile: p, ...st });
    }
    const H = ['band', 'profile', 'stage', 'req', 'conc', 'wall ms', 'req/s', 'p50', 'p95', 'p99', 'err', 'rssMB'];
    const rows = collected.map(c =>
      [c.band, c.profile, c.stage, c.requests, c.concurrency, c.wallMs, c.rps, c.p50, c.p95, c.p99, c.errors, c.peakWorkerRssMB].map(String),
    );
    const w = H.map((h, i) => Math.max(h.length, ...rows.map(r => r[i].length)));
    console.log('\n=== ALL BANDS ===');
    console.log(H.map((h, i) => h.padStart(w[i])).join('  '));
    console.log(w.map(n => '-'.repeat(n)).join('  '));
    for (const r of rows) console.log(r.map((c, i) => c.padStart(w[i])).join('  '));
    if (JSON_OUT !== undefined) writeFileSync(JSON_OUT, JSON.stringify(collected, null, 1));
    process.exit(0);
  }

  const corpus = readdirSync(DIR)
    .filter(f => /\.(ya?ml|json)$/i.test(f))
    .sort()
    .map(f => `${DIR}/${f}`);
  if (corpus.length === 0) {
    console.error(`no documents in ${DIR}`);
    process.exit(2);
  }

  const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];

  async function runStage({ requests, concurrency }, startIndex, warmup, cap) {
    concurrency = Math.max(1, Math.min(concurrency, cap));
    const workers = [];
    const ready = [];
    for (let i = 0; i < concurrency; i++) {
      const w = new Worker(fileURLToPath(import.meta.url), { workerData: { root: ROOT } });
      workers.push(w);
      ready.push(new Promise(res => w.once('message', m => (m.type === 'ready' ? res() : null))));
    }
    await Promise.all(ready);

    const lat = [];
    let issued = 0;
    let completed = 0;
    let errors = 0;
    let findings = 0;
    let peakWorkerRss = 0;

    const t0 = performance.now();
    await new Promise(resolve => {
      const pump = w => {
        if (issued >= requests) return;
        const file = corpus[(startIndex + issued) % corpus.length];
        w.postMessage({ type: 'lint', id: issued++, file, warmup });
      };
      for (const w of workers) {
        w.on('message', m => {
          if (m.type !== 'done') return;
          completed++;
          lat.push(m.ms);
          findings += m.findings;
          if (m.error !== null) errors++;
          if (completed === requests) return resolve();
          pump(w);
        });
      }
      for (const w of workers) pump(w);
    });
    const wall = performance.now() - t0;

    await Promise.all(
      workers.map(
        w =>
          new Promise(res => {
            w.once('message', m => {
              if (m.type === 'bye' && m.rss > peakWorkerRss) peakWorkerRss = m.rss;
              res();
            });
            w.postMessage({ type: 'stop' });
          }),
      ),
    );
    for (const w of workers) await w.terminate().catch(() => {});

    lat.sort((a, b) => a - b);
    return {
      requests,
      concurrency, // effective, after the size cap

      wallMs: +wall.toFixed(0),
      rps: +((requests / wall) * 1000).toFixed(1),
      p50: +pct(lat, 50).toFixed(1),
      p90: +pct(lat, 90).toFixed(1),
      p95: +pct(lat, 95).toFixed(1),
      p99: +pct(lat, 99).toFixed(1),
      max: +lat[lat.length - 1].toFixed(1),
      errors,
      findings,
      peakWorkerRssMB: +(peakWorkerRss / 1048576).toFixed(0),
    };
  }

  const meanBytes = corpus.reduce((a, f) => a + statSync(f).size, 0) / corpus.length;
  const cap = Math.max(1, Math.floor((BUDGET_GB * 1024 ** 3) / (meanBytes * RSS_PER_BYTE)));
  console.log(`corpus ${DIR} (${corpus.length} docs, mean ${(meanBytes / 1048576).toFixed(2)}MB) | ${cpus().length} cpus | load ${loadavg()[0].toFixed(2)}`);
  console.log(`concurrency cap ${cap} (from --budget-gb ${BUDGET_GB} at ~${RSS_PER_BYTE}x source size)`);
  console.log('a "request" = one library lint of one document; each concurrent slot is a worker_thread\n');

  const out = {};
  let cursor = 0;
  for (const name of names) {
    process.stderr.write(`[${name}] warmup ${WARMUP.requests}x${WARMUP.concurrency} ... `);
    const warm = await runStage(WARMUP, cursor, true, cap);
    cursor += WARMUP.requests;
    process.stderr.write(`done (p50 ${warm.p50}ms)\n`);

    out[name] = [];
    for (const raw of PROFILES[name]) {
      const stage = { ...raw, requests: Math.max(1, Math.round(raw.requests / SCALE)) };
      const conc = Math.min(stage.concurrency, cap);
      // Estimate from the warmup's median latency, which is measured on this
      // corpus with this build -- not a guess.
      const estS = (stage.requests * warm.p50) / conc / 1000;
      const label = `${name}${stage.label ? ':' + stage.label : ''}`;
      if (MAX_STAGE_S > 0 && estS > MAX_STAGE_S) {
        process.stderr.write(`[${label}] SKIPPED: estimated ${estS.toFixed(0)}s exceeds --max-stage-s ${MAX_STAGE_S}\n`);
        continue;
      }
      if (estS > 120) process.stderr.write(`[${label}] note: estimated ~${estS.toFixed(0)}s\n`);
      process.stderr.write(`[${label}] ${stage.requests}x${conc} ... `);
      const r = await runStage(stage, cursor, false, cap);
      cursor += stage.requests;
      out[name].push({ stage: stage.label ?? name, ...r });
      process.stderr.write(`${r.wallMs}ms ${r.rps} rps\n`);
    }
  }

  const H = ['profile', 'stage', 'req', 'conc', 'wall ms', 'req/s', 'p50', 'p90', 'p95', 'p99', 'max', 'err', 'rssMB'];
  const rows = [];
  for (const [name, stages] of Object.entries(out))
    for (const s of stages)
      rows.push([name, s.stage, s.requests, s.concurrency, s.wallMs, s.rps, s.p50, s.p90, s.p95, s.p99, s.max, s.errors, s.peakWorkerRssMB].map(String));
  const w = H.map((h, i) => Math.max(h.length, ...rows.map(r => r[i].length)));
  console.log('\n' + H.map((h, i) => h.padStart(w[i])).join('  '));
  console.log(w.map(n => '-'.repeat(n)).join('  '));
  for (const r of rows) console.log(r.map((c, i) => c.padStart(w[i])).join('  '));

  if (JSON_OUT !== undefined) {
    writeFileSync(JSON_OUT, JSON.stringify({ dir: DIR, cpus: cpus().length, profiles: out }, null, 1));
    console.log(`\nwrote ${JSON_OUT}`);
  }
}
