import { describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
  type FakePluginHost,
} from "@get-bb/plugin-sdk/testing";
import plugin from "./server";

const DAY = 24 * 60 * 60 * 1_000;
const MERGED_AT = new Date(7 * DAY).toISOString();

type ThreadOverrides = Parameters<typeof makeThreadResponse>[0];

function mergedThread(overrides: ThreadOverrides = {}) {
  return makeThreadResponse({
    id: "thr_1",
    title: "Fix the flaky test",
    environmentId: "env_1",
    status: "idle",
    pinnedAt: null,
    createdAt: DAY,
    updatedAt: 6 * DAY,
    latestAttentionAt: 6 * DAY,
    ...overrides,
  });
}

function probe(state: "merged" | "closed" | "open" | "draft") {
  return {
    outcome: "available",
    pullRequest: {
      state,
      updatedAt: MERGED_AT,
      number: 42,
      url: "https://example.test/pr/42",
    },
  };
}

const SIDEBAR_PLUGIN = { id: "bb-sidebar", enabled: true };

async function load(options: {
  threads?: ThreadOverrides[];
  pullRequest?: () => unknown;
  sidebar?: boolean;
  settings?: Record<string, boolean>;
}): Promise<FakePluginHost> {
  const { bb, harness } = createFakePluginHost({
    pluginId: "auto-settle",
    settings: options.settings ?? { dryRun: false },
    sdk: {
      threads: {
        list: async () => (options.threads ?? [{}]).map(mergedThread),
        archive: async () => ({}),
        stop: async () => ({}),
      },
      environments: {
        pullRequest: options.pullRequest ?? (async () => probe("merged")),
      },
      plugins: {
        list: async () => ({
          plugins: options.sidebar === false ? [] : [SIDEBAR_PLUGIN],
        }),
        callRpc: async () => ({ ok: true }),
      },
    },
  });
  await plugin(bb);
  return { bb, harness };
}

describe("auto-settle schedule", () => {
  it("delegates a merged pull request to BB Sidebar when it is installed", async () => {
    const { harness } = await load({});
    await harness.behavior.runSchedule("auto-settle");

    expect(harness.inspection.sdk.callsTo("plugins.callRpc")).toHaveLength(1);
    expect(harness.inspection.sdk.callsTo("threads.archive")).toHaveLength(0);
    expect(harness.inspection.sdk.callsTo("threads.stop")).toHaveLength(0);
  });

  it("archives and stops the runtime without BB Sidebar", async () => {
    const { harness } = await load({ sidebar: false });
    await harness.behavior.runSchedule("auto-settle");

    expect(harness.inspection.sdk.callsTo("threads.archive")).toHaveLength(1);
    expect(harness.inspection.sdk.callsTo("threads.stop")).toHaveLength(1);
    expect(harness.inspection.sdk.callsTo("plugins.callRpc")).toHaveLength(0);
  });

  it("ignores an open pull request", async () => {
    const { harness } = await load({
      pullRequest: async () => probe("open"),
      sidebar: false,
    });
    await harness.behavior.runSchedule("auto-settle");
    expect(harness.inspection.sdk.callsTo("threads.archive")).toHaveLength(0);
  });

  it("ignores a pinned thread without asking for its pull request", async () => {
    const { harness } = await load({
      threads: [{ pinnedAt: 8 * DAY }],
      sidebar: false,
    });
    await harness.behavior.runSchedule("auto-settle");
    expect(
      harness.inspection.sdk.callsTo("environments.pullRequest"),
    ).toHaveLength(0);
    expect(harness.inspection.sdk.callsTo("threads.archive")).toHaveLength(0);
  });

  it("keeps the current state when the pull request lookup fails", async () => {
    const { harness } = await load({
      pullRequest: async () => {
        throw new Error("github is down");
      },
      sidebar: false,
    });
    await harness.behavior.runSchedule("auto-settle");
    expect(harness.inspection.sdk.callsTo("threads.archive")).toHaveLength(0);
  });

  it("previews instead of settling while Preview only is on", async () => {
    const { bb, harness } = await load({
      settings: { dryRun: true },
      sidebar: false,
    });
    await harness.behavior.runSchedule("auto-settle");

    expect(harness.inspection.sdk.callsTo("threads.archive")).toHaveLength(0);
    const lastRun = await bb.storage.kv.get<{
      applied: boolean;
      previewed: unknown[];
    }>("lastRun");
    expect(lastRun?.applied).toBe(false);
    expect(lastRun?.previewed).toHaveLength(1);
  });

  it("settles when the CLI runs with --apply", async () => {
    const { harness } = await load({
      settings: { dryRun: true },
      sidebar: false,
    });
    const result = await harness.behavior.runCli(["run", "--apply"]);
    expect(result.exitCode).toBe(0);
    expect(harness.inspection.sdk.callsTo("threads.archive")).toHaveLength(1);
  });

  it("settles a thread only once while it stays quiet", async () => {
    const { harness } = await load({ sidebar: false });
    await harness.behavior.runSchedule("auto-settle");
    await harness.behavior.runSchedule("auto-settle");
    expect(harness.inspection.sdk.callsTo("threads.archive")).toHaveLength(1);
  });

  it("does nothing while the plugin is disabled", async () => {
    const { harness } = await load({
      settings: { dryRun: false, enabled: false },
      sidebar: false,
    });
    await harness.behavior.runSchedule("auto-settle");
    expect(harness.inspection.sdk.callsTo("threads.archive")).toHaveLength(0);
  });

  it("clears a thread's settle record after new activity", async () => {
    const { bb, harness } = await load({ sidebar: false });
    await harness.behavior.runSchedule("auto-settle");
    expect(await bb.storage.kv.get<Record<string, unknown>>("ledger")).toHaveProperty(
      "thr_1",
    );

    await harness.behavior.emitThreadEvent("thread.active", {
      thread: mergedThread({ status: "active" }),
    });
    expect(await bb.storage.kv.get<Record<string, unknown>>("ledger")).not.toHaveProperty(
      "thr_1",
    );
  });
});
