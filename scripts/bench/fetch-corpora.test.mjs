import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { generateSynthetic, readManifest, verifyCorpusIntegrity, writeManifest } from './fetch-corpora.mjs';

const fixture = t => {
  const dir = mkdtempSync(join(tmpdir(), 'spectral-corpus-integrity-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('verifies every prior checksum before allowing a manifest rewrite', t => {
  const dir = fixture(t);
  writeFileSync(join(dir, 'a.yaml'), 'a: original\n');
  writeFileSync(join(dir, 'b.json'), '{"b":"original"}\n');
  writeManifest(dir, ['a.yaml', 'b.json']);
  const originalManifest = readFileSync(join(dir, 'SHA256SUMS'), 'utf8');

  writeFileSync(join(dir, 'a.yaml'), 'a: changed\n');
  writeFileSync(join(dir, 'b.json'), '{"b":"changed"}\n');

  assert.throws(
    () => verifyCorpusIntegrity(dir, ['a.yaml', 'b.json']),
    error => {
      assert.match(error.message, /checksum mismatch: a\.yaml/);
      assert.match(error.message, /checksum mismatch: b\.json/);
      return true;
    },
  );
  assert.equal(readFileSync(join(dir, 'SHA256SUMS'), 'utf8'), originalManifest);
});

test('refresh permits replacement only for files in the exact expected corpus', t => {
  const dir = fixture(t);
  writeFileSync(join(dir, 'expected.yaml'), 'expected: old\n');
  writeManifest(dir, ['expected.yaml']);
  writeFileSync(join(dir, 'expected.yaml'), 'expected: corrupt\n');
  writeFileSync(join(dir, 'new.json'), '{"new":true}\n');

  const { replacements } = verifyCorpusIntegrity(dir, ['expected.yaml', 'new.json'], true);
  assert.deepEqual([...replacements].sort(), ['expected.yaml', 'new.json']);

  writeFileSync(join(dir, 'stale.yaml'), 'stale: true\n');
  assert.throws(
    () => verifyCorpusIntegrity(dir, ['expected.yaml', 'new.json'], true),
    /unexpected corpus file: stale\.yaml/,
  );
});

test('rejects stale manifest entries even during refresh', t => {
  const dir = fixture(t);
  writeFileSync(join(dir, 'selected.yaml'), 'selected: true\n');
  writeFileSync(join(dir, 'old-selection.yaml'), 'old: true\n');
  writeManifest(dir, ['selected.yaml', 'old-selection.yaml']);

  assert.throws(
    () => verifyCorpusIntegrity(dir, ['selected.yaml'], true),
    error => {
      assert.match(error.message, /stale manifest entry: old-selection\.yaml/);
      assert.match(error.message, /unexpected corpus file: old-selection\.yaml/);
      return true;
    },
  );
});

test('does not adopt unmanifested files without an explicit refresh', t => {
  const dir = fixture(t);
  writeFileSync(join(dir, 'existing.yaml'), 'existing: true\n');

  assert.throws(
    () => verifyCorpusIntegrity(dir, ['existing.yaml']),
    /file is not tracked by SHA256SUMS: existing\.yaml/,
  );
  assert.doesNotThrow(() => verifyCorpusIntegrity(dir, ['existing.yaml'], true));
});

test('refuses to write a manifest for a missing or unexpected corpus member', t => {
  const dir = fixture(t);
  writeFileSync(join(dir, 'expected.yaml'), 'expected: true\n');
  writeFileSync(join(dir, 'unexpected.json'), '{}\n');

  assert.throws(
    () => writeManifest(dir, ['expected.yaml', 'missing.yaml']),
    error => {
      assert.match(error.message, /missing: missing\.yaml/);
      assert.match(error.message, /unexpected: unexpected\.json/);
      return true;
    },
  );
  assert.equal(existsSync(join(dir, 'SHA256SUMS')), false);
});

test('rejects malformed and path-traversing manifest entries', t => {
  const dir = fixture(t);
  writeFileSync(join(dir, 'SHA256SUMS'), `${'0'.repeat(64)}  ..\\outside.yaml\n`);
  assert.throws(() => readManifest(dir), /invalid SHA256SUMS entry at line 1/);
});

test('refresh regenerates an existing synthetic document', t => {
  const dir = fixture(t);
  const out = join(dir, 'synth.yaml');
  writeFileSync(out, 'old synthetic\n');
  let calls = 0;
  const execute = (_executable, args) => {
    calls++;
    const output = args[args.indexOf('--out') + 1];
    writeFileSync(output, `regenerated ${args.includes('--dirty') ? 'dirty' : 'clean'}\n`);
  };

  assert.equal(generateSynthetic(out, 1, true, { refresh: false, execute }), false);
  assert.equal(calls, 0);
  assert.equal(readFileSync(out, 'utf8'), 'old synthetic\n');

  assert.equal(generateSynthetic(out, 1, true, { refresh: true, execute }), true);
  assert.equal(calls, 1);
  assert.equal(readFileSync(out, 'utf8'), 'regenerated dirty\n');
});
