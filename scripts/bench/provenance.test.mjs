import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { assertExecutableProvenanceUnchanged, gitProvenance, stabilizeGitSnapshot } from './provenance.mjs';

const snapshot = (tag, overrides = {}) => ({
  commit: 'commit',
  dirty: tag !== 'clean',
  statusSha256: `status-${tag}`,
  trackedDiffSha256: `diff-${tag}`,
  untrackedSha256: `untracked-${tag}`,
  untrackedFiles: tag === 'clean' ? 0 : 1,
  ...overrides,
});

const sequence = values => {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
};

test('accepts only two consecutive matching git snapshots', () => {
  const clean = snapshot('clean');
  const dirty = snapshot('dirty');

  assert.deepEqual(stabilizeGitSnapshot(sequence([clean, clean])), clean);
  assert.deepEqual(stabilizeGitSnapshot(sequence([clean, dirty, dirty])), dirty);
  assert.throws(
    () => stabilizeGitSnapshot(sequence([snapshot('a'), snapshot('b'), snapshot('c')])),
    /did not stabilize across 3 provenance captures/,
  );
});

test('every recorded git field participates in stabilization', () => {
  const clean = snapshot('clean');
  for (const [field, value] of [
    ['commit', 'other-commit'],
    ['dirty', true],
    ['statusSha256', 'other-status'],
    ['trackedDiffSha256', 'other-diff'],
    ['untrackedSha256', 'other-untracked'],
    ['untrackedFiles', 2],
  ]) {
    assert.throws(
      () => stabilizeGitSnapshot(sequence([clean, { ...clean, [field]: value }, clean])),
      /did not stabilize/,
      field,
    );
  }
});

test('snapshot reader failures propagate instead of becoming null provenance', () => {
  const failure = new Error('reader failed');
  assert.throws(
    () =>
      stabilizeGitSnapshot(() => {
        throw failure;
      }),
    error => error === failure,
  );
});

test('executable provenance must remain identical for the full run', () => {
  const original = {
    git: { worktreeSha256: 'worktree' },
    lockfileSha256: 'lockfile',
    loadedPackageDist: { sha256: 'dist' },
    installedPatchedDependencies: { dependency: { sha256: 'dependency' } },
  };
  assert.doesNotThrow(() => assertExecutableProvenanceUnchanged(original, structuredClone(original), 'test'));

  for (const mutate of [
    value => (value.git.worktreeSha256 = 'changed'),
    value => (value.lockfileSha256 = 'changed'),
    value => (value.loadedPackageDist.sha256 = 'changed'),
    value => (value.installedPatchedDependencies.dependency.sha256 = 'changed'),
  ]) {
    const changed = structuredClone(original);
    mutate(changed);
    assert.throws(() => assertExecutableProvenanceUnchanged(original, changed, 'test'), /provenance changed/);
  }
});

const gitFixture = t => {
  const dir = mkdtempSync(join(tmpdir(), 'spectral-provenance-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet', dir]);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'spectral-test@example.invalid']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Spectral Test']);
  writeFileSync(join(dir, 'tracked.txt'), 'original\n');
  execFileSync('git', ['-C', dir, 'add', 'tracked.txt']);
  execFileSync('git', ['-C', dir, '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture']);
  return dir;
};

test('git provenance is repeatable and detects staged, unstaged, deleted, and untracked state', t => {
  const dir = gitFixture(t);
  const clean = gitProvenance(dir);
  assert.equal(clean.dirty, false);
  assert.deepEqual(gitProvenance(dir), clean);

  writeFileSync(join(dir, 'tracked.txt'), 'changed\n');
  const unstaged = gitProvenance(dir);
  assert.equal(unstaged.dirty, true);
  assert.notEqual(unstaged.worktreeSha256, clean.worktreeSha256);

  execFileSync('git', ['-C', dir, 'add', 'tracked.txt']);
  const staged = gitProvenance(dir);
  assert.notEqual(staged.statusSha256, unstaged.statusSha256);

  writeFileSync(join(dir, 'untracked.txt'), 'untracked\n');
  const untracked = gitProvenance(dir);
  assert.equal(untracked.untrackedFiles, 1);
  assert.notEqual(untracked.untrackedSha256, staged.untrackedSha256);

  rmSync(join(dir, 'tracked.txt'));
  const deleted = gitProvenance(dir);
  assert.notEqual(deleted.statusSha256, untracked.statusSha256);
  assert.notEqual(deleted.trackedDiffSha256, untracked.trackedDiffSha256);
});

test('git provenance fails with context outside a repository', t => {
  const dir = mkdtempSync(join(tmpdir(), 'spectral-provenance-no-git-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  assert.throws(
    () => gitProvenance(dir),
    error => {
      assert.match(error.message, /git rev-parse HEAD\^\{commit\} failed/);
      assert.ok(error.cause instanceof Error);
      return true;
    },
  );
});
