// bb-plugin-auto-settle — settle a thread when its pull request finishes.
//
// Every five minutes the plugin reads the active threads, asks bb for each
// thread's pull request, and settles the threads whose pull request is merged
// (or closed, when that is enabled). It works in two places:
//
//   - With the BB Sidebar plugin installed, it calls that plugin's `settle`
//     RPC, so the thread lands on Sidebar's settled shelf and Sidebar releases
//     the thread runtime.
//   - Without BB Sidebar, it archives the thread and stops its runtime, which
//     the default BB sidebar respects.
//
// Keep the decision itself in lib/policy.ts. This file only reads threads,
// loads pull requests, and applies the result.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  decideAutoSettle,
  needsPullRequestProbe,
  parseInactiveDays,
  type AutoSettlePolicy,
  type PullRequestProbe,
  type SettleThread,
} from "./lib/policy";

const SIDEBAR_PLUGIN_ID = "bb-sidebar";
const SIDEBAR_SETTLE_METHOD = "settle";
const LEDGER_KEY = "ledger";
const LAST_RUN_KEY = "lastRun";
const PAGE_SIZE = 500;
const MAX_THREADS = 5_000;
const MAX_PROBE_CONCURRENCY = 4;
const LEDGER_MAX = 500;
const REPORT_MAX = 50;

type SettleMechanism = "sidebar" | "archive" | "stop";

interface SettlementRecord {
  threadId: string;
  title: string;
  settledAt: number;
  mechanism: SettleMechanism;
  prNumber: number | null;
  prUrl: string | null;
}

interface PreviewRecord {
  threadId: string;
  title: string;
  prNumber: number | null;
  prUrl: string | null;
}

interface RunSummary {
  at: number;
  applied: boolean;
  /** Active threads that were scanned. */
  evaluated: number;
  /** Scanned threads whose pull request was looked up. */
  probed: number;
  /** Scanned threads the policy decided to settle. */
  matched: number;
  settled: SettlementRecord[];
  previewed: PreviewRecord[];
  skipped: number;
  failures: { threadId: string; error: string }[];
}

type WithoutSidebar = "archive" | "stop" | "skip";

