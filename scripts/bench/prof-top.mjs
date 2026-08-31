#!/usr/bin/env node
/**
 * Summarizes a V8 .cpuprofile (from --cpu-prof) into top self-time functions.
 * Avoids needing Chrome DevTools for the common "who is burning the CPU" case.
 *   node scripts/bench/prof-top.mjs /tmp/prof/run.cpuprofile [--top 25]
 */
import { readFileSync } from 'node:fs';
const file = process.argv[2];
const TOP = Number(process.argv[process.argv.indexOf('--top') + 1]) || 25;
const p = JSON.parse(readFileSync(file, 'utf8'));

const byId = new Map();
const walk = n => { byId.set(n.id, n); for (const c of n.children ?? []) { /* flat in v8 fmt */ } };
for (const n of p.nodes) byId.set(n.id, n);

// self time per node id from the sample stream
const self = new Map();
for (let i = 0; i < p.samples.length; i++) {
  const id = p.samples[i];
  self.set(id, (self.get(id) ?? 0) + (p.timeDeltas[i] ?? 0));
}
// aggregate by functionName + file
const agg = new Map();
for (const [id, us] of self) {
  const n = byId.get(id); if (!n) continue;
  const f = n.callFrame;
  const short = (f.url || '').replace(/^.*\/node_modules\//, '').replace(/^.*\/packages\//, 'packages/');
  const key = `${f.functionName || '(anonymous)'}  @ ${short}:${f.lineNumber + 1}`;
  agg.set(key, (agg.get(key) ?? 0) + us);
}
const totalUs = [...agg.values()].reduce((a, b) => a + b, 0);
console.log(`profile ${file}`);
console.log(`wall ${( (p.endTime - p.startTime) / 1000).toFixed(0)} ms, sampled ${(totalUs / 1000).toFixed(0)} ms, ${p.nodes.length.toLocaleString()} nodes\n`);
console.log('   ms     %    function @ file:line');
for (const [k, us] of [...agg].sort((a, b) => b[1] - a[1]).slice(0, TOP)) {
  console.log(`${(us / 1000).toFixed(0).padStart(6)}  ${((us / totalUs) * 100).toFixed(1).padStart(5)}%  ${k}`);
}
