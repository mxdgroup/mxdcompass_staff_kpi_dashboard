---
title: "fix: Repair Wrike KPI sync pipeline and add multi-schedule cron"
type: fix
status: completed
date: 2026-04-16
---

# fix: Repair Wrike KPI sync pipeline and add multi-schedule cron

## Overview

The KPI dashboard sync pipeline has two critical bugs that cause it to produce empty or incomplete data, plus the cron schedule only runs once daily instead of the desired three times. This plan fixes the broken sync, adds the flow snapshot to the cron path, and configures the requested multi-schedule cron.

## Problem Frame

Tasks moved in Wrike are not reflected in the KPI dashboard even after clicking "Sync Now" or waiting for the daily cron. Investigation revealed:

1. **Cron sync never loads config overrides** -- on Vercel cold starts, all `wrikeContactId` values are empty strings, causing the weekly snapshot to contain zero tasks for every team member. This empty snapshot overwrites the valid one in Redis.
2. **Cron sync never builds the FlowSnapshot** -- the flow dashboard (tickets, WIP, throughput, cycle times) only updates on manual sync, going stale between clicks.
3. **Cron runs once daily at 04:00 UTC** -- the user needs syncs at 8:00 AM, 10:20 AM, and 8:00 PM (Philippine time, UTC+8).
4. **Webhook events store transitions but never trigger a snapshot rebuild** -- the dashboard shows stale data until the next full sync.

## Requirements Trace

- R1. Cron sync must load config overrides from Redis before building snapshots (parity with manual sync)
- R2. Cron sync must build and save both WeeklySnapshot and FlowSnapshot (parity with manual sync)
- R3. Cron must run at 8:00 AM PHT (00:00 UTC), 10:20 AM PHT (02:20 UTC), and 8:00 PM PHT (12:00 UTC)
- R4. Manual "Sync Now" must continue working correctly (no regressions)
- R5. Improve observability: alert when sync guard blocks a cron run

## Scope Boundaries

- NOT implementing real-time snapshot rebuilds on webhook events (would require significant architecture change; deferred)
- NOT changing the dedup key for webhook transitions (separate concern)
- NOT fixing the missing webhook signature enforcement (separate security fix)
- NOT fixing the timelogs date filtering or week-boundary ISO calculation (separate bugs)

## Context & Research

### Relevant Code and Patterns

- `src/app/api/sync/route.ts` -- the **correct** reference implementation: calls `loadOverridesFromRedis()`, builds both snapshots
- `src/app/api/cron/sync/route.ts` -- the broken cron: missing `loadOverridesFromRedis()` and `buildFlowSnapshot()`
- `src/lib/bootstrap.ts` -- `loadOverridesFromRedis()` rehydrates contact IDs from Redis into in-memory config
- `src/lib/flowBuilder.ts` -- `buildFlowSnapshot()` builds ticket flow data
- `src/lib/flowStorage.ts` -- `saveFlowSnapshot()` persists flow data to Redis
- `src/lib/storage.ts` -- sync guard, snapshot persistence, `getWebhookLastEvent()`
- `vercel.json` -- current cron config: single `0 4 * * *` schedule

### Key Observation

The manual sync route (`src/app/api/sync/route.ts`) is the correct reference. The cron route diverged -- it was likely written before the flow snapshot was added, and `loadOverridesFromRedis()` was either forgotten or added to the manual route later. The fix is to bring the cron route into parity.

## Key Technical Decisions

- **Use Vercel Cron's multiple-entry syntax**: Vercel supports multiple cron entries in `vercel.json`. We'll add three entries all pointing to the same `/internal/kpis/api/cron/sync` path with different schedules, rather than trying to encode multiple times in a single cron expression.
- **Philippine Time (UTC+8)**: 8:00 AM PHT = 00:00 UTC, 10:20 AM PHT = 02:20 UTC, 8:00 PM PHT = 12:00 UTC.
- **Notify on guard conflict**: When `acquireSyncGuard()` returns false in the cron path, send a Slack notification using the existing `notifySlack` pattern so the team knows a sync was skipped.

## Open Questions

### Resolved During Planning

- **Q: Does the cron route import `loadOverridesFromRedis`?** Yes, the import exists at line 1, but the function is never called in `runSync()`. This is clearly an oversight.
- **Q: What timezone is the user in?** Philippine Time (UTC+8), based on the team being in Davao.
- **Q: Can Vercel handle multiple cron entries?** Yes, `vercel.json` supports an array of cron objects.

### Deferred to Implementation

- **Q: Should we add a force-release mechanism for stuck sync guards?** Worth considering but out of scope for this fix.

## Implementation Units

