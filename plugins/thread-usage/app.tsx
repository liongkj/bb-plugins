import { useEffect, useMemo, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import {
  definePluginApp,
  experimental_useSidebarThreads,
  useRpc,
  useSettings,
  type PluginThreadHeaderActionProps,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract, ThreadUsage, UsageTimelinePoint } from "./server";

const REFRESH_INTERVAL_MS = 15_000;
const DEFAULT_CACHE_WINDOW_MINUTES = 30;
type CacheTimerState = "warm" | "cooling" | "unhit";
type ThreadRowStatus = {
  icon: string;
  label: string;
  tone?: "default" | "error" | "running" | "success";
};
type SidebarStatusEntry = {
  threadId: string;
  status: ThreadRowStatus | null;
};

const SIDEBAR_STATUS_EVENT = "bb-plugin-thread-usage:sidebar-status";
const SIDEBAR_STATUS_REQUEST_EVENT = "bb-plugin-thread-usage:sidebar-status-request";
const SIDEBAR_STATUS_READY_EVENT = "bb-plugin-thread-usage:sidebar-status-ready";
const CACHE_EXPIRED_MESSAGE = "The next message will be read as a new message";
const SIDEBAR_EXPIRED_LABEL = "Cache expired; " + CACHE_EXPIRED_MESSAGE;
const SIDEBAR_STATUS_TIMER_ATTRIBUTE = "data-bb-thread-usage-timer";
const SIDEBAR_STATUS_ORANGE_CSS = `
  [aria-label^="Cache going cold"],
  [aria-label="${SIDEBAR_EXPIRED_LABEL}"],
  [aria-label^="Cache going cold"] svg,
  [aria-label="${SIDEBAR_EXPIRED_LABEL}"] svg {
    color: #f59e0b !important;
  }
  [data-bb-thread-usage-timer] {
    display: inline-block;
    margin-inline-start: 0.25rem;
    white-space: nowrap;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas,
      "Liberation Mono", "Courier New", monospace;
    font-size: 10px;
    font-variant-numeric: tabular-nums;
    line-height: 1;
  }
  [data-bb-thread-usage-timer][data-cache-state="cooling"] {
    color: #f59e0b !important;
  }
`;

function parseSidebarStatus(value: unknown): ThreadRowStatus | null | undefined {
  if (value === null) return null;
  if (typeof value !== "object" || value === null) return undefined;

  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.icon !== "string" ||
    candidate.icon.length === 0 ||
    candidate.icon.length > 64 ||
    typeof candidate.label !== "string" ||
    candidate.label.length === 0 ||
    candidate.label.length > 240
  ) {
    return undefined;
  }

  const tone = candidate.tone;
  if (
    tone !== undefined &&
    tone !== "default" &&
    tone !== "error" &&
    tone !== "running" &&
    tone !== "success"
  ) {
    return undefined;
  }

  return {
    icon: candidate.icon,
    label: candidate.label,
    ...(tone === undefined ? {} : { tone }),
  };
}

function isSidebarStatusEvent(
  value: unknown,
): value is { entries: SidebarStatusEntry[] } {
  if (typeof value !== "object" || value === null) return false;
  const entries = (value as Record<string, unknown>).entries;
  return (
    Array.isArray(entries) &&
    entries.every(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as Record<string, unknown>).threadId === "string",
    )
  );
}

function useThreadUsage(threadId: string, enabled: boolean) {
  const rpc = useRpc<typeof rpcContract>();
  const [usage, setUsage] = useState<ThreadUsage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) {
      setUsage(null);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;

    const refresh = async () => {
      setLoading(true);
      try {
        const response = await rpc.call("usage_batch", { threadIds: [threadId] });
        if (cancelled) return;
        setUsage(response.usages[0]?.usage ?? null);
        setError(null);
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [enabled, rpc, threadId]);

  return { usage, loading, error };
}

function useThreadUsageTimeline(threadId: string, enabled: boolean) {
  const rpc = useRpc<typeof rpcContract>();
  const [points, setPoints] = useState<UsageTimelinePoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) {
      setPoints([]);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;

    const refresh = async () => {
      setLoading(true);
      try {
        const response = await rpc.call("usage_timeline", { threadId });
        if (cancelled) return;
        setPoints(response.points);
        setError(null);
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [enabled, rpc, threadId]);

  return { points, loading, error };
}

function useNow(intervalMs = 1_000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);

  return now;
}

function formatTokens(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) {
    return String((value / 1_000).toFixed(value < 10_000 ? 1 : 0)) + "k";
  }
  return String((value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0)) + "M";
}

