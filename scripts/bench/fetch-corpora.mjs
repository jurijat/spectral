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
 *
 * Selection is deterministic (sorted by size, then name), so the same flags
 * always produce the same corpus. Nothing here is committed -- corpora/ is
 * gitignored; the index is small enough to keep.
 *
 * Flags: --top N  --min-kb N  --max-mb N  --concurrency N  --out DIR
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = pathResolve(dirname(fileURLToPath(import.meta.url)), '../..');
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
const MIN_KB = Number(arg('min-kb', 0));
const MAX_MB = Number(arg('max-mb', Infinity));
const UA = 'spectral-perf-bench (+https://github.com/stoplightio/spectral) node-fetch';

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

function select() {
  if (!existsSync(INDEX)) {
    console.error('no index yet -- run with --index first');
    process.exit(2);
  }
  const { entries } = JSON.parse(readFileSync(INDEX, 'utf8'));
  return entries.filter(e => e.bytes >= MIN_KB * 1024 && e.bytes <= MAX_MB * 1024 * 1024).slice(0, TOP);
}

const MB = b => (b / 1048576).toFixed(2).padStart(8) + ' MB';

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
} else if (has('download')) {
  const sel = select();
  mkdirSync(OUT, { recursive: true });
  let n = 0;
  await pool(sel, CONCURRENCY, async e => {
    const file = pathResolve(OUT, `${e.id.replace(/[^\w.@-]/g, '_')}.yaml`);
    if (existsSync(file)) {
      process.stderr.write(`skip  ${e.id}\n`);
      return;
    }
    const r = await fetch(e.url, { headers: { 'user-agent': UA }, redirect: 'follow' });
    if (!r.ok) {
      process.stderr.write(`FAIL  ${e.id} ${r.status}\n`);
      return;
    }
    writeFileSync(file, Buffer.from(await r.arrayBuffer()));
    process.stderr.write(`ok    ${MB(e.bytes)} ${e.id}\n`);
    n++;
  });
  console.log(`\ndownloaded ${n} new documents into ${OUT}`);
} else {
  console.error('usage: fetch-corpora.mjs --index | --plan | --download [--top N] [--min-kb N] [--max-mb N]');
  process.exit(2);
}
