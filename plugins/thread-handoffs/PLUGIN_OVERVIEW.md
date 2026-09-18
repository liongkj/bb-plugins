See how a thread's work moved from one agent run to the next — which thread was
handed off, and which one picked it up.

## What you get

- An at-a-glance badge on linked threads in the sidebar: the older thread reads
  `2/3 superseded`, the tip reads `3/3 current`, tinted with a per-chain colour
  so scattered members still read as one group. It auto-detects BB Sidebar and
  can be forced with the `sidebar` setting.
- **Grouped rows**: a linear chain's superseded threads are nested under the
  thread that replaced them, so the chain reads as one block. The group
  collapses, and the thread you're viewing always stays visible. Toggle with the
  `groupRows` setting.
- A **Handoffs** control in the thread header, shown only when the open thread
  is part of a chain. It opens a grouped chains view in the right panel: every
  chain as its own group, yours first, with an **Only this chain** toggle.
- A `bb handoffs` command for the same data from a terminal, including
  `bb handoffs show` for the chain containing the current thread.

There is no new sidebar item: a plugin that replaces the thread list (such as BB
Sidebar) owns it. The badge decorates the rows that already exist.

## How it works

A handoff is already recorded in BB. When you start a thread with
`Continue from @thread:<id>`, BB stores that reference as a structured mention
on the thread's first turn, and a fork records its source thread. This plugin
reads those links and groups the threads into chains, so a run that ran out of
credit and continued in a fresh thread stays visibly connected.

Everything is derived from data on the BB server; the plugin stores nothing,
contacts no external service, and needs no account or API key.

## For agents

The bundled skill tells an agent to run `bb handoffs show` to find the thread it
was handed off from, then read that thread's output and log before continuing
its work instead of starting over.