function inputTokensFor(
  breakdown: ThreadUsage["total"],
  cacheAccounting: ThreadUsage["cacheAccounting"],
): number {
  return cacheAccounting === "separate"
    ? breakdown.inputTokens + breakdown.cachedInputTokens
    : breakdown.inputTokens;
}

function cacheHitPercent(
  breakdown: ThreadUsage["total"],
  cacheAccounting: ThreadUsage["cacheAccounting"],
): number | null {
  const totalInputTokens = inputTokensFor(breakdown, cacheAccounting);
  if (totalInputTokens <= 0) return null;
  return Math.min(
    100,
    Math.round((breakdown.cachedInputTokens / totalInputTokens) * 100),
  );
}

function uncachedInputTokens(
  breakdown: ThreadUsage["total"],
  cacheAccounting: ThreadUsage["cacheAccounting"],
): number {
  return cacheAccounting === "separate"
    ? Math.max(0, breakdown.inputTokens)
    : Math.max(0, breakdown.inputTokens - breakdown.cachedInputTokens);
}

function cacheMetricLabel(
  cacheAccounting: ThreadUsage["cacheAccounting"],
): string {
  return cacheAccounting === "separate" ? "Cache activity" : "Cache hit";
}

function cachedSegmentLabel(
  cacheAccounting: ThreadUsage["cacheAccounting"],
): string {
  return cacheAccounting === "separate" ? "cache activity" : "cached";
}

type ContextWindowStats = {
  usedTokens: number;
  capacityTokens: number;
  usedPercent: number;
  remainingPercent: number;
  estimated: boolean;
};

function contextWindowStats(usage: ThreadUsage): ContextWindowStats | null {
  const capacityTokens =
    usage.contextWindow?.modelContextWindow ?? usage.modelContextWindow;
  const usedTokens = usage.contextWindow?.usedTokens ?? null;
  if (
    capacityTokens === null ||
    usedTokens === null ||
    !Number.isFinite(capacityTokens) ||
    !Number.isFinite(usedTokens) ||
    capacityTokens <= 0
  ) {
    return null;
  }

  const boundedUsedTokens = Math.max(0, usedTokens);
  const usedPercent = Math.min(
    100,
    Math.round((boundedUsedTokens / capacityTokens) * 100),
  );

  return {
    usedTokens: boundedUsedTokens,
    capacityTokens,
    usedPercent,
    remainingPercent: Math.max(0, 100 - usedPercent),
    estimated: usage.contextWindow?.estimated ?? true,
  };
}

function configuredCacheWindowMinutes(
  values: Record<string, string | number | boolean> | undefined,
  cacheAccounting: ThreadUsage["cacheAccounting"] | null,
): number | null {
  const configured = String(values?.cacheWindowMinutes ?? "auto");
  if (configured === "auto") {
    // BB normalizes Claude/Pi-style usage with cache input separate from
    // uncached input. Those providers use the short default estimate. The
    // normalized event does not carry a provider id, so inclusive/unknown
    // adapters use the generic fallback unless the user chooses a window.
    if (cacheAccounting === "separate") return 5;
    return DEFAULT_CACHE_WINDOW_MINUTES;
  }

  const parsed = Number(configured);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_CACHE_WINDOW_MINUTES;
}

function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const paddedMinutes = String(minutes).padStart(2, "0");
  const paddedSeconds = String(seconds).padStart(2, "0");

  if (hours > 0) return String(hours) + "h " + paddedMinutes + "m";
  return paddedMinutes + ":" + paddedSeconds;
}

function cacheTimerText(
  recordedAt: number,
  cacheWindowMinutes: number | null,
  now: number,
): string | null {
  if (cacheWindowMinutes === null) return null;

  const remainingMs =
    recordedAt + cacheWindowMinutes * 60_000 - now;
  return remainingMs <= 0 ? "unhit" : formatDuration(remainingMs);
}

function cacheTimerSecondsText(
  recordedAt: number,
  cacheWindowMinutes: number | null,
  now: number,
): string | null {
  if (cacheWindowMinutes === null) return null;

  const remainingMs =
    recordedAt + cacheWindowMinutes * 60_000 - now;
  if (remainingMs <= 0) return null;
  return String(Math.ceil(remainingMs / 1_000)) + "s";
}

function cacheTimerState(
  recordedAt: number,
  cacheWindowMinutes: number | null,
  now: number,
): CacheTimerState | null {
  if (cacheWindowMinutes === null) return null;

  const cacheWindowMs = cacheWindowMinutes * 60_000;
  const elapsedMs = now - recordedAt;
  if (elapsedMs >= cacheWindowMs) return "unhit";
  // The cache is considered to be going cold once half of its estimated
  // window has elapsed, while the countdown still has time remaining.
  return elapsedMs >= cacheWindowMs / 2 ? "cooling" : "warm";
}

