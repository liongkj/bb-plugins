# BB Worktree Cleanup

BB plugin that scans every registered project source, including containers
with nested repositories, for unused worktrees.

The hourly schedule runs at minute 23. A worktree is eligible only when all of
these checks pass:

- BB created and manages it through the `git-worktree` provider.
- Every unarchived thread, including hidden threads, is idle, unpinned, and has
  no pending interaction, queued work, goal, workflow, plan, agent, or command.
- Its environment and archived threads are older than the retention period.
- Its branch, path, provider, and base-branch metadata still match.
- Its working tree is clean, with no untracked files.
- It has no commits ahead of its merge base.

For worktrees outside BB's managed environment provider, the plugin discovers
repositories under each source, dry-runs or applies `git worktree prune`, and
protects every path attached to a BB environment. It preserves primary
checkouts and requires the worktree HEAD to remain reachable from another Git
ref. Modified and untracked files are compared by exact blob content against
branch tips and the primary checkout. Unique content blocks removal. Narrow
OS/editor residue, log lock files, and untracked dependency directories may be
discarded after the retention period.

Source-worktree age is based on the latest commit timestamp and the mtimes of
tracked changes or non-ignored untracked files. The scanner does not use the
worktree directory mtime, so creating or removing an ignored cache does not
reset its retention clock. Directory traversal is still used to discover Git
repositories; it is not used as an activity signal.

Cleanup requests use BB's environment API. The plugin archives eligible
threads, BB performs its final live-thread check, and the worktree provider
removes the path asynchronously. These checks and actions are separate, so a
thread or filesystem change made in that small window cannot be locked out by
a plugin. Leave automation disabled if that residual race is unacceptable.

## Install

```sh
npm install
npm run check
npm test
npm run build
bb plugin install .
```

## Use

```sh
bb worktree-cleanup preview
bb worktree-cleanup status
bb worktree-cleanup run --apply
bb worktree-cleanup sources --prune
bb worktree-cleanup sources --apply --prune
bb worktree-cleanup mole
bb worktree-cleanup review
```

`review` examines old, unattached worktrees containing unique changes. It sends
bounded, redacted evidence to short-lived hidden reviewer threads and then
opens a structured decision form in the invoking BB thread. Sensitive and
binary contents are withheld, and **Keep** is selected by default.

An approved removal proceeds only when a fresh content fingerprint matches the
reviewed fingerprint. Before removal, tracked changes and untracked files are
copied to the plugin's private host data directory under `recoveries/`.
The hourly scan creates one deduplicated visible BB review thread when old
unique work appears; it does not repeatedly ask about an unchanged candidate
set.

Configure automatic cleanup and retention through BB settings or the CLI:

```sh
bb plugin config worktree-cleanup set retentionDays 14
bb plugin config worktree-cleanup set projectIds proj_one,proj_two
bb plugin config worktree-cleanup set automatic true
bb plugin config worktree-cleanup set automaticReview true
```

`projectIds` is empty by default, which includes every project. `mole` runs a
dry-run of Mole's project artifact purge against the registered source paths;
Mole's interactive application remains a deliberate terminal action. Reports
are stored as the plugin's last managed-environment, all-source, semantic, and
human-review reports.
