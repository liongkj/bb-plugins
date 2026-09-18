---
name: thread-handoffs
description: "Find the threads a BB thread was handed off from or to, and read the prior work. Use when a thread continues another thread's task, when picking up a handoff, or when the user asks which threads are linked."
---

# Thread handoffs

BB records a handoff when a message references another thread with
`@thread:<id>` (the common "Continue from @thread:..." pattern), and when a
thread is forked from another. The Thread Handoffs plugin turns those links into
chains you can read.

## Find your own chain

```sh
bb handoffs show          # uses $BB_THREAD_ID, the thread running the command
bb handoffs show thr_xxx  # a specific thread
bb handoffs               # every chain in the workspace
bb handoffs --json        # machine-readable chains, threads, and links
```

`show` prints the chain oldest-first. A `↳` step continues the previous thread;
`↰` means the previous thread references a later one; `●` is the chain start.

## Read the prior work

A handoff link is a pointer, not the content. Pull the predecessor's messages
before continuing its task:

```sh
bb thread output thr_xxx          # last assistant message
bb thread log thr_xxx --limit 40  # recent turns, newest first
bb thread show thr_xxx            # environment, branch, PR status
```

Carry forward the same environment and branch when the predecessor's workspace
still holds the work; do not redo committed changes.

## Notes

- Hidden subagent workers are excluded from fork links, so chains stay about
  real user-facing handoffs.
- The snapshot is cached on the server for about 15 seconds. A just-created
  handoff thread may take one refresh to appear; `bb handoffs` always recomputes
  after the cache expires.
- The sidebar shows an at-a-glance badge on linked threads: each badge shows the
  thread's step in the chain (`2/3`) and whether it is `superseded` or
  `current`, tinted with a per-chain colour. Linear chains also nest their
  superseded threads under the thread that replaced them (collapsible); the
  thread you are viewing always stays visible.
- The thread header shows a **Handoffs** control only on a thread that is part
  of a chain; it opens a grouped chains view in the right panel (every chain as
  a group, yours first). There is deliberately no sidebar item: the sidebar's
  thread list belongs to whichever list plugin is active.
