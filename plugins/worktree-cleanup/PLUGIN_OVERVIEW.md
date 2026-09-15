## Safe cleanup policy

Worktree Cleanup discovers repositories and worktrees throughout every BB
project source. It checks pinned and pending thread state, provider metadata,
retention, Git refs, modified files, untracked files, and exact copies on other
branch tips before removing anything.

Automation is disabled initially. Preview candidates with:

```sh
bb worktree-cleanup preview
```

You can request one managed cleanup pass with `run --apply`, inspect every
source with `sources --prune`, apply the reviewed source cleanup with
`sources --apply --prune`, or run agent-assisted human review with `review`.
Approved review removals receive a private recovery capsule first. `mole`
previews regenerable project artifacts.
The hourly schedule creates a deduplicated visible review thread when retained
unique content crosses the configured age threshold.
Project IDs can be allowlisted and retention defaults to seven days.

For source worktrees, retention uses the latest commit and tracked or
non-ignored untracked file activity. Ignored caches do not change the age;
unknown ignored files remain a separate safety concern before deleting a whole
worktree.

The plugin skips uncertain states. BB still makes the final decision: it
refuses cleanup while an environment has a live or stopping thread, then its
environment provider performs removal asynchronously.
