# BB plugins

Personal BB plugins maintained in one repository.

## Included plugins

- Account Pooler Custom — per-account quota switch thresholds for Claude and Codex.
- Auto Settle — settle a thread when its pull request is merged, with or without the BB Sidebar plugin.
- Close Terminal Button — inspect and close terminal sessions from a thread header.
- Thread Usage — show thread token, cache, and context metrics.
- Thread Handoffs — show which threads were handed off to which, with sidebar badges and grouped chains.
- Worktree Cleanup — audit and clean worktrees with human-gated recovery.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
```

Build one plugin from the repository root:

```bash
bb plugin build plugins/account-pool-custom
```

Install one plugin directly from this repository:

```bash
bb plugin install git:https://github.com/liongkj/bb-plugins.git@main \
  --subdirectory plugins/account-pool-custom --yes
```

The `.bb/plugins.json` file indexes every plugin for BB marketplace and
collection installs. The previous standalone repositories remain available as
historical sources; new changes should land here.
