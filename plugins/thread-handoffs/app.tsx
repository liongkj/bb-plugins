// bb-plugin-thread-handoffs — frontend entry.
//
// The sidebar thread list is owned by whichever list plugin is active (for
// example BB Sidebar), so this plugin does not add a nav item or touch rows.
// It surfaces handoffs on host-owned chrome instead:
//   - a thread-header control, shown only when the open thread has links
//   - a right-panel tab with the open thread's chain, opened from that control
// The server detects the links; `lib/handoffs.ts` orders them into chains.
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  definePluginApp,
  useBbNavigate,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type {
  PluginContentScriptContext,
  PluginThreadHeaderActionProps,
  PluginThreadPanelProps,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import {
  buildChains,
  chainHue,
  stepCounterpartId,
  stepRelationLabel,
  type HandoffBadge,
  type HandoffBadgePayload,
  type HandoffChain,
  type HandoffData,
} from "./lib/handoffs";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

const REFRESH_INTERVAL_MS = 20_000;
const PANEL_ACTION_ID = "handoffs";

/** Fetch the handoff snapshot; poll and reconcile on realtime reconnect. */
function useHandoffData() {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<HandoffData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(() => {
    rpc.call("handoffs_get").then(
      (result) => {
        setData(result);
        setError(null);
      },
      (cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
  }, [rpc]);

  useEffect(() => {
    refetch();
    const timer = window.setInterval(refetch, REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [refetch]);

  const connection = useRealtimeConnectionState();
  const previous = useRef(connection);
  useEffect(() => {
    if (previous.current !== "connected" && connection === "connected") {
      refetch();
    }
    previous.current = connection;
  }, [connection, refetch]);

  return { data, error, refetch };
}

/** The dashed box BB's own list pages use for loading and empty states. */
function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div
      role="status"
      className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground"
    >
      {children}
    </div>
  );
}

function ChainCard({
  chain,
  focusId,
  hue,
  onOpen,
}: {
  chain: HandoffChain;
  focusId: string | null;
  hue: number;
  onOpen: (threadId: string) => void;
}) {
  const first = chain.steps[0];
  const titles = new Map(
    chain.steps.map((step) => [step.thread.id, step.thread.title]),
  );
  const containsFocus = chain.steps.some((step) => step.thread.id === focusId);
  return (
    <section className="overflow-hidden rounded-lg border border-border bg-card">
      <header
        className="flex items-center gap-2 border-b border-border px-3 py-2"
        style={{ borderLeft: `3px solid hsl(${hue} 65% 50%)` }}
      >
        <Icon name="GitBranch" className="size-4 shrink-0 text-muted-foreground" />
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium">
          {first.thread.title}
        </h2>
        {containsFocus ? (
          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-foreground">
            this thread
          </span>
        ) : null}
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
          {chain.steps.length} threads
        </span>
      </header>
      <ol className="divide-y divide-border">
        {chain.steps.map((step) => {
          const focused = step.thread.id === focusId;
          const counterpart = stepCounterpartId(step);
          const glyph = step.via === null
            ? "Play"
            : step.forward
              ? "CornerDownRight"
              : "CornerDownLeft";
          return (
            <li key={step.thread.id}>
              <button
                type="button"
                onClick={() => onOpen(step.thread.id)}
                className={cn(
                  "flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors hover:bg-state-hover",
                  focused && "bg-state-active",
                )}
              >
                <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center text-muted-foreground">
                  <Icon name={glyph} className="size-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-foreground">
                    {step.thread.title}
                  </span>
                  <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
                    <span className="truncate">{step.thread.projectName}</span>
                    <span className="font-mono">{step.thread.id}</span>
                    <span>
                      {stepRelationLabel(step)}
                      {counterpart === null
                        ? ""
                        : ` ${titles.get(counterpart) ?? counterpart}`}
                    </span>
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** Right-panel tab: every handoff chain, grouped, with this thread's first. */
function ThreadHandoffsPanel({ threadId }: PluginThreadPanelProps) {
  const navigate = useBbNavigate();
  const { data, error, refetch } = useHandoffData();
  const [onlyThisChain, setOnlyThisChain] = useState(false);
  const chains = useMemo(
    () => (data === null ? [] : buildChains(data)),
    [data],
  );
  const currentId = useMemo(
    () =>
      chains.find((candidate) =>
        candidate.steps.some((step) => step.thread.id === threadId),
      )?.id ?? null,
    [chains, threadId],
  );
  const ordered = useMemo(() => {
    if (currentId === null) return chains;
    const current = chains.find((chain) => chain.id === currentId);
    if (current === undefined) return chains;
    return [current, ...chains.filter((chain) => chain.id !== currentId)];
  }, [chains, currentId]);
  const visible =
    onlyThisChain && currentId !== null
      ? ordered.filter((chain) => chain.id === currentId)
      : ordered;

  return (
    <div className="space-y-3">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <p className="min-w-40 flex-1 text-sm text-muted-foreground">
          {currentId === null
            ? "Every handoff chain, newest first. Click a thread to open it."
            : "Chains grouped oldest-to-newest. Yours is first; click a thread to open it."}
        </p>
        <div className="flex shrink-0 items-center gap-1.5">
          {currentId === null ? null : (
            <Button
              variant="ghost"
              size="sm"
              aria-pressed={onlyThisChain}
              onClick={() => setOnlyThisChain((value) => !value)}
            >
              {onlyThisChain ? "All chains" : "Only this chain"}
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={refetch}
            aria-label="Refresh handoffs"
          >
            <Icon name="ArrowReloadHorizontal" className="size-4" />
          </Button>
        </div>
      </header>

      {data === null ? null : (
        <p className="text-[11px] text-muted-foreground">
          {chains.length} chain{chains.length === 1 ? "" : "s"} ·{" "}
          {data.links.length} link{data.links.length === 1 ? "" : "s"} ·{" "}
          {data.scannedThreads} scanned
          {data.truncated ? " (truncated)" : ""}
        </p>
      )}

      {error === null ? null : (
        <p
          role="alert"
          className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      )}

      {data === null ? (
        <EmptyState>Loading handoffs…</EmptyState>
      ) : visible.length === 0 ? (
        <EmptyState>
          {currentId === null && chains.length > 0
            ? "This thread isn't part of a handoff chain."
            : 'No handoff chains yet. Start a thread with "Continue from @thread:<id>" and it will appear here.'}
        </EmptyState>
      ) : (
        <div className="space-y-3">
          {visible.map((chain) => (
            <ChainCard
              key={chain.id}
              chain={chain}
              focusId={threadId}
              hue={chainHue(chains.indexOf(chain))}
              onOpen={(id) => navigate.toThread(id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** Header control: open the handoff chain for this thread. */
function ThreadHandoffAction({
  threadId,
  isCompactViewport,
}: PluginThreadHeaderActionProps) {
  const navigate = useBbNavigate();
  const { data } = useHandoffData();
  const related = useMemo(() => {
    if (data === null) return 0;
    let count = 0;
    for (const link of data.links) {
      if (link.fromThreadId === threadId || link.toThreadId === threadId) {
        count += 1;
      }
    }
    return count;
  }, [data, threadId]);

  if (related === 0) return null;

  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-7 gap-1.5 px-2 text-xs"
      aria-label={`Handoffs: ${related} linked thread${related === 1 ? "" : "s"}`}
      onClick={() => navigate.openThreadPanel({ actionId: PANEL_ACTION_ID })}
    >
      <Icon name="GitBranch" className="size-3.5" />
      {isCompactViewport ? null : <span>Handoffs</span>}
      <span className="tabular-nums text-muted-foreground">{related}</span>
    </Button>
  );
}

// ---------------------------------------------------------------------------
// At-a-glance sidebar badges
//
// Two integrations over one server payload:
//   - "default": the host's `experimental_setThreadRowStatus` decorates BB's
//     own built-in thread list.
//   - "bb-sidebar": BB Sidebar replaces that list and does not render plugin row
//     statuses, so a small badge is injected next to each row's title instead.
// "auto" picks bb-sidebar when its row markup is present. Force either with the
// plugin's `sidebar` setting.
// ---------------------------------------------------------------------------

const BADGE_STYLE = [
  "position:relative",
  "z-index:5",
  "pointer-events:auto",
  "display:inline-flex",
  "align-items:center",
  "gap:2px",
  "margin-left:6px",
  "max-width:13rem",
  "overflow:hidden",
  "white-space:nowrap",
  "text-overflow:ellipsis",
  "border-radius:4px",
  "padding:0 5px",
  "font-size:9px",
  "line-height:15px",
  "font-weight:500",
  "color:var(--muted-foreground)",
  "background:var(--muted)",
  "vertical-align:middle",
  "cursor:pointer",
].join(";");

function detectBbSidebar(): boolean {
  return (
    document.querySelector(
      '[data-parent-card], [class*="group/card"], [class*="group/slim"]',
    ) !== null
  );
}

/** The row's own title node, so the badge can sit right after it. */
function findTitleNode(row: Element, title: string): HTMLElement | null {
  const nodes = Array.from(row.querySelectorAll<HTMLElement>("span,div"));
  let found: HTMLElement | null = null;
  for (const node of nodes) {
    if (node.closest("[data-handoff-badge]")) continue;
    if (node.children.length > 0) continue;
    if ((node.textContent ?? "").trim() === title) found = node;
  }
  return found;
}

/** The list row (or row container) for a thread, if it is on screen. */
function rowFor(threadId: string): HTMLElement | null {
  const anchor = document.querySelector<HTMLElement>(
    `[data-sidebar-thread-id="${threadId}"]`,
  );
  if (anchor === null) return null;
  return anchor.closest("li") ?? anchor.parentElement;
}

/** Open a thread by clicking its row anchor, even when the row is hidden. */
function clickThread(threadId: string): void {
  document
    .querySelector<HTMLElement>(`[data-sidebar-thread-id="${threadId}"]`)
    ?.click();
}

/** True when the row is the active or selected thread in its sidebar. */
function isRowActive(threadId: string): boolean {
  const anchor = document.querySelector<HTMLElement>(
    `[data-sidebar-thread-id="${threadId}"]`,
  );
  return (
    anchor !== null &&
    anchor.matches('[aria-current="page"], [data-selected="true"]')
  );
}

function installHandoffBadges({
  pluginId,
  signal,
  experimental_setThreadRowStatus,
}: PluginContentScriptContext): () => void {
  const nativeSignatures = new Map<string, string>();
  const domNodes = new Map<string, HTMLElement>();
  const hiddenRows = new Map<string, { row: HTMLElement; display: string }>();
  const groupNodes = new Map<string, HTMLElement>();
  const collapsedChains = new Set<string>();
  let badges: HandoffBadge[] = [];
  let mode = "auto";
  let groupRows = true;
  let frame = 0;

  const clearNative = () => {
    if (experimental_setThreadRowStatus) {
      for (const threadId of nativeSignatures.keys()) {
        experimental_setThreadRowStatus(threadId, null);
      }
    }
    nativeSignatures.clear();
  };

  const restoreHidden = () => {
    for (const [, entry] of Array.from(hiddenRows)) {
      if (entry.row.isConnected) entry.row.style.display = entry.display;
    }
    hiddenRows.clear();
  };

  const clearGroups = () => {
    for (const node of groupNodes.values()) node.remove();
    groupNodes.clear();
    restoreHidden();
  };

  const clearDom = () => {
    for (const element of domNodes.values()) element.remove();
    domNodes.clear();
    clearGroups();
  };

  const applyNative = () => {
    if (!experimental_setThreadRowStatus) return;
    const next = new Map(badges.map((badge) => [badge.threadId, badge]));
    for (const threadId of Array.from(nativeSignatures.keys())) {
      if (!next.has(threadId)) {
        experimental_setThreadRowStatus(threadId, null);
        nativeSignatures.delete(threadId);
      }
    }
    for (const badge of next.values()) {
      const signature = `${badge.kind}|${badge.label}|${badge.position}/${badge.total}`;
      if (nativeSignatures.get(badge.threadId) === signature) continue;
      experimental_setThreadRowStatus(badge.threadId, {
        icon: "GitBranch",
        label: `${
          badge.chainLabel === "" ? "" : `[${badge.chainLabel}] `
        }${badge.label} (${badge.position} of ${badge.total})`,
      });
      nativeSignatures.set(badge.threadId, signature);
    }
  };

  const applyGroups = (next: Map<string, HandoffBadge>) => {
    const byChain = new Map<string, HandoffBadge[]>();
    for (const badge of next.values()) {
      const list = byChain.get(badge.chainId) ?? [];
      list.push(badge);
      byChain.set(badge.chainId, list);
    }

    const activeChains = new Set<string>();
    const activeHidden = new Set<string>();

    for (const [chainId, members] of byChain) {
      const tips = members.filter((badge) => badge.kind !== "superseded");
      // Only a linear chain has one tip. A branched chain (siblings that each
      // continue the same thread) has several, and nesting one under another
      // would misrepresent them, so those stay as plain badges.
      if (tips.length !== 1) continue;
      const tip = tips[0];
      const tipRow = rowFor(tip.threadId);
      if (tipRow === null) continue;

      const superseded = members
        .filter((badge) => badge.threadId !== tip.threadId)
        // Never hide the thread the user is looking at: its row must stay for
        // the active/selected highlight to work.
        .filter((badge) => !isRowActive(badge.threadId))
        .filter((badge) => rowFor(badge.threadId) !== null)
        .sort((a, b) => a.position - b.position || a.updatedAt - b.updatedAt);
      if (superseded.length === 0) continue;

      activeChains.add(chainId);

      let node = groupNodes.get(chainId);
      if (node === undefined || !node.isConnected) {
        node = document.createElement("li");
        node.dataset.handoffGroup = chainId;
        groupNodes.set(chainId, node);
      }
      node.style.cssText = "list-style:none;";
      if (node.previousSibling !== tipRow) {
        tipRow.parentElement?.insertBefore(node, tipRow.nextSibling);
      }

      const collapsed = collapsedChains.has(chainId);
      const signature = `${tip.threadId}|${superseded
        .map((badge) => badge.threadId)
        .join(",")}|${collapsed ? "c" : "e"}`;
      if (node.dataset.signature !== signature) {
        const container = document.createElement("div");
        container.style.cssText = `margin:2px 0 6px 14px;border-left:2px solid hsl(${tip.chainHue} 65% 50%);padding:3px 0 3px 8px;`;

        const heading = document.createElement("button");
        heading.type = "button";
        heading.dataset.handoffGroupToggle = "1";
        heading.style.cssText =
          "display:flex;align-items:center;gap:4px;width:100%;text-align:left;background:transparent;border:0;padding:0 0 2px 0;cursor:pointer;font-size:9px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted-foreground);";
        heading.setAttribute("aria-expanded", collapsed ? "false" : "true");
        const arrow = document.createElement("span");
        arrow.textContent = collapsed ? "▸" : "▾";
        arrow.style.cssText = "font-size:8px;flex:0 0 auto;";
        const headingText = document.createElement("span");
        headingText.textContent = `superseded (${superseded.length})`;
        heading.append(arrow, headingText);
        heading.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (collapsedChains.has(chainId)) collapsedChains.delete(chainId);
          else collapsedChains.add(chainId);
          runApply();
        });
        container.appendChild(heading);

        const rows = document.createElement("div");
        rows.style.cssText = collapsed ? "display:none;" : "";
        for (const badge of superseded) {
          const button = document.createElement("button");
          button.type = "button";
          button.dataset.handoffGroupRow = "1";
          button.style.cssText =
            "display:flex;align-items:center;gap:6px;width:100%;text-align:left;background:transparent;border:0;padding:2px 4px;border-radius:4px;color:var(--muted-foreground);font-size:11px;cursor:pointer;opacity:.85;";
          button.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            clickThread(badge.threadId);
          });
          button.addEventListener("mouseenter", () => {
            button.style.background = "rgba(127,127,127,0.12)";
          });
          button.addEventListener("mouseleave", () => {
            button.style.background = "transparent";
          });
          const step = document.createElement("span");
          step.style.cssText =
            "font-size:9px;font-variant-numeric:tabular-nums;opacity:.7;flex:0 0 auto;";
          step.textContent = `${badge.position}/${badge.total}`;
          const title = document.createElement("span");
          title.style.cssText =
            "min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
          title.textContent = badge.threadTitle;
          title.title = badge.threadTitle;
          button.append(step, title);
          rows.appendChild(button);
        }
        container.appendChild(rows);

        node.replaceChildren(container);
        node.dataset.signature = signature;
      }

      for (const badge of superseded) {
        activeHidden.add(badge.threadId);
        let entry = hiddenRows.get(badge.threadId);
        if (entry === undefined || !entry.row.isConnected) {
          const row = rowFor(badge.threadId);
          if (row === null) continue;
          entry = { row, display: row.style.display };
          hiddenRows.set(badge.threadId, entry);
        }
        if (entry.row.style.display !== "none") entry.row.style.display = "none";
      }
    }

    for (const [chainId, node] of Array.from(groupNodes)) {
      if (!activeChains.has(chainId) || !node.isConnected) {
        node.remove();
        groupNodes.delete(chainId);
      }
    }
    for (const [threadId, entry] of Array.from(hiddenRows)) {
      if (activeHidden.has(threadId)) continue;
      if (entry.row.isConnected) entry.row.style.display = entry.display;
      hiddenRows.delete(threadId);
    }
  };

  const applyDom = () => {
    const next = new Map(badges.map((badge) => [badge.threadId, badge]));
    for (const [threadId, element] of Array.from(domNodes)) {
      if (!next.has(threadId) || !element.isConnected) {
        element.remove();
        domNodes.delete(threadId);
      }
    }

    for (const badge of next.values()) {
      const anchor = document.querySelector<HTMLElement>(
        `[data-sidebar-thread-id="${badge.threadId}"]`,
      );
      if (anchor === null) continue;
      const row = anchor.closest("li") ?? anchor.parentElement;
      if (row === null) continue;

      let element = domNodes.get(badge.threadId);
      if (element === undefined || !element.isConnected) {
        const titleNode = findTitleNode(row, badge.threadTitle);
        if (titleNode === null) continue;
        const created = document.createElement("span");
        created.dataset.handoffBadge = "1";
        created.style.cssText = BADGE_STYLE;
        created.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          const counterpart = created.dataset.counterpart;
          if (!counterpart) return;
          document
            .querySelector<HTMLElement>(
              `[data-sidebar-thread-id="${counterpart}"]`,
            )
            ?.click();
        });
        domNodes.set(badge.threadId, created);
        // Insert before the title: a card's title line truncates, so a badge
        // after it can be clipped away; before it always stays visible.
        titleNode.parentElement?.insertBefore(created, titleNode);
        element = created;
      }

      const place = `${badge.position}/${badge.total}`;
      // "current" means nothing continues it, not merely the deepest step: a
      // short branch's tip is current even when a sibling branch runs longer.
      const current = badge.kind !== "superseded";
      const text = current ? `${place} current` : `${place} superseded`;
      if (element.textContent !== text) element.textContent = text;
      element.title =
        badge.chainLabel === ""
          ? badge.label
          : `[${badge.chainLabel}] ${badge.label}`;
      element.style.fontWeight = current ? "600" : "500";
      element.style.color = current
        ? "var(--foreground)"
        : "var(--muted-foreground)";
      element.style.borderLeft = `3px solid hsl(${badge.chainHue} 65% 50%)`;
      element.style.background = `hsl(${badge.chainHue} 70% 50% / 0.14)`;
      element.dataset.chain = badge.chainId;
      if (element.dataset.counterpart !== badge.counterpartId) {
        element.dataset.counterpart = badge.counterpartId;
      }
    }

    if (groupRows) {
      applyGroups(next);
    } else {
      clearGroups();
    }
  };

  let observer: MutationObserver | null = null;

  const runApply = () => {
    if (signal.aborted) return;
    observer?.disconnect();
    try {
      const resolved =
        mode === "default" || mode === "bb-sidebar"
          ? mode
          : detectBbSidebar()
            ? "bb-sidebar"
            : "default";
      if (resolved === "default" && experimental_setThreadRowStatus) {
        clearDom();
        applyNative();
      } else {
        clearNative();
        applyDom();
      }
    } finally {
      if (!signal.aborted && observer !== null) {
        observer.observe(document.body, { childList: true, subtree: true });
      }
    }
  };

  const schedule = () => {
    if (frame !== 0 || signal.aborted) return;
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      runApply();
    });
  };

  const load = async () => {
    try {
      const response = await fetch(`/api/v1/plugins/${pluginId}/http/badges`, {
        signal,
        credentials: "same-origin",
        headers: { accept: "application/json" },
      });
      if (!response.ok) return;
      const payload = (await response.json()) as HandoffBadgePayload;
      mode = payload.mode;
      groupRows = payload.groupRows !== false;
      badges = payload.badges;
      runApply();
    } catch (cause) {
      if (!signal.aborted) {
        console.debug("thread-handoffs: badge refresh failed", cause);
      }
    }
  };

  observer = new MutationObserver(schedule);
  observer.observe(document.body, { childList: true, subtree: true });
  const interval = window.setInterval(() => {
    void load();
  }, REFRESH_INTERVAL_MS);
  void load();

  return () => {
    window.clearInterval(interval);
    if (frame !== 0) window.cancelAnimationFrame(frame);
    observer?.disconnect();
    observer = null;
    clearNative();
    clearDom();
  };
}

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "handoff-row-badges",
    mount: installHandoffBadges,
  });
  app.slots.threadPanelAction({
    id: PANEL_ACTION_ID,
    title: "Handoffs",
    icon: "GitBranch",
    component: ThreadHandoffsPanel,
  });
  app.slots.experimental_threadHeaderAction({
    id: "thread-handoffs",
    title: "Handoffs",
    component: ThreadHandoffAction,
  });
});
