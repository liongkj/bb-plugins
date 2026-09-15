Thread Usage adds a small, provider-independent usage control beside the chat
title in the BB thread header. Open it for cumulative tokens, input/output and
reasoning tokens, the latest-turn total, context-window usage, and a
cache-accounting-aware percentage. The context card shows used/capacity tokens,
remaining capacity, and the input-cost tradeoff between continuing and starting
a new thread. The live timer is shown inline beside the thread title and counts
down from the latest usage event. Native sidebar thread rows also show the same
cache state without replacing BB's list or row actions. The popover also includes
a cached-versus-uncached input timeline for the latest 60 persisted usage snapshots.
Before 50% of the estimated cache window elapses, it shows a green warm
indicator; after 50%, it shows a going-cold indicator; after the full window,
it marks the next message as a new message.

## What it reads

The plugin asks BB only for the latest persisted thread/tokenUsage/updated and
thread/contextWindowUsage/updated events for the active thread (`limit: 1`,
newest first). It uses the token-usage event's cumulative totals and the
context-window event's current used/capacity snapshot, so opening the panel does
not hydrate turns, items, or the entire thread history. Threads with no usage
event show that usage has not been recorded yet.

When the popover is open, the timeline reads only typed token-usage events and
plots each event's last cached and uncached input breakdown from oldest to
newest. It is a usage-snapshot view: BB may not emit one event for every chat
turn and cannot identify the exact message or text span because normalized
events do not include that attribution.

No account, API key, or external service is required. Usage stays inside the
local BB installation.

The header control and sidebar statuses can be hidden from the plugin settings
with **Show thread usage in the chat header**, or from the CLI with:

~~~sh
bb plugin config thread-usage set showUsage false
~~~

The plugin detects BB's accounting shape. For Codex or DeepSeek-style events,
`inputTokens` includes cached input, so the cache-hit percentage is
`cachedInputTokens / inputTokens`. For Claude-style events, `inputTokens` is
the uncached portion, so the percentage uses
`cachedInputTokens / (inputTokens + cachedInputTokens)` and is labeled **Cache
activity** because BB combines cache reads and writes.

The estimated cache window defaults to accounting-aware **auto** mode: 5
minutes for separate-input accounting and 30 minutes otherwise. It can be
changed with the plugin setting or with:

~~~sh
bb plugin config thread-usage set cacheWindowMinutes auto
~~~

Before half of the configured window, the inline timer shows a green indicator
and the popover says **Cache warm**. At half or less remaining, it shows an
amber `!` and says **Cache going cold**. Once the window has elapsed, it says
**Cache expired** in amber and says **The next message will be read as a new
message**. The countdown is advisory because provider routing, prompt changes,
and cache retention can cause an earlier miss.

The context card makes the cost tradeoff explicit: continuing keeps the current
context available and may reuse its cache while warm; after expiry it may resend
that context without cache reuse. Starting a new thread avoids sending the
existing context, but any background needed for the new thread must be provided
again. BB can mark the context snapshot as estimated.

Sidebar row statuses use a warm clock, an orange going-cold alert with the
exact seconds until expiry, or an orange expired alert. The cold countdown
ticks every second; each visible row's latest usage event refreshes every 15
seconds. BB's archive and ellipsis controls remain host-rendered.