- [ ] **Unit 1: Fix cron sync to load config overrides and build flow snapshot**

  **Goal:** Bring the cron sync route into parity with the manual sync route so it produces complete, correct data.

  **Requirements:** R1, R2

  **Dependencies:** None

  **Files:**
  - Modify: `src/app/api/cron/sync/route.ts`

  **Approach:**
  - Add `await loadOverridesFromRedis();` **before** `acquireSyncGuard()` in `runSync()` -- matching the manual sync route's ordering where overrides load before guard acquisition (the import already exists at line 1)
  - After `await saveSnapshot(snapshot)`, add `buildFlowSnapshot(week)` and `saveFlowSnapshot()` calls, matching the pattern in `src/app/api/sync/route.ts` lines 29-30. Do NOT wrap in try/catch -- match the manual sync's existing behavior for parity
  - Import `buildFlowSnapshot` from `@/lib/flowBuilder` and `saveFlowSnapshot` from `@/lib/flowStorage`
  - Add `flowTickets` count to the JSON response, matching the manual sync response shape

  **Patterns to follow:**
  - `src/app/api/sync/route.ts` lines 12, 28-30 -- exact pattern to replicate

  **Test expectation:** none -- no test infrastructure exists in this repo (no test runner, no config). This is a 7-line parity fix to an existing route. Test coverage is a separate initiative.

  **Verification:**
  - Deploy and trigger a cron sync; confirm the response JSON includes non-zero `membersProcessed` and `flowTickets`
  - Confirm the flow dashboard updates after a cron run without manual intervention

- [ ] **Unit 2: Configure multi-schedule cron in vercel.json**

  **Goal:** Run syncs at the three requested times daily instead of once at 04:00 UTC.

  **Requirements:** R3

  **Dependencies:** Unit 1 (cron should be correct before increasing frequency)

  **Files:**
  - Modify: `vercel.json`
  - Test: none (declarative config, verified by deployment)

  **Approach:**
  - Replace the single cron entry with three entries, all pointing to `/internal/kpis/api/cron/sync`:
    - `0 0 * * *` (00:00 UTC = 8:00 AM PHT)
    - `20 2 * * *` (02:20 UTC = 10:20 AM PHT)
    - `0 12 * * *` (12:00 UTC = 8:00 PM PHT)

  **Patterns to follow:**
  - Existing `vercel.json` crons array structure

  **Test expectation:** none -- declarative config change, verified by Vercel deployment logs showing three scheduled invocations.

  **Verification:**
  - Vercel dashboard shows three cron schedules
  - Each cron fires at the expected UTC time

- [ ] **Unit 3: Alert on sync guard conflict in cron path**

  **Goal:** Make stuck sync guards visible instead of silently returning 409.

  **Requirements:** R5

  **Dependencies:** Unit 1

  **Files:**
  - Modify: `src/app/api/cron/sync/route.ts`

  **Approach:**
  - When `acquireSyncGuard()` returns false, send a Slack notification before returning 409
  - Inline a simple `fetch()` call to `NOTIFICATION_WEBHOOK_URL` with the message "KPI Sync skipped: sync guard still held (possible stuck lock)" -- do not extract a helper for a single use

  **Patterns to follow:**
  - Existing `notifySlack()` function in the same file (lines 81-102)

  **Test scenarios:**
  - Happy path: when guard acquisition fails and `NOTIFICATION_WEBHOOK_URL` is set, a Slack notification is sent
  - Edge case: when guard acquisition fails and `NOTIFICATION_WEBHOOK_URL` is not set, no error is thrown (graceful skip)

  **Verification:**
  - Slack channel receives a notification when a cron sync is blocked by the guard

## System-Wide Impact

- **Interaction graph:** The cron route change affects the same Redis keys as the manual sync (`kpi:snapshot:{week}`, `kpi:flow:{week}`, `kpi:latest`, `kpi:flow:latest`). No new interaction surfaces.
- **Error propagation:** Adding `buildFlowSnapshot()` to the cron path means a flow builder failure could prevent the cron response from returning. The `finally` block already handles `releaseSyncGuard()`, so the guard won't get stuck. We replicate the manual sync's behavior (no try/catch on flow build) for parity -- if flow build fails, the weekly snapshot is already saved, and the error surfaces in the response.
- **State lifecycle risks:** With three cron runs instead of one, the sync guard becomes more important. Two crons firing close together (unlikely given the spread) would correctly be handled by the existing guard.
- **Unchanged invariants:** The manual sync route, webhook handler, bootstrap endpoint, and dashboard read endpoints are not modified.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| `buildFlowSnapshot()` increases cron duration beyond 300s `maxDuration` | Monitor first few runs; flow build is I/O-bound (Wrike API calls). The manual sync already does both within the same 300s limit. |
| Redis overrides key missing (bootstrap never run) | The `loadOverridesFromRedis()` function is a no-op if the key doesn't exist -- config stays at defaults. This is existing behavior. If overrides are missing, the real fix is to run bootstrap. |
| Three cron runs triple Wrike API usage | Wrike rate limit is 400 req/min. Each sync makes ~20-30 requests (3 members x ~8 requests). Three syncs/day is well within limits. |

## Sources & References

- Manual sync route: `src/app/api/sync/route.ts` (correct reference implementation)
- Cron sync route: `src/app/api/cron/sync/route.ts` (file to fix)
- Vercel Cron docs: Vercel supports multiple cron entries in the `crons` array
