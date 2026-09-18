# bb-plugin-thread-handoffs

A BB plugin that shows which threads were handed off to which. When one thread
runs out of model credit (or you otherwise continue its work elsewhere), the
next thread usually starts with `Continue from @thread:<id>`. BB already stores
that reference as a structured thread mention; this plugin reads those mentions,
adds fork relationships, and links the threads into readable chains.

- `server.ts` — the backend: scans `client/turn/requested` events for
  `@thread:` mentions, pairs them with fork relationships, caches the graph, and
  serves it over RPC plus the `bb handoffs` command.
- `app.tsx` — the frontend: an at-a-glance badge on each linked thread's
  sidebar row, plus a **Handoffs** control in the thread header that opens a
  grouped chains view in the right panel
  (`app.slots.experimental_threadHeaderAction` + `app.slots.threadPanelAction`).
  No new sidebar item is added.
- `lib/handoffs.ts` — runtime-neutral graph shaping shared by both bundles.
- `skills/thread-handoffs/SKILL.md` — tells an agent how to find and read the
  thread it was handed off from.

Try it: install the plugin, then look for the **superseded by …** / **continues
…** badge on a handed-off thread's sidebar row. Open that thread and use the
**Handoffs** control in its header for the full chain, or run `bb handoffs` in a
terminal. `bb handoffs show` prints the chain for the current thread
(`$BB_THREAD_ID`).

## Sidebar modes

The badge has two integrations over one server payload, selected by the
`sidebar` setting:

| Value | Behavior |
| --- | --- |
| `auto` (default) | Uses `bb-sidebar` when BB Sidebar's row markup is present, else `default`. |
| `default` | Uses the host's `experimental_setThreadRowStatus`, which renders in BB's **built-in** thread list. |
| `bb-sidebar` | Injects a small badge next to each row's title, for the **BB Sidebar** plugin. |

```
bb plugin config thread-handoffs set sidebar bb-sidebar
bb plugin reload thread-handoffs
```

`groupRows` (default `true`) additionally groups the sidebar: a linear chain's
superseded threads are nested under the thread that replaced them, so the chain
reads as one block. The `superseded (n)` header collapses the nested list, and
the thread you are viewing is never nested away — its row stays put so the
sidebar's active/selected highlight keeps working. Branched chains (siblings that
each continue the same thread) stay as plain step badges, because nesting one
branch under another would misrepresent it. Turn it off with:

```
bb plugin config thread-handoffs set groupRows false
bb plugin reload thread-handoffs
```

Why two: BB Sidebar replaces the exclusive thread list slot, and BB only renders
plugin row statuses in its own built-in list, so the native path shows nothing
there. The `bb-sidebar` path inserts a badge beside the row title instead. The
badge shows the thread's step in the chain and whether it is superseded or
current (e.g. `2/3 superseded`, `3/3 current`), tinted with a per-chain colour so
scattered members of one chain still read as a group; its tooltip names the
linked thread and the chain's root.

Grouping limitation: BB Sidebar only nests rows by `parentThreadId` and ignores
BB thread sections, and a plugin cannot reorder its rendered rows. So the chain
is surfaced as step numbers and shared colour, not as a single grouped block.

## How detection works

1. List every non-archived thread, including hidden workers.
2. Read each thread's `client/turn/requested` events and collect mentions whose
   resource is `{ kind: "thread", threadId, label }` — these are your
   `@thread:` references, already resolved by BB.
3. Add a `fork` link for a thread whose `sourceThreadId` (or forked
   `parentThreadId`) names another thread. Hidden subagent workers are skipped.
4. Group the resulting graph into connected chains, oldest thread first, and
   label each step with the thread it continues from.

The scan is cached server-side for 15 seconds, so a just-created handoff thread
can take one refresh to appear.

## UI components

`components/ui/` is vendored source you own (the shadcn model): edit the files
freely — they never update out from under you. Add more from the BB component
registry (the full shadcn set, version-matched to your BB install via the pinned
ref in `components.json`):

```
npx shadcn add @bb/select @bb/table
```

Run `npm install` once before `bb plugin build` — the vendored components' npm
deps bundle into your dist. React and BB-shimmed packages are provided by the BB
app at runtime and never bundled. Every shimmed package is declared in
`devDependencies` at the host's version so those imports typecheck; keep them
there (never in `dependencies`, which would bundle a second copy).

## Install

From this directory:

```
npm install
bb plugin install .
```

After editing sources, rebuild and reload:

```
bb plugin build
bb plugin reload thread-handoffs
```

Or let `bb plugin dev` rebuild and reload on every save.

## Commands

```
bb handoffs                 # every chain, oldest thread first
bb handoffs show [thread]   # one chain; defaults to $BB_THREAD_ID
bb handoffs --json          # machines: chains, threads, and links
```

In the UI, a `↳` step continues the previous thread, `↰` means the previous
thread references a later one, and `●` starts a chain. Click any thread to open
it.

## Types & API reference

The plugin API ships as the npm package `@get-bb/plugin-sdk`, pinned to an exact
version in `devDependencies`. After `npm install`, the full surface is on disk
at:

```
node_modules/@get-bb/plugin-sdk/bundled-types/bb-plugin-sdk.d.ts      # backend
node_modules/@get-bb/plugin-sdk/bundled-types/bb-plugin-sdk-app.d.ts  # frontend
```

The SDK surface grows with every BB release, so the pin has to track the BB you
actually run:

```
bb plugin types          # sync this plugin's SDK surface to the running BB
bb plugin types --check  # CI: fail when it does not match
```
