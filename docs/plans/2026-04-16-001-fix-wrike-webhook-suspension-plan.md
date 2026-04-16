---
title: "fix: Prevent recurring Wrike webhook suspension"
type: fix
status: active
date: 2026-04-16
---

# fix: Prevent recurring Wrike webhook suspension

## Overview

The Wrike webhook (ID `IEAGV532JAACBO6C`) keeps getting suspended because Wrike cannot reliably reach the endpoint. Previous fixes addressed the handshake timeout, base path 404s, and host-based blocking — but the event processing path still blocks the HTTP response, there is no auto-reactivation mechanism, and the webhook secret can be silently lost.

## Problem Frame

Wrike suspends webhooks when it receives repeated errors or timeouts from the endpoint. Three independent failure modes remain unfixed:

1. **Response timeout during event processing:** The handshake path correctly uses `after()` to defer Redis work, but the event handler at `src/app/api/webhook/wrike/route.ts:46-53` awaits `storeTransition()` (multiple Redis round-trips) before returning 200 OK. Under load or Redis latency, this exceeds Wrike's timeout window.

2. **No auto-reactivation:** The cron sync job detects webhook staleness (48h with no events) and notifies Slack, but takes no corrective action. The webhook stays suspended until someone manually sends the PUT request from the Wrike email.

3. **Lost webhook secret → 401 rejections:** The HMAC secret is stored in Redis after handshake. If Redis evicts it and `WRIKE_WEBHOOK_SECRET` is not set as an env var, `validateSignature()` returns false and every event gets a 401 response, causing Wrike to suspend.

## Requirements Trace

- R1. Webhook endpoint must return 200 OK within Wrike's timeout window for all valid event payloads
- R2. System must automatically reactivate suspended webhooks without manual intervention
- R3. Webhook secret must be reliably available across deployments and Redis evictions

## Scope Boundaries

- Not changing webhook event types or transition storage logic
- Not changing the cron schedule or sync aggregation
- Not adding new monitoring beyond what already exists (Slack notifications)

## Context & Research

### Relevant Code and Patterns

- `src/app/api/webhook/wrike/route.ts` — webhook handler; handshake already uses `after()` pattern
- `src/lib/wrike/webhook.ts` — secret storage, HMAC validation, transition storage
- `src/app/api/cron/sync/route.ts` — daily cron with existing staleness detection at line 48
- `src/lib/storage.ts` — Redis utilities including `getWebhookLastEvent()`

### Institutional Learnings

- Commit 7821e26 established the `after()` pattern for deferring Redis work in the handshake path — same pattern should apply to event processing
- Commit d9d1726/c4a371c showed that base path changes cause immediate webhook breakage (404s)

## Key Technical Decisions

- **Use `after()` for event storage:** Matches the established pattern from the handshake fix. Return 200 immediately, process events asynchronously. This is the simplest fix for timeout-related suspensions.
- **Reactivate from the existing cron job:** The staleness detection already runs daily. Adding a Wrike API call to reactivate is cheaper and simpler than a new endpoint or separate scheduled function.
- **Store secret with explicit TTL, not default eviction:** Redis keys without TTL can still be evicted under memory pressure. Set a long explicit TTL (matching the 365-day TTL used for transitions) and add a persistence check.

## Open Questions

### Resolved During Planning

- **Where to put auto-reactivation?** In the existing cron sync handler — it already detects staleness and has auth, so adding a Wrike API call there avoids new infrastructure.
- **Should we re-register the webhook or just reactivate?** Just reactivate via PUT. Re-registration would generate a new webhook ID and require a new handshake.

### Deferred to Implementation

- **Exact Wrike API error handling for reactivation:** Need to verify what status codes the Wrike PUT endpoint returns on success/failure.

## Implementation Units

- [ ] **Unit 1: Defer event processing with `after()`**

**Goal:** Return 200 OK immediately for all valid webhook events, deferring Redis storage to background.

**Requirements:** R1

**Dependencies:** None

**Files:**
- Modify: `src/app/api/webhook/wrike/route.ts`

**Approach:**
- Wrap the event processing loop (lines 46-53) in `after()`, matching the existing handshake pattern on line 15
- Parse and validate the payload before `after()` so invalid requests still get 400/401 responses synchronously
- Return 200 OK immediately after validation passes

**Patterns to follow:**
- Handshake path in the same file (lines 14-22) already demonstrates this exact pattern

