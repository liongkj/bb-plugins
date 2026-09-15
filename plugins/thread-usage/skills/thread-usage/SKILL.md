---
name: thread-usage
description: Explain Thread Usage token, context-window, and cache-accounting metrics when a user asks about per-thread usage.
---

# Thread Usage

The Thread Usage plugin adds a usage control beside the chat title in the
active BB thread header and cache statuses to native sidebar thread rows. It
reads BB's latest persisted thread/tokenUsage/updated and
thread/contextWindowUsage/updated events and does not call a provider or
external service. It does not replace the sidebar list or its archive/ellipsis
controls.

## Metrics

- tokens is the cumulative total from the thread's latest usage event.
- Codex/DeepSeek-style cache hit is cached input tokens divided by total input
  tokens; Claude-style cache activity is cached input divided by uncached plus
  cached input.
- The popover also contains input, cached input, output, reasoning, last-turn,
  context-window used/capacity, context-window remaining, cache-timer values,
  and a cached-versus-uncached timeline for the latest 60 persisted usage
  snapshots.
- The context-window card uses BB's current used/capacity snapshot and explains
  that continuing keeps the current context while a new thread avoids sending
  it but requires any needed background again. After cache expiry, continuing
  may resend the context without cache reuse.
- The timeline uses each event's `last` breakdown to show cached and uncached
  input by usage snapshot, oldest to newest. BB may not emit one usage event for
  every chat turn, so missing turns cannot be reconstructed. It cannot identify
  the exact message or text span because normalized events do not include that
  attribution.

If a thread has no usage event, the popover says Usage not recorded yet. The
open panel refreshes every 15 seconds. The control can be hidden with the
showUsage plugin setting. The cache timer is visible inline beside the thread
title and in the popover. Native sidebar rows use the same status. Before 50%
of the configured cache window, show a green warm indicator; after 50%, show
the going-cold indicator; after 100%, show the amber expired state and say that
the next message will be read as a new message. It
defaults to accounting-aware auto mode: five
minutes for separate-input accounting and 30 minutes otherwise. It can be
changed with the cacheWindowMinutes setting.

Load the bounded cache timeline when the usage popover is open. Treat it as a
persisted usage-snapshot token-count view, not a complete transcript or a
provider cache trace.

For cache debugging, the timeline logs deduplicated `[cache-debug]` lines for
newly observed usage events with uncached input, including full misses in the
bounded window. The line contains only the thread id, timestamps, gap,
accounting mode, and numeric token counts; it never logs prompt text. Read it
with `bb plugin logs thread-usage`.

For Claude, BB's normalized cachedInputTokens combines cache reads and writes,
so call the percentage cache activity rather than a read-only cache-hit rate.
For Codex/DeepSeek-style accounting, inputTokens already includes
cachedInputTokens; do not add them together when calculating the percentage.

The timer is advisory. It shows **Cache warm** before half the configured idle
window, **Cache going cold** after half that window, and shows the amber
**Cache expired** state after the full window. The sidebar's warm status is
icon-only; its going-cold status includes the exact seconds until expiry, uses
an orange warning treatment, and ticks every second. Usage events refresh every
15 seconds for visible rows. The expired sidebar status uses the same orange
treatment. Provider routing, prompt changes, and retention policy can still
cause an earlier cache miss.
