# bb-plugin-thread-usage

Adds a compact usage control beside the chat title in BB's thread header. Open
it for cumulative token totals, input/output/reasoning tokens, the latest-turn
total, context-window usage, and provider-aware cache percentage. The context
card shows used capacity, remaining capacity, and whether continuing or starting
a new thread avoids more input work. Native sidebar thread rows also show a
compact cache status. A cache timeline shows the cached and uncached input share
for the latest 60 persisted usage snapshots.

The plugin reads BB's latest persisted thread/tokenUsage/updated and
thread/contextWindowUsage/updated events for the active thread. It never sends
usage data to an external service and refreshes the open panel every 15 seconds.
The cache timer is also shown inline beside the thread title; it counts down
from the latest usage event, shows the cache as **warm** with a green indicator
before 50%, changes to **going cold** with an amber `!` after half of the
estimated window has elapsed, and marks the next message as a new message after
the full window.

## Install and develop

~~~sh
npm install
bb plugin build
bb plugin install .
bb plugin dev
~~~

The visibility of the header control and sidebar status is configurable. In the
plugin settings, turn off **Show thread usage in the chat header**, or use:

~~~sh
bb plugin config thread-usage set showUsage false
~~~

Set it back to boolean true to show the control again.

The timer uses an automatic accounting-aware estimate by default: 5 minutes for
adapters that report cached input separately (such as Claude), and 30 minutes
as the generic fallback. The normalized usage event does not include the
provider id, so choose a fixed value when a provider has a different or
best-effort cache lifetime. Available values are 5, 10, 30, 60, or 1440
minutes:

~~~sh
bb plugin config thread-usage set cacheWindowMinutes auto
~~~

Before half of the estimated window elapses, the inline timer shows a green
indicator and the popover says **Cache warm**. At half or less remaining, it
changes to an amber `!` indicator and says **Cache going cold**. Once the
window has elapsed, it says **Cache expired** and says the next message will be
read as a new message. The expired state is amber. This is a visual warning,
not a provider guarantee.

The native sidebar rows use the same states: a warm clock, an orange going-cold
alert with the exact seconds until expiry, or an orange expired alert. The row
status is presentational and does not replace BB's thread list, archive action,
or ellipsis menu. The cold countdown ticks every second; usage events for
visible rows refresh every 15 seconds.

When the usage popover is open, the cache timeline loads the latest 60 typed
token-usage events and plots each event's last cached and uncached input
breakdown. It is a snapshot timeline, not a complete transcript or an exact
highlight of which message or text span missed cache; BB may not persist one
usage event for every chat turn and does not persist that attribution in the
normalized event.

For cache debugging, each newly observed timeline event with uncached input
also writes one deduplicated `[cache-debug]` line to the plugin log. It includes
the event time, gap from the prior usage event, accounting mode, and numeric
cached/uncached counts; it never records prompt text. Inspect it with:

~~~sh
bb plugin logs thread-usage
~~~

## Data boundary

For adapters where `inputTokens` already includes cached input, the cache-hit
percentage is calculated as:

~~~text
cached input tokens / total input tokens
~~~

Adding cached input a second time makes a long Codex or DeepSeek-style thread
look like it is stuck around 49%. Claude's adapter reports uncached input and
cache activity separately, so the plugin uses cached input divided by
`inputTokens + cachedInputTokens` and labels that value **Cache activity**.
BB combines Claude cache reads and writes in that field, so it cannot claim a
read-only hit rate from the normalized event alone.

Threads without a token-usage event show that usage has not been recorded yet.
The context card uses BB's latest context-window snapshot rather than deriving
current context from cumulative totals. It shows the used/capacity ratio and
explains that continuing preserves the current context while a new thread avoids
sending it but requires any background that is still needed. When the cache has
expired, it also warns that continuing may resend that context without cache
reuse. BB can mark the snapshot as estimated.
No account, API key, or external service is required. Usage stays inside the
local BB installation. The timer is a heuristic: cache routing, prompt
changes, provider retention, and provider-specific TTL rules can still cause a
message to miss earlier.
