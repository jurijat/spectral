#!/usr/bin/env node
/**
 * Fetch real-world OpenAPI documents from APIs.guru for benchmarking.
 *
 * Synthetic corpora repeatedly proved blind: the first had zero findings, the
 * second zero schema violations, and all of them have a uniform $ref shape that
 * no real document has. Real specs are the only honest calibration.
 *
 *   node scripts/bench/fetch-corpora.mjs --index          # size every spec (cached)
 *   node scripts/bench/fetch-corpora.mjs --plan           # show what --download would take
 *   node scripts/bench/fetch-corpora.mjs --download       # fetch the selected set
 *   node scripts/bench/fetch-corpora.mjs --bands          # stratified set, one dir per size band
 *
 * Selection is deterministic (sorted by size, then name), so the same flags
 * always produce the same corpus. Nothing here is committed -- corpora/ is
 * gitignored; the index is small enough to keep.
 *
 * Flags: --top N  --min-kb N  --max-mb N  --concurrency N  --out DIR --refresh
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { basename, dirname, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = pathResolve(dirname(SELF), '../..');
const argv = process.argv.slice(2);
const has = n => argv.includes(`--${n}`);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i === -1 ? d : argv[i + 1];
};

const LIST_URL = 'https://api.apis.guru/v2/list.json';
const INDEX = pathResolve(ROOT, 'scripts/bench/apis-guru-index.json');
const OUT = pathResolve(ROOT, arg('out', 'corpora/real'));
const CONCURRENCY = Number(arg('concurrency', 16));
const TOP = Number(arg('top', 40));
const PER_BAND = Number(arg('per-band', 40));
const MIN_KB = Number(arg('min-kb', 0));
const MAX_MB = Number(arg('max-mb', Infinity));
const REFRESH = has('refresh');
const UA = 'spectral-perf-bench (+https://github.com/stoplightio/spectral) node-fetch';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const CORPUS_FILE = /\.(ya?ml|json)$/i;

const normaliseExpectedFiles = files => {
  const expected = new Set();
  for (const file of files) {
    if (/[\\/]/.test(file) || basename(file) !== file || !CORPUS_FILE.test(file)) {
      throw new Error(`invalid corpus filename: ${file}`);
    }
    if (expected.has(file)) {
      throw new Error(`duplicate corpus filename after sanitising document ids: ${file}`);
    }
    expected.add(file);
  }
  return expected;
};

const listCorpusFiles = dir => {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter(entry => CORPUS_FILE.test(entry.name))
    .map(entry => {
      if (!entry.isFile()) {
        throw new Error(`corpus entry must be a regular file: ${pathResolve(dir, entry.name)}`);
      }
      return entry.name;
    })
    .sort();
};

export function readManifest(dir) {
  const file = pathResolve(dir, 'SHA256SUMS');
  if (!existsSync(file)) return new Map();

  const manifest = new Map();
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line === '') continue;
    const match = /^([a-f\d]{64})  (.+)$/i.exec(line);
    if (match === null || /[\\/]/.test(match[2]) || basename(match[2]) !== match[2] || !CORPUS_FILE.test(match[2])) {
      throw new Error(`invalid SHA256SUMS entry at line ${index + 1}`);
    }
    const [, hash, name] = match;
    if (manifest.has(name)) {
      throw new Error(`duplicate SHA256SUMS entry for ${name}`);
    }
    manifest.set(name, hash.toLowerCase());
  }
  return manifest;
}

/**
 * Validate the complete existing corpus before a download or generation pass.
 * A refresh may replace expected files, but it never silently adopts stale files
 * left by a different selection.
 */
export function verifyCorpusIntegrity(dir, expectedFiles, refresh = false) {
  const expected = normaliseExpectedFiles(expectedFiles);
  const previous = readManifest(dir);
  const files = listCorpusFiles(dir);
  const present = new Set(files);
  const blocking = [];
  const replacements = new Set();

  // Read and hash every prior entry before reporting anything. This avoids a
  // stale first entry hiding corruption elsewhere in the same corpus.
  for (const [name, expectedHash] of previous) {
    const isExpected = expected.has(name);
    if (!isExpected) blocking.push(`stale manifest entry: ${name}`);
    if (!present.has(name)) {
      if (refresh && isExpected) replacements.add(name);
      else blocking.push(`manifested file is missing: ${name}`);
      continue;
    }

    const actualHash = sha256(readFileSync(pathResolve(dir, name)));
    if (actualHash !== expectedHash) {
      if (refresh && isExpected) replacements.add(name);
      else blocking.push(`checksum mismatch: ${name}`);
    }
  }

  for (const name of files) {
    const isExpected = expected.has(name);
    if (!isExpected) blocking.push(`unexpected corpus file: ${name}`);
    if (!previous.has(name)) {
      if (refresh && isExpected) replacements.add(name);
      else blocking.push(`file is not tracked by SHA256SUMS: ${name}`);
    }
  }

  if (blocking.length > 0) {
    throw new Error(
      `corpus integrity check failed in ${dir}:\n  ${blocking.join('\n  ')}\n` +
        'Use an empty output directory, or use --refresh only when every listed replacement is intentional.',
    );
  }

  return { previous, replacements };
}

