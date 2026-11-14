# Balanced Account Pool + BB Provider Retry

This fork keeps OXI's per-account thresholds, priority/reserve roles, projects,
schedules, and routing. It adds the official BB Provider Retry availability RPC
for **routed Claude Code and Codex threads only**.

## Behavior

- A new request still follows Balanced's existing account selection policy.
- An eligible backup account is used before waiting for a reset.
- When all usable accounts are quota- or weekly-cap-blocked, the pool returns
  HTTP 429 and, when known, a retry-after hint. BB Provider Retry may then
  schedule a retry of the **same failed turn**.
- The availability RPC checks the exact most recent failed request, provider,
  project and routing state. It returns `blocked` with a conservative next
  reset estimate, `ready` or `unavailable`.
- Explicit schedules, project restrictions, disabled accounts, authentication
  errors and unknown reset times are **not** automatically bypassed.
- **No separate retry queue or `turn.failed` handler exists in Balanced**. BB
  Provider Retry owns transient network failures, overloads and rate limits.
- The official availability RPC is consulted for quota failures on routed
  Claude Code and Codex threads. Other providers still benefit from Provider
  Retry generic network/overload handling, but do not have custom quota
  availability integration here.
- Provider Retry defaults to a six-hour maximum automatic wait, configurable
  to 24 hours or No limit. Provider Retry also bounds retry attempts.
- This does not provide a perpetual background worker by itself: BB's
  **Provider Retry** component must be present and enabled to schedule the
  delayed turn retry.

## Important safeguards

Disable the **original** Account Pooler if this fork is handling the same
provider. Two poolers contributing environment variables can conflict.
Do not share subscription credentials between people or use this integration
to circumvent provider usage or account restrictions.

## Verification

`pnpm --filter bb-plugin-account-pool-balanced typecheck`
`pnpm --filter bb-plugin-account-pool-balanced test`

End-to-end verification requires a BB host with Provider Retry installed:
test provider discovery, a controlled cap block, delayed retry scheduling,
manual continuation canceling queued retries, server restart, and known vs.
unknown reset timestamps. Do not deploy to valuable accounts before these
checks have passed.
