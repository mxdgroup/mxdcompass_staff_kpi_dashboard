---
title: "Comprehensive Reliability Audit: All Known Problems"
type: fix
status: active
date: 2026-04-16
---

# Comprehensive Reliability Audit: All Known Problems

## Overview

Full inventory of every known reliability, correctness, and security issue in the KPI dashboard sync pipeline. This document catalogs problems only. Fix plans are in separate documents, grouped by priority phase.

The dashboard has a recurring pattern: it works for a day, then silently stops producing correct data. This audit traces every path that can cause that behavior.

## Problem Frame

The KPI dashboard syncs data from Wrike to Redis via three paths:
1. **Cron sync** (3x daily) -- builds weekly + flow snapshots
2. **Manual sync** ("Sync Now" button) -- same pipeline, triggered by user
3. **Webhook** -- real-time transition events from Wrike

All three paths have independent failure modes that compound. A single webhook suspension, lock race, or empty snapshot can cascade into days of bad data with no alert.

---

## Problem Inventory

### Category 1: Sync Lock & Race Conditions

#### P1. Sync guard has no owner token (CRITICAL)

**Location:** `src/lib/storage.ts:160`, `src/app/api/cron/sync/route.ts:42`

The sync guard is a plain Redis `SET NX EX 300` key with no owner identifier. If a sync run exceeds 300s (the same as `maxDuration`), the TTL expires, a second sync starts, and the first run's `finally` block calls `releaseSyncGuard()` which deletes the second run's lock. This creates overlapping syncs where stale data can overwrite fresh data.

**Impact:** Intermittent data corruption, "works then stops" pattern.

#### P2. Lock TTL equals route timeout (HIGH)

**Location:** `src/app/api/cron/sync/route.ts:10`, `src/lib/storage.ts:160`

Both are 300s. A sync that runs to the limit loses its lock exactly when it needs it most. The lock should outlive the function by a comfortable margin.

**Impact:** Lock expiry race under load or with growing data volume.

#### P3. Sync guard returns `true` when Redis is unavailable (HIGH)

**Location:** `src/lib/storage.ts` (acquireSyncGuard)

If Redis is unreachable, `acquireSyncGuard()` returns `true` (acquired). This means multiple serverless instances can all think they hold the lock simultaneously when Redis is down.

**Impact:** Overlapping syncs with no guard during Redis outages.

---

### Category 2: Snapshot Data Protection

#### P4. Partial/empty snapshots always saved (CRITICAL)

**Location:** `src/lib/aggregator.ts:115`, `src/lib/flowBuilder.ts:435`, `src/app/api/cron/sync/route.ts:72`

Both sync routes always save whatever they built, even if the result has zero employees or zero tasks. A transient Wrike outage produces an empty snapshot that overwrites the last good data in Redis.

**Impact:** One bad sync run wipes all dashboard data until the next successful run.

#### P5. Snapshot persistence is not atomic (CRITICAL)

**Location:** `src/lib/storage.ts:118`, `src/lib/flowStorage.ts:40`

`saveSnapshot()` writes the week-keyed payload first, then separately updates the `kpi:latest` pointer. `saveFlowSnapshot()` does the same. A failure between writes leaves the `latest` pointer stale or pointing at a different generation than the flow snapshot.

**Impact:** Dashboard shows stale or inconsistent data after partial write failures.

#### P6. flowStorage creates new Redis instances per call (HIGH)

**Location:** `src/lib/flowStorage.ts` (getRedis)

Unlike `storage.ts` which uses a singleton `getSharedRedis()`, `flowStorage.ts` creates a new `Redis.fromEnv()` on every call. This wastes connections and could cause rate limiting on Upstash.

**Impact:** Connection waste, potential Upstash rate limiting during heavy sync.

---

### Category 3: Webhook Processing

#### P7. Event processing runs in `after()` -- fire-and-forget (CRITICAL)

**Location:** `src/app/api/webhook/wrike/route.ts:52`

The webhook route returns `200 OK` before transitions are stored in Redis. The `after()` callback runs `storeTransition()` and `applyDateForStatusChange()` in the background. If the Vercel function shuts down, times out, or the background task is dropped, events are permanently lost with no retry mechanism.

**Impact:** Silent permanent event loss. Pipeline movement, cycle times, and date auto-setting all degrade.

#### P8. Handshake secret storage also in `after()` (HIGH)

**Location:** `src/app/api/webhook/wrike/route.ts:16`

If the `after()` callback for storing the webhook handshake secret is dropped, the secret never persists. All subsequent signed events fail with 401, Wrike sees repeated errors, and suspends the webhook.

**Impact:** Webhook permanently broken until manual re-registration.