export function writeManifest(dir, expectedFiles) {
  const expected = [...normaliseExpectedFiles(expectedFiles)].sort();
  const files = listCorpusFiles(dir);
  const missing = expected.filter(file => !files.includes(file));
  const unexpected = files.filter(file => !expected.includes(file));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `refusing to write SHA256SUMS for an incomplete corpus in ${dir}` +
        (missing.length > 0 ? `; missing: ${missing.join(', ')}` : '') +
        (unexpected.length > 0 ? `; unexpected: ${unexpected.join(', ')}` : ''),
    );
  }

  const rows = expected.map(file => `${sha256(readFileSync(pathResolve(dir, file)))}  ${file}`);
  const target = pathResolve(dir, 'SHA256SUMS');
  const temporary = pathResolve(dir, `.SHA256SUMS.${process.pid}.tmp`);
  writeFileSync(temporary, `${rows.join('\n')}\n`);
  renameSync(temporary, target);
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      for (;;) {
        const k = i++;
        if (k >= items.length) return;
        out[k] = await fn(items[k], k);
      }
    }),
  );
  return out;
}

async function buildIndex() {
  process.stderr.write(`fetching ${LIST_URL}\n`);
  const list = await (await fetch(LIST_URL, { headers: { 'user-agent': UA } })).json();

  const entries = [];
  for (const [name, api] of Object.entries(list)) {
    for (const [version, v] of Object.entries(api.versions)) {
      const url = v.swaggerYamlUrl ?? v.swaggerUrl;
      if (url === undefined) continue;
      entries.push({ id: `${name}@${version}`, name, version, url, openapiVer: v.openapiVer ?? null });
    }
  }
  entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  process.stderr.write(`sizing ${entries.length} documents (concurrency ${CONCURRENCY})\n`);

  let done = 0;
  const sized = await pool(entries, CONCURRENCY, async e => {
    let bytes = null;
    try {
      const r = await fetch(e.url, { method: 'HEAD', headers: { 'user-agent': UA }, redirect: 'follow' });
      const len = r.headers.get('content-length');
      if (r.ok && len !== null) bytes = Number(len);
    } catch {
      /* leave null; reported in the summary */
    }
    if (++done % 250 === 0) process.stderr.write(`  ${done}/${entries.length}\n`);
    return { ...e, bytes };
  });

  const ok = sized.filter(e => e.bytes !== null);
  ok.sort((a, b) => b.bytes - a.bytes || (a.id < b.id ? -1 : 1));
  writeFileSync(INDEX, JSON.stringify({ generatedFrom: LIST_URL, count: ok.length, entries: ok }, null, 1));
  process.stderr.write(`wrote ${INDEX}: ${ok.length} sized, ${sized.length - ok.length} unsized\n`);
  return ok;
}

const K = 1024;
const M = 1024 * 1024;
// Size bands. Lint cost and peak RSS both scale with document size, so a single
// mixed corpus averages away exactly the effect being measured; each band gets
// its own directory and is benchmarked separately.
const BANDS = [
  ['b100k', 0, 100 * K],
  ['b500k', 100 * K, 500 * K],
  ['b2m', 500 * K, 2 * M],
  ['b4m', 2 * M, 4 * M],
  ['b10m', 4 * M, 10 * M],
  // Bounded, not open-ended: microsoft graph-beta (55.7MB) alone lints for ~350s
  // and would dominate any band it landed in. It is a deliberate outlier, not a
  // 25MB sample -- benchmark it on its own.
  ['b25m', 10 * M, 30 * M],
];

async function pool_download(sel, dir) {
  let n = 0;
  await pool(sel, CONCURRENCY, async e => {
    const file = pathResolve(dir, corpusFilename(e));
    if (existsSync(file) && !REFRESH) return;
    const r = await fetch(e.url, { headers: { 'user-agent': UA }, redirect: 'follow' });
    if (!r.ok) {
      throw new Error(`download failed for ${e.id}: HTTP ${r.status}`);
    }
    writeFileSync(file, Buffer.from(await r.arrayBuffer()));
    n++;
  });
  process.stderr.write(`  downloaded ${n} new\n`);
  return n;
}

function select() {
  if (!existsSync(INDEX)) {
    console.error('no index yet -- run with --index first');
    process.exit(2);
  }
  const { entries } = JSON.parse(readFileSync(INDEX, 'utf8'));
  return entries.filter(e => e.bytes >= MIN_KB * 1024 && e.bytes <= MAX_MB * 1024 * 1024).slice(0, TOP);
}

