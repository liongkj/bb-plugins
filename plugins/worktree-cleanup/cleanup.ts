import type { PluginBbSdk } from '@get-bb/plugin-sdk';
export type Environment = Awaited<ReturnType<PluginBbSdk['environments']['get']>>;
export type GitStatus = Awaited<ReturnType<PluginBbSdk['environments']['status']>>;
export type Thread = Awaited<ReturnType<PluginBbSdk['threads']['list']>>[number];
export type Inspection = { reason: string | null; unarchivedThreadCount: number };
export const DAY = 86_400_000;
export function environmentReason(env: Environment): string | null {
  if (!env.managed || !env.isWorktree || !env.isGitRepo || env.environmentProviderId !== 'git-worktree' || env.workspaceProvisionType !== 'managed-worktree') return 'Not a BB-managed Git worktree';
  if (env.status !== 'ready' || !['active', 'retiring'].includes(env.lifecycle.phase)) return 'Not ready, or cleanup already started';
  if (!env.path || !env.branchName || !env.defaultBranch || !env.mergeBaseBranch) return 'Missing path or branch metadata';
  if (env.branchName === env.defaultBranch || env.branchName === env.mergeBaseBranch) return 'Protected base branch';
  return null;
}
export function gitReason(status: GitStatus, env: Environment): string | null {
  if (status.outcome !== 'available') return 'Git status unavailable';
  const w = status.workspace;
  if (w.checkout.kind !== 'branch' || !w.checkout.headSha || w.checkout.branchName !== env.branchName) return 'Checkout changed or is detached';
  if (w.workingTree.hasUncommittedChanges || w.workingTree.files.length || w.workingTree.state !== 'clean') return 'Uncommitted or untracked changes';
  if (!w.mergeBase || w.mergeBase.aheadCount !== 0 || w.mergeBase.hasCommittedUnmergedChanges) return 'Unmerged commits or unknown merge base';
  return null;
}
function threadReason(thread: Thread): string | null {
  if (thread.pinnedAt !== null) return 'Has a pinned thread';
  if (!['idle', 'error'].includes(thread.status) || !['idle', 'error'].includes(thread.runtime.displayStatus)) return 'Has a thread that is not idle';
  if (thread.hasPendingInteraction || thread.queuedWork !== 'none') return 'Has pending thread work';
  if (Object.values(thread.activity).some(count => count !== 0)) return 'Has active background work';
  return null;
}

export async function inspect(sdk: PluginBbSdk, id: string, days: number, now: number, signal?: AbortSignal): Promise<Inspection> {
  const env = await sdk.environments.get({ environmentId: id, signal });
  const reason = environmentReason(env);
  if (reason) return { reason, unarchivedThreadCount: 0 };
  let lastUsed = env.updatedAt;
  let unarchivedThreadCount = 0;
  for (const archived of [false, true]) {
    for (let offset = 0; ; offset += 100) {
      if (offset >= 10000) return { reason: 'Too many threads to verify', unarchivedThreadCount };
      const threads = await sdk.threads.list({ environmentId: id, archived, includeHidden: true, limit: 100, offset, signal });
      for (const thread of threads) {
        if (archived && thread.archivedAt === null) return { reason: 'Thread archive state changed', unarchivedThreadCount };
        if (!archived) {
          if (thread.archivedAt !== null) return { reason: 'Thread archive state changed', unarchivedThreadCount };
          unarchivedThreadCount++;
          const unsafe = threadReason(thread);
          if (unsafe) return { reason: unsafe, unarchivedThreadCount };
        }
        lastUsed = Math.max(lastUsed, thread.archivedAt ?? 0, thread.updatedAt);
      }
      if (threads.length < 100) break;
    }
  }
  if (!Number.isFinite(lastUsed) || now - lastUsed < days * DAY) return { reason: 'Within retention period', unarchivedThreadCount };
  return { reason: gitReason(await sdk.environments.status({ environmentId: id, signal }), env), unarchivedThreadCount };
}