**Test scenarios:**
- Happy path: POST with valid events returns 200 immediately without awaiting Redis operations
- Error path: POST with invalid JSON still returns 400 synchronously
- Error path: POST with invalid HMAC signature still returns 401 synchronously

**Verification:**
- Webhook endpoint returns 200 within milliseconds for valid payloads regardless of Redis latency

- [ ] **Unit 2: Add webhook auto-reactivation to cron sync**

**Goal:** Automatically reactivate the Wrike webhook when staleness is detected, eliminating manual intervention.

**Requirements:** R2

**Dependencies:** Unit 1 (endpoint must be healthy before reactivation makes sense)

**Files:**
- Modify: `src/app/api/cron/sync/route.ts`
- Create: `src/lib/wrike/api.ts` (Wrike API client for reactivation call)

**Approach:**
- When `webhookStale` is true (line 48-49), call the Wrike API to reactivate before sending the Slack notification
- Use `WRIKE_PERMANENT_ACCESS_TOKEN` (already in env) for the Wrike API auth
- Store the webhook ID (`IEAGV532JAACBO6C`) as an env var `WRIKE_WEBHOOK_ID` to avoid hardcoding
- Update the Slack notification to indicate whether reactivation succeeded or failed
- Keep the reactivation call simple: PUT to `https://www.wrike.com/api/v4/webhooks/{id}?status=Active`

**Patterns to follow:**
- Existing `notifySlack()` function in the same file for error reporting pattern
- Existing env var usage pattern (`WRIKE_PERMANENT_ACCESS_TOKEN`, `CRON_SECRET`)

**Test scenarios:**
- Happy path: When webhook is stale, cron calls Wrike API to reactivate and reports success in Slack notification
- Error path: Wrike API reactivation fails (network error, invalid token) — cron continues sync, Slack notification includes failure details
- Edge case: Webhook is not stale — no reactivation attempt is made

**Verification:**
- Cron sync job detects stale webhook and automatically attempts reactivation via Wrike API
- Slack notification reflects reactivation outcome

- [ ] **Unit 3: Harden webhook secret persistence**

**Goal:** Ensure the HMAC secret survives Redis eviction and cold starts.

**Requirements:** R3

**Dependencies:** None (can be done in parallel with Unit 1)

**Files:**
- Modify: `src/lib/wrike/webhook.ts`

**Approach:**
- Add explicit TTL (365 days, matching transition keys) when storing the webhook secret in `storeWebhookSecret()`
- Log a warning when falling back to `WRIKE_WEBHOOK_SECRET` env var so it's visible in logs
- In `validateSignature()`, if no secret is available from either source, log an error with actionable context (not just "No webhook secret available")

**Patterns to follow:**
- TTL pattern from `storeTransition()` in the same file (line 89, `TTL_SECONDS = 365 * 24 * 60 * 60`)

**Test scenarios:**
- Happy path: Secret stored with explicit TTL, retrieved successfully on subsequent calls
- Edge case: Redis secret missing, falls back to env var with warning log
- Error path: Neither Redis nor env var has secret — returns 401 with clear error log

**Verification:**
- Redis key `kpi:webhook:secret` has explicit TTL set
- Fallback to env var produces a visible log warning

## System-Wide Impact

- **Interaction graph:** The cron sync job gains a new outbound call to the Wrike API. The webhook handler's response timing changes (faster return, deferred processing).
- **Error propagation:** If `after()` processing fails, events are silently lost for that batch. This is acceptable since the daily cron sync rebuilds from Wrike API data anyway.
- **State lifecycle risks:** None — `after()` runs in the same request lifecycle, just after the response is sent.
- **Unchanged invariants:** Webhook event types, transition storage format, cron schedule, sync aggregation logic, and Slack notification channel all remain unchanged.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| `after()` failures silently drop events | Acceptable: daily cron sync rebuilds from Wrike API. Add error logging inside `after()` callback |
| Wrike API reactivation requires valid access token | Token already exists as `WRIKE_PERMANENT_ACCESS_TOKEN`; if expired, Slack notification will report the failure |
| New env var `WRIKE_WEBHOOK_ID` must be set | Document in deployment; reactivation gracefully skips if not set |

## Sources & References

- Wrike webhook suspension email referencing webhook ID `IEAGV532JAACBO6C`
- Wrike API docs: PUT `/api/v4/webhooks/{id}?status=Active` for reactivation
- Previous fix commits: 7821e26 (handshake timeout), d9d1726 (base path), 5081e74 (HMAC rejection)
