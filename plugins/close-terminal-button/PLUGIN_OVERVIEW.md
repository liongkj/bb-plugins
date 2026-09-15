Adds a small `X` button to a BB thread header only when that thread has an
active terminal session or background activity.

Click the button to see the active terminal sessions owned by that thread. Each
session shows its title, working directory, and status. Closing a session needs
an explicit confirmation and stops the shell and its child process.

The plugin uses BB's terminal API and does not inspect or store terminal output.