function sidebarStatusForUsage(
  usage: ThreadUsage | null,
  cacheWindowMinutes: number | null,
  now: number,
): ThreadRowStatus | null {
  if (usage === null) return null;

  const timerState = cacheTimerState(usage.recordedAt, cacheWindowMinutes, now);
  const timerText = cacheTimerText(usage.recordedAt, cacheWindowMinutes, now);
  if (timerState === null || timerText === null) return null;

  if (timerState === "warm") {
    return {
      icon: "Clock",
      label: "Cache warm",
      tone: "success",
    };
  }

  if (timerState === "cooling") {
    const timerSeconds = cacheTimerSecondsText(
      usage.recordedAt,
      cacheWindowMinutes,
      now,
    );
    return {
      icon: "CircleAlert",
      label:
        timerSeconds === null
          ? "Cache going cold"
          : "Cache going cold; cache expires in " + timerSeconds,
      tone: "default",
    };
  }

  return {
    icon: "CircleAlert",
    label: SIDEBAR_EXPIRED_LABEL,
    tone: "default",
  };
}

type SidebarTimerInfo = {
  state: "cooling";
  text: string;
};

function sidebarTimerFromLabel(label: string): SidebarTimerInfo | null {
  const coolingPrefix = "Cache going cold; cache expires in ";
  if (label.startsWith(coolingPrefix)) {
    return { state: "cooling", text: label.slice(coolingPrefix.length) };
  }

  return null;
}

function CacheStateIndicator({ state }: { state: CacheTimerState | null }) {
  if (state === null) return null;

  return (
    <span
      aria-hidden="true"
      className={
        state === "warm"
          ? "font-bold text-emerald-500 dark:text-emerald-400"
          : "font-bold text-amber-500 dark:text-amber-400"
      }
    >
      {state === "warm" ? "●" : "!"}
    </span>
  );
}

function CacheWindowMetric({
  recordedAt,
  cacheWindowMinutes,
  now,
}: {
  recordedAt: number;
  cacheWindowMinutes: number | null;
  now: number;
}) {
  if (cacheWindowMinutes === null) {
    return (
      <div className="col-span-2 rounded-md border border-border/70 bg-muted/30 px-2.5 py-2">
        <dt className="text-[10px] text-muted-foreground">Cache timer</dt>
        <dd className="text-sm font-medium text-foreground">
          No fixed provider window
        </dd>
        <dd className="text-[10px] text-muted-foreground">
          The provider keeps cache entries on a best-effort basis. Choose a
          fixed estimate in settings to enable a countdown.
        </dd>
      </div>
    );
  }

  const timerState = cacheTimerState(recordedAt, cacheWindowMinutes, now);
  const timerText = cacheTimerText(recordedAt, cacheWindowMinutes, now);
  const expired = timerState === "unhit";
  const goingCold = timerState === "cooling";
  const warning = goingCold || expired;
  const timerStatus =
    timerState === "cooling"
      ? "Cache going cold"
      : timerState === "unhit"
        ? "Cache expired"
        : timerState === "warm"
          ? "Cache warm"
          : null;
  const timerMessage = expired
    ? CACHE_EXPIRED_MESSAGE
    : "Cached prefix may be reused for " + timerText;

  return (
    <div className="col-span-2 rounded-md border border-border/70 bg-muted/30 px-2.5 py-2">
      <dt className="text-[10px] text-muted-foreground">Cache timer</dt>
      <dd
        aria-live="polite"
        className={[
          "text-sm font-medium",
          warning
            ? "text-amber-500 dark:text-amber-400"
            : timerState === "warm"
              ? "text-emerald-600 dark:text-emerald-400"
              : "text-foreground",
        ].join(" ")}
      >
        <CacheStateIndicator state={timerState} />
        {timerStatus === null ? null : " " + timerStatus + " · "}
        {timerMessage}
      </dd>
      <dd className="text-[10px] text-muted-foreground">
        {expired
          ? "The cache window has elapsed; continuing may resend the existing context without cache reuse."
          : goingCold
            ? "Half or less of the estimated cache window remains; send soon to reuse the cached prefix."
            : "More than half of the estimated cache window remains; routing must stay the same to reuse the prefix."}
      </dd>
    </div>
  );
}

