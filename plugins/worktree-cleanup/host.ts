import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, readdir, readlink, stat, symlink, writeFile, chmod } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  experimental_defineHostEntry,
  experimental_killProcessesWithCwdUnder,
} from '@get-bb/plugin-sdk/host';
import { hostContract } from './contract.js';
import { newestMeaningfulTimestamp, unixTimestampMs } from './activity.js';
import { isResidue } from './residue.js';

const exec = promisify(execFile);
const SKIP_DIRECTORIES = new Set(['.git', 'node_modules', '.pnpm-store', '.venv', 'venv', '__pycache__']);
const SENSITIVE_PATH = /(^|\/)(?:\.env(?:\.|$)|[^/]*(?:secret|credential|private[-_]?key)[^/]*|[^/]+\.(?:pem|key|p12|pfx))$/iu;
const BINARY_PATH = /\.(?:png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|bz2|xz|7z|woff2?|ttf|eot|mp[34]|mov|avi|sqlite3?|db)$/iu;

async function command(file: string, args: string[], signal: AbortSignal, cwd?: string, env?: NodeJS.ProcessEnv, timeout = 30_000) {
  try {
    const result = await exec(file, args, { cwd, env, signal, timeout, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' });
    return { ok: true, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  } catch (error) {
    const value = error as { stdout?: string; stderr?: string; message?: string; code?: string | number };
    return { ok: false, stdout: String(value.stdout ?? '').trim(), stderr: String(value.stderr || value.message || value.code || 'command failed').trim() };
  }
}

async function discoverGitCheckouts(root: string, signal: AbortSignal): Promise<string[]> {
  const found: string[] = [];
  async function walk(directory: string, depth: number): Promise<void> {
    signal.throwIfAborted();
    if (depth > 6 || found.length >= 5000) return;
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    if (entries.some(entry => entry.name === '.git')) found.push(directory);
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIP_DIRECTORIES.has(entry.name)) continue;
      await walk(join(directory, entry.name), depth + 1);
    }
  }
  await walk(root, 0);
  return found;
}

type PorcelainWorktree = { path: string; head: string | null; branch: string | null; bare: boolean };

function parseWorktrees(output: string): PorcelainWorktree[] {
  const result: PorcelainWorktree[] = [];
  let current: PorcelainWorktree | null = null;
  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current) result.push(current);
      current = { path: line.slice(9), head: null, branch: null, bare: false };
    } else if (current && line.startsWith('HEAD ')) current.head = line.slice(5);
    else if (current && line.startsWith('branch refs/heads/')) current.branch = line.slice(18);
    else if (current && line === 'bare') current.bare = true;
  }
  if (current) result.push(current);
  return result;
}

function zeroList(output: string): string[] {
  return output.split('\0').filter(Boolean);
}

async function fileHash(worktree: string, path: string, signal: AbortSignal): Promise<string | null> {
  const result = await command('git', ['hash-object', '--', path], signal, worktree);
  return result.ok && /^[0-9a-f]{40,64}$/u.test(result.stdout) ? result.stdout : null;
}

