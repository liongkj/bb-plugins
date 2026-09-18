// Shared handoff model. Runtime-neutral (no Node, SDK, or React imports) so it
// bundles into both the backend and the app. `server.ts` produces a
// `HandoffData` snapshot; `app.tsx` turns it into ordered chains for display.

/** One thread participating in a handoff. */
export interface ThreadRef {
  id: string;
  /** Display title: the thread's own title, else its first-prompt fallback. */
  title: string;
  projectId: string;
  projectName: string;
  providerId: string;
  status: string;
  hidden: boolean;
  createdAt: number;
  updatedAt: number;
}

/** How two threads are linked. */
export type HandoffKind = "mention" | "fork";

/**
 * A directed handoff edge: `fromThreadId` is the newer thread, `toThreadId` is
 * the earlier one it continued. `mention` comes from an `@thread:` reference in
 * `from`'s messages; `fork` comes from BB's fork/source relationship.
 */
export interface HandoffLink {
  fromThreadId: string;
  toThreadId: string;
  kind: HandoffKind;
  /** The mention's captured label, when the source was a mention. */
  label: string | null;
}

/** The full snapshot returned by the `handoffs_get` RPC and the CLI. */
export interface HandoffData {
  threads: ThreadRef[];
  links: HandoffLink[];
  /** How many threads the scan covered. */
  scannedThreads: number;
  /** True when the scan hit its thread cap and may have missed links. */
  truncated: boolean;
  fetchedAt: number;
}

/** One thread in a chain, with the edge that joins it to the previous thread. */
export interface HandoffStep {
  thread: ThreadRef;
  via: HandoffLink | null;
  /** True when `via.fromThreadId` is this (newer) step, i.e. it continues the previous one. */
  forward: boolean;
}