function ContextWindowMetric({
  usage,
  cacheWindowMinutes,
  now,
}: {
  usage: ThreadUsage;
  cacheWindowMinutes: number | null;
  now: number;
}) {
  const stats = contextWindowStats(usage);
  const timerState = cacheTimerState(usage.recordedAt, cacheWindowMinutes, now);
  const continueMessage =
    timerState === "unhit"
      ? "may resend the current context without cache reuse."
      : timerState === "cooling"
        ? "keeps the current context, but its cache is going cold."
        : timerState === "warm"
          ? "keeps the current context and may reuse its cached prefix."
          : "keeps the current context; cache reuse depends on the provider.";

  return (
    <div className="col-span-2 rounded-md border border-border/70 bg-muted/30 px-2.5 py-2">
      <div className="flex items-center justify-between gap-3">
        <dt className="text-sm font-medium text-foreground">Context window</dt>
        <dd className="text-sm font-medium text-foreground">
          {stats === null
            ? "n/a"
            : String(stats.usedPercent) + "% used" +
              (stats.estimated ? " · estimated" : "")}
        </dd>
      </div>
      {stats === null ? (
        <dd className="mt-1 text-[10px] text-muted-foreground">
          Current context usage has not been recorded yet.
        </dd>
      ) : (
        <>
          <div
            role="progressbar"
            aria-label="Context window usage"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={stats.usedPercent}
            aria-valuetext={
              formatTokens(stats.usedTokens) +
              " of " +
              formatTokens(stats.capacityTokens) +
              " tokens used; " +
              String(stats.remainingPercent) +
              "% left"
            }
            className="mt-2 h-2 overflow-hidden rounded-full bg-muted"
          >
            <div
              className="h-full rounded-full bg-foreground/70"
              style={{ width: String(stats.usedPercent) + "%" }}
            />
          </div>
          <div className="mt-2 flex items-center justify-between gap-3 text-sm text-muted-foreground">
            <span>
              {formatTokens(stats.usedTokens)} / {formatTokens(stats.capacityTokens)} tokens
            </span>
            <span>{String(stats.remainingPercent)}% left</span>
          </div>
          <div className="mt-2 space-y-1 text-[10px] text-muted-foreground">
            <p>
              <span className="font-medium text-foreground">Continue:</span>{" "}
              {continueMessage}
            </p>
            <p>
              <span className="font-medium text-foreground">New thread:</span>{" "}
              avoids sending this existing context, but you must provide any
              background you still need.
            </p>
            <p>
              <span className="font-medium text-foreground">Cost guide:</span>{" "}
              this is a token-cost proxy; exact pricing depends on the provider
              and model.
            </p>
          </div>
        </>
      )}
    </div>
  );
}

type TimelinePointStats = {
  inputTokens: number;
  cachedInputTokens: number;
  uncachedInputTokens: number;
  cacheHitPercent: number | null;
};

function timelinePointStats(point: UsageTimelinePoint): TimelinePointStats {
  const inputTokens = Math.max(
    0,
    inputTokensFor(point.last, point.cacheAccounting),
  );
  const cachedInputTokens = Math.min(
    inputTokens,
    Math.max(0, point.last.cachedInputTokens),
  );

  return {
    inputTokens,
    cachedInputTokens,
    uncachedInputTokens: Math.min(
      inputTokens,
      uncachedInputTokens(point.last, point.cacheAccounting),
    ),
    cacheHitPercent: cacheHitPercent(point.last, point.cacheAccounting),
  };
}

function timelinePointLabel(
  point: UsageTimelinePoint,
  stats: TimelinePointStats,
): string {
  const time = new Date(point.recordedAt).toLocaleString(undefined, {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "short",
  });
  const hit =
    stats.cacheHitPercent === null
      ? "no cache data"
      : String(stats.cacheHitPercent) + "% " +
        cacheMetricLabel(point.cacheAccounting).toLowerCase();

  return (
    time +
    ": " +
    hit +
    "; " +
    formatTokens(stats.cachedInputTokens) +
    " " +
    cachedSegmentLabel(point.cacheAccounting) +
    ", " +
    formatTokens(stats.uncachedInputTokens) +
    " uncached input tokens"
  );
}

