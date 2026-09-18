# Auto Settle

A headless BB plugin. It settles a thread when the thread's pull request is
merged.

Auto Settle works in two places:

- **With the BB Sidebar plugin.** Auto Settle calls Sidebar's `settle` RPC. The
  thread moves to the Sidebar settled shelf and Sidebar releases the runtime.
- **Without the BB Sidebar plugin.** Auto Settle archives the thread and stops
  its runtime. The default BB sidebar respects the archive.

This is the difference from BB Sidebar's own merge rule: that rule is part of
the Sidebar plugin and stops when the plugin stops. Auto Settle is separate, so
the rule keeps working on its own.

## Install

```
bb plugin install /Users/liongkj/work/bb-plugin-auto-settle
```

Or from the plugin directory:

```
bb plugin install .
```

## First run

**Preview only** is `true` at first. The plugin reports the threads that would
settle and changes nothing.

```
bb auto-settle preview
```

To apply the result, turn the preview off:

```
bb plugin config auto-settle set dryRun false
```

To settle one thread immediately, without a settings change:

```
bb auto-settle settle <thread-id>
```

## Commands

| Command | Result |
| --- | --- |
| `bb auto-settle status [--json]` | Settings, last run, and recent settlements. |
| `bb auto-settle preview [--json]` | The threads that would settle now. No change. |
| `bb auto-settle run [--apply] [--json]` | Evaluate now. `--apply` settles even in preview mode. |
| `bb auto-settle settle <thread-id>` | Settle one thread now. |
| `bb auto-settle forget <thread-id>` | Clear one thread's settle record. |

## Settings

`bb plugin config auto-settle set <key> <value>`

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Run the five-minute schedule. |
| `settleMerged` | `true` | Settle a thread when its pull request is merged. |
| `settleClosed` | `false` | Also settle a thread when its pull request is closed without a merge. |
| `settleInactive` | `false` | Also settle a thread after a period without activity. |
| `inactiveAfterDays` | `3` | The inactivity period. Range: 1 to 90 days. |
| `withoutSidebar` | `archive` | What to do without BB Sidebar. Values: `archive`, `stop`, `skip`. |
| `dryRun` | `true` | Report only. Do not settle. |

## Safety rules

- Auto Settle does not settle a pinned thread.
- Auto Settle does not settle a thread that is active, pending, starting, or
  stopping.
- Auto Settle does not settle a thread when the merge time is before the last
  thread activity.
- Auto Settle does not settle an open or a draft pull request.
- A failed pull request lookup keeps the current state. The next run tries
  again.
- New thread activity clears the settle record. Auto Settle then judges the
  thread again.
- With `withoutSidebar` set to `archive`, Auto Settle archives the thread.
  Archiving a parent thread also archives the child threads.

## Development

```
npm install
npm run typecheck
npm test
npm run build
```

The decision logic is in `lib/policy.ts` and has unit tests in
`lib/policy.test.ts`. The unit tests do not need a running BB server.

## License

MIT. The merge rule is adapted from the MIT-licensed
[bb-sidebar](https://github.com/yusuf8834/bb-sidebar) plugin.