#### P9. Unsigned events accepted when signature header is absent (HIGH)

**Location:** `src/app/api/webhook/wrike/route.ts:28`

The signature validation only runs when `x-hook-signature` is present. If the header is absent, the event is processed without any authentication. This allows forged or malformed events to poison transition history.

**Impact:** Security gap, data integrity risk from forged events.

#### P10. Any request can overwrite the stored webhook secret (HIGH)

**Location:** `src/app/api/webhook/wrike/route.ts:14`

The handshake path stores any `x-hook-secret` it receives with no origin validation. A single crafted request replaces the stored secret, breaking all future real webhook events.

**Impact:** Denial-of-service vector, breaks all webhook processing.

#### P11. Webhook dedup key ignores timestamp (CRITICAL)

**Location:** `src/lib/wrike/webhook.ts:104`

The dedup key is `taskId:fromStatusId:toStatusId`, scoped to the week. A task that legitimately transitions `In Review -> In Progress` twice in one week has the second event dropped. This undercounts movement and makes items look like they stopped being picked up.

**Impact:** Incorrect KPI data, missed transitions.

#### P12. Webhook dedup is not atomic (HIGH)

**Location:** `src/lib/wrike/webhook.ts:117`

`SISMEMBER` check happens before the pipeline `SADD`. Concurrent webhook deliveries can both see "not present" and both insert, creating duplicate transitions.

**Impact:** Duplicate transitions inflate movement counts under concurrent load.

---

### Category 4: Wrike API Robustness

#### P13. Pagination failures silently truncated (HIGH)

**Location:** `src/lib/wrike/client.ts:204`

If a later page of a paginated Wrike API response errors, the client logs a warning and returns the partial pages collected so far. This is silent data loss -- the sync completes successfully with incomplete data.

**Impact:** Missing tasks/timelogs in snapshots without any error signal.

#### P14. 429 retry ignores Retry-After header (HIGH)

**Location:** `src/lib/wrike/client.ts:92`, `src/lib/wrike/errorUtils.ts:23`

The retry logic uses a fixed exponential backoff and ignores the `Retry-After` header. Under real rate limiting, the client hammers too early and can turn transient throttling into persistent failure.

**Impact:** Extended API failures during rate limiting periods.

#### P15. reactivateWebhook() bypasses WrikeClient (MEDIUM)

**Location:** `src/lib/wrike/api.ts`

`reactivateWebhook()` uses raw `fetch` instead of `WrikeClient`, so it has no retry, no throttle, and no timeout handling. If the reactivation call fails, it fails silently.

**Impact:** Webhook reactivation can fail without retry.

---

### Category 5: Data Correctness

#### P16. Comments fetched without date filters -- unbounded growth (HIGH)

**Location:** `src/lib/wrike/fetcher.ts:171,196,254,273`

Folder comments and per-task comments are fetched without date filters. The API cost grows with total account history, not just this week's activity. As data accumulates, syncs take longer and eventually time out.

**Impact:** "Works for a while, then times out" pattern. Direct cause of P1/P2 lock races.

#### P17. Timelogs summed across all time, not requested week (HIGH)

**Location:** `src/lib/wrike/fetcher.ts:205`

Timelogs are fetched unfiltered and summed across all time. The dashboard shows total historical hours, not weekly hours. This is incorrect data and another scaling risk.

**Impact:** Wrong timelog numbers on dashboard, growing API cost.

#### P18. Flow dashboard drops items with no recent update (MEDIUM)

**Location:** `src/lib/wrike/fetcher.ts:241`

`fetchClientTasks()` for the flow snapshot only fetches tasks updated within the requested week. Active items with no recent update disappear from the flow dashboard entirely, making it look like items stopped being picked up.

**Impact:** Incomplete flow dashboard, misleading WIP counts.

#### P19. Transition history truncated at week boundary (MEDIUM)

**Location:** `src/lib/flowBuilder.ts:412`

Transitions are stored by ISO week. Flow reconstruction only looks at transitions within the selected week. Any stage entered before week start is invisible, so cycle-time calculations are truncated for long-running items.

**Impact:** Inaccurate cycle times for items spanning multiple weeks.

#### P20. Task "moved this week" flag is per-member, not per-task (MEDIUM)

**Location:** `src/lib/aggregator.ts:59`

The `movedThisWeek` flag is computed from whether the member moved *any* task, not whether that specific task moved. This inflates movement flags and masks real pickup behavior.

**Impact:** Misleading movement indicators on dashboard.

#### P21. getPriorWeekStr() hardcodes week 52 (LOW)

**Location:** `src/lib/aggregator.ts:191`

Prior year week is hardcoded to `52`. Years with ISO week 53 (e.g., 2026) will produce wrong prior-week lookups.