function UsageTimeline({
  points,
  loading,
  error,
}: {
  points: UsageTimelinePoint[];
  loading: boolean;
  error: string | null;
}) {
  const stats = points.map(timelinePointStats);
  const snapshotLabel = points.length === 1 ? "usage snapshot" : "usage snapshots";
  const cachedLabel = points.some(
    (point) => point.cacheAccounting === "separate",
  )
    ? "Cache activity"
    : "Cached";
  const maxInputTokens = Math.max(1, ...stats.map((point) => point.inputTokens));
  const recentInputTokens = stats.reduce(
    (sum, point) => sum + point.inputTokens,
    0,
  );
  const recentCachedInputTokens = stats.reduce(
    (sum, point) => sum + point.cachedInputTokens,
    0,
  );
  const recentUncachedInputTokens = stats.reduce(
    (sum, point) => sum + point.uncachedInputTokens,
    0,
  );
  const chartHeight = 64;
  const chartGap = 0.75;
  const minimumVisibleUncachedHeight = 2;
  const chartBarWidth =
    points.length === 0
      ? 0
      : (100 - chartGap * Math.max(0, points.length - 1)) / points.length;

  return (
    <div className="col-span-2 rounded-md border border-border/70 bg-muted/30 px-2.5 py-2">
      <div className="flex items-center justify-between gap-3">
        <dt className="text-sm font-medium text-foreground">Cache timeline</dt>
        <dd className="text-[10px] text-muted-foreground">
          {points.length === 0
            ? "Usage snapshots"
            : String(points.length) + " " + snapshotLabel}
        </dd>
      </div>
      {points.length === 0 ? (
        <dd className="mt-1 text-[10px] text-muted-foreground">
          {loading
            ? "Loading usage snapshots…"
            : error === null
              ? "No usage snapshot has been recorded yet."
              : "Timeline could not be loaded. Try again shortly."}
        </dd>
      ) : (
        <>
          <div
            className="mt-3 h-16 border-b border-border/70"
          >
            <svg
              role="img"
              aria-label={
                "Timeline of cached and uncached input across " +
                String(points.length) +
                " persisted usage snapshots; newest snapshot is on the right"
              }
              viewBox={"0 0 100 " + String(chartHeight)}
              preserveAspectRatio="none"
              className="block h-full w-full"
            >
              {points.map((point, index) => {
                const pointStats = stats[index]!;
                const totalHeight =
                  pointStats.inputTokens === 0
                    ? 3
                    : Math.max(
                        4,
                        Math.round(
                          (pointStats.inputTokens / maxInputTokens) * chartHeight,
                        ),
                      );
                const uncachedHeight =
                  pointStats.uncachedInputTokens === 0
                    ? 0
                    : Math.min(
                        totalHeight,
                        Math.max(
                          minimumVisibleUncachedHeight,
                          Math.round(
                            (pointStats.uncachedInputTokens /
                              pointStats.inputTokens) *
                              totalHeight,
                          ),
                        ),
                      );
                const cachedHeight = Math.max(0, totalHeight - uncachedHeight);
                const label = timelinePointLabel(point, pointStats);
                const x = index * (chartBarWidth + chartGap);

                return (
                  <g
                    key={String(point.recordedAt) + "-" + String(index)}
                    aria-label={label}
                  >
                    <title>{label}</title>
                    {cachedHeight === 0 ? null : (
                      <rect
                        x={x}
                        y={chartHeight - totalHeight}
                        width={chartBarWidth}
                        height={cachedHeight}
                        className="text-muted-foreground"
                        fill="currentColor"
                      />
                    )}
                    {uncachedHeight === 0 ? null : (
                      <rect
                        x={x}
                        y={chartHeight - uncachedHeight}
                        width={chartBarWidth}
                        height={uncachedHeight}
                        className="text-amber-400"
                        fill="currentColor"
                        style={{ fill: "var(--color-amber-400)" }}
                      />
                    )}
                  </g>
                );
              })}
            </svg>
          </div>
          <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
            <span>Older</span>
            <span>Newest</span>
          </div>
          <dd className="mt-2 text-[10px] text-muted-foreground">
            {String(points.length)} snapshots · {formatTokens(recentInputTokens)} input ·{" "}
            {formatTokens(recentCachedInputTokens)} {cachedLabel.toLowerCase()} ·{" "}
            {formatTokens(recentUncachedInputTokens)} new
          </dd>
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
            <span>
              <span
                aria-hidden="true"
                className="mr-1 inline-block size-1.5 rounded-full bg-muted-foreground align-middle"
              />
              {cachedLabel}
            </span>
            <span>
              <span
                aria-hidden="true"
                className="mr-1 inline-block size-1.5 rounded-full bg-amber-400 align-middle"
                style={{ backgroundColor: "var(--color-amber-400)" }}
              />
              Uncached
            </span>
          </div>
          <p className="mt-2 text-[10px] text-muted-foreground">
            Small nonzero uncached slices use a 2px visual minimum. This shows
            persisted usage snapshots; BB may not emit one for every chat turn,
            so missing turns cannot be reconstructed here.
          </p>
          {points.some((point) => point.cacheAccounting === "separate") ? (
            <p className="mt-1 text-[10px] text-muted-foreground">
              For Claude, cache activity combines cache reads and writes; it is
              not a read-only cache-hit trace.
            </p>
          ) : null}
          {loading ? (
            <p className="mt-1 text-[10px] text-muted-foreground">Refreshing…</p>
          ) : null}
          {error === null ? null : (
            <p className="mt-1 text-[10px] text-destructive">
              Timeline refresh failed; showing the last result.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function SidebarStatusOverlay() {
  const { values } = useSettings();
  const showUsage = values?.showUsage !== false;
  const cacheWindowSetting = String(values?.cacheWindowMinutes ?? "auto");
  const { threads } = experimental_useSidebarThreads();
  const rpc = useRpc<typeof rpcContract>();
  const now = useNow(1_000);
  const threadIds = useMemo(
    () => [...new Set(threads.map((thread) => thread.id))],
    [threads],
  );
  const threadIdsKey = JSON.stringify(threadIds);
  const [usages, setUsages] = useState<Record<string, ThreadUsage | null>>({});
  const [statusEntries, setStatusEntries] = useState<SidebarStatusEntry[]>([]);
  const knownThreadIds = useRef<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;

    if (!showUsage || threadIds.length === 0) {
      setUsages({});
      return () => {
        cancelled = true;
      };
    }

    const refresh = async () => {
      try {
        const responses = await Promise.all(
          Array.from(
            { length: Math.ceil(threadIds.length / 200) },
            (_, index) =>
              rpc.call("usage_batch", {
                threadIds: threadIds.slice(index * 200, (index + 1) * 200),
              }),
          ),
        );
        if (cancelled) return;

        const next: Record<string, ThreadUsage | null> = {};
        for (const response of responses) {
          for (const entry of response.usages) {
            next[entry.threadId] = entry.usage;
          }
        }
        setUsages(next);
      } catch {
        // Keep the last successful sidebar state when a refresh is transiently unavailable.
      }
    };

    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [rpc, showUsage, threadIdsKey]);

  useEffect(() => {
    const previousThreadIds = knownThreadIds.current;
    const allThreadIds = new Set([...previousThreadIds, ...threadIds]);
    const entries = [...allThreadIds].map((threadId) => {
      const usage = showUsage ? usages[threadId] ?? null : null;
      return {
        threadId,
        status: showUsage
          ? sidebarStatusForUsage(
              usage,
              configuredCacheWindowMinutes(
                { cacheWindowMinutes: cacheWindowSetting },
                usage?.cacheAccounting ?? null,
              ),
              now,
            )
          : null,
      };
    });

    knownThreadIds.current = new Set(threadIds);
    setStatusEntries(entries);
  }, [cacheWindowSetting, now, showUsage, threadIdsKey, usages]);

  useEffect(() => {
    const broadcast = () => {
      window.dispatchEvent(
        new CustomEvent(SIDEBAR_STATUS_EVENT, {
          detail: { entries: statusEntries },
        }),
      );
    };

    window.addEventListener(SIDEBAR_STATUS_READY_EVENT, broadcast);
    broadcast();
    return () => window.removeEventListener(SIDEBAR_STATUS_READY_EVENT, broadcast);
  }, [statusEntries]);

  return null;
}

function Metric({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] text-muted-foreground">{label}</dt>
      <dd className="truncate text-sm font-medium text-foreground">{value}</dd>
      {detail === undefined ? null : (
        <dd className="truncate text-[10px] text-muted-foreground">{detail}</dd>
      )}
    </div>
  );
}

function UsagePanel({
  usage,
  loading,
  error,
  cacheWindowMinutes,
  now,
  timelinePoints,
  timelineLoading,
  timelineError,
}: {
  usage: ThreadUsage | null;
  loading: boolean;
  error: string | null;
  cacheWindowMinutes: number | null;
  now: number;
  timelinePoints: UsageTimelinePoint[];
  timelineLoading: boolean;
  timelineError: string | null;
}) {
  if (usage === null) {
    return (
      <p className="text-xs text-muted-foreground">
        {loading
          ? "Loading token usage…"
          : error === null
            ? "No token usage has been recorded for this thread yet."
            : "Usage could not be loaded. Try again shortly."}
      </p>
    );
  }

  const cacheHit = cacheHitPercent(usage.total, usage.cacheAccounting);
  const lastCacheHit = cacheHitPercent(usage.last, usage.cacheAccounting);
  const cacheLabel = cacheMetricLabel(usage.cacheAccounting);
  const cachedInput = formatTokens(usage.total.cachedInputTokens);
  const uncachedInput = formatTokens(
    uncachedInputTokens(usage.total, usage.cacheAccounting),
  );
  const totalInput = formatTokens(
    inputTokensFor(usage.total, usage.cacheAccounting),
  );

  return (
    <>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
        <Metric label="Total tokens" value={formatTokens(usage.total.totalTokens)} />
        <Metric
          label={cacheLabel}
          value={cacheHit === null ? "n/a" : String(cacheHit) + "%"}
          detail={cachedInput + " cached"}
        />
        <Metric
          label="Input"
          value={totalInput}
          detail={cachedInput + " cached · " + uncachedInput + " new"}
        />
        <Metric label="Output" value={formatTokens(usage.total.outputTokens)} />
        <Metric
          label="Reasoning"
          value={formatTokens(usage.total.reasoningOutputTokens)}
        />
        <Metric
          label="Last turn"
          value={formatTokens(usage.last.totalTokens)}
          detail={
            lastCacheHit === null
              ? undefined
              : String(lastCacheHit) + "% " + cacheLabel.toLowerCase()
          }
        />
        <CacheWindowMetric
          recordedAt={usage.recordedAt}
          cacheWindowMinutes={cacheWindowMinutes}
          now={now}
        />
        <ContextWindowMetric
          usage={usage}
          cacheWindowMinutes={cacheWindowMinutes}
          now={now}
        />
        <UsageTimeline
          points={timelinePoints}
          loading={timelineLoading}
          error={timelineError}
        />
      </dl>
      <div className="mt-3 border-t border-border/70 pt-3 text-[10px] text-muted-foreground">
        {usage.cacheAccounting === "separate" ? (
          <p className="mt-1">
            This provider combines cache reads and writes, so the percentage is
            cached-input share rather than read-only hits.
          </p>
        ) : null}
        {loading ? <p className="mt-1">Refreshing…</p> : null}
        {error === null ? null : (
          <p className="mt-1 text-destructive">Refresh failed; showing the last result.</p>
        )}
      </div>
    </>
  );
}

function ThreadUsageHeaderAction({
  threadId,
  isCompactViewport,
}: PluginThreadHeaderActionProps) {
  const { values } = useSettings();
  const showUsage = values?.showUsage !== false;
  const [open, setOpen] = useState(false);
  const { usage, loading, error } = useThreadUsage(threadId, showUsage);
  const {
    points: timelinePoints,
    loading: timelineLoading,
    error: timelineError,
  } = useThreadUsageTimeline(threadId, showUsage && open);
  const cacheWindowMinutes = configuredCacheWindowMinutes(
    values,
    usage?.cacheAccounting ?? null,
  );
  const now = useNow();

  if (!showUsage) return null;

  const cacheHit =
    usage === null
      ? null
      : cacheHitPercent(usage.total, usage.cacheAccounting);
  const cacheLabel =
    usage === null ? "cache" : cacheMetricLabel(usage.cacheAccounting).toLowerCase();
  const timerText =
    usage === null
      ? null
      : cacheTimerText(usage.recordedAt, cacheWindowMinutes, now);
  const timerState =
    usage === null
      ? null
      : cacheTimerState(usage.recordedAt, cacheWindowMinutes, now);
  const timerDescription =
    timerText === null
      ? null
      : timerState === "cooling"
        ? "the cache is going cold; the cached prefix may be reused for " + timerText
        : timerState === "unhit"
          ? "the cache window has elapsed; the next message will be read as a new message"
          : "the cache is warm; the cached prefix may be reused for " + timerText;
  const buttonLabel =
    usage === null
      ? "Show thread token usage"
      : "Show thread token usage: " +
        (cacheHit === null ? "no cache data" : String(cacheHit) + "% " + cacheLabel) +
        (timerDescription === null ? "" : "; " + timerDescription);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={buttonLabel}
          title={buttonLabel}
          className={[
            "inline-flex h-7 items-center justify-center gap-1 rounded-md px-2 text-[11px] font-medium text-muted-foreground",
            "hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            isCompactViewport && timerText === null ? "w-7 px-0" : "",
          ].join(" ")}
        >
          {timerText === null ? (
            <>
              <span aria-hidden="true" className="font-mono text-[10px]">
                %
              </span>
              {isCompactViewport ? null : (
                <span>{cacheHit === null ? "Usage" : String(cacheHit) + "%"}</span>
              )}
            </>
          ) : (
            <>
              <CacheStateIndicator state={timerState} />
              {timerState === "warm" ? (
                <span aria-hidden="true" className="font-mono text-[10px]">
                  ◷
                </span>
              ) : null}
              <span className="font-mono text-[10px]">{timerText}</span>
            </>
          )}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          collisionPadding={8}
          className="z-50 w-72 rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-lg outline-none"
        >
          <div className="mb-3 flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-medium">Thread usage</p>
              <p className="mt-0.5 text-[10px] text-muted-foreground">
                Cumulative usage for this thread
              </p>
            </div>
            <Popover.Close
              aria-label="Close thread usage"
              className="rounded px-1 text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              ×
            </Popover.Close>
          </div>
          <UsagePanel
            usage={usage}
            loading={loading}
            error={error}
            cacheWindowMinutes={cacheWindowMinutes}
            now={now}
            timelinePoints={timelinePoints}
            timelineLoading={timelineLoading}
            timelineError={timelineError}
          />
          <Popover.Arrow className="fill-border" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "sidebar-cache-status",
    mount({ experimental_setThreadRowStatus }) {
      if (experimental_setThreadRowStatus === undefined) return;

      // SDK 0.4.87 has no warning/amber row tone. Keep the status host-rendered
      // and apply the orange warning palette through its documented aria label.
      const orangeStyle = document.createElement("style");
      orangeStyle.textContent = SIDEBAR_STATUS_ORANGE_CSS;
      (document.head ?? document.documentElement).appendChild(orangeStyle);

      let timerFrame: number | null = null;
      const renderSidebarTimers = () => {
        timerFrame = null;
        const activeTimers = new Set<HTMLElement>();
        const statusElements = Array.from(
          document.querySelectorAll<HTMLElement>(
            '[aria-label^="Cache going cold; cache expires in "]',
          ),
        );

        for (const statusElement of statusElements) {
          const timerInfo = sidebarTimerFromLabel(
            statusElement.getAttribute("aria-label") ?? "",
          );
          const parent = statusElement.parentElement;
          if (timerInfo === null || parent === null) continue;

          let timer: HTMLElement | null = null;
          const nextElement = statusElement.nextElementSibling;
          if (
            nextElement instanceof HTMLElement &&
            nextElement.hasAttribute(SIDEBAR_STATUS_TIMER_ATTRIBUTE)
          ) {
            timer = nextElement;
          }

          if (timer === null) {
            timer = document.createElement("span");
            timer.setAttribute(SIDEBAR_STATUS_TIMER_ATTRIBUTE, "true");
            timer.setAttribute("aria-hidden", "true");
            parent.insertBefore(timer, statusElement.nextSibling);
          }

          if (timer.textContent !== timerInfo.text) {
            timer.textContent = timerInfo.text;
          }
          if (timer.dataset.cacheState !== timerInfo.state) {
            timer.dataset.cacheState = timerInfo.state;
          }
          activeTimers.add(timer);
        }

        document
          .querySelectorAll<HTMLElement>(`[${SIDEBAR_STATUS_TIMER_ATTRIBUTE}]`)
          .forEach((timer) => {
            if (!activeTimers.has(timer)) timer.remove();
          });
      };
      const scheduleSidebarTimerRender = () => {
        if (timerFrame !== null) return;
        timerFrame = window.requestAnimationFrame(renderSidebarTimers);
      };
      const sidebarObserver = new MutationObserver(scheduleSidebarTimerRender);
      sidebarObserver.observe(document.body ?? document.documentElement, {
        attributes: true,
        attributeFilter: ["aria-label"],
        childList: true,
        subtree: true,
      });
      scheduleSidebarTimerRender();

      const applyStatuses = (event: Event) => {
        const detail = (event as CustomEvent<unknown>).detail;
        if (!isSidebarStatusEvent(detail)) return;

        for (const entry of detail.entries) {
          if (entry.threadId.length === 0 || entry.threadId.length > 200) continue;
          const status = parseSidebarStatus(entry.status);
          if (status !== undefined) {
            experimental_setThreadRowStatus(entry.threadId, status);
          }
        }
        scheduleSidebarTimerRender();
      };
      const requestStatuses = () => {
        window.dispatchEvent(new Event(SIDEBAR_STATUS_READY_EVENT));
      };

      window.addEventListener(SIDEBAR_STATUS_EVENT, applyStatuses);
      window.addEventListener(SIDEBAR_STATUS_REQUEST_EVENT, requestStatuses);
      requestStatuses();

      return () => {
        window.removeEventListener(SIDEBAR_STATUS_EVENT, applyStatuses);
        window.removeEventListener(SIDEBAR_STATUS_REQUEST_EVENT, requestStatuses);
        sidebarObserver.disconnect();
        if (timerFrame !== null) window.cancelAnimationFrame(timerFrame);
        document
          .querySelectorAll<HTMLElement>(`[${SIDEBAR_STATUS_TIMER_ATTRIBUTE}]`)
          .forEach((timer) => timer.remove());
        orangeStyle.remove();
      };
    },
  });
  app.slots.experimental_appOverlay({
    id: "sidebar-cache-status",
    component: SidebarStatusOverlay,
  });
  app.slots.experimental_threadHeaderAction({
    id: "thread-usage",
    title: "Thread usage",
    component: ThreadUsageHeaderAction,
  });
});
