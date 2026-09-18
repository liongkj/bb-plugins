// bb-plugin-thread-handoffs — backend.
//
// A "handoff" is a new thread that continues an earlier one (typically after
// the earlier thread runs out of model credit). BB already records the
// strongest signal: when a message contains an `@thread:<id>` mention, the
// stored `client/turn/requested` event carries a structured mention whose
// resource is `{ kind: "thread", threadId, label }`. This plugin reads those
// mentions, adds BB's fork relationships, and turns them into a link graph the
// Handoffs page, the thread-header control, and `bb handoffs` all render.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  buildBadges,
  buildChains,
  stepCounterpartId,
  stepRelationLabel,
  type HandoffData,
  type HandoffLink,
  type ThreadRef,
} from "./lib/handoffs";

const threadRefSchema = z.object({
  id: z.string(),
  title: z.string(),
  projectId: z.string(),
  projectName: z.string(),
  providerId: z.string(),
  status: z.string(),
  hidden: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const handoffLinkSchema = z.object({
  fromThreadId: z.string(),
  toThreadId: z.string(),
  kind: z.enum(["mention", "fork"]),
  label: z.string().nullable(),
});

export const rpcContract = defineRpcContract({
  handoffs_get: {
    input: z.null(),
    output: z.object({
      threads: z.array(threadRefSchema),
      links: z.array(handoffLinkSchema),
      scannedThreads: z.number(),
      truncated: z.boolean(),
      fetchedAt: z.number(),
    }),
  },
});

interface RawThread {
  id: string;
  title: string | null;
  titleFallback: string | null;
  projectId: string;
  providerId: string;
  status: string;
  hidden: boolean;
  createdAt: number;
  updatedAt: number;
  parentThreadId: string | null;
  sourceThreadId: string | null;
  originKind: "fork" | null;
}

const REQUESTED_EVENT = "client/turn/requested" as const;
const PAGE_SIZE = 200;
const MAX_THREADS = 2000;
const MAX_EVENTS_PER_THREAD = 50;
const SCAN_CONCURRENCY = 8;
const CACHE_TTL_MS = 15_000;

let cache: { value: HandoffData; expiresAt: number } | null = null;
let inflight: Promise<HandoffData> | null = null;

/** Run `fn` over `items` with at most `limit` promises in flight. */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      for (;;) {
        const index = next++;
        if (index >= items.length) return;
        results[index] = await fn(items[index] as T);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

function displayTitle(thread: RawThread): string {
  const title = thread.title ?? thread.titleFallback ?? thread.id;
  const trimmed = title.replace(/\s+/gu, " ").trim();
  return trimmed === "" ? thread.id : trimmed;
}

async function listThreads(bb: BbPluginApi): Promise<{
  threads: RawThread[];
  truncated: boolean;
}> {
  const threads: RawThread[] = [];
  let truncated = false;

  for (let offset = 0; offset < MAX_THREADS; offset += PAGE_SIZE) {
    const page = await bb.sdk.threads.list({
      limit: PAGE_SIZE,
      offset,
      includeHidden: true,
    });
    for (const thread of page) {
      threads.push({
        id: thread.id,
        title: thread.title,
        titleFallback: thread.titleFallback,
        projectId: thread.projectId,
        providerId: thread.providerId,
        status: thread.status,
        hidden: thread.visibility === "hidden",
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
        parentThreadId: thread.parentThreadId,
        sourceThreadId: thread.sourceThreadId,
        originKind: thread.originKind,
      });
    }
    if (page.length < PAGE_SIZE) break;
    if (offset + PAGE_SIZE >= MAX_THREADS) truncated = true;
  }

  return { threads, truncated };
}

/** Thread ids referenced by `@thread:` mentions in one thread's user turns. */
async function mentionLinks(
  bb: BbPluginApi,
  thread: RawThread,
): Promise<HandoffLink[]> {
  const links: HandoffLink[] = [];
  let rows;
  try {
    rows = await bb.sdk.threads.events.list({
      threadId: thread.id,
      types: [REQUESTED_EVENT],
      order: "asc",
      limit: String(MAX_EVENTS_PER_THREAD),
    });
  } catch (cause) {
    bb.log.debug(
      `Could not read events for ${thread.id}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    return links;
  }

  const seen = new Set<string>();
  for (const row of rows) {
    if (row.type !== "client/turn/requested") continue;
    for (const item of row.data.input) {
      if (item.type !== "text") continue;
      for (const mention of item.mentions) {
        const resource = mention.resource;
        if (resource.kind !== "thread") continue;
        if (resource.threadId === thread.id) continue;
        const key = `${thread.id}|${resource.threadId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        links.push({
          fromThreadId: thread.id,
          toThreadId: resource.threadId,
          kind: "mention",
          label: resource.label,
        });
      }
    }
  }

  return links;
}

async function computeHandoffs(bb: BbPluginApi): Promise<HandoffData> {
  const fetchedAt = Date.now();

  const [{ threads: rawThreads, truncated }, projects] = await Promise.all([
    listThreads(bb),
    bb.sdk.projects.list({ includePersonal: true }),
  ]);

  const projectNames = new Map(projects.map((project) => [project.id, project.name]));
  const known = new Set(rawThreads.map((thread) => thread.id));

  const linkKeys = new Set<string>();
  const links: HandoffLink[] = [];
  const addLink = (link: HandoffLink) => {
    if (link.fromThreadId === link.toThreadId) return;
    if (!known.has(link.fromThreadId) || !known.has(link.toThreadId)) return;
    const key = `${link.fromThreadId}|${link.toThreadId}|${link.kind}`;
    if (linkKeys.has(key)) return;
    linkKeys.add(key);
    links.push(link);
  };

  // Fork/source relationships BB already knows about. Only visible threads,
  // so hidden subagent workers do not show up as handoffs.
  for (const thread of rawThreads) {
    if (thread.hidden) continue;
    const source =
      thread.sourceThreadId ??
      (thread.originKind === "fork" ? thread.parentThreadId : null);
    if (source !== null) {
      addLink({
        fromThreadId: thread.id,
        toThreadId: source,
        kind: "fork",
        label: null,
      });
    }
  }

  const mentionGroups = await mapLimit(
    rawThreads,
    SCAN_CONCURRENCY,
    (thread) => mentionLinks(bb, thread),
  );
  for (const group of mentionGroups) {
    for (const link of group) addLink(link);
  }

  const involved = new Set<string>();
  for (const link of links) {
    involved.add(link.fromThreadId);
    involved.add(link.toThreadId);
  }

  const threads: ThreadRef[] = rawThreads
    .filter((thread) => involved.has(thread.id))
    .map((thread) => ({
      id: thread.id,
      title: displayTitle(thread),
      projectId: thread.projectId,
      projectName: projectNames.get(thread.projectId) ?? thread.projectId,
      providerId: thread.providerId,
      status: thread.status,
      hidden: thread.hidden,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
    }));

  return {
    threads,
    links,
    scannedThreads: rawThreads.length,
    truncated,
    fetchedAt,
  };
}

async function getHandoffs(bb: BbPluginApi): Promise<HandoffData> {
  if (cache !== null && cache.expiresAt > Date.now()) return cache.value;
  if (inflight !== null) return inflight;

  inflight = computeHandoffs(bb)
    .then((value) => {
      cache = { value, expiresAt: Date.now() + CACHE_TTL_MS };
      return value;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

function shortTitle(value: string, max = 48): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function formatChain(index: number, chain: ReturnType<typeof buildChains>[number]): string[] {
  const titles = new Map(chain.steps.map((step) => [step.thread.id, step.thread.title]));
  const lines = [`${index + 1}. ${chain.steps.length} threads`];
  for (const step of chain.steps) {
    const marker = step.via === null ? "●" : step.forward ? "↳" : "↰";
    const counterpart = stepCounterpartId(step);
    const relation =
      counterpart === null
        ? "chain start"
        : `${stepRelationLabel(step)} ${shortTitle(titles.get(counterpart) ?? counterpart)}`;
    lines.push(
      `   ${marker} ${step.thread.id}  ${shortTitle(step.thread.title, 64)}  [${step.thread.projectName}]  (${relation})`,
    );
  }
  return lines;
}

export default async function plugin(bb: BbPluginApi): Promise<void> {
  bb.log.info("loaded");

  // Which sidebar draws the at-a-glance row badge. `auto` inspects the DOM for
  // BB Sidebar's row markup; the other values force one integration. Settings
  // are read once per load, so reload after changing this.
  const settings = bb.settings.define({
    sidebar: {
      type: "select",
      label: "Sidebar for row badges",
      description:
        "Auto detects BB Sidebar; force default for BB's built-in list, or bb-sidebar for the BB Sidebar plugin.",
      options: ["auto", "default", "bb-sidebar"],
      default: "auto",
    },
    groupRows: {
      type: "boolean",
      label: "Group chains in the sidebar",
      description:
        "In BB Sidebar, nest superseded threads under the thread that replaced them.",
      default: true,
    },
  });
  const { sidebar, groupRows } = await settings.get();

  bb.rpc.register(rpcContract, {
    handoffs_get: () => getHandoffs(bb),
  });

  // Served to the content script (native row-status and BB Sidebar badges).
  // Default `local` auth accepts same-origin frontend GETs.
  bb.http.route("GET", "/badges", async () => {
    const data = await getHandoffs(bb);
    return new Response(
      JSON.stringify({ mode: sidebar, groupRows, badges: buildBadges(data) }),
      {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        },
      },
    );
  });

  const usage = [
    "Usage:",
    "  bb handoffs [--json]                 List every handoff chain",
    "  bb handoffs show [thread-id] [--json]  Show the chain containing a thread",
    "",
    "With no thread id, `show` uses $BB_THREAD_ID (the thread running the command).",
  ].join("\n");

  bb.cli.register({
    name: "handoffs",
    summary: "Show which threads were handed off to which",
    commands: [
      {
        name: "list",
        summary: "List every handoff chain",
        usage: "bb handoffs list [--json]",
      },
      {
        name: "show",
        summary: "Show the chain containing a thread",
        usage: "bb handoffs show [thread-id] [--json]",
      },
    ],
    async run(argv) {
      const json = argv.includes("--json");
      const args = argv.filter((arg) => arg !== "--json");
      const [command = "list", threadId] = args;

      if (command === "help" || command === "--help") {
        return { exitCode: 0, stdout: usage };
      }
      if (command !== "list" && command !== "show") {
        return { exitCode: 1, stderr: usage };
      }

      const data = await getHandoffs(bb);
      const chains = buildChains(data);

      if (command === "show") {
        const target = threadId ?? process.env.BB_THREAD_ID;
        if (target === undefined || target === "") {
          return {
            exitCode: 1,
            stderr: "No thread id given and BB_THREAD_ID is not set.",
          };
        }
        const match = chains.filter((chain) =>
          chain.steps.some((step) => step.thread.id === target),
        );
        if (match.length === 0) {
          const known = data.threads.some((thread) => thread.id === target);
          return {
            exitCode: 0,
            stdout: known
              ? `${target} is not part of a handoff chain.`
              : `${target} is not in the scanned threads or has no handoff links.`,
          };
        }
        if (json) {
          return { exitCode: 0, stdout: JSON.stringify({ chains: match }) };
        }
        return {
          exitCode: 0,
          stdout: match.map((chain, index) => formatChain(index, chain)).join("\n\n"),
        };
      }

      if (json) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            chains,
            threads: data.threads,
            links: data.links,
            scannedThreads: data.scannedThreads,
            truncated: data.truncated,
            fetchedAt: data.fetchedAt,
          }),
        };
      }

      if (chains.length === 0) {
        return {
          exitCode: 0,
          stdout: `No handoff chains found among ${data.scannedThreads} scanned threads.`,
        };
      }

      const header = `Handoff chains: ${chains.length} (scanned ${data.scannedThreads} threads${
        data.truncated ? ", truncated" : ""
      })`;
      const body = chains
        .slice(0, 25)
        .map((chain, index) => formatChain(index, chain))
        .join("\n\n");
      const more =
        chains.length > 25 ? `\n\n…and ${chains.length - 25} more chains.` : "";
      return { exitCode: 0, stdout: `${header}\n\n${body}${more}` };
    },
  });

  bb.onDispose(() => {
    bb.log.info("disposed");
  });
}

export type { HandoffData };
