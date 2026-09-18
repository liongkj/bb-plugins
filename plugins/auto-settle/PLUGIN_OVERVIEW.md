# Auto Settle — plugin overview

## What it does

Auto Settle checks the active BB threads every five minutes. It settles a
thread when the thread's pull request is merged.

## Why it is separate

The BB Sidebar plugin already has a merge rule. That rule lives inside the
Sidebar plugin. If you disable the Sidebar plugin, the rule stops. Auto Settle
keeps the rule in a small headless plugin, so the rule works with or without
the Sidebar plugin.

## Settle targets

- With the BB Sidebar plugin: Auto Settle calls Sidebar's `settle` RPC. The
  thread moves to the Sidebar settled shelf.
- Without the BB Sidebar plugin: Auto Settle archives the thread and stops its
  runtime. The default BB sidebar respects the archive.

## Surfaces

- Plugin server entry: `server.ts`
- Decision logic: `lib/policy.ts`
- `bb auto-settle` CLI: `status`, `preview`, `run`, `settle`, `forget`
- Agent skill: `skills/auto-settle/SKILL.md`
