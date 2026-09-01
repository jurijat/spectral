import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { join, relative } from 'node:path';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const compareText = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const GIT_MAX_BUFFER = 128 * 1024 * 1024;

function sortedFiles(root, directory) {
  const files = [];
  const visit = path => {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => compareText(a.name, b.name))) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') visit(child);
      } else {
        files.push(child);
      }
    }
  };
  if (existsSync(directory)) visit(directory);
  return files.map(path => ({ path, name: relative(root, path).replaceAll('\\', '/') }));
}

function hashFiles(files, allowSymlinks = false) {
  const hash = createHash('sha256');
  let bytes = 0;
  for (const { path, name } of files) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() && !allowSymlinks) {
      throw new Error(`refusing to hash executable symlink: ${name}`);
    }
    if (!stat.isSymbolicLink() && !stat.isFile()) {
      throw new Error(`refusing to hash non-regular file: ${name}`);
    }
    const type = stat.isSymbolicLink() ? 'link' : 'file';
    const value = type === 'link' ? Buffer.from(readlinkSync(path)) : readFileSync(path);
    hash.update(`${name.length}:${name}:${type}:${value.length}:`);
    hash.update(value);
    hash.update('\0');
    bytes += value.length;
  }
  return { sha256: hash.digest('hex'), files: files.length, bytes };
}

function runGit(root, args) {
  try {
    return execFileSync('git', ['--no-optional-locks', ...args], {
      cwd: root,
      maxBuffer: GIT_MAX_BUFFER,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    throw new Error(`git ${args.join(' ')} failed in ${root}`, { cause: error });
  }
}

class GitHeadChangedError extends Error {}

function captureGitSnapshot(root) {
  const commitBefore = runGit(root, ['rev-parse', 'HEAD^{commit}']).toString('utf8').trim();
  const status = runGit(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const trackedDiff = runGit(root, ['diff', '--binary', '--no-ext-diff', 'HEAD', '--']);
  const untrackedOutput = runGit(root, ['ls-files', '--others', '--exclude-standard', '-z']);
  const untrackedNames = untrackedOutput.toString('utf8').split('\0').filter(Boolean).sort(compareText);
  let untracked;
  try {
    untracked = hashFiles(
      untrackedNames.map(name => ({ path: join(root, name), name })),
      true,
    );
  } catch (error) {
    throw new Error(`failed to hash untracked files in ${root}`, { cause: error });
  }
  const commitAfter = runGit(root, ['rev-parse', 'HEAD^{commit}']).toString('utf8').trim();
  if (commitBefore !== commitAfter) throw new GitHeadChangedError('HEAD changed while collecting git provenance');
  return {
    commit: commitAfter,
    dirty: status.length > 0,
    statusSha256: sha256(status),
    trackedDiffSha256: sha256(trackedDiff),
    untrackedSha256: untracked.sha256,
    untrackedFiles: untracked.files,
  };
}

const gitSnapshotFingerprint = snapshot =>
  [
    snapshot.commit,
    snapshot.dirty,
    snapshot.statusSha256,
    snapshot.trackedDiffSha256,
    snapshot.untrackedSha256,
    snapshot.untrackedFiles,
  ].join('\0');

function stabilizeGitSnapshot(capture, maxCaptures = 3) {
  let previous = null;
  for (let attempt = 0; attempt < maxCaptures; attempt++) {
    let current;
    try {
      current = capture();
    } catch (error) {
      if (error instanceof GitHeadChangedError) {
        previous = null;
        continue;
      }
      throw error;
    }
    if (previous !== null && gitSnapshotFingerprint(previous) === gitSnapshotFingerprint(current)) return current;
    previous = current;
  }
  throw new Error(`git worktree did not stabilize across ${maxCaptures} provenance captures`);
}

function gitProvenance(root) {
  const snapshot = stabilizeGitSnapshot(() => captureGitSnapshot(root));
  return {
    ...snapshot,
    worktreeSha256: createHash('sha256')
      .update(snapshot.commit)
      .update('\0')
      .update(snapshot.trackedDiffSha256)
      .update('\0')
      .update(snapshot.untrackedSha256)
      .digest('hex'),
  };
}

function distProvenance(root) {
  const packages = join(root, 'packages');
  const files = readdirSync(packages, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .flatMap(entry => sortedFiles(root, join(packages, entry.name, 'dist')))
    .sort((a, b) => compareText(a.name, b.name));
  return hashFiles(files);
}

function patchedDependencyProvenance(root) {
  const patches = join(root, 'patches');
  if (!existsSync(patches)) return {};

  const installed = {};
  for (const entry of readdirSync(patches, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.patch')) continue;
    const parts = entry.name.slice(0, -'.patch'.length).split('+');
    const packageName = parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
    if (packageName in installed) continue;

    const directory = join(root, 'node_modules', ...packageName.split('/'));
    installed[packageName] = existsSync(directory) ? hashFiles(sortedFiles(root, directory)) : null;
  }

  return Object.fromEntries(Object.entries(installed).sort(([left], [right]) => compareText(left, right)));
}

export function collectProvenance(root) {
  return {
    git: gitProvenance(root),
    lockfileSha256: sha256(readFileSync(join(root, 'yarn.lock'))),
    loadedPackageDist: distProvenance(root),
    installedPatchedDependencies: patchedDependencyProvenance(root),
    node: process.version,
    execPath: process.execPath,
    execArgv: [...process.execArgv],
    argv: process.argv.slice(1),
    cwd: process.cwd(),
    nodeOptions: process.env.NODE_OPTIONS ?? null,
    allocatorPreload: process.env.LD_PRELOAD ?? null,
  };
}

export function assertExecutableProvenanceUnchanged(before, after, context = 'benchmark') {
  const fields = [
    ['git worktree', before.git.worktreeSha256, after.git.worktreeSha256],
    ['lockfile', before.lockfileSha256, after.lockfileSha256],
    ['loaded package dist', before.loadedPackageDist.sha256, after.loadedPackageDist.sha256],
    [
      'installed patched dependencies',
      JSON.stringify(before.installedPatchedDependencies),
      JSON.stringify(after.installedPatchedDependencies),
    ],
  ];
  const changed = fields.filter(([, start, end]) => start !== end).map(([name]) => name);
  if (changed.length > 0) {
    throw new Error(`${context} executable provenance changed during the run: ${changed.join(', ')}`);
  }
}

export { gitProvenance, sha256, stabilizeGitSnapshot };
