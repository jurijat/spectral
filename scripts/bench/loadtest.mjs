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
 * Profiles (requests x concurrency). Each measured stage warms the same worker
 * pool first, with at least 10 requests and at least one request per worker;
 * warmup results are discarded and resolver caches are cleared before timing.
 *
 *   light    50 x 5
 *   medium  100 x 10
 *   heavy   200 x 20
 *   spike   200, split 50/50: 100 x 5 then 100 x 50   (a concurrency step, not a
 *                                                      document-size split)
 *   tp1k   1000 x 50
 *   tp5k   5000 x 50
 *   tp10k 10000 x 50
 *   retention 400 x 1 (pair with --distinct and compare --cache shared/per-run)
 *
 * Reports throughput and latency percentiles. On a shared machine, compare
 * RATIOS between two builds, not absolute numbers.
 *
 * CONCURRENCY IS CAPPED BY DOCUMENT SIZE. Peak RSS during a lint runs roughly
 * 40-60x the source bytes, so the requested concurrency is only safe for small
 * documents: 50 workers on a 25MB corpus would ask for ~75GB. The cap is derived
 * from the corpus's largest document and --budget-gb (default 8), and the
 * effective concurrency is printed. Raise the budget deliberately, not by
 * accident.
 *
 *   node scripts/bench/loadtest.mjs --profile tp1k --dir corpora/bands/b100k
 *   node scripts/bench/loadtest.mjs --profile heavy --bands            # every band
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { dirname, join, resolve as pathResolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { arch, cpus, loadavg, release, tmpdir, totalmem } from 'node:os';
import { assertExecutableProvenanceUnchanged, collectProvenance, sha256 } from './provenance.mjs';

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
  retention: [{ requests: 400, concurrency: 1 }],
};
const MIN_WARMUP_REQUESTS = 10;