const MB = b => (b / 1048576).toFixed(2).padStart(8) + ' MB';

const corpusFilename = entry => `${entry.id.replace(/[^\w.@-]/g, '_')}.yaml`;

export function generateSynthetic(out, targetMb, dirty, { refresh = REFRESH, execute = execFileSync } = {}) {
  if (existsSync(out) && !refresh) return false;
  execute(
    process.execPath,
    [
      pathResolve(ROOT, 'scripts/bench/gen-synthetic.mjs'),
      '--target',
      targetMb.toFixed(2),
      '--out',
      out,
      ...(dirty ? ['--dirty'] : []),
    ],
    { stdio: 'ignore' },
  );
  return true;
}

async function main() {
  if (!Number.isInteger(CONCURRENCY) || CONCURRENCY <= 0) {
    throw new Error('--concurrency must be a positive integer');
  }
  if (!Number.isInteger(TOP) || TOP <= 0) {
    throw new Error('--top must be a positive integer');
  }
  if (!Number.isInteger(PER_BAND) || PER_BAND <= 0) {
    throw new Error('--per-band must be a positive integer');
  }
  if (!Number.isFinite(MIN_KB) || MIN_KB < 0 || Number.isNaN(MAX_MB) || MAX_MB <= 0 || MIN_KB > MAX_MB * 1024) {
    throw new Error('--min-kb and --max-mb must be non-negative bounds with min <= max');
  }

  if (has('index')) {
    const ok = await buildIndex();
    console.log('\nlargest 15:');
    for (const e of ok.slice(0, 15)) console.log(MB(e.bytes), e.id);
    const total = ok.reduce((a, e) => a + e.bytes, 0);
    console.log(`\ntotal catalogue: ${(total / 1073741824).toFixed(2)} GB across ${ok.length} documents`);
  } else if (has('plan')) {
    const sel = select();
    for (const e of sel) console.log(MB(e.bytes), e.id);
    console.log(`\n${sel.length} documents, ${MB(sel.reduce((a, e) => a + e.bytes, 0))} total`);
  } else if (has('bands')) {
    if (!existsSync(INDEX)) {
      console.error('no index yet -- run with --index first');
      process.exit(2);
    }
    const { entries } = JSON.parse(readFileSync(INDEX, 'utf8'));
    for (const [name, lo, hi] of BANDS) {
      const candidates = entries.filter(e => e.bytes > lo && e.bytes <= hi);
      // Largest-first within the band, so a band is represented by its heavy end
      // rather than by whatever happens to sort first alphabetically.
      const sel = candidates.slice(0, PER_BAND);
      // Real documents thin out above a few MB, so a band short of PER_BAND is
      // topped up with deterministic synthetic specs sized for that band. They are
      // named synth-* so a mixed band stays legible.
      const shortfall = PER_BAND - sel.length;
      const syntheticFiles = Array.from(
        { length: shortfall },
        (_, index) => `synth-${name}-${String(index).padStart(3, '0')}.yaml`,
      );
      const expectedFiles = [...sel.map(corpusFilename), ...syntheticFiles];
      const dir = pathResolve(ROOT, 'corpora/bands', name);
      mkdirSync(dir, { recursive: true });
      verifyCorpusIntegrity(dir, expectedFiles, REFRESH);
      process.stderr.write(`\n[${name}] ${sel.length} of ${candidates.length} available -> ${dir}\n`);
      await pool_download(sel, dir);
      if (shortfall > 0) {
        const targetMb = ((lo + hi) / 2 / M) * 0.95;
        process.stderr.write(`  topping up ${shortfall} synthetic @ ~${targetMb.toFixed(1)}MB\n`);
        for (let i = 0; i < shortfall; i++) {
          generateSynthetic(pathResolve(dir, syntheticFiles[i]), targetMb * (1 + (i % 5) * 0.03), i % 2 === 0);
        }
      }
      writeManifest(dir, expectedFiles);
    }
    console.log('\nbands ready under corpora/bands/');
  } else if (has('download')) {
    const sel = select();
    const expectedFiles = sel.map(corpusFilename);
    mkdirSync(OUT, { recursive: true });
    verifyCorpusIntegrity(OUT, expectedFiles, REFRESH);
    await pool_download(sel, OUT);
    writeManifest(OUT, expectedFiles);
    console.log(`\ncorpus ready in ${OUT}; checksums written to SHA256SUMS`);
  } else {
    console.error(
      'usage: fetch-corpora.mjs --index | --plan | --download | --bands [--top N] [--min-kb N] [--max-mb N] [--refresh]',
    );
    process.exit(2);
  }
}

if (process.argv[1] !== undefined && pathResolve(process.argv[1]) === SELF) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
