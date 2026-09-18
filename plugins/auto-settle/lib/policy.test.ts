import { describe, expect, it } from "vitest";
import {
  decideAutoSettle,
  needsPullRequestProbe,
  parseInactiveDays,
  type AutoSettlePolicy,
  type PullRequestProbe,
  type SettleThread,
} from "./policy";

const DAY = 24 * 60 * 60 * 1_000;
const NOW = 10 * DAY;

const quietThread: SettleThread = {
  id: "thr_1",
  title: "Fix the flaky test",
  environmentId: "env_1",
  createdAt: DAY,
  latestAttentionAt: 6 * DAY,
  pinnedAt: null,
  status: "idle",
  updatedAt: 6 * DAY,
};

const mergeOnly: AutoSettlePolicy = {
  settleMerged: true,
  settleClosed: false,
  inactiveAfterDays: null,
};

function decision(
  overrides: {
    thread?: Partial<SettleThread>;
    probe?: PullRequestProbe;
    policy?: Partial<AutoSettlePolicy>;
    settledAt?: number | null;
  } = {},
) {
  return decideAutoSettle({
    thread: { ...quietThread, ...overrides.thread },
    probe: overrides.probe ?? { outcome: "absent" },
    policy: { ...mergeOnly, ...overrides.policy },
    settledAt: overrides.settledAt ?? null,
    now: NOW,
  });
}

describe("needsPullRequestProbe", () => {
  it("skips pinned and non-idle threads", () => {
    expect(needsPullRequestProbe(quietThread)).toBe(true);
    for (const status of ["active", "pending", "starting", "stopping"] as const) {
      expect(needsPullRequestProbe({ ...quietThread, status })).toBe(false);
    }
    expect(needsPullRequestProbe({ ...quietThread, pinnedAt: NOW })).toBe(false);
  });
});

describe("parseInactiveDays", () => {
  it("accepts only configured thresholds from 1 through 90", () => {
    expect(parseInactiveDays(true, 3)).toBe(3);
    expect(parseInactiveDays(true, 1)).toBe(1);
    expect(parseInactiveDays(true, 90)).toBe(90);
    expect(parseInactiveDays(false, 3)).toBeNull();
    expect(parseInactiveDays(true, 0)).toBeNull();
    expect(parseInactiveDays(true, 3.5)).toBeNull();
    expect(parseInactiveDays(true, 91)).toBeNull();
  });
});

describe("decideAutoSettle", () => {
  it("settles a merged pull request that is newer than the thread activity", () => {
    expect(
      decision({
        probe: {
          outcome: "available",
          state: "merged",
          updatedAt: new Date(7 * DAY).toISOString(),
          number: 42,
          url: "https://example.test/pr/42",
        },
      }),
    ).toBe("settle");
  });

  it("keeps open and draft pull requests active", () => {
    for (const state of ["open", "draft"] as const) {
      expect(
        decision({
          probe: {
            outcome: "available",
            state,
            updatedAt: new Date(NOW).toISOString(),
            number: 7,
            url: null,
          },
        }),
      ).toBe("keep");
    }
  });

  it("settles no pull request by default", () => {
    expect(decision({ probe: { outcome: "absent" } })).toBe("keep");
  });

  it("respects the merged and closed switches", () => {
    const merged = {
      outcome: "available",
      state: "merged",
      updatedAt: new Date(7 * DAY).toISOString(),
      number: 1,
      url: null,
    } as const;
    const closed = { ...merged, state: "closed" } as const;

    expect(decision({ probe: merged, policy: { settleMerged: false } })).toBe(
      "keep",
    );
    expect(decision({ probe: closed, policy: { settleClosed: true } })).toBe(
      "settle",
    );
    expect(decision({ probe: closed, policy: { settleClosed: false } })).toBe(
      "keep",
    );
  });

  it("does not settle when activity postdates the merge", () => {
    expect(
      decision({
        thread: { updatedAt: 8 * DAY },
        probe: {
          outcome: "available",
          state: "merged",
          updatedAt: new Date(7 * DAY).toISOString(),
          number: 1,
          url: null,
        },
      }),
    ).toBe("keep");
  });

  it("keeps the current state when a terminal timestamp is malformed", () => {
    expect(
      decision({
        probe: {
          outcome: "available",
          state: "merged",
          updatedAt: "not-a-timestamp",
          number: 1,
          url: null,
        },
      }),
    ).toBe("keep");
  });

  it("never settles pinned, busy, or unknown lookups", () => {
    expect(decision({ thread: { pinnedAt: NOW } })).toBe("keep");
    expect(decision({ thread: { status: "active" } })).toBe("keep");
    expect(decision({ probe: { outcome: "unknown" } })).toBe("keep");
  });

  it("does not settle the same thread twice while it stays quiet", () => {
    expect(
      decision({
        settledAt: 7 * DAY,
        probe: {
          outcome: "available",
          state: "merged",
          updatedAt: new Date(7 * DAY).toISOString(),
          number: 1,
          url: null,
        },
      }),
    ).toBe("keep");
  });

  it("re-evaluates after fresh activity clears the settle record", () => {
    // Activity after the merge: the merge rule no longer applies, and the
    // inactivity rule is off, so the thread stays active.
    expect(
      decision({
        thread: { updatedAt: 9 * DAY },
        settledAt: 7 * DAY,
        probe: {
          outcome: "available",
          state: "merged",
          updatedAt: new Date(7 * DAY).toISOString(),
          number: 1,
          url: null,
        },
      }),
    ).toBe("keep");
  });

  it("applies the inactivity rule only when it is enabled", () => {
    const old: Partial<SettleThread> = { updatedAt: 1 * DAY, latestAttentionAt: 1 * DAY };
    expect(decision({ thread: old })).toBe("keep");
    expect(
      decision({ thread: old, policy: { inactiveAfterDays: 3 } }),
    ).toBe("settle");
    // An open pull request blocks inactivity settling.
    expect(
      decision({
        thread: old,
        policy: { inactiveAfterDays: 3 },
        probe: {
          outcome: "available",
          state: "open",
          updatedAt: new Date(NOW).toISOString(),
          number: 1,
          url: null,
        },
      }),
    ).toBe("keep");
  });
});