// ---------------------------------------------------------------- worker side
if (!isMainThread) {
  const { root, cachePolicy, allowRemote } = workerData;
  const { Spectral, Document } = await import(pathToFileURL(join(root, 'packages/core/dist/index.js')).href);
  const Parsers = await import(pathToFileURL(join(root, 'packages/parsers/dist/index.js')).href);
  const mod = await import(pathToFileURL(join(root, 'packages/rulesets/dist/oas/index.js')).href);
  const { Resolver, createHttpAndFileResolver } = await import(
    pathToFileURL(join(root, 'packages/ref-resolver/dist/index.js')).href
  );
  const { readFileSync } = await import('node:fs');

  // One Spectral per worker, reused across requests -- the way a long-lived
  // library consumer would use it.
  const spectral = new Spectral({ resolver: allowRemote ? createHttpAndFileResolver() : new Resolver() });
  spectral.setRuleset(mod.default?.default ?? mod.default);

  parentPort.on('message', async msg => {
    if (msg.type === 'stop') {
      parentPort.postMessage({ type: 'bye', rss: process.memoryUsage().rss });
      process.exit(0);
    }
    if (msg.type === 'clear') {
      spectral.clearCache();
      parentPort.postMessage({ type: 'cleared' });
      return;
    }
    const started = performance.now();
    let findings = 0;
    let error = null;
    try {
      const src = readFileSync(msg.file, 'utf8');
      findings = (await spectral.run(new Document(src, Parsers.Yaml, msg.file))).length;
    } catch (e) {
      error = e instanceof Error ? e.message.slice(0, 120) : String(e).slice(0, 120);
    } finally {
      // Warmup must exercise identical resolver behavior for both measured
      // policies; otherwise shared-cache workers arrive at the measurement
      // with different cache-hit and retention history from per-run workers.
      if (msg.warmup === true || cachePolicy === 'per-run') spectral.clearCache();
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
  const CACHE_POLICY = arg('cache', 'shared');
  const DISTINCT = argv.includes('--distinct');
  const ALLOW_REMOTE = argv.includes('--allow-remote');
  if (!Number.isFinite(BUDGET_GB) || BUDGET_GB <= 0) {
    console.error('--budget-gb must be a positive number');
    process.exit(2);
  }
  if (!Number.isFinite(SCALE) || SCALE <= 0) {
    console.error('--scale must be a positive number');
    process.exit(2);
  }
  if (!Number.isFinite(MAX_STAGE_S) || MAX_STAGE_S < 0) {
    console.error('--max-stage-s must be a non-negative number');
    process.exit(2);
  }
  const hasHeapLimit = value =>
    value === '--max-old-space-size' ||
    value === '--max_old_space_size' ||
    /^--max[-_]old[-_]space[-_]size=/.test(value);
  if (
    process.execArgv.some(hasHeapLimit) ||
    /(?:^|\s)--max[-_]old[-_]space[-_]size(?:=|\s|$)/.test(process.env.NODE_OPTIONS ?? '')
  ) {
    console.error(
      'loadtest manages worker heap limits from --budget-gb; remove --max-old-space-size from Node flags and NODE_OPTIONS',
    );
    process.exit(2);
  }
  if (ALLOW_REMOTE && MAX_STAGE_S === 0) {
    console.error('--allow-remote requires a positive --max-stage-s so stalled I/O cannot hang the load test');
    process.exit(2);
  }
  if (CACHE_POLICY !== 'shared' && CACHE_POLICY !== 'per-run') {
    console.error('--cache must be shared or per-run');
    process.exit(2);
  }
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
    const dirs = readdirSync(base, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort();
    const self = fileURLToPath(import.meta.url);
    const { spawnSync } = await import('node:child_process');
    const collected = [];
    const bands = [];
    const failures = [];
    const provenance = collectProvenance(ROOT);
    const temp = mkdtempSync(join(tmpdir(), 'spectral-loadtest-'));
    try {
      for (const d of dirs) {
        const tmp = join(temp, `${d}.json`);
        const r = spawnSync(
          process.execPath,
          [
            ...process.execArgv,
            self,
            '--profile',
            WANT,
            '--dir',
            `${base}/${d}`,
            '--json',
            tmp,
            '--budget-gb',
            String(BUDGET_GB),
            '--cache',
            CACHE_POLICY,
            '--scale',
            String(SCALE),
            '--max-stage-s',
            String(MAX_STAGE_S),
            ...(DISTINCT ? ['--distinct'] : []),
            ...(ALLOW_REMOTE ? ['--allow-remote'] : []),
          ],
          { stdio: ['ignore', 'inherit', 'inherit'] },
        );
        if (r.status !== 0) {
          console.error(`band ${d} failed`);
          failures.push({ band: d, status: r.status, signal: r.signal });
          continue;
        }
        const result = JSON.parse(readFileSync(tmp, 'utf8'));
        assertExecutableProvenanceUnchanged(provenance, result.provenance, `load-test band ${d}`);
        bands.push({ band: d, ...result });
        for (const [profile, stages] of Object.entries(result.profiles)) {
          for (const stage of stages) collected.push({ band: d, profile, ...stage });
        }
      }
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
    assertExecutableProvenanceUnchanged(provenance, collectProvenance(ROOT), 'load-test bands');
    const H = [
      'band',
      'profile',
      'stage',
      'req',
      'conc',
      'wall ms',
      'req/s',
      'p50',
      'p95',
      'p99',
      'err',
      'final RSS MB',
    ];
    const rows = collected.map(c =>
      [
        c.band,
        c.profile,
        c.stage,
        c.requests,
        c.concurrency,
        c.wallMs,
        c.rps,
        c.p50,
        c.p95,
        c.p99,
        c.errors,
        c.finalRssMB,
      ].map(String),
    );
    const w = H.map((h, i) => Math.max(h.length, ...rows.map(r => r[i].length)));
    console.log('\n=== ALL BANDS ===');
    console.log(H.map((h, i) => h.padStart(w[i])).join('  '));
    console.log(w.map(n => '-'.repeat(n)).join('  '));
    for (const r of rows) console.log(r.map((c, i) => c.padStart(w[i])).join('  '));
    if (JSON_OUT !== undefined) {
      writeFileSync(
        JSON_OUT,
        JSON.stringify(
          {
            mode: 'bands',
            profile: WANT,
            cachePolicy: CACHE_POLICY,
            distinct: DISTINCT,
            allowRemote: ALLOW_REMOTE,
            provenance,
            bands,
            rows: collected,
            failures,
          },
          null,
          1,
        ),
      );
    }
    process.exit(failures.length === 0 ? 0 : 1);
  }

  const corpus = readdirSync(DIR, { withFileTypes: true })
    .filter(entry => entry.isFile() && /\.(ya?ml|json)$/i.test(entry.name))
    .map(entry => entry.name)
    .sort()
    .map(file => `${DIR}/${file}`);
  if (corpus.length === 0) {
    console.error(`no documents in ${DIR}`);
    process.exit(2);
  }

  const provenance = {
    ...collectProvenance(ROOT),
    platform: `${process.platform} ${release()} ${arch()}`,
    cpu: cpus()[0]?.model ?? null,
    cpuCount: cpus().length,
    totalMemoryMB: +(totalmem() / 1048576).toFixed(1),
    documents: corpus.map(file => {
      const contents = readFileSync(file);
      return { file, bytes: contents.byteLength, sha256: sha256(contents) };
    }),
  };
  const verifyCorpusUnchanged = () => {
    for (const document of provenance.documents) {
      if (sha256(readFileSync(document.file)) !== document.sha256) {
        throw new Error(`corpus document changed during load test: ${document.file}`);
      }
    }
  };
  verifyCorpusUnchanged();

  const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];

  async function runStage({ requests, concurrency }, startIndex, cap, label) {
    concurrency = Math.max(1, Math.min(concurrency, cap, requests));
    const workers = [];
    const exitedWorkers = new Set();
    const ready = [];
    try {
      for (let i = 0; i < concurrency; i++) {
        // Without an explicit limit a worker gets a default old-space far below what
        // a multi-MB lint needs, and dies with ERR_WORKER_OUT_OF_MEMORY. Give each
        // worker an equal share of the budget instead.
        const w = new Worker(fileURLToPath(import.meta.url), {
          workerData: { root: ROOT, cachePolicy: CACHE_POLICY, allowRemote: ALLOW_REMOTE },
          resourceLimits: { maxOldGenerationSizeMb: Math.max(512, Math.floor((BUDGET_GB * 1024) / concurrency)) },
        });
        w.on('error', e => {
          process.stderr.write(`\n  worker error: ${e.message.slice(0, 120)}\n`);
        });
        w.once('exit', () => exitedWorkers.add(w));
        workers.push(w);
        ready.push(
          new Promise((resolve, reject) => {
            const cleanup = () => {
              w.off('message', onMessage);
              w.off('error', onError);
              w.off('exit', onExit);
            };
            const onMessage = m => {
              if (m.type !== 'ready') return;
              cleanup();
              resolve();
            };
            const onError = error => {
              cleanup();
              reject(error);
            };
            const onExit = code => {
              cleanup();
              reject(new Error(`load-test worker exited before ready with code ${code}`));
            };
            w.on('message', onMessage);
            w.once('error', onError);
            w.once('exit', onExit);
          }),
        );
      }
    } catch (error) {
      await Promise.all(workers.map(w => w.terminate().catch(() => {})));
      await Promise.allSettled(ready);
      throw error;
    }

    const runBatch = (batchRequests, batchStartIndex, warmup, distinct) => {
      if (distinct && batchStartIndex + batchRequests > corpus.length) {
        return Promise.reject(
          new Error(
            `distinct batch needs documents through index ${batchStartIndex + batchRequests - 1}, corpus has ${corpus.length}`,
          ),
        );
      }
      const lat = [];
      let issued = 0;
      let completed = 0;
      let errors = 0;
      const errorMessages = new Set();
      let findings = 0;
      const t0 = performance.now();

      return new Promise((resolve, reject) => {
        let settled = false;
        let timer;
        const cleanup = () => {
          clearTimeout(timer);
          for (const w of workers) {
            w.off('message', onMessage);
            w.off('error', onError);
            w.off('exit', onExit);
          }
        };
        const finish = result => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(result);
        };
        const fail = error => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        };
        const pump = w => {
          if (issued >= batchRequests) return;
          const file = corpus[distinct ? batchStartIndex + issued : (batchStartIndex + issued) % corpus.length];
          w.postMessage({ type: 'lint', id: issued++, file, warmup });
        };
        const onMessage = function (m) {
          if (m.type !== 'done') return;
          completed++;
          lat.push(m.ms);
          findings += m.findings;
          if (m.error !== null) {
            errors++;
            if (errorMessages.size < 3) errorMessages.add(m.error);
          }
          if (completed === batchRequests) {
            lat.sort((a, b) => a - b);
            finish({ lat, errors, errorMessages: [...errorMessages], findings, wall: performance.now() - t0 });
          } else {
            pump(this);
          }
        };
        const onError = error => fail(error);
        const onExit = code => {
          fail(new Error(`load-test worker exited during a batch with code ${code}`));
        };

        if (MAX_STAGE_S > 0) {
          timer = setTimeout(
            () => fail(new Error(`${warmup ? 'warmup' : 'measured'} batch exceeded --max-stage-s ${MAX_STAGE_S}`)),
            MAX_STAGE_S * 1000,
          );
        }

        for (const w of workers) {
          w.on('message', onMessage);
          w.once('error', onError);
          w.once('exit', onExit);
          pump(w);
        }
      });
    };

    const clearWorker = w =>
      new Promise((resolve, reject) => {
        if (exitedWorkers.has(w)) {
          reject(new Error('load-test worker exited before its cache could be cleared'));
          return;
        }
        const cleanup = () => {
          w.off('message', onMessage);
          w.off('error', onError);
          w.off('exit', onExit);
        };
        const onMessage = m => {
          if (m.type !== 'cleared') return;
          cleanup();
          resolve();
        };
        const onError = error => {
          cleanup();
          reject(error);
        };
        const onExit = code => {
          cleanup();
          reject(new Error(`load-test worker exited while clearing its cache with code ${code}`));
        };
        w.on('message', onMessage);
        w.once('error', onError);
        w.once('exit', onExit);
        w.postMessage({ type: 'clear' });
      });

    const stopWorker = w =>
      new Promise(resolve => {
        if (exitedWorkers.has(w)) {
          resolve(0);
          return;
        }
        let timer;
        const cleanup = () => {
          clearTimeout(timer);
          w.off('message', onMessage);
          w.off('error', onError);
          w.off('exit', onExit);
        };
        const finish = rss => {
          cleanup();
          resolve(rss);
        };
        const onMessage = m => {
          if (m.type === 'bye') finish(m.rss);
        };
        const onError = () => finish(0);
        const onExit = () => finish(0);
        w.on('message', onMessage);
        w.once('error', onError);
        w.once('exit', onExit);
        timer = setTimeout(() => {
          w.terminate()
            .catch(() => {})
            .finally(() => finish(0));
        }, 5000);
        try {
          w.postMessage({ type: 'stop' });
        } catch {
          finish(0);
        }
      });

    let measured = null;
    let finalRss = 0;
    let warmupRequests = 0;
    let warmupP50 = 0;
    try {
      await Promise.all(ready);
      warmupRequests = Math.max(MIN_WARMUP_REQUESTS, concurrency);
      process.stderr.write(`[${label}] warmup ${warmupRequests}x${concurrency} ... `);
      const warm = await runBatch(warmupRequests, startIndex, true, false);
      if (warm.errors > 0) {
        throw new Error(`warmup had ${warm.errors} failed request(s): ${warm.errorMessages.join('; ')}`);
      }
      warmupP50 = pct(warm.lat, 50);
      process.stderr.write(`done (p50 ${warmupP50.toFixed(1)}ms)\n`);

      // A shared resolver cache would otherwise make the first measured files
      // warm only in shared mode. Keep JIT/module warmup while resetting document
      // retention so cache-policy comparisons start from the same state.
      await Promise.all(workers.map(clearWorker));

      const estS = (requests * warmupP50) / concurrency / 1000;
      if (MAX_STAGE_S > 0 && estS > MAX_STAGE_S) {
        process.stderr.write(
          `[${label}] SKIPPED: estimated ${estS.toFixed(0)}s exceeds --max-stage-s ${MAX_STAGE_S}\n`,
        );
      } else {
        if (estS > 120) process.stderr.write(`[${label}] note: estimated ~${estS.toFixed(0)}s\n`);
        process.stderr.write(`[${label}] ${requests}x${concurrency} ... `);
        measured = await runBatch(requests, startIndex, false, DISTINCT);
      }
    } finally {
      const rssValues = await Promise.all(workers.map(stopWorker));
      // process.memoryUsage().rss is process-wide for worker_threads. These
      // samples are retained/final RSS, not intra-request peaks or per-worker RSS.
      finalRss = Math.max(0, ...rssValues);
      for (const w of workers) await w.terminate().catch(() => {});
    }

    if (measured === null) return null;
    return {
      requests,
      concurrency, // effective, after the size cap
      warmupRequests,
      warmupP50: +warmupP50.toFixed(1),
      wallMs: +measured.wall.toFixed(0),
      rps: +((requests / measured.wall) * 1000).toFixed(1),
      p50: +pct(measured.lat, 50).toFixed(1),
      p90: +pct(measured.lat, 90).toFixed(1),
      p95: +pct(measured.lat, 95).toFixed(1),
      p99: +pct(measured.lat, 99).toFixed(1),
      max: +measured.lat[measured.lat.length - 1].toFixed(1),
      errors: measured.errors,
      errorMessages: measured.errorMessages,
      findings: measured.findings,
      finalRssMB: +(finalRss / 1048576).toFixed(0),
    };
  }

  const meanBytes = provenance.documents.reduce((sum, document) => sum + document.bytes, 0) / corpus.length;
  const maxBytes = Math.max(...provenance.documents.map(document => document.bytes));
  const cap = Math.max(1, Math.floor((BUDGET_GB * 1024 ** 3) / (Math.max(1, maxBytes) * RSS_PER_BYTE)));
  console.log(
    `corpus ${DIR} (${corpus.length} docs, mean ${(meanBytes / 1048576).toFixed(2)}MB) | ${cpus().length} cpus | load ${loadavg()[0].toFixed(2)}`,
  );
  console.log(
    `concurrency cap ${cap} (from --budget-gb ${BUDGET_GB}, max ${(maxBytes / 1048576).toFixed(2)}MB at ~${RSS_PER_BYTE}x)`,
  );
  console.log(`resolver cache ${CACHE_POLICY}${DISTINCT ? ' | distinct documents required' : ''}`);
  console.log(`resolver I/O ${ALLOW_REMOTE ? 'http+file (explicitly enabled)' : 'offline (local $refs only)'}`);
  console.log('a "request" = one library lint of one document; each concurrent slot is a worker_thread\n');

  const out = {};
  let cursor = 0;
  for (const name of names) {
    out[name] = [];
    for (const raw of PROFILES[name]) {
      const stage = { ...raw, requests: Math.max(1, Math.round(raw.requests / SCALE)) };
      if (DISTINCT && cursor + stage.requests > corpus.length) {
        process.stderr.write(
          `[${name}] SKIPPED: --distinct needs ${cursor + stage.requests} cumulative documents, corpus has ${corpus.length}\n`,
        );
        continue;
      }
      const conc = Math.min(stage.concurrency, cap);
      const label = `${name}${stage.label ? ':' + stage.label : ''}`;
      let r;
      try {
        r = await runStage(stage, cursor, cap, label);
      } finally {
        verifyCorpusUnchanged();
      }
      if (r === null) continue;
      cursor += stage.requests;
      out[name].push({ stage: stage.label ?? name, ...r });
      process.stderr.write(`${r.wallMs}ms ${r.rps} rps\n`);
    }
  }
  verifyCorpusUnchanged();
  assertExecutableProvenanceUnchanged(provenance, collectProvenance(ROOT), 'load test');

  const H = [
    'profile',
    'stage',
    'req',
    'conc',
    'wall ms',
    'req/s',
    'p50',
    'p90',
    'p95',
    'p99',
    'max',
    'err',
    'final RSS MB',
  ];
  const rows = [];
  for (const [name, stages] of Object.entries(out))
    for (const s of stages)
      rows.push(
        [
          name,
          s.stage,
          s.requests,
          s.concurrency,
          s.wallMs,
          s.rps,
          s.p50,
          s.p90,
          s.p95,
          s.p99,
          s.max,
          s.errors,
          s.finalRssMB,
        ].map(String),
      );
  const w = H.map((h, i) => Math.max(h.length, ...rows.map(r => r[i].length)));
  console.log('\n' + H.map((h, i) => h.padStart(w[i])).join('  '));
  console.log(w.map(n => '-'.repeat(n)).join('  '));
  for (const r of rows) console.log(r.map((c, i) => c.padStart(w[i])).join('  '));
  if (rows.length === 0) {
    console.error('\nno measured stages completed');
    process.exitCode = 1;
  }
  const requestErrors = Object.values(out)
    .flat()
    .reduce((sum, stage) => sum + stage.errors, 0);
  if (requestErrors > 0) {
    console.error(`\n${requestErrors} measured request(s) failed`);
    process.exitCode = 1;
  }

  if (JSON_OUT !== undefined) {
    writeFileSync(
      JSON_OUT,
      JSON.stringify(
        {
          dir: DIR,
          cpus: cpus().length,
          cachePolicy: CACHE_POLICY,
          distinct: DISTINCT,
          allowRemote: ALLOW_REMOTE,
          provenance,
          profiles: out,
        },
        null,
        1,
      ),
    );
    console.log(`\nwrote ${JSON_OUT}`);
  }
}