async function duplicateEvidence(repository: string, primaryWorktree: PorcelainWorktree | undefined, ownPath: string, path: string, hash: string, signal: AbortSignal): Promise<string | null> {
  const refsResult = await command('git', ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes'], signal, repository);
  if (refsResult.ok) {
    for (const ref of refsResult.stdout.split('\n').filter(Boolean).slice(0, 500)) {
      const blob = await command('git', ['rev-parse', '--verify', `${ref}:${path}`], signal, repository);
      if (blob.ok && blob.stdout === hash) return `Exact content exists at ${ref}:${path}`;
    }
  }
  if (primaryWorktree && resolve(primaryWorktree.path) !== resolve(ownPath) && !primaryWorktree.bare) {
    if (await fileHash(primaryWorktree.path, path, signal) === hash) return `Exact content exists in primary checkout ${primaryWorktree.path}/${path}`;
  }
  return null;
}

async function inspectWorktree(sourcePath: string, repository: string, allWorktrees: PorcelainWorktree[], item: PorcelainWorktree, primary: boolean, protectedPaths: Set<string>, retentionDays: number, signal: AbortSignal) {
  const normalizedPath = resolve(item.path);
  const protectedWorktree = protectedPaths.has(normalizedPath);
  const trackedResult = await command('git', ['diff', '--name-only', '-z', 'HEAD', '--'], signal, item.path);
  const untrackedResult = await command('git', ['ls-files', '--others', '--exclude-standard', '-z'], signal, item.path);
  const tracked = trackedResult.ok ? zeroList(trackedResult.stdout) : [];
  const untracked = untrackedResult.ok ? zeroList(untrackedResult.stdout) : [];
  const paths = [...new Map([...tracked.map(path => [path, 'tracked'] as const), ...untracked.map(path => [path, 'untracked'] as const)]).entries()];
  const changes = [] as { path: string; kind: 'tracked' | 'untracked'; classification: 'duplicate' | 'residue' | 'unique'; evidence: string }[];
  const fingerprints: { path: string; kind: string; hash: string | null }[] = [];
  const fileTimestamps: number[] = [];
  for (const [path, kind] of paths.slice(0, 200)) {
    try { fileTimestamps.push((await stat(join(item.path, path))).mtimeMs); } catch { /* deleted tracked file */ }
    if (kind === 'untracked' && isResidue(path)) {
      fingerprints.push({ path, kind, hash: await fileHash(item.path, path, signal) });
      changes.push({ path, kind, classification: 'residue', evidence: 'Known OS/editor temporary file pattern' });
      continue;
    }
    const hash = await fileHash(item.path, path, signal);
    fingerprints.push({ path, kind, hash });
    const duplicate = hash ? await duplicateEvidence(repository, allWorktrees[0], item.path, path, hash, signal) : null;
    changes.push({ path, kind, classification: duplicate ? 'duplicate' : 'unique', evidence: duplicate ?? 'No exact copy found at another branch tip or worktree path' });
  }
  // `git ls-files --others --exclude-standard` above intentionally excludes
  // ignored files. Use the commit time when there are no meaningful changed
  // paths, and never use the worktree directory mtime: cache purges mutate it.
  const commitResult = await command('git', ['show', '-s', '--format=%ct', item.head ?? 'HEAD'], signal, repository);
  const commitTimestampMs = commitResult.ok ? unixTimestampMs(commitResult.stdout) : null;
  const newest = newestMeaningfulTimestamp(commitTimestampMs, fileTimestamps);
  const ageDays = newest ? Math.max(0, (Date.now() - newest) / 86_400_000) : 0;
  const refs = item.head ? await command('git', ['for-each-ref', '--contains', item.head, '--format=%(refname)', 'refs/heads', 'refs/remotes'], signal, repository) : { ok: false, stdout: '', stderr: '' };
  const changesTruncated = paths.length > 200;
  const fingerprint = createHash('sha256').update(JSON.stringify({ head: item.head, branch: item.branch, changes: fingerprints })).digest('hex');
  let reason = 'Eligible';
  if (primary) reason = 'Primary checkout';
  else if (protectedWorktree) reason = 'Attached to a BB environment';
  else if (item.bare) reason = 'Bare repository';
  else if (!trackedResult.ok || !untrackedResult.ok) reason = 'Git status unavailable';
  else if (!item.head || !refs.ok || !refs.stdout) reason = 'HEAD is not preserved by another Git ref';
  else if (ageDays < retentionDays) reason = 'Within retention period';
  else if (changesTruncated) reason = 'More than 200 changes require manual review';
  else if (changes.some(change => change.classification === 'unique')) reason = 'Contains changes not found elsewhere';
  const safeToRemove = reason === 'Eligible';
  let action: 'kept' | 'removed' | 'failed' = 'kept';
  return { sourcePath, repositoryPath: repository, path: item.path, branch: item.branch, head: item.head, primary, protected: protectedWorktree, ageDays, fingerprint, changes, changesTruncated, safeToRemove, reason, action: action as 'kept' | 'removed' | 'failed' };
}

async function locateWorktree(sourcePaths: string[], targetPath: string, protectedPaths: Set<string>, retentionDays: number, signal: AbortSignal) {
  const target = resolve(targetPath);
  const groups = new Map<string, { sourcePath: string; checkout: string }>();
  for (const sourcePath of [...new Set(sourcePaths.map(path => resolve(path)))]) {
    for (const checkout of await discoverGitCheckouts(sourcePath, signal)) {
      const common = await command('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], signal, checkout);
      if (common.ok && !groups.has(common.stdout)) groups.set(common.stdout, { sourcePath, checkout });
    }
  }
  for (const { sourcePath, checkout } of groups.values()) {
    const listed = await command('git', ['worktree', 'list', '--porcelain'], signal, checkout);
    if (!listed.ok) continue;
    const items = parseWorktrees(listed.stdout);
    const index = items.findIndex(item => resolve(item.path) === target);
    if (index < 0) continue;
    return inspectWorktree(sourcePath, items[0]?.path ?? checkout, items, items[index]!, index === 0, protectedPaths, retentionDays, signal);
  }
  return null;
}

async function reviewEvidence(report: Awaited<ReturnType<typeof inspectWorktree>>, signal: AbortSignal) {
  const redactedPaths = report.changes.filter(change => SENSITIVE_PATH.test(change.path) || BINARY_PATH.test(change.path)).map(change => change.path);
  const visible = report.changes.filter(change => !redactedPaths.includes(change.path));
  const tracked = visible.filter(change => change.kind === 'tracked').map(change => change.path);
  const lines = [
    `Worktree: ${report.path}`,
    `Branch: ${report.branch ?? '(detached)'}`,
    `HEAD: ${report.head ?? '(unknown)'}`,
    `Age days: ${report.ageDays.toFixed(1)}`,
    'Changes:',
    ...report.changes.map(change => `- ${change.kind} ${change.classification} ${change.path}: ${change.evidence}`),
  ];
  if (redactedPaths.length) lines.push(`Content redacted for ${redactedPaths.length} sensitive or binary path(s).`);
  if (tracked.length) {
    const patch = await command('git', ['diff', '--no-ext-diff', '--unified=8', 'HEAD', '--', ...tracked], signal, report.path, undefined, 60_000);
    if (patch.stdout) lines.push('Working tree patch:', patch.stdout.slice(0, 35_000));
  }
  const untracked = visible.filter(change => change.kind === 'untracked').slice(0, 20);
  let previewBytes = 0;
  for (const change of untracked) {
    if (previewBytes >= 8_000) break;
    try {
      const content = await readFile(join(report.path, change.path), 'utf8');
      const preview = content.slice(0, Math.min(2_000, 8_000 - previewBytes));
      previewBytes += preview.length;
      lines.push(`Untracked preview ${change.path}:`, preview);
    } catch { /* directories, non-text files, and unreadable paths remain name-only */ }
  }
  return { evidence: lines.join('\n').slice(0, 60_000), redactedPaths };
}

async function copyRecoveryFile(worktreePath: string, relativePath: string, recoveryRoot: string) {
  if (relativePath.startsWith('/') || relativePath.split('/').includes('..')) throw new Error(`Unsafe untracked path: ${relativePath}`);
  const source = join(worktreePath, relativePath);
  const destination = join(recoveryRoot, 'untracked', relativePath);
  const info = await lstat(source);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  if (info.isSymbolicLink()) await symlink(await readlink(source), destination);
  else if (info.isFile()) { await copyFile(source, destination); await chmod(destination, 0o600); }
}

async function createRecovery(report: Awaited<ReturnType<typeof inspectWorktree>>, dataDir: string, signal: AbortSignal) {
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  const root = join(dataDir, 'recoveries', `${stamp}-${basename(report.path)}-${report.fingerprint.slice(0, 12)}`);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const patch = await command('git', ['diff', '--binary', 'HEAD', '--'], signal, report.path, undefined, 120_000);
  if (!patch.ok) throw new Error(`Could not create recovery patch: ${patch.stderr}`);
  await writeFile(join(root, 'tracked.patch'), `${patch.stdout}\n`, { encoding: 'utf8', mode: 0o600 });
  const untracked = await command('git', ['ls-files', '--others', '--exclude-standard', '-z'], signal, report.path);
  if (!untracked.ok) throw new Error(`Could not list untracked files: ${untracked.stderr}`);
  for (const path of zeroList(untracked.stdout)) await copyRecoveryFile(report.path, path, root);
  await writeFile(join(root, 'metadata.json'), `${JSON.stringify({
    createdAt: new Date().toISOString(), worktreePath: report.path, repositoryPath: report.repositoryPath,
    branch: report.branch, head: report.head, fingerprint: report.fingerprint,
    untrackedPaths: zeroList(untracked.stdout),
  }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return root;
}

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    async scanSources(input, context) {
      const errors: string[] = [];
      let errorsTruncated = false;
      const addError = (message: string) => { if (errors.length < 100) errors.push(message.slice(0, 1000)); else errorsTruncated = true; };
      const roots = [...new Set(input.sourcePaths.map(path => resolve(path)))];
      const protectedPaths = new Set(input.protectedPaths.map(path => resolve(path)));
      const groups = new Map<string, { sourcePath: string; checkout: string }>();
      for (const sourcePath of roots) {
        for (const checkout of await discoverGitCheckouts(sourcePath, context.signal)) {
          const common = await command('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], context.signal, checkout);
          if (common.ok && !groups.has(common.stdout)) groups.set(common.stdout, { sourcePath, checkout });
        }
      }
      const worktrees = [] as Awaited<ReturnType<typeof inspectWorktree>>[];
      let worktreesTruncated = false;
      for (const { sourcePath, checkout } of groups.values()) {
        context.signal.throwIfAborted();
        const listed = await command('git', ['worktree', 'list', '--porcelain'], context.signal, checkout);
        if (!listed.ok) { addError(`${checkout}: ${listed.stderr}`); continue; }
        const items = parseWorktrees(listed.stdout);
        if (input.prune) {
          const prune = await command('git', ['worktree', 'prune', ...(input.apply ? [] : ['--dry-run']), '--verbose', '--expire', 'now'], context.signal, checkout);
          if (!prune.ok) addError(`${checkout}: prune failed: ${prune.stderr}`);
        }
        for (let index = 0; index < items.length; index++) {
          if (worktrees.length >= 1000) { worktreesTruncated = true; break; }
          const report = await inspectWorktree(sourcePath, items[0]?.path ?? checkout, items, items[index]!, index === 0, protectedPaths, input.retentionDays, context.signal);
          if (input.apply && report.safeToRemove) {
            const inUse = await command('lsof', ['-a', '-d', 'cwd', '+D', report.path], context.signal);
            if (inUse.ok && inUse.stdout) {
              report.safeToRemove = false;
              report.reason = 'A process is using this worktree';
            } else {
              try {
                await experimental_killProcessesWithCwdUnder({ directory: report.path });
                const removed = await command('git', ['worktree', 'remove', '--force', report.path], context.signal, report.repositoryPath);
                if (removed.ok) report.action = 'removed';
                else { report.action = 'failed'; report.reason = `Removal failed: ${removed.stderr}`; }
              } catch (error) {
                report.action = 'failed';
                report.reason = `Removal failed: ${String(error).slice(0, 500)}`;
              }
            }
          }
          worktrees.push(report);
        }
      }
      return { repositoriesScanned: groups.size, metadataPruned: input.prune && input.apply, worktrees, worktreesTruncated, errors, errorsTruncated };
    },
    async molePurge(input, context) {
      const home = join(context.experimental_paths.tempDir, 'mole-home');
      await mkdir(join(home, '.config', 'mole'), { recursive: true });
      await writeFile(join(home, '.config', 'mole', 'purge_paths'), `${input.sourcePaths.map(path => resolve(path)).join('\n')}\n`, 'utf8');
      const result = await command('mo', ['purge', ...(input.apply ? [] : ['--dry-run'])], context.signal, home, { ...process.env, HOME: home }, 10 * 60_000);
      const output = `${result.stdout}${result.stderr ? `\n${result.stderr}` : ''}`.slice(0, 100_000);
      return { available: result.ok || !result.stderr.includes('ENOENT'), exitCode: result.ok ? 0 : 1, output };
    },
    async prepareReview(input, context) {
      const candidate = await locateWorktree(
        input.sourcePaths,
        input.worktreePath,
        new Set(input.protectedPaths.map(path => resolve(path))),
        input.retentionDays,
        context.signal,
      );
      if (!candidate) return { candidate: null, evidence: '', redactedPaths: [] };
      const evidence = await reviewEvidence(candidate, context.signal);
      return { candidate, ...evidence };
    },
    async applyReviewed(input, context) {
      const protectedPaths = new Set(input.protectedPaths.map(path => resolve(path)));
      const results = [] as { worktreePath: string; action: 'removed' | 'kept' | 'failed'; reason: string; recoveryPath: string | null }[];
      for (const decision of input.decisions) {
        let recoveryPath: string | null = null;
        try {
          const report = await locateWorktree(input.sourcePaths, decision.worktreePath, protectedPaths, input.retentionDays, context.signal);
          if (!report) {
            results.push({ worktreePath: decision.worktreePath, action: 'kept', reason: 'Worktree no longer exists', recoveryPath });
            continue;
          }
          if (report.fingerprint !== decision.fingerprint) {
            results.push({ worktreePath: report.path, action: 'kept', reason: 'Contents changed after review; a new review is required', recoveryPath });
            continue;
          }
          if (report.primary || report.protected || report.ageDays < input.retentionDays || report.changesTruncated || !report.head) {
            results.push({ worktreePath: report.path, action: 'kept', reason: report.reason, recoveryPath });
            continue;
          }
          recoveryPath = await createRecovery(report, context.experimental_paths.dataDir, context.signal);
          const inUse = await command('lsof', ['-a', '-d', 'cwd', '+D', report.path], context.signal);
          if (inUse.ok && inUse.stdout) {
            results.push({ worktreePath: report.path, action: 'kept', reason: 'A process is using this worktree', recoveryPath });
            continue;
          }
          await experimental_killProcessesWithCwdUnder({ directory: report.path });
          const removed = await command('git', ['worktree', 'remove', '--force', report.path], context.signal, report.repositoryPath);
          if (!removed.ok) throw new Error(removed.stderr);
          results.push({ worktreePath: report.path, action: 'removed', reason: 'Removed after verified private recovery capture', recoveryPath });
        } catch (error) {
          results.push({ worktreePath: decision.worktreePath, action: 'failed', reason: String(error).slice(0, 1000), recoveryPath });
        }
      }
      return { results };
    },
  },
});
