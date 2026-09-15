import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

const tokenBreakdownSchema = z
  .object({
    cachedInputTokens: z.number(),
    inputTokens: z.number(),
    outputTokens: z.number(),
    reasoningOutputTokens: z.number(),
    totalTokens: z.number(),
  })
  .strict();

const cacheAccountingSchema = z.enum(["inclusive", "separate", "unknown"]);
const contextWindowSchema = z
  .object({
    estimated: z.boolean(),
    modelContextWindow: z.number().nullable(),
    usedTokens: z.number().nullable(),
  })
  .strict();

type TokenBreakdown = z.infer<typeof tokenBreakdownSchema>;
type CacheAccounting = z.infer<typeof cacheAccountingSchema>;
type ContextWindow = z.infer<typeof contextWindowSchema>;

const usageSchema = z
  .object({
    cacheAccounting: cacheAccountingSchema,
    recordedAt: z.number().int().nonnegative(),
    last: tokenBreakdownSchema,
    modelContextWindow: z.number().nullable(),
    contextWindow: contextWindowSchema.nullable(),
    total: tokenBreakdownSchema,
  })
  .strict();

const usageTimelinePointSchema = z
  .object({
    cacheAccounting: cacheAccountingSchema,
    last: tokenBreakdownSchema,
    recordedAt: z.number().int().nonnegative(),
  })
  .strict();

export type ThreadUsage = z.infer<typeof usageSchema>;
export type UsageTimelinePoint = z.infer<typeof usageTimelinePointSchema>;

export const rpcContract = defineRpcContract({
  usage_batch: {
    input: z
      .object({
        threadIds: z.array(z.string().min(1).max(200)).max(1_000),
      })
      .strict(),
    output: z
      .object({
        usages: z
          .array(
            z
              .object({
                threadId: z.string(),
                usage: usageSchema.nullable(),
              })
              .strict(),
          )
          .max(1_000),
      })
      .strict(),
  },
  usage_timeline: {
    input: z
      .object({
        threadId: z.string().min(1).max(200),
      })
      .strict(),
    output: z
      .object({
        points: z.array(usageTimelinePointSchema).max(60),
      })
      .strict(),
  },
});

type UsageResult = { threadId: string; usage: ThreadUsage | null };

const CACHE_DEBUG_PREFIX = "[cache-debug]";
const loggedCacheDiagnosticKeys = new Set<string>();

function inferCacheAccounting(
  breakdowns: readonly TokenBreakdown[],
): CacheAccounting {
  for (const breakdown of breakdowns) {
    if (breakdown.cachedInputTokens <= 0) continue;

    const inputInclusiveTotal =
      breakdown.inputTokens + breakdown.outputTokens;
    const separateInputTotal =
      inputInclusiveTotal + breakdown.cachedInputTokens;

    if (
      breakdown.totalTokens === separateInputTotal &&
      breakdown.totalTokens !== inputInclusiveTotal
    ) {
      return "separate";
    }

    if (
      breakdown.totalTokens === inputInclusiveTotal &&
      breakdown.totalTokens !== separateInputTotal
    ) {
      return "inclusive";
    }
  }

  return "unknown";
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const run = async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= values.length) return;
      results[index] = await worker(values[index]!);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () => run()),
  );
  return results;
}

async function latestUsage(bb: BbPluginApi, threadId: string): Promise<ThreadUsage | null> {
  const [tokenUsageEvents, contextWindowEvents] = await Promise.all([
    bb.sdk.threads.events.list({
      threadId,
      types: ["thread/tokenUsage/updated"],
      order: "desc",
      limit: "1",
    }),
    bb.sdk.threads.events.list({
      threadId,
      types: ["thread/contextWindowUsage/updated"],
      order: "desc",
      limit: "1",
    }),
  ]);
  const tokenUsageEvent = tokenUsageEvents[0];
  if (tokenUsageEvent?.type !== "thread/tokenUsage/updated") return null;

  const contextWindowEvent = contextWindowEvents[0];
  const contextWindow: ContextWindow | null =
    contextWindowEvent?.type === "thread/contextWindowUsage/updated"
      ? {
          estimated: contextWindowEvent.data.contextWindowUsage.estimated,
          modelContextWindow:
            contextWindowEvent.data.contextWindowUsage.modelContextWindow,
          usedTokens: contextWindowEvent.data.contextWindowUsage.usedTokens,
        }
      : null;

  return {
    cacheAccounting: inferCacheAccounting([
      tokenUsageEvent.data.tokenUsage.total,
      tokenUsageEvent.data.tokenUsage.last,
    ]),
    recordedAt: tokenUsageEvent.createdAt,
    last: tokenUsageEvent.data.tokenUsage.last,
    modelContextWindow: tokenUsageEvent.data.tokenUsage.modelContextWindow,
    contextWindow,
    total: tokenUsageEvent.data.tokenUsage.total,
  };
}

