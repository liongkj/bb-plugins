import assert from 'node:assert/strict';
import test from 'node:test';
import type { PluginBbSdk } from '@get-bb/plugin-sdk';
import { DAY, environmentReason, gitReason, inspect, type Environment, type GitStatus, type Thread } from './cleanup.js';

function environment(overrides: Partial<Environment> = {}): Environment {
  return {
    id: 'env_1', projectId: 'project_1', hostId: 'host_1', name: 'test',
    path: '/tmp/worktree', baseBranch: 'main', branchName: 'codex/test',
    defaultBranch: 'main', mergeBaseBranch: 'main', managed: true,
    isWorktree: true, isGitRepo: true, environmentProviderId: 'git-worktree',
    environmentProviderInstanceKey: null, environmentProviderSelection: null,
    workspaceProvisionType: 'managed-worktree', status: 'ready',
    lifecycle: { phase: 'active', retireAt: null, teardown: null },
    createdAt: 1, updatedAt: DAY,
    ...overrides,
  };
}

function status(overrides: Record<string, unknown> = {}): GitStatus {
  return {
    outcome: 'available',
    workspace: {
      branch: { currentBranch: 'codex/test', defaultBranch: 'main' },
      checkout: { kind: 'branch', branchName: 'codex/test', headSha: 'abc123' },
      mergeBase: {
        aheadCount: 0, behindCount: 0, baseRef: 'main', commits: [], files: [],
        insertions: 0, deletions: 0, lineStatsComplete: true,
        hasCommittedUnmergedChanges: false, mergeBaseBranch: 'main',
      },
      workingTree: {
        files: [], insertions: 0, deletions: 0, lineStatsComplete: true,
        hasUncommittedChanges: false, state: 'clean',
      },
      ...overrides,
    },
  } as GitStatus;
}

function thread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: 'thr_1', projectId: 'project_1', providerId: 'codex', title: 'Done',
    titleFallback: null, environmentId: 'env_1', environmentName: 'test',
    environmentPath: '/tmp/worktree', environmentBranchName: 'codex/test',
    environmentHostId: 'host_1', environmentProviderId: 'git-worktree',
    environmentIsWorktree: true, environmentWorkspaceDisplayKind: 'managed-worktree',
    parentThreadId: null, sourceThreadId: null, originKind: null, originPluginId: null,
    sectionId: null, visibility: 'visible', status: 'idle',
    runtime: { displayStatus: 'idle', hostReconnectGraceExpiresAt: null },
    queuedWork: 'none', hasPendingInteraction: false,
    activity: { activeBackgroundAgentCount: 0, activeBackgroundCommandCount: 0, activeGoalCount: 0, activePlanModeCount: 0, activeWorkflowCount: 0 },
    pinnedAt: null, pinSortKey: null, archivedAt: null, deletedAt: null,
    createdAt: DAY, updatedAt: DAY, latestAttentionAt: DAY, lastReadAt: null,
    ...overrides,
  };
}

test('rejects worktrees outside the narrow managed provider boundary', () => {
  assert.equal(environmentReason(environment({ managed: false })), 'Not a BB-managed Git worktree');
  assert.equal(environmentReason(environment({ branchName: 'main' })), 'Protected base branch');
});

test('rejects dirty and committed-unmerged worktrees', () => {
  assert.equal(gitReason(status({ workingTree: {
    files: [{ path: 'notes.txt', status: '??', insertions: null, deletions: null }],
    insertions: 0, deletions: 0, lineStatsComplete: true,
    hasUncommittedChanges: true, state: 'untracked',
  } }), environment()), 'Uncommitted or untracked changes');
  assert.equal(gitReason(status({ mergeBase: {
    aheadCount: 1, behindCount: 0, baseRef: 'main', commits: [], files: [],
    insertions: 0, deletions: 0, lineStatsComplete: true,
    hasCommittedUnmergedChanges: true, mergeBaseBranch: 'main',
  } }), environment()), 'Unmerged commits or unknown merge base');
});

test('rejects active or pinned threads and recent archived activity', async () => {
  const env = environment();
  const sdk = {
    environments: { get: async () => env, status: async () => status() },
    threads: { list: async ({ archived }: { archived?: boolean }) => archived ? [] : [thread({ status: 'active', runtime: { displayStatus: 'active', hostReconnectGraceExpiresAt: null } })] },
  } as unknown as PluginBbSdk;
  assert.equal((await inspect(sdk, env.id, 7, 20 * DAY)).reason, 'Has a thread that is not idle');

  const pinnedSdk = {
    environments: { get: async () => env, status: async () => status() },
    threads: { list: async ({ archived }: { archived?: boolean }) => archived ? [] : [thread({ pinnedAt: DAY })] },
  } as unknown as PluginBbSdk;
  assert.equal((await inspect(pinnedSdk, env.id, 7, 20 * DAY)).reason, 'Has a pinned thread');

  const recentSdk = {
    environments: { get: async () => env, status: async () => status() },
    threads: { list: async ({ archived }: { archived?: boolean }) => archived ? [thread({ archivedAt: 19 * DAY, updatedAt: 19 * DAY })] : [] },
  } as unknown as PluginBbSdk;
  assert.equal((await inspect(recentSdk, env.id, 7, 20 * DAY)).reason, 'Within retention period');
});

test('accepts an old, idle, clean and fully merged worktree', async () => {
  const env = environment();
  const sdk = {
    environments: { get: async () => env, status: async () => status() },
    threads: { list: async ({ archived }: { archived?: boolean }) => archived ? [] : [thread()] },
  } as unknown as PluginBbSdk;
  assert.deepEqual(await inspect(sdk, env.id, 7, 20 * DAY), { reason: null, unarchivedThreadCount: 1 });
});
