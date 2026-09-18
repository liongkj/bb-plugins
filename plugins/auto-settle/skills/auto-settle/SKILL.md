---
name: auto-settle
description: "Settle BB threads whose pull requests are merged. Use to check, preview, run, or explain the Auto Settle plugin."
---

# Auto Settle

The Auto Settle plugin checks the active BB threads every five minutes. It asks
BB for each thread's pull request. It settles a thread when the pull request is
merged. A settled thread does not hold work.

The plugin uses the BB Sidebar plugin when that plugin is installed. Then the
thread moves to the Sidebar settled shelf. Without the BB Sidebar plugin, the
plugin archives the thread and stops its runtime.

## Commands

- `bb auto-settle status` — show the settings, the last run, and the recent
  settlements. Add `--json` for machine output.
- `bb auto-settle preview` — list the threads that would settle now. This
  command changes nothing.
- `bb auto-settle run` — evaluate now. The command obeys the **Preview only**
  setting. Add `--apply` to settle even when **Preview only** is on.
- `bb auto-settle settle <thread-id>` — settle one thread now. The settings do
  not apply to this command.
- `bb auto-settle forget <thread-id>` — clear one thread's settle record, so
  the plugin judges the thread again.

## Settings

Use `bb plugin config auto-settle set <key> <value>`.

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Run the five-minute schedule. |
| `settleMerged` | `true` | Settle a thread when its pull request is merged. |
| `settleClosed` | `false` | Also settle a thread when its pull request is closed without a merge. |
| `settleInactive` | `false` | Also settle a thread after a period without activity. |
| `inactiveAfterDays` | `3` | The inactivity period. Range: 1 to 90 days. |
| `withoutSidebar` | `archive` | What to do without BB Sidebar. Values: `archive`, `stop`, `skip`. |
| `dryRun` | `true` | Report only. Do not settle. |

## Rules

- The plugin does not settle a pinned thread.
- The plugin does not settle a thread that is active, pending, starting, or
  stopping.
- The plugin does not settle a thread when the merge time is before the last
  thread activity.
- The plugin does not settle an open or a draft pull request.
- A failed pull request lookup keeps the current state. The next run tries
  again.
- New thread activity clears the settle record. The plugin then judges the
  thread again.

## First run

**Preview only** is `true` at first. Run `bb auto-settle preview` to see the
threads that would settle. Then set `dryRun` to `false` to apply the result.