/** A connected run of handed-off threads, oldest first. */
export interface HandoffChain {
  id: string;
  steps: HandoffStep[];
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

/**
 * Group links into connected chains, order each chain oldest-first, and attach
 * the edge that explains each step. Treats the graph as undirected so a chain
 * survives a missing direction; prefers a `mention` over a `fork` when both
 * join the same pair.
 */
export function buildChains(data: HandoffData): HandoffChain[] {
  const byId = new Map(data.threads.map((thread) => [thread.id, thread]));
  const adjacency = new Map<string, Set<string>>();
  const linksByPair = new Map<string, HandoffLink[]>();

  for (const link of data.links) {
    if (!byId.has(link.fromThreadId) || !byId.has(link.toThreadId)) continue;
    if (link.fromThreadId === link.toThreadId) continue;

    for (const [self, other] of [
      [link.fromThreadId, link.toThreadId],
      [link.toThreadId, link.fromThreadId],
    ] as const) {
      const neighbours = adjacency.get(self) ?? new Set<string>();
      neighbours.add(other);
      adjacency.set(self, neighbours);
    }

    const key = pairKey(link.fromThreadId, link.toThreadId);
    const pair = linksByPair.get(key) ?? [];
    pair.push(link);
    linksByPair.set(key, pair);
  }

  const visited = new Set<string>();
  const chains: HandoffChain[] = [];

  for (const thread of data.threads) {
    if (visited.has(thread.id) || !adjacency.has(thread.id)) continue;

    const component: string[] = [];
    const queue = [thread.id];
    visited.add(thread.id);
    while (queue.length > 0) {
      const id = queue.shift() as string;
      component.push(id);
      for (const next of adjacency.get(id) ?? []) {
        if (visited.has(next)) continue;
        visited.add(next);
        queue.push(next);
      }
    }

    const ordered = component
      .map((id) => byId.get(id) as ThreadRef)
      .sort((a, b) => a.createdAt - b.createdAt || a.updatedAt - b.updatedAt);

    const steps: HandoffStep[] = ordered.map((node, index) => {
      if (index === 0) return { thread: node, via: null, forward: false };

      // Prefer an edge to the immediately previous thread, then the nearest
      // earlier one. A hub (one thread many others mention) branches; each
      // branch still names the thread it continues from.
      for (let i = index - 1; i >= 0; i -= 1) {
        const candidates =
          linksByPair.get(pairKey(ordered[i].id, node.id)) ?? [];
        const via =
          candidates.find((link) => link.kind === "mention") ??
          candidates[0];
        if (via !== undefined) {
          return { thread: node, via, forward: via.fromThreadId === node.id };
        }
      }
      return { thread: node, via: null, forward: false };
    });

    chains.push({ id: ordered[0].id, steps });
  }

  chains.sort((a, b) => {
    const aAt = Math.max(0, ...a.steps.map((step) => step.thread.updatedAt));
    const bAt = Math.max(0, ...b.steps.map((step) => step.thread.updatedAt));
    return bAt - aAt;
  });

  return chains;
}

/** A short human label for the edge joining a step to the previous one. */
export function stepRelationLabel(step: HandoffStep): string {
  if (step.via === null) return "chain start";
  if (step.forward) {
    return step.via.kind === "mention" ? "continued from" : "forked from";
  }
  return step.via.kind === "mention" ? "referenced by next" : "forked into";
}

/** The thread on the other end of a step's edge, or null at a chain start. */
export function stepCounterpartId(step: HandoffStep): string | null {
  if (step.via === null) return null;
  return step.via.fromThreadId === step.thread.id
    ? step.via.toThreadId
    : step.via.fromThreadId;
}

function shorten(value: string, max = 48): string {
  const clean = value.replace(/\s+/gu, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

/**
 * A thread whose title is just the handoff prompt ("Continue from
 * @thread:…") is clearer as its id inside another thread's badge.
 */
function badgeName(thread: ThreadRef): string {
  const title = thread.title.replace(/\s+/gu, " ").trim();
  if (title === "" || /^Continue from @thread:/iu.test(title)) return thread.id;
  return title;
}

/** Deterministic hue for chain `index`, so the panel and badges agree. */
export function chainHue(index: number): number {
  return Math.round((index * 137.508) % 360);
}

/** Where a thread sits in its chain, for a one-line sidebar badge. */
export type HandoffBadgeKind = "superseded" | "continues";

export interface HandoffBadge {
  threadId: string;
  threadTitle: string;
  kind: HandoffBadgeKind;
  /** Short text, e.g. `Superseded by "Fix the parser"`. */
  label: string;
  counterpartId: string;
  counterpartTitle: string;
  /** How many linked threads share this relation. */
  count: number;
  /** 1-based position within the chain, oldest first. */
  position: number;
  /** Total threads in the chain. */
  total: number;
  /** Root thread of the chain; shared by every member. */
  chainId: string;
  /** Short root title, so scattered members can be recognised as one group. */
  chainLabel: string;
  /** Deterministic hue (0-359) for this chain's colour cue. */
  chainHue: number;
  /** Thread's last-updated time, used to pick the chain tip. */
  updatedAt: number;
}

/** Payload the `/badges` HTTP route serves to the content script. */
export interface HandoffBadgePayload {
  /** The plugin's `sidebar` setting: `auto`, `default`, or `bb-sidebar`. */
  mode: string;
  /** The plugin's `groupRows` setting: nest superseded rows under the tip. */
  groupRows: boolean;
  badges: HandoffBadge[];
}

/**
 * One badge per linked thread. A thread that was continued shows
 * `superseded` (the at-a-glance signal the user asked for); a thread that did
 * the continuing shows `continues`. A mid-chain thread gets `superseded`,
 * because the older relation is the one worth noticing.
 */
export function buildBadges(data: HandoffData): HandoffBadge[] {
  const byId = new Map(data.threads.map((thread) => [thread.id, thread]));
  const successors = new Map<string, HandoffLink[]>();
  const predecessors = new Map<string, HandoffLink[]>();

  for (const link of data.links) {
    if (!byId.has(link.fromThreadId) || !byId.has(link.toThreadId)) continue;
    if (link.fromThreadId === link.toThreadId) continue;
    const next = successors.get(link.toThreadId) ?? [];
    next.push(link);
    successors.set(link.toThreadId, next);
    const previous = predecessors.get(link.fromThreadId) ?? [];
    previous.push(link);
    predecessors.set(link.fromThreadId, previous);
  }

  // Depth from the chain root, so siblings that both continue the same thread
  // share a step instead of reading as a false sequence.
  const chainPlace = new Map<
    string,
    {
      position: number;
      total: number;
      chainId: string;
      chainLabel: string;
      chainHue: number;
    }
  >();
  for (const [chainIndex, chain] of buildChains(data).entries()) {
    const ids = new Set(chain.steps.map((step) => step.thread.id));
    const byAge = chain.steps
      .map((step) => step.thread)
      .sort((a, b) => a.createdAt - b.createdAt);
    const depth = new Map<string, number>();
    for (const thread of byAge) {
      let best = 0;
      for (const link of data.links) {
        if (link.fromThreadId !== thread.id || !ids.has(link.toThreadId)) continue;
        const parentDepth = depth.get(link.toThreadId);
        if (parentDepth !== undefined) best = Math.max(best, parentDepth + 1);
      }
      depth.set(thread.id, best);
    }
    const total = Math.max(0, ...depth.values()) + 1;
    const root = chain.steps[0]?.thread;
    const chainLabel = root === undefined ? chain.id : shorten(badgeName(root));
    const chainHueValue = chainHue(chainIndex);
    for (const [threadId, value] of depth) {
      chainPlace.set(threadId, {
        position: value + 1,
        total,
        chainId: chain.id,
        chainLabel,
        chainHue: chainHueValue,
      });
    }
  }
  const place = (threadId: string) =>
    chainPlace.get(threadId) ?? {
      position: 1,
      total: 1,
      chainId: threadId,
      chainLabel: "",
      chainHue: 0,
    };

  const badges: HandoffBadge[] = [];
  for (const thread of data.threads) {
    const continued = successors.get(thread.id) ?? [];
    const continues = predecessors.get(thread.id) ?? [];

    if (continued.length > 0) {
      const pick = continued
        .map((link) => byId.get(link.fromThreadId))
        .filter((candidate): candidate is ThreadRef => candidate !== undefined)
        .sort((a, b) => a.createdAt - b.createdAt)[0];
      if (pick === undefined) continue;
      const extra = continued.length > 1 ? ` +${continued.length - 1}` : "";
      badges.push({
        threadId: thread.id,
        threadTitle: thread.title,
        kind: "superseded",
        label: `Superseded by "${shorten(badgeName(pick))}"${extra}`,
        counterpartId: pick.id,
        counterpartTitle: badgeName(pick),
        count: continued.length,
        ...place(thread.id),
        updatedAt: thread.updatedAt,
      });
      continue;
    }

    if (continues.length > 0) {
      const pick = continues
        .map((link) => byId.get(link.toThreadId))
        .filter((candidate): candidate is ThreadRef => candidate !== undefined)
        .sort((a, b) => b.createdAt - a.createdAt)[0];
      if (pick === undefined) continue;
      const extra = continues.length > 1 ? ` +${continues.length - 1}` : "";
      badges.push({
        threadId: thread.id,
        threadTitle: thread.title,
        kind: "continues",
        label: `Continues "${shorten(badgeName(pick))}"${extra}`,
        counterpartId: pick.id,
        counterpartTitle: badgeName(pick),
        count: continues.length,
        ...place(thread.id),
        updatedAt: thread.updatedAt,
      });
    }
  }

  return badges;
}
