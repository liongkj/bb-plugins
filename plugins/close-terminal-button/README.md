# Close Terminal Button

This BB plugin adds an `X` button to a thread header only when that thread has
an active terminal session or BB background activity. The button opens a small
terminal and background-work panel for that thread. Each terminal has its own
Close button and confirmation step. Background activity has a separate
confirmation that stops all background commands and agents in the thread.

Closing a terminal stops its shell and any process running in it. The plugin
does not read or store terminal output.

## Install

```sh
bb plugin install 'git:https://github.com/liongkj/bb-plugin-close-terminal-button.git@^0.1.3'
```

For local development, install the checkout instead:

```sh
bb plugin install .
```

To migrate an existing local-path installation to the GitHub release:

```sh
bb plugin remove close-terminal-button
bb plugin install 'git:https://github.com/liongkj/bb-plugin-close-terminal-button.git@^0.1.3'
```

The Git installation tracks compatible `0.1.x` releases. Run `bb plugin update
close-terminal-button --yes` after a new release is tagged.

After source changes:

```sh
bb plugin build
bb plugin reload close-terminal-button
```