**Impact:** Wrong comparison data in week 1 of ISO-53 years.

---

### Category 6: Bootstrap & Configuration

#### P22. loadOverridesFromRedis() swallows all failures (HIGH)

**Location:** `src/lib/bootstrap.ts:133`

If Redis override loading fails after a cold start, all contact IDs remain blank. The system quietly stops matching tasks to people. No error, no alert -- just empty data.

**Impact:** Silent data loss on every cold start where Redis overrides fail.

#### P23. Config has blank contact IDs by default (HIGH)

**Location:** `src/lib/config.ts:45`

The checked-in config has empty `wrikeContactId` for all team members. The app depends on overrides loading perfectly every time. If overrides fail (P22), the entire sync pipeline produces zero useful data.

**Impact:** No defense-in-depth for the most critical config values.

#### P24. Bootstrap contact matching is ambiguous (MEDIUM)

**Location:** `src/lib/bootstrap.ts:29`

Contact discovery matches by first name or full name only. Duplicate or ambiguous names silently bind the wrong person. Missing matches produce only warnings.

**Impact:** Wrong person's tasks shown on dashboard.

#### P25. Workflow status cache never refreshes (MEDIUM)

**Location:** `src/lib/wrike/fetcher.ts:39`

`resolveWorkflowStatuses()` caches in a module-level variable. On Vercel serverless, this means it's fresh per cold start but stale within a warm instance. The Redis cache key (`kpi:workflow:statuses`) exists in storage but is never read or populated by the fetcher.

**Impact:** Workflow changes require a cold start to take effect.

---

### Category 7: Observability & Operational Safety

#### P26. Stale-webhook check skips when last_event is missing (HIGH)

**Location:** `src/app/api/cron/sync/route.ts:62`

The staleness check is `lastEvent !== null && Date.now() - lastEvent * 1000 > 48h`. If the key is missing (Redis flush, first deploy, eviction), `lastEvent` is `null`, the check is false, and the webhook is treated as healthy even if it's dead.

**Impact:** Dead webhook not detected or reactivated.

#### P27. Manual sync has no authentication (MEDIUM)

**Location:** `src/app/api/sync/route.ts:11`

The manual sync endpoint has no auth. Anyone who can reach the app can trigger expensive sync runs, increasing overlap risk and API rate limiting.

**Impact:** Unauthenticated access to expensive operation.

#### P28. No alarm on top-level sync failure (MEDIUM)

**Location:** `src/app/api/cron/sync/route.ts:60`

Slack notifications only fire on lock contention or member-level errors. A top-level sync failure (e.g., Redis down, Wrike auth expired) returns 500 with no alert, no persisted failure state, and no health endpoint.

**Impact:** Sync can fail repeatedly with nobody noticing.

#### P29. Webhook metrics fail open to zeros (MEDIUM)

**Location:** `src/lib/aggregator.ts:32`

If webhook/transition retrieval fails, pipeline movement, returns, and approval cycle time all quietly become zero instead of surfacing the fault.

**Impact:** Dashboard shows zeros instead of error state, misleading users.

#### P30. Local-file fallback not production-safe (MEDIUM)

**Location:** `src/lib/storage.ts:36`, `src/lib/flowStorage.ts:51`, `src/lib/bootstrap.ts:81`

The code falls back to local JSON files when Redis env vars are absent. On Vercel's read-only filesystem, this silently fails. If Redis is misconfigured, the app doesn't degrade cleanly.

**Impact:** Silent failure in production if Redis env vars are missing.

---

## Summary by Severity

| Severity | Count | Problems |
|----------|-------|----------|
| CRITICAL | 5 | P1, P4, P5, P7, P11 |
| HIGH | 14 | P2, P3, P6, P8, P9, P10, P12, P13, P14, P16, P17, P22, P23, P26 |
| MEDIUM | 9 | P15, P18, P19, P20, P24, P25, P27, P28, P29 |
| LOW | 1 | P21 |
| **Total** | **29** | |

## Fix Plan Structure

Fixes are organized into four phased plans, ordered by impact and dependency:

1. **Phase 1: Sync Lock & Data Protection** (P1, P2, P3, P4, P5, P6) -- Stop bad data from being written
2. **Phase 2: Webhook Reliability** (P7, P8, P9, P10, P11, P12) -- Stop losing real-time events
3. **Phase 3: API Robustness & Data Correctness** (P13, P14, P15, P16, P17, P18, P19, P20, P21) -- Fix what data is fetched and how
4. **Phase 4: Observability & Operational Safety** (P22, P23, P24, P25, P26, P27, P28, P29, P30) -- Make failures visible and config resilient

Each phase has its own plan document in `docs/plans/`.