/** BB Sidebar's `settle` result is `{ ok, reclaim }`; we only need `ok`. */
const sidebarSettleOutput = z
  .object({ ok: z.boolean() })
  .catchall(z.unknown());

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");

  const settings = bb.settings.define({
    enabled: {
      type: "boolean",
      label: "Run the settle schedule",
      description: "Check the active threads every five minutes.",
      default: true,
    },
    settleMerged: {
      type: "boolean",
      label: "Settle merged pull requests",
      description: "Settle a thread when its pull request is merged.",
      default: true,
    },
    settleClosed: {
      type: "boolean",
      label: "Settle closed pull requests",
      description:
        "Also settle a thread when its pull request is closed without merging.",
      default: false,
    },
    settleInactive: {
      type: "boolean",
      label: "Settle inactive threads",
      description: "Also settle a thread after a period without activity.",
      default: false,
    },
    inactiveAfterDays: {
      type: "number",
      label: "Inactive after (days)",
      experimental_schema: z.number().int().min(1).max(90),
      default: 3,
    },
    withoutSidebar: {
      type: "select",
      label: "Without BB Sidebar",
      description:
        "What to do when the BB Sidebar plugin is not installed or is disabled.",
      options: ["archive", "stop", "skip"],
      default: "archive",
    },
    dryRun: {
      type: "boolean",
      label: "Preview only",
      description:
        "Report the threads that would settle, but do not settle them.",
      default: true,
    },
  });

  async function readConfig(): Promise<{
    enabled: boolean;
    policy: AutoSettlePolicy;
    withoutSidebar: WithoutSidebar;
    dryRun: boolean;
  }> {
    const values = await settings.get();
    return {
      enabled: values.enabled,
      policy: {
        settleMerged: values.settleMerged,
        settleClosed: values.settleClosed,
        inactiveAfterDays: parseInactiveDays(
          values.settleInactive,
          values.inactiveAfterDays,
        ),
      },
      withoutSidebar: values.withoutSidebar as WithoutSidebar,
      dryRun: values.dryRun,
    };
  }

  async function readLedger(): Promise<Record<string, SettlementRecord>> {
    return (await bb.storage.kv.get<Record<string, SettlementRecord>>(LEDGER_KEY)) ?? {};
  }

  function addRecord(
    ledger: Record<string, SettlementRecord>,
    record: SettlementRecord,
  ): Record<string, SettlementRecord> {
    const entries = Object.entries({ ...ledger, [record.threadId]: record });
    if (entries.length <= LEDGER_MAX) return Object.fromEntries(entries);
    entries.sort((left, right) => left[1].settledAt - right[1].settledAt);
    return Object.fromEntries(entries.slice(entries.length - LEDGER_MAX));
  }

  function toSettleThread(thread: Awaited<
    ReturnType<typeof bb.sdk.threads.list>
  >[number]): SettleThread {
    return {
      id: thread.id,
      title: thread.title,
      environmentId: thread.environmentId,
      createdAt: thread.createdAt,
      latestAttentionAt: thread.latestAttentionAt,
      pinnedAt: thread.pinnedAt,
      status: thread.status,
      updatedAt: thread.updatedAt,
    };
  }

  async function loadPolicyThreads(): Promise<SettleThread[]> {
    const threads: SettleThread[] = [];
    for (let offset = 0; offset < MAX_THREADS; offset += PAGE_SIZE) {
      const page = await bb.sdk.threads.list({
        archived: false,
        includeHidden: false,
        limit: PAGE_SIZE,
        offset,
      });
      threads.push(...page.map(toSettleThread));
      if (page.length < PAGE_SIZE) break;
    }
    return threads;
  }

  async function probePullRequest(
    environmentId: string,
  ): Promise<PullRequestProbe> {
    try {
      const result = await bb.sdk.environments.pullRequest({ environmentId });
      if (result.outcome === "available") {
        return {
          outcome: "available",
          state: result.pullRequest.state,
          updatedAt: result.pullRequest.updatedAt,
          number: result.pullRequest.number,
          url: result.pullRequest.url,
        };
      }
      if (result.outcome === "absent") return { outcome: "absent" };
      return { outcome: "unknown" };
    } catch (error) {
      bb.log.warn(
        `Pull request lookup failed for ${environmentId}: ${message(error)}`,
      );
      return { outcome: "unknown" };
    }
  }

  async function loadProbes(
    environmentIds: string[],
  ): Promise<Map<string, PullRequestProbe>> {
    const probes = new Map<string, PullRequestProbe>();
    let nextIndex = 0;
    const workers = Array.from(
      { length: Math.min(MAX_PROBE_CONCURRENCY, environmentIds.length) },
      async () => {
        while (nextIndex < environmentIds.length) {
          const environmentId = environmentIds[nextIndex++]!;
          probes.set(environmentId, await probePullRequest(environmentId));
        }
      },
    );
    await Promise.all(workers);
    return probes;
  }

  async function sidebarAvailable(): Promise<boolean> {
    try {
      const { plugins } = await bb.sdk.plugins.list();
      return plugins.some(
        (candidate) =>
          candidate.id === SIDEBAR_PLUGIN_ID && candidate.enabled,
      );
    } catch (error) {
      bb.log.warn(`Could not list the installed plugins: ${message(error)}`);
      return false;
    }
  }

  /** Settle one thread. Throws when a real action fails. */
  async function settleThread(
    thread: SettleThread,
    withoutSidebar: WithoutSidebar,
    sidebar: boolean,
  ): Promise<SettleMechanism | "skip"> {
    if (sidebar) {
      try {
        await bb.sdk.plugins.callRpc({
          pluginId: SIDEBAR_PLUGIN_ID,
          method: SIDEBAR_SETTLE_METHOD,
          input: { threadId: thread.id },
          outputSchema: sidebarSettleOutput,
        });
        return "sidebar";
      } catch (error) {
        bb.log.warn(
          `BB Sidebar settle failed for ${thread.id}: ${message(error)}. Using the fallback.`,
        );
      }
    }

    if (withoutSidebar === "skip") return "skip";
    if (withoutSidebar === "stop") {
      await bb.sdk.threads.stop({ threadId: thread.id });
      return "stop";
    }

    await bb.sdk.threads.archive({ threadId: thread.id });
    try {
      // Archive closes terminals and stops a running turn. An idle runtime
      // that a stop cannot reach is a missed reclaim, not a broken settle.
      await bb.sdk.threads.stop({ threadId: thread.id });
    } catch (error) {
      bb.log.debug(
        `Could not stop the runtime for ${thread.id}: ${message(error)}`,
      );
    }
    return "archive";
  }

  async function runEvaluation(options: {
    apply?: boolean;
    record: boolean;
  }): Promise<RunSummary> {
    const config = await readConfig();
    const apply = options.apply ?? !config.dryRun;
    const now = Date.now();

    const threads = await loadPolicyThreads();
    const ledger = await readLedger();
    const candidates = threads.filter(needsPullRequestProbe);
    const environmentIds = [
      ...new Set(
        candidates.flatMap((thread) =>
          thread.environmentId === null ? [] : [thread.environmentId],
        ),
      ),
    ];
    const probes = await loadProbes(environmentIds);

    const decided: {
      thread: SettleThread;
      probe: PullRequestProbe;
    }[] = [];
    for (const thread of candidates) {
      const probe =
        thread.environmentId === null
          ? ({ outcome: "absent" } as const)
          : (probes.get(thread.environmentId) ?? { outcome: "unknown" });
      const decision = decideAutoSettle({
        thread,
        probe,
        policy: config.policy,
        settledAt: ledger[thread.id]?.settledAt ?? null,
        now,
      });
      if (decision === "settle") decided.push({ thread, probe });
    }

    const settled: SettlementRecord[] = [];
    const previewed: PreviewRecord[] = [];
    const failures: { threadId: string; error: string }[] = [];
    let skipped = 0;

    const describe = (probe: PullRequestProbe) => ({
      prNumber: probe.outcome === "available" ? probe.number : null,
      prUrl: probe.outcome === "available" ? probe.url : null,
    });

    if (apply) {
      const sidebar = await sidebarAvailable();
      for (const { thread, probe } of decided) {
        try {
          const mechanism = await settleThread(
            thread,
            config.withoutSidebar,
            sidebar,
          );
          if (mechanism === "skip") {
            skipped += 1;
            continue;
          }
          settled.push({
            threadId: thread.id,
            title: thread.title ?? "",
            settledAt: now,
            mechanism,
            ...describe(probe),
          });
        } catch (error) {
          failures.push({ threadId: thread.id, error: message(error) });
        }
      }
      if (settled.length > 0) {
        let next = ledger;
        for (const record of settled) next = addRecord(next, record);
        await bb.storage.kv.set(LEDGER_KEY, next);
      }
    } else {
      for (const { thread, probe } of decided) {
        previewed.push({
          threadId: thread.id,
          title: thread.title ?? "",
          ...describe(probe),
        });
      }
    }

    const summary: RunSummary = {
      at: now,
      applied: apply,
      evaluated: threads.length,
      probed: candidates.filter((thread) => thread.environmentId !== null).length,
      matched: decided.length,
      settled: settled.slice(0, REPORT_MAX),
      previewed: previewed.slice(0, REPORT_MAX),
      skipped,
      failures: failures.slice(0, REPORT_MAX),
    };
    if (options.record) await bb.storage.kv.set(LAST_RUN_KEY, summary);

    if (!apply && previewed.length > 0) {
      bb.log.info(
        `Preview: ${previewed.length} thread(s) would settle. Set "Preview only" to false to apply.`,
      );
    } else if (settled.length > 0) {
      bb.log.info(`Settled ${settled.length} thread(s).`);
    }
    if (failures.length > 0) {
      bb.log.warn(`${failures.length} thread(s) could not be settled.`);
    }
    return summary;
  }

  let running: Promise<RunSummary> | null = null;
  function evaluate(options?: {
    apply?: boolean;
    record?: boolean;
  }): Promise<RunSummary> {
    if (running !== null) {
      bb.log.debug("An evaluation is already running; reusing its result.");
      return running;
    }
    const current = runEvaluation({
      apply: options?.apply,
      record: options?.record ?? true,
    }).finally(() => {
      if (running === current) running = null;
    });
    running = current;
    return current;
  }

  bb.background.schedule("auto-settle", "*/5 * * * *", async () => {
    const config = await readConfig();
    if (!config.enabled) return;
    await evaluate();
  });

  // Real work clears the settle record, so a resumed thread is judged again.
  // An unarchive does not clear it: the user's revival must not let the merge
  // rule archive the same thread again on the next run.
  bb.events.on("thread.active", async ({ thread }) => {
    await clearSettleRecord(thread.id);
  });
  bb.events.on("thread.deleted", async ({ thread }) => {
    await clearSettleRecord(thread.id);
  });

  async function clearSettleRecord(threadId: string): Promise<void> {
    const ledger = await readLedger();
    if (!(threadId in ledger)) return;
    const { [threadId]: _removed, ...rest } = ledger;
    await bb.storage.kv.set(LEDGER_KEY, rest);
  }

  settings.onChange(() => {
    // Apply a settings change at once. A live change must not wait for the
    // five-minute schedule, and a disabled plugin stays idle.
    void (async () => {
      const config = await readConfig();
      if (!config.enabled) return;
      await evaluate();
    })().catch((error) => {
      bb.log.error(`Evaluation after a settings change failed: ${message(error)}`);
    });
  });

  const usage = [
    "Usage:",
    "  bb auto-settle status [--json]",
    "  bb auto-settle preview [--json]",
    "  bb auto-settle run [--apply] [--json]",
    "  bb auto-settle settle <thread-id>",
    "  bb auto-settle forget <thread-id>",
  ].join("\n");

  function formatSettlement(record: SettlementRecord): string {
    return `${record.threadId}  ${record.mechanism.padEnd(7)}  ${record.title}${
      record.prNumber === null ? "" : `  (#${record.prNumber})`
    }`;
  }

  bb.cli.register({
    name: "auto-settle",
    summary: "Settle BB threads whose pull requests are merged",
    commands: [
      {
        name: "status",
        summary: "Show settings and the last run",
        usage: "bb auto-settle status [--json]",
      },
      {
        name: "preview",
        summary: "List the threads that would settle now",
        usage: "bb auto-settle preview [--json]",
      },
      {
        name: "run",
        summary: "Evaluate now; --apply settles even in preview mode",
        usage: "bb auto-settle run [--apply] [--json]",
      },
      {
        name: "settle",
        summary: "Settle one thread now, whatever the settings say",
        usage: "bb auto-settle settle <thread-id>",
      },
      {
        name: "forget",
        summary: "Clear one thread's settle record so it is judged again",
        usage: "bb auto-settle forget <thread-id>",
      },
    ],
    async run(argv) {
      const json = argv.includes("--json");
      const apply = argv.includes("--apply");
      const [command, ...args] = argv.filter(
        (arg) => arg !== "--json" && arg !== "--apply",
      );
      const reply = (value: unknown, text: string) => ({
        exitCode: 0,
        stdout: json ? JSON.stringify(value) : text,
      });

      switch (command) {
        case undefined:
        case "help":
        case "--help":
          return { exitCode: 0, stdout: usage };

        case "status": {
          const config = await readConfig();
          const lastRun = await bb.storage.kv.get<RunSummary>(LAST_RUN_KEY);
          const ledger = Object.values(await readLedger()).sort(
            (left, right) => right.settledAt - left.settledAt,
          );
          if (json) {
            return reply(
              {
                settings: config,
                sidebar: await sidebarAvailable(),
                lastRun: lastRun ?? null,
                recent: ledger.slice(0, 20),
              },
              "",
            );
          }
          const lines = [
            `enabled:           ${config.enabled}`,
            `preview only:      ${config.dryRun}`,
            `settle merged:     ${config.policy.settleMerged}`,
            `settle closed:     ${config.policy.settleClosed}`,
            `inactive after:    ${
              config.policy.inactiveAfterDays === null
                ? "off"
                : `${config.policy.inactiveAfterDays} day(s)`
            }`,
            `without sidebar:   ${config.withoutSidebar}`,
            `BB Sidebar:        ${
              (await sidebarAvailable()) ? "installed" : "not installed"
            }`,
            lastRun === undefined
              ? "last run:          never"
              : `last run:          ${new Date(lastRun.at).toISOString()} (${
                  lastRun.applied ? "applied" : "preview"
                }, ${lastRun.settled.length} settled, ${lastRun.previewed.length} previewed, ${lastRun.failures.length} failed)`,
          ];
          if (ledger.length > 0) {
            lines.push("", "Recently settled:");
            lines.push(...ledger.slice(0, 10).map((record) => `  ${formatSettlement(record)}`));
          }
          return { exitCode: 0, stdout: lines.join("\n") };
        }

        case "preview": {
          const summary = await evaluate({ apply: false, record: false });
          if (json) return reply(summary, "");
          if (summary.previewed.length === 0) {
            return { exitCode: 0, stdout: "Nothing to settle." };
          }
          return reply(
            summary,
            [
              `${summary.previewed.length} thread(s) would settle:`,
              ...summary.previewed.map(
                (entry) =>
                  `  ${entry.threadId}  ${entry.title}${
                    entry.prNumber === null ? "" : `  (#${entry.prNumber})`
                  }`,
              ),
            ].join("\n"),
          );
        }

        case "run": {
          const summary = await evaluate({
            apply: apply ? true : undefined,
          });
          if (json) return reply(summary, "");
          const lines = summary.applied
            ? summary.settled.map((record) => `  ${formatSettlement(record)}`)
            : summary.previewed.map(
                (entry) => `  ${entry.threadId}  ${entry.title} (preview)`,
              );
          if (lines.length === 0) {
            return { exitCode: 0, stdout: "Nothing to settle." };
          }
          const heading = summary.applied
            ? `Settled ${summary.settled.length} thread(s):`
            : `Preview only; ${summary.previewed.length} thread(s) would settle:`;
          return reply(summary, [heading, ...lines].join("\n"));
        }

        case "settle": {
          const threadId = args[0];
          if (threadId === undefined || args.length !== 1) {
            return { exitCode: 1, stderr: usage };
          }
          const config = await readConfig();
          const thread = (await loadPolicyThreads()).find(
            (candidate) => candidate.id === threadId,
          );
          if (thread === undefined) {
            return {
              exitCode: 1,
              stderr: `Thread ${threadId} is not an active thread.`,
            };
          }
          const mechanism = await settleThread(
            thread,
            config.withoutSidebar,
            await sidebarAvailable(),
          );
          if (mechanism === "skip") {
            return {
              exitCode: 1,
              stderr:
                "The fallback is \"skip\" and BB Sidebar is not available, so nothing changed.",
            };
          }
          return reply({ threadId, mechanism }, `Settled ${threadId} (${mechanism}).`);
        }

        case "forget": {
          const threadId = args[0];
          if (threadId === undefined || args.length !== 1) {
            return { exitCode: 1, stderr: usage };
          }
          await clearSettleRecord(threadId);
          return reply({ threadId }, `Cleared the settle record for ${threadId}.`);
        }
      }

      return { exitCode: 1, stderr: usage };
    },
  });

  bb.onDispose(() => {
    bb.log.debug("disposed");
  });
}
