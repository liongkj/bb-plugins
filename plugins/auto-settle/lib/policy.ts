// Pure settle-on-merge policy.
//
// The merge rule is adapted from the MIT-licensed bb-sidebar plugin
// (github.com/yusuf8834/bb-sidebar, src/auto-settle.ts). It is narrowed to the
// terminal pull-request rules and kept free of SDK calls so the decision is
// unit-testable without a bb server.

export const DAY_MS = 24 * 60 * 60 * 1_000;
export const MIN_INACTIVE_DAYS = 1;
export const MAX_INACTIVE_DAYS = 90;

export type ThreadStatus =
  | "active"
  | "error"
  | "idle"
  | "pending"
  | "starting"
  | "stopping";

/** The subset of a thread that the policy reads. */
export interface SettleThread {
  id: string;
  title: string | null;
  environmentId: string | null;
  createdAt: number;
  latestAttentionAt: number;
  pinnedAt: number | null;
  status: ThreadStatus;
  updatedAt: number;
}

export type PullRequestState = "closed" | "draft" | "merged" | "open";

/** A pull-request probe. `unknown` means the lookup failed, not that none exists. */
export type PullRequestProbe =
  | { outcome: "absent" }
  | { outcome: "unknown" }
  | {
      outcome: "available";
      state: PullRequestState;
      updatedAt: string;
      number: number | null;
      url: string | null;
    };

export interface AutoSettlePolicy {
  settleMerged: boolean;
  settleClosed: boolean;
  /** `null` disables the inactivity rule. */
  inactiveAfterDays: number | null;
}

export type AutoSettleDecision = "keep" | "settle";

/**
 * A thread that is pinned or not at rest must not be settled: parking it would
 * hide or interrupt live work.
 */
function cannotSettle(thread: SettleThread): boolean {
  return (
    thread.pinnedAt !== null ||
    thread.status === "active" ||
    thread.status === "pending" ||
    thread.status === "starting" ||
    thread.status === "stopping"
  );
}

/** Whether deciding this thread's state needs a pull-request lookup at all. */
export function needsPullRequestProbe(thread: SettleThread): boolean {
  return !cannotSettle(thread);
}

/** Invalid settings disable the inactivity rule instead of hiding work. */
export function parseInactiveDays(
  enabled: boolean,
  rawDays: number,
): number | null {
  if (!enabled) return null;
  return Number.isInteger(rawDays) &&
    rawDays >= MIN_INACTIVE_DAYS &&
    rawDays <= MAX_INACTIVE_DAYS
    ? rawDays
    : null;
}

export function decideAutoSettle({
  thread,
  probe,
  policy,
  settledAt,
  now,
}: {
  thread: SettleThread;
  probe: PullRequestProbe;
  policy: AutoSettlePolicy;
  /** When this plugin already settled the thread; `null` when it did not. */
  settledAt: number | null;
  now: number;
}): AutoSettleDecision {
  if (cannotSettle(thread)) return "keep";

  // A failed lookup is not evidence that no open pull request exists. Keep the
  // current state until the next evaluation can make a safe decision.
  if (probe.outcome === "unknown") return "keep";

  const activityAt = Math.max(
    thread.createdAt,
    thread.updatedAt,
    thread.latestAttentionAt,
  );

  // Already settled and nothing happened since: do not settle it again. This
  // only matters when bb-sidebar keeps the thread in the list after settling.
  if (settledAt !== null && activityAt <= settledAt) return "keep";

  if (probe.outcome === "available") {
    const terminal =
      (probe.state === "merged" && policy.settleMerged) ||
      (probe.state === "closed" && policy.settleClosed);
    if (terminal) {
      const pullRequestUpdatedAt = Date.parse(probe.updatedAt);
      // A malformed terminal timestamp is not evidence that the pull request
      // finished after the thread's last activity.
      if (Number.isNaN(pullRequestUpdatedAt)) return "keep";
      if (pullRequestUpdatedAt >= activityAt) return "settle";
    }

    // Draft and open pull requests are open work. They never fall through to
    // the inactivity rule.
    if (probe.state === "open" || probe.state === "draft") return "keep";
  }

  if (
    policy.inactiveAfterDays !== null &&
    activityAt < now - policy.inactiveAfterDays * DAY_MS
  ) {
    return "settle";
  }

  return "keep";
}