async function usageTimeline(
  bb: BbPluginApi,
  threadId: string,
): Promise<UsageTimelinePoint[]> {
  const events = await bb.sdk.threads.events.list({
    threadId,
    types: ["thread/tokenUsage/updated"],
    order: "desc",
    limit: "60",
  });

  const points: UsageTimelinePoint[] = [];
  for (const event of events) {
    if (event.type !== "thread/tokenUsage/updated") continue;
    points.push({
      cacheAccounting: inferCacheAccounting([
        event.data.tokenUsage.total,
        event.data.tokenUsage.last,
      ]),
      last: event.data.tokenUsage.last,
      recordedAt: event.createdAt,
    });
  }

  return points.reverse();
}

function logCacheDiagnostic(
  bb: BbPluginApi,
  threadId: string,
  point: UsageTimelinePoint,
  previous: UsageTimelinePoint | undefined,
  isLatestInWindow: boolean,
): void {
  if (point.last.inputTokens <= 0) return;

  const cachedInputTokens = Math.max(0, point.last.cachedInputTokens);
  const uncachedInputTokens =
    point.cacheAccounting === "separate"
      ? Math.max(0, point.last.inputTokens)
      : Math.max(0, point.last.inputTokens - cachedInputTokens);
  if (uncachedInputTokens === 0) return;

  const diagnosticKey = threadId + ":" + String(point.recordedAt);
  if (loggedCacheDiagnosticKeys.has(diagnosticKey)) return;
  loggedCacheDiagnosticKeys.add(diagnosticKey);
  if (loggedCacheDiagnosticKeys.size > 512) {
    const oldestKey = loggedCacheDiagnosticKeys.values().next().value;
    if (typeof oldestKey === "string") loggedCacheDiagnosticKeys.delete(oldestKey);
  }

  const cacheHitPercent = Math.round(
    (cachedInputTokens /
      (point.cacheAccounting === "separate"
        ? point.last.inputTokens + cachedInputTokens
        : point.last.inputTokens)) *
      100,
  );
  bb.log.info(
    CACHE_DEBUG_PREFIX +
      " " +
      JSON.stringify({
        threadId,
        recordedAt: point.recordedAt,
        previousRecordedAt: previous?.recordedAt ?? null,
        gapMs:
          previous === undefined
            ? null
            : Math.max(0, point.recordedAt - previous.recordedAt),
        cacheAccounting: point.cacheAccounting,
        inputTokens: point.last.inputTokens,
        cachedInputTokens,
        uncachedInputTokens,
        cacheHitPercent,
        fullMiss: cachedInputTokens === 0,
        isLatestInWindow,
      }),
  );
}

function logCacheDiagnostics(
  bb: BbPluginApi,
  threadId: string,
  points: readonly UsageTimelinePoint[],
): void {
  const latestIndex = points.length - 1;
  if (latestIndex < 0) return;

  for (const [index, point] of points.entries()) {
    const cachedInputTokens = Math.max(0, point.last.cachedInputTokens);
    const fullMiss = point.last.inputTokens > 0 && cachedInputTokens === 0;
    const latestPartialMiss =
      index === latestIndex &&
      point.last.inputTokens > 0 &&
      point.last.inputTokens > cachedInputTokens;
    if (!fullMiss && !latestPartialMiss) continue;
    logCacheDiagnostic(
      bb,
      threadId,
      point,
      points[index - 1],
      index === latestIndex,
    );
  }
}

export default function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");
  bb.settings.define({
    showUsage: {
      type: "boolean",
      label: "Show thread usage in the chat header",
      description:
        "Show the token and cache status in the chat header and sidebar thread rows.",
      default: true,
    },
    cacheWindowMinutes: {
      type: "select",
      label: "Estimated cache window",
      description:
        "Auto uses the usage accounting shape; choose a fixed window for the countdown.",
      options: ["auto", "5", "10", "30", "60", "1440"],
      default: "auto",
    },
  });

  bb.rpc.register(rpcContract, {
    usage_batch: async ({ threadIds }) => {
      const uniqueThreadIds = [...new Set(threadIds)];
      const usages = await mapConcurrent(
        uniqueThreadIds,
        8,
        async (threadId): Promise<UsageResult> => {
          try {
            return { threadId, usage: await latestUsage(bb, threadId) };
          } catch {
            // A thread can disappear between the sidebar snapshot and this
            // RPC. Keep the batch useful for the remaining rows.
            return { threadId, usage: null };
          }
        },
      );
      return { usages };
    },
    usage_timeline: async ({ threadId }) => {
      const points = await usageTimeline(bb, threadId);
      logCacheDiagnostics(bb, threadId, points);
      return { points };
    },
  });
}
