---
title: "fix: Optimize full sync to fit within Vercel 300s timeout"
type: fix
status: shipped-pending-validation
date: 2026-04-16
deepened: 2026-04-16
scope_locked: 2026-04-17
refined: 2026-04-17
shipped: 2026-04-17
pr: "#20"
---

> **Status (2026-04-17):** Implementation landed on branch `mxd-matt/fast-sync-timeout` (PR #20). This document has been refined to match the shipped state and to capture gaps that surfaced in post-implementation review.
>
> **Landed (shipped in PR #20):** Unit 2 (folder cache, Promise-valued with rejection eviction), Unit 2.5 (90-day cutoff + active-first sort within the unmapped fallback loop), Unit 6 (outer-loop parallelism across members and client folders), Unit 7 (`catchUpMissingDates` soft deadline with telemetry), Unit 8 (two-line cache wiring in `syncRunner` + cron route).
>
> **Outstanding:** Unit 5 (end-to-end timing validation against real Wrike data), Unit 9 (UI audit for 90-day cutoff — see product-gap findings), Unit 10 (partial-sync state visible in dashboard UI — see product-gap findings).
>
> **Deferred until Unit 5 telemetry says we need them:** Unit 0 (batch endpoint validation — requires live token), Unit 1A (batch fetch), Unit 1B (concurrent fetch + throttle reduction), Unit 3 (fetcher refactor to use batch/concurrent). Unit 4 (shared `runSyncBuilds` extraction) was superseded by Unit 8's two-line wiring and will not be revisited unless a later refactor motivates it.
>
> **What actually changed vs. the original plan:** R5's "partial snapshot survives timeout" guarantee is delivered by active-first *ordering within a single build* rather than by a two-phase save with intermediate `saveSnapshot` calls. See the R5 note below for the behavioral consequence. The two-phase save is not in scope until Unit 5 shows it is load-bearing.

# fix: Optimize full sync to fit within Vercel 300s timeout

## Overview

The full Wrike-to-dashboard sync takes ~10 minutes, far exceeding Vercel's 300s function timeout. The three daily crons will timeout and fail. This plan optimizes the sync to complete well under 300s through five complementary strategies:

1. **90-day completed-task cutoff** — the dashboard only stores completed tasks within the last 90 days. Tasks completed earlier are excluded from sync before any expensive fetches (comments, timelogs). This is both a payload bound AND a product decision about what the dashboard represents (see R4 note below).
2. **Active-first ordering** — within each build, unmapped active tasks are fetched before unmapped completed tasks. If a per-task comment fetch loop is interrupted, the active tail is what gets cut, not the active work users see most. (Note: the shipped implementation does NOT save an intermediate snapshot between active and completed processing — see R5.)
3. **Shared folder-comment cache** between the weekly and flow builds, and across parallel branches (Unit 6).
4. **Outer-loop parallelism** across team members (weekly build) and client folders (flow build) via `Promise.all`, so the shared throttle chain interleaves requests rather than serializing entire members/folders.
5. **Batch (or concurrent) comment fetching for unmapped tasks** — deferred; only activated if Unit 5 timing validation shows the above four are insufficient.

## Problem Frame

Both `buildWeeklySnapshot` and `buildFlowSnapshot` independently fetch comments for every task — the same Wrike API calls happen twice per sync. Within each build, tasks whose comments aren't found at the folder level fall back to sequential per-task fetches, each throttled to 1.1s apart. With ~200 unmapped tasks across both builds, that alone is 220s of wall-clock time before counting task/timelog fetches.

The current fetchers also have no completed-task cutoff — `fetchClientTasks` merges `recentTasks` (updatedDate window) with all `activeTasks` and fetches comments for the union, but long-tail completed tasks that Wrike returns in the "recent" window because they were touched recently still end up incurring comment fetches. As the Wrike history grows, this compounds.

The Wrike rate limit is 400 req/min (~6.7 req/s), but the current code makes at most ~1 req/1.1s. There is significant headroom for concurrent requests.

## Requirements Trace

- R1. Full sync completes within 300s on Vercel (with safety margin, target <180s). Success definition: three consecutive cron runs complete with `deadlineReached: false` on catchup. Persistent `deadlineReached: true` across runs is the tripwire for activating the deferred batch/concurrent units — not an acceptable steady state.
- R2. Data correctness preserved within the new 90-day storage boundary — all in-scope tasks (active + completed <90d) have the same comments, tasks, and timelogs as before
- R3. Stay within Wrike's 400 req/min rate limit
- R4. **90-day completed-task cutoff (design AND product rule):** tasks where `status == completed && completedDate < today - 90d` are not synced, not stored, and not displayed. Applies at the earliest point in the fetch pipeline, before comments/timelogs are requested for those tasks. **Active (non-completed) tasks are NEVER filtered by age** — an active task that has been open for 6 months or 2 years stays in scope indefinitely. The 90-day rule is exclusively about completed-task retention.

  **Product framing:** This is not only a storage bound — it is a product decision about what the dashboard represents. The dashboard will not support quarterly or annual completed-task trend comparisons unless the constant is tuned. `COMPLETED_TASK_CUTOFF_DAYS` lives in `src/lib/config.ts`; tuning authority belongs to whoever owns KPI reporting cadence for the dashboard. Revisit if any recurring review cadence exceeds the cutoff, or quarterly as part of dashboard review. See Unit 9 for the UI audit that must accompany this rule.

  **Migration-artifact behavior:** Completed tasks with `completedDate: null` (Feb–early-Mar 2026 migration artifact) are conservatively **included** with a one-time per-sync log line counting how many such tasks passed through. If the count is unbounded or trends up, `isCompletedBeyondCutoff` should switch to using `updatedDate` as a surrogate — tracked as a follow-up, not a blocker.

- R5. **Active-first ordering within each build.** Inside `fetchWeeklyMemberData` and `fetchClientTasks`, the unmapped-task fallback loop sorts active tasks before completed tasks so that if the per-task comment fetch loop is interrupted (by timeout or error), the completed tail is what gets cut, not active work.

  **Non-guarantee:** R5 does NOT promise that a partial snapshot survives a mid-build Vercel timeout. `saveSnapshot` and `saveFlowSnapshot` are only called after their respective builds fully return, so a function that is killed inside `buildWeeklySnapshot` or `buildFlowSnapshot` persists nothing. Users see the prior sync's full snapshot in that case, not a partial active-only snapshot. If true partial-snapshot survival becomes a requirement, it needs the two-phase save originally drafted here (kept in Unit 2.5's historical notes) — that is out of scope for this PR.

## Scope Boundaries

- This plan does NOT split the sync into multiple Vercel function invocations (fan-out).
- This plan does NOT change the cron schedule or add new API routes.
- This plan does NOT save an intermediate snapshot between active and completed task processing. Active-first ordering (R5) is implemented as a sort within the per-task comment fallback loop. If a Vercel timeout kills the sync mid-build, nothing is persisted — the previous sync's full snapshot stands. True partial-snapshot survival would require the two-phase save originally drafted here and is out of scope.
- This plan DOES change what data is fetched — tasks completed more than 90 days ago are excluded (R4). This is both a payload bound and a product decision about what the dashboard represents.
- **Alternatives considered and rejected:** (1) split cron into two endpoints (`/cron/sync-weekly` + `/cron/sync-flow`) — rejected because it doubles cron complexity and doesn't address the 90-day retention question independently; (2) move sync to a longer-timeout worker (Upstash QStash, Vercel Queue) — rejected as over-engineering before measuring whether Units 2, 2.5, 6, 7, 8 are sufficient; (3) webhook-only + per-task incremental, drop full-sync cron — rejected because the cron is also the catch-up mechanism for dropped webhook events. All three remain on the table as escalation paths if Unit 5 shows timing is still insufficient after batch/concurrent (Units 1A/1B/3) are applied.

## Context & Research

### Glossary

- **Unmapped task** — a task whose comments are not returned by the folder-level `/folders/{id}/comments` endpoint and therefore require a per-task `/tasks/{id}/comments` fallback call. Not related to the 90-day cutoff; the cutoff is applied to tasks before the unmapped check runs.
- **Unmapped member** — a team member whose Wrike contact ID has not been resolved via bootstrap/overrides. Separate concept from unmapped tasks; tracked via `getUnmappedMembers()`.
- **Mapped folder comment** — a comment returned by `/folders/{id}/comments` that carries a `taskId`, letting us attribute it to a specific task without a per-task fetch.

### Relevant Code and Patterns

- `src/lib/wrike/fetcher.ts` — `fetchWeeklyMemberData()` and `fetchClientTasks()` both fetch comments. Now share the `_folderCommentCache` (Unit 2, landed). 90-day cutoff applied via `isCompletedBeyondCutoff()` before comment work (Unit 2.5, landed).
- `src/lib/wrike/client.ts` — `WrikeClient` with 1.1s throttle via `requestSlotChain`. The chain serializes slot *reservation* but not the post-slot wait and fetch, so concurrent `Promise.all` callers DO benefit from overlapping network round-trips.
- `src/lib/syncRunner.ts` — `runSync()` calls `buildWeeklySnapshot` then `buildFlowSnapshot` sequentially. Cache init/clear wired at the try/finally boundaries (Unit 8, landed).
- `src/lib/aggregator.ts` — `buildWeeklySnapshot()` processes team members in parallel via `Promise.all` (Unit 6, landed).
- `src/lib/flowBuilder.ts` — `buildFlowSnapshot()` processes client folders in parallel via `Promise.all` (Unit 6, landed).
- `src/lib/config.ts` — 4 client folders, 3 team members, exports `COMPLETED_TASK_CUTOFF_DAYS = 90` (Unit 2.5, landed).
- `src/lib/storage.ts` — sync guard with 600s TTL (already 2x maxDuration — no change needed).
- `src/app/api/cron/sync/route.ts` — inline sync logic with its own guard/pre-checks (NOT calling `syncRunner.runSync()`). Cache wiring and catchup deadline landed (Units 7, 8).
- `src/lib/wrike/dateCatchup.ts` — `catchUpMissingDates(deadlineMs?)` with soft deadline and foldersProcessed/foldersTotal telemetry (Unit 7, landed).

### Institutional Learnings

- Wrike comments endpoint rejects `updatedDate` param (HTTP 400) — all date filtering must happen client-side after fetching
- Wrike rate limit is 400 req/min — current usage ~20-30 req/sync, massive headroom for parallelism
- Sync guard TTL is already 600s (2x maxDuration) — already satisfies the lock-outlives-function principle
- `after()` is fire-and-forget and unreliable for critical work — don't use it for sync chunking

## Key Technical Decisions

- **How the throttle chain actually behaves.** `WrikeClient.requestSlotChain` is a serialized promise chain that each caller awaits to reserve a request "slot." The critical detail: slot reservation is synchronous inside the chain (increment counter, schedule a setTimeout of `MIN_REQUEST_INTERVAL_MS` to release the next slot), but the throttle *wait* and the HTTP fetch itself happen *after* the caller has been handed their slot — outside the chain. That means concurrent `Promise.all` callers DO run in parallel: call N waits 1100ms for its slot, but call N+1 (scheduled 1100ms later) can execute its fetch while call N is still awaiting its network response. Wall-clock speedup from `Promise.all` across members/folders comes from network-latency overlap + slot pipelining, not from bypassing the throttle. This corrects the original plan's claim that "concurrent callers queue — they do not run in parallel," which was incorrect and motivated the proposed throttle reduction.
- **Realistic speedup math for the landed design.** With 3 parallel members (weekly build) + 4 parallel client folders (flow build) going through a single 1100ms-spaced chain, and ~30-50 unmapped tasks per build after the 90-day cutoff: per-call spacing stays at 1100ms, but effective wall-clock per branch drops because each branch only sees 1/7 of the slots while the other 6 run in parallel. Nominal aggregate: `(total_unmapped_tasks × 1100ms) / 7` — roughly 5-8s of per-task comment work per build, plus folder fetches (cached to 4 unique across both builds) and timelog fetches. Combined with catchup's 60s budget and build overhead, expected total is well under 180s. This is the claim Unit 5 validates against real data. If it fails, the escalation path is Unit 1B (throttle reduction) + Unit 3 (batch/concurrent fetch).
- **Shared comment cache between builds and branches.** Module-level `Map<string, Promise<WrikeComment[]>>` in `fetcher.ts` (following the existing `_cachedStatuses` pattern) caches folder-level comment responses within a single sync run. The Promise-valued type is load-bearing: with Unit 6's outer-loop parallelism, multiple branches can arrive at the same folderId simultaneously; storing the pending Promise means the second caller `await`s the first caller's in-flight request rather than firing a duplicate. A `.catch` handler evicts the entry on rejection so a transient failure doesn't poison every subsequent caller. The cache stores **unfiltered** responses — each consumer applies its own date filtering post-cache.
- **Batch comment fetching (deferred primary strategy).** Wrike API v4 supports comma-separated IDs on entity endpoints (`/tasks/{id1},{id2},...,{idN}`). If this works for the `/comments` sub-resource, it collapses N per-task calls into ceil(N/50) calls. **Unvalidated without a live token** — deferred until Unit 5 shows the landed design is insufficient.
- **Concurrent per-task fetches (deferred fallback strategy).** If the batch sub-resource fails, fall back to `Promise.all` over all unmapped task IDs with `MIN_REQUEST_INTERVAL_MS` reduced from 1100ms to 180ms. Deferred with same trigger as batch.
- **Two separate sync entry points, cache wired at each (Unit 8 shipped, Unit 4 superseded).** Original plan proposed extracting a shared `runSyncBuilds()` function. Implementation instead wired `initFolderCommentCache()` / `clearFolderCommentCache()` directly at the try/finally boundaries in `syncRunner.runSync()` and the cron route — two lines in each file. Reason: the cron route and `runSync()` have meaningfully different pre-checks, error handling, and response shapes; a shared function would have carried five parameters just to paper over that difference. Two-line wiring keeps each entry point self-contained.

## Open Questions

### Resolved During Planning

- **Will concurrent requests break the throttle?**: No — `WrikeClient.throttle()` uses a serialized `requestSlotChain` that queues all callers. Multiple concurrent `get()` calls will each await their turn in the chain. Wall-clock parallelism comes from overlapping the wait-for-response time, not from bypassing the throttle.
- **Does the sync guard TTL need changing?**: No — it's already 600s (2x maxDuration) at `src/lib/storage.ts:190`. No change needed.
- **Should the comment cache be its own file?**: No — the existing `_cachedStatuses` pattern in `fetcher.ts` proves that module-level cache with explicit clear works fine. A single Map + `clearFolderCommentCache()` function in `fetcher.ts` is simpler and follows established patterns.

### Deferred to Implementation

- **Whether Wrike batch endpoint works for comment sub-resources**: `/tasks/{id1},{id2}/comments` may return 400/404. Must test with a real API call. If it fails, implement the concurrent-fetch fallback instead.
- **Whether comments from batch endpoint include `taskId` field**: The single-task endpoint may omit `taskId` since it's implicit in the URL. Verify that `taskId` is populated in batch responses for proper Map grouping.
- **Exact batch chunk size**: Start with 50 IDs per chunk (conservative). Increase to 100 if confirmed to work.
- **Whether folder-level comments return enough `taskId` mappings to skip per-task fallback entirely**: This varies by Wrike account configuration. The batch/concurrent endpoint is the safety net regardless.

## High-Level Technical Design

> *This illustrates three states: the pre-optimization baseline, what shipped in PR #20, and the deferred target if Unit 5 telemetry shows more is needed. Directional guidance, not implementation specification.*

```
Pre-optimization baseline (~10 min, fully sequential):
  buildWeeklySnapshot
    for each member (serial):
      for each folder (serial):
        fetch folder comments          ← 4 API calls
        for each unmapped task (serial, 1.1s spacing):
          fetch task comments          ← N sequential calls
  buildFlowSnapshot
    for each client folder (serial):
      fetch folder comments            ← 4 API calls (DUPLICATE of above)
      for each unmapped task (serial, 1.1s spacing):
        fetch task comments            ← M sequential calls

Current shipped state (PR #20) — parallel-member + parallel-client + folder cache:
  syncRunner / cron-route
    initFolderCommentCache()                                 ← Unit 8
  buildWeeklySnapshot
    Promise.all over members:                                ← Unit 6
      for each folder:
        check _folderCommentCache (Promise-valued)          ← Unit 2
          miss → fetch + store in-flight Promise (rejection-evicts)
          hit  → await shared Promise
        filter: drop completed && completedDate < 90d ago   ← Unit 2.5 (R4)
        sort: active tasks before completed                 ← Unit 2.5 (R5)
        for each unmapped task (serial, 1.1s through shared chain):
          fetch task comments          ← still per-task in this release
  buildFlowSnapshot
    Promise.all over client folders:                         ← Unit 6
      check _folderCommentCache → hit (populated by weekly)
      filter + sort (same as above)
      per-task fallback (same as above)
  catchUpMissingDates(Date.now() + 60_000)                   ← Unit 7 soft deadline
  clearFolderCommentCache()                                   ← Unit 8

  Key property: all 7 branches (3 members + 4 client folders) share one
  WrikeClient throttle chain. Slot reservation is serialized at 1100ms, but
  network waits + fetch execution overlap across branches, so effective
  wall-clock per branch ≈ (total_calls × 1100ms) / 7.

Deferred target (if Unit 5 shows current shipped state is insufficient):
  Same topology as current, but the per-task fallback becomes:
    getCommentsByTaskIds(unmappedIds)     ← Unit 1A (batch) or Unit 1B (concurrent)
  Unit 1B also drops MIN_REQUEST_INTERVAL_MS from 1100ms to 180ms.
```

**API call accounting by state:**

| Call type | Pre-opt baseline | Current shipped (PR #20) | Deferred target |
|-----------|------------------|--------------------------|-----------------|
| Folder comments | 16 (4 weekly × 4 folders + 4 flow, de-duped within each build but duplicated across builds) | 4 (cached across both builds and across parallel branches) | 4 (unchanged from shipped) |
| Per-task comments | ~200 sequential @ 1.1s each (~220s) | ~30–50 sequential through shared chain, parallelized across 7 branches | ~4 batch calls OR ~200 concurrent @ 180ms (~36s) |
| Completed tasks fetched | all time (unbounded) | <90 days (R4) | <90 days (unchanged) |

## Implementation Units

- [ ] **Unit 0: Validate Wrike batch comment endpoint**

  **Goal:** Determine whether `/tasks/{id1},{id2}/comments` works as a batch endpoint before building on that assumption.

  **Requirements:** R1

  **Dependencies:** None

  **Files:**
  - No file changes — manual API call or throwaway script

  **Approach:**
  - Make a test call to `/tasks/{id1},{id2}/comments` using 2-3 known task IDs with the existing Wrike access token
  - Verify: (a) the endpoint returns 200, (b) `taskId` is present on each returned comment, (c) pagination works as expected
  - If it fails with 400/404, the implementation uses the concurrent-fetch fallback instead of the batch endpoint

  **Test expectation: none** — this is a manual validation step

  **Verification:**
  - Clear answer: batch endpoint works (proceed with Unit 1A) or doesn't (proceed with Unit 1B)
  - **Default if Unit 0 cannot be validated** (e.g., no live Wrike token available): default to Unit 1B (concurrent fallback with throttle reduction), since it requires no unconfirmed API capability

- [ ] **Unit 1A: Add batch comment fetch to WrikeClient (if batch endpoint works)**

  **Goal:** Add a method that fetches comments for multiple task IDs in a single API call using Wrike's comma-separated ID syntax.

  **Requirements:** R1, R2, R3

  **Dependencies:** Unit 0 (must confirm batch endpoint works)

  **Files:**
  - Modify: `src/lib/wrike/client.ts`
  - Test: `src/lib/wrike/__tests__/client.test.ts`

  **Approach:**
  - Add a `getCommentsByTaskIds(taskIds: string[]): Promise<Map<string, WrikeComment[]>>` method to `WrikeClient`
  - Chunk task IDs into groups of 50, call `/tasks/{id1},{id2},...,{idN}/comments` per chunk
  - Group returned comments by `taskId` into a Map
  - Each chunk goes through the existing `get()` method (inherits throttle, retry, pagination)
  - Return empty Map for empty input array without making API calls

  **Patterns to follow:**
  - Existing `get<T>()` method pattern in `WrikeClient`

  **Test scenarios:**
  - Happy path: batch of 5 task IDs returns comments grouped by taskId
  - Happy path: batch of 75 task IDs splits into 2 chunks (50 + 25)
  - Edge case: empty task ID array returns empty Map without making API calls
  - Edge case: some tasks have no comments — those taskIds are absent from the Map
  - Edge case: comments returned without `taskId` field — logged as warning, excluded from Map
  - Error path: one chunk fails — error propagates (consistent with existing pagination failure behavior)

  **Verification:**
  - `getCommentsByTaskIds` exists, accepts string array, returns `Map<string, WrikeComment[]>`
  - IDs are chunked at 50 per request

- [ ] **Unit 1B: Add concurrent comment fetch to WrikeClient (fallback if batch endpoint fails)**

  **Goal:** Add a method that fetches comments for multiple task IDs concurrently using `Promise.all` with a concurrency limiter.

  **Requirements:** R1, R2, R3

  **Dependencies:** Unit 0 (only if batch endpoint doesn't work)

  **Files:**
  - Modify: `src/lib/wrike/client.ts`
  - Test: `src/lib/wrike/__tests__/client.test.ts`

  **Approach:**
  - Add a `getCommentsByTaskIds(taskIds: string[]): Promise<Map<string, WrikeComment[]>>` method (same signature as 1A for interchangeability)
  - Reduce `MIN_REQUEST_INTERVAL_MS` from 1100ms to 180ms — the rate limit of 400 req/min allows ~150ms between requests, so 180ms provides safety margin. Without this reduction, `Promise.all` provides no speedup because the `requestSlotChain` serializes all requests at the throttle interval regardless of concurrency
  - Issue all per-task requests via `Promise.all` over the full unmapped task ID array (not chunked waves) — the `requestSlotChain` naturally serializes them at 180ms intervals, and `Promise.all` lets network round-trip time (~400ms) overlap with throttle waits for subsequent requests
  - Group returned comments by taskId into a Map

  **Patterns to follow:**
  - Existing `get<T>()` method for individual calls
  - `Promise.all` pattern already used in `fetchClientTasks` for parallel task fetches

  **Test scenarios:**
  - Happy path: 10 task IDs fetched — all issued via Promise.all, throttled at 180ms intervals
  - Happy path: 200 task IDs complete in ~36s (200 × 180ms) instead of 220s (200 × 1100ms)
  - Edge case: empty task ID array returns empty Map
  - Edge case: some tasks have no comments
  - Error path: one task fetch fails — error propagates
  - Integration: total API calls stay under 400 req/min with reduced throttle interval

  **Verification:**
  - Same `getCommentsByTaskIds` signature as Unit 1A
  - `MIN_REQUEST_INTERVAL_MS` reduced to 180ms
  - Concurrent calls go through the throttle chain safely

- [x] **Unit 2: Add folder comment cache in fetcher.ts** *(Shipped in PR #20)*

  **Goal:** Cache folder-level comment responses within a sync run so `buildWeeklySnapshot` and `buildFlowSnapshot` don't re-fetch the same folder comments.

  **Requirements:** R1, R2

  **Dependencies:** None (parallel with Unit 1)

  **Files:**
  - Modify: `src/lib/wrike/fetcher.ts`

  **Approach:**
  - Add a module-level `_folderCommentCache: Map<string, Promise<WrikeComment[]>> | null` following the `_cachedStatuses` pattern. The cache stores the pending **Promise** (not the resolved array) so concurrent parallel callers for the same folderId share one in-flight request instead of racing to fetch it twice — this is load-bearing once Unit 6's outer-loop parallelism is in place.
  - Add `clearFolderCommentCache()` (exported) that sets the Map to null
  - Add `initFolderCommentCache()` (exported) that **unconditionally** creates a fresh Map (replacing any stale state from a killed prior Vercel warm-start)
  - In `fetchWeeklyMemberData` and `fetchClientTasks`: check the cache before calling `/folders/{id}/comments`; on miss, store the pending Promise and attach a `.catch` handler that evicts the entry on rejection (so a transient API failure doesn't poison every subsequent caller for that folder)
  - **Critical invariant**: The cache stores **raw unfiltered** comment arrays. `fetchClientTasks` applies its own `commentCutoff` date filter post-cache. `fetchWeeklyMemberData` uses comments as-is (no date filter). Do not filter at the cache layer.
  - Note: The 90-day completed-task cutoff (Unit 2.5) applies to TASKS, not comments. The cache is unaffected — it caches folder-level comment arrays by folderId. Per-task comment fetches are simply skipped for filtered-out tasks.

  **Patterns to follow:**
  - `_cachedStatuses` / `clearStatusCache()` pattern in the same file (`fetcher.ts`)

  **Test scenarios:**
  - Happy path: first call for a folder fetches from API and caches; second call returns cached data
  - Happy path: two different folder IDs are cached independently
  - Edge case: `initFolderCommentCache()` replaces any pre-existing cache state (warm-start safety)
  - Edge case: `clearFolderCommentCache()` fully resets — subsequent get returns undefined
  - Integration: `fetchClientTasks` applies `commentCutoff` filter to cached comments correctly

  **Verification:**
  - Folder comments fetched once per folder per sync, not once per consumer

- [x] **Unit 2.5: Apply 90-day completed-task cutoff and active-first ordering** *(Shipped in PR #20)*

  **Goal:** Filter out completed tasks older than 90 days before any expensive per-task work (comments, timelogs), and order the in-build per-task fallback loop so active tasks are fetched first.

  **Requirements:** R1, R4, R5

  **Dependencies:** None

  **Files:**
  - Modify: `src/lib/wrike/fetcher.ts`
  - Modify: `src/lib/config.ts` (cutoff constant)

  **Approach (shipped):**
  - `COMPLETED_TASK_CUTOFF_DAYS = 90` exported from `src/lib/config.ts`; `isCompletedBeyondCutoff(task)` helper lives in `fetcher.ts`.
  - In `fetchWeeklyMemberData`: after `tasks.filter(responsibleIds)`, drop tasks where `isCompletedBeyondCutoff(task)` is true. Active tasks (regardless of age) pass through unconditionally.
  - In `fetchClientTasks`: after the recent/active merge, apply the same filter before the comment-fetch phase.
  - **Active-first ordering (R5 delivery mechanism):** sort the unmapped-task fallback array so active tasks precede completed tasks before the per-task comment loop runs. If the loop is interrupted mid-run (timeout, error), the completed tail is what gets cut.
  - Migration artifact (null `completedDate`): conservatively included. A one-time per-sync log line reports how many such tasks passed through. Tracked as a follow-up metric — see Unit 5b.

  **Approach NOT taken (documented as rejected):**
  - Two-phase save (Phase A active → `saveSnapshot` → Phase B completed → `saveSnapshot` again) was drafted in the original plan but rejected during implementation. Reason: it doubles save I/O and complicates `SyncResult` semantics for a scenario (mid-build Vercel timeout) that the landed design already makes rare via Units 2, 6, and 7. See R5 Non-guarantee and Unit 10 if partial-snapshot survival becomes a requirement.

  **Patterns to follow:**
  - Existing `recentTasks + activeTasks` merge pattern in `fetcher.ts`

  **Test scenarios (covered by shipped tests):**
  - Happy path: task with `status: Completed` and `completedDate` 95 days ago is excluded; 89 days ago is included
  - Happy path: task with `status: Active` and no `completedDate` is always included regardless of age
  - Happy path: task with `status: Active` updated 6 months ago still passes the filter
  - Edge case: task with `status: Completed` but null `completedDate` is conservatively included; one-time log emitted
  - Integration: the per-task comment endpoint is not called for tasks filtered out by the cutoff

  **Verification:**
  - Request count for completed-heavy folders drops proportionally to the filtered-out ratio
  - Active-first ordering is observable in the per-task fetch log order
  - 90-day boundary is a `config.ts` constant, not hardcoded in fetchers

- [ ] **Unit 3: Refactor fetcher to use batch/concurrent comments**

  **Goal:** Replace the sequential per-task comment fallback loops in both fetch functions with the new `getCommentsByTaskIds` method.

  **Requirements:** R1, R2, R3

  **Dependencies:** Unit 1A or 1B, Unit 2, Unit 2.5 (filter applies before batch/concurrent comment fetch)

  **Files:**
  - Modify: `src/lib/wrike/fetcher.ts`
  - Test: `src/lib/wrike/__tests__/fetcher.test.ts`

  **Approach:**
  - In both `fetchWeeklyMemberData` and `fetchClientTasks`:
    1. After the folder-comment-to-task mapping, collect all unmapped task IDs
    2. Call `getCommentsByTaskIds(unmappedIds)` once instead of the `for...of` loop
    3. Merge the returned Map into the existing `commentsByTask` Map
  - In `fetchClientTasks`: apply the existing `commentCutoff` date filter to batch results before merging (same filter as the current per-task loop applies at `fetcher.ts:380-383`)
  - In `fetchWeeklyMemberData`: no date filter on batch results (matches current behavior)
  - Keep the existing folder-comment-to-task mapping logic unchanged

  **Patterns to follow:**
  - Existing `mappedTaskIds` / `unmapped` pattern in both functions

  **Test scenarios:**
  - Happy path: unmapped tasks fetched via single batch/concurrent call instead of N individual calls
  - Happy path: `fetchClientTasks` applies `commentCutoff` to batch results
  - Happy path: `fetchWeeklyMemberData` does not apply date filter to batch results
  - Edge case: all tasks mapped from folder comments — `getCommentsByTaskIds` not called (0 unmapped)
  - Edge case: batch results merged correctly into existing `commentsByTask` Map
  - Integration: full `fetchClientTasks` call returns same comments as before optimization

  **Verification:**
  - Same comments are returned as before (data correctness)
  - Number of Wrike API calls reduced (observable via request count or timing)

- [~] **Unit 4: Extract shared build function and wire cache lifecycle** *(SUPERSEDED by Unit 8 — not shipped, not planned)*

  **Disposition:** During implementation, the proposed `runSyncBuilds()` extraction was rejected in favor of Unit 8's two-line init/clear wiring at each existing call site. Reason: the cron route and `syncRunner.runSync()` have meaningfully different pre-checks, response shapes, and post-processing (webhook health, `catchUpMissingDates`, Slack notification, `NextResponse` construction). A shared function would have carried five parameters just to paper over that difference. The two-line wiring keeps each entry point self-contained and was landed in PR #20.

  This unit is preserved here only as a record of an alternative considered and rejected. **Do not implement.** If a future refactor motivates the extraction (e.g., a third sync entry point), revisit from scratch.

  **Original goal (for historical reference only):** Extract the core build+save logic into a shared `runSyncBuilds()` function that both `syncRunner.runSync()` and the cron route call, with comment cache init/clear managed inside it.

  **Requirements:** R1, R2

  **Dependencies:** Unit 2, Unit 3

  **Files:**
  - Modify: `src/lib/syncRunner.ts`
  - Modify: `src/app/api/cron/sync/route.ts`

  **Approach:**
  - Extract a new exported `runSyncBuilds(week: string)` function in `syncRunner.ts` that encapsulates:
    - `initFolderCommentCache()` at the start
    - `buildWeeklySnapshot(week)` → `saveSnapshot()`
    - `buildFlowSnapshot(week)` → `saveFlowSnapshot()`
    - `clearFolderCommentCache()` in a `finally` block
    - Returns a `BuildResult` with `{ snapshot, flowSnapshot, weeklyResult, flowResult }` — enough data for callers to construct their own responses
  - Refactor `syncRunner.runSync()` to call `runSyncBuilds(week)` inside its existing guard-protected try block, replacing the inline build+save calls. `runSync()` keeps its own guard acquisition, `loadOverridesFromRedis()`, unmapped check, and Wrike connectivity pre-check.
  - Refactor `cron/sync/route.ts` to call `runSyncBuilds(week)` inside its existing guard-protected try block, replacing the inline build+save calls. The cron route keeps its own guard acquisition, `loadOverridesFromRedis()`, unmapped check, webhook health check/reactivation, `catchUpMissingDates()`, Slack notifications, and `NextResponse` construction.
  - This approach avoids: (a) double guard acquisition, (b) `SyncResult`/`NextResponse` type mismatch, (c) duplicate pre-checks running twice per invocation
  - `syncTask()` does NOT use `runSyncBuilds()` or the cache — it only fetches one task's comments directly
  - Note: `catchUpMissingDates()` runs after the builds and makes its own Wrike API calls through the shared throttle chain. This adds to the cron route's total time but is unchanged and runs after the snapshot saves, so it only affects cron timing (not the trigger route or the build portion).

  **Patterns to follow:**
  - Existing `acquireSyncGuard` / `releaseSyncGuard` pattern in both callers
  - Existing `clearStatusCache()` / `initFolderCommentCache()` pattern for cache lifecycle

  **Test scenarios:**
  - Happy path: `runSyncBuilds()` initializes cache, runs both builds, saves both snapshots, clears cache
  - Happy path: `runSync()` calls `runSyncBuilds()` inside its guard — no duplicate pre-checks
  - Happy path: cron route calls `runSyncBuilds()` inside its guard — keeps its own webhook/catchup/Slack logic
  - Error path: cache is cleared even if a build throws (`finally` block in `runSyncBuilds`)
  - Error path: cron route still sends Slack notifications on failure after refactor
  - Edge case: `syncTask` still works independently without `runSyncBuilds()`
  - Integration: cron route response includes `webhookStale`, `dateCatchup`, `summary` fields as before
  - Integration: webhook health check and date catchup still run as part of cron sync

  **Verification:**
  - No comment cache state persists after `runSyncBuilds` completes
  - Both `runSync()` and cron route behavior unchanged from their callers' perspectives
  - No duplicate build/save logic remains — only pre-check and post-processing logic is caller-specific
  - Guard is acquired exactly once per sync invocation

- [x] **Unit 6: Outer-loop parallelism (replaces throttle reduction from Unit 1B)** *(Shipped in PR #20)*

  **Goal:** Parallelize the `for (member of members)` loop in `buildWeeklySnapshot` and the `for (client of clients)` loop in `buildFlowSnapshot` so all members (and all client folders) are fetched concurrently, without touching the global `MIN_REQUEST_INTERVAL_MS`.

  **Requirements:** R1

  **Dependencies:** Unit 2 (folder cache must be in place AND must store `Promise<WrikeComment[]>` — not resolved arrays — so concurrent parallel callers for the same folderId dedupe to a single in-flight request rather than each firing a fresh fetch)

  **Files:**
  - Modify: `src/lib/aggregator.ts`
  - Modify: `src/lib/flowBuilder.ts`

  **Approach:**
  - In `buildWeeklySnapshot`: replace `for (const member of teamMembers) { ... }` with `await Promise.all(teamMembers.map(async (member) => { ... }))`.
  - In `buildFlowSnapshot`: replace `for (const clientFolder of clientFolders) { ... }` with `await Promise.all(clientFolders.map(async (clientFolder) => { ... }))`.
  - Inner work is unchanged. Each parallel branch still goes through the shared `WrikeClient` throttle chain, which serializes requests at 1100ms — but multiple branches can have their requests interleaved, so wall-clock time drops to `(total_calls / num_branches) * 1100ms`.
  - Preserve error-collection semantics: if one member/client fails, collect the error but don't cancel the others. Use a `results` / `errors` split pattern or `Promise.allSettled` so partial success is reportable.

  **Patterns to follow:**
  - Existing `Promise.all` usage in `fetcher.ts:313-325` (recentTasks + activeTasks merge)

  **Test scenarios:**
  - Happy path: 3 members processed in parallel; total time ≈ max(member_time) not sum(member_time)
  - Happy path: 4 client folders processed in parallel with same property
  - Edge case: one member fetch fails — other members still complete; failed member surfaces in `memberErrors` (or equivalent) in the result
  - Edge case: all members fail — aggregated error surfaces, sync fails cleanly
  - Integration: shared folder cache is populated correctly when concurrent branches touch the same folder (later branch gets a cache hit)

  **Verification:**
  - Observable: aggregate sync time drops to roughly (original_time / num_members)
  - No data correctness regression — same snapshot content as serial version
  - Errors from one branch do not mask or suppress results from other branches

- [x] **Unit 7: catchUpMissingDates soft deadline with loud telemetry** *(Shipped in PR #20)*

  **Goal:** Prevent `catchUpMissingDates()` from pushing the cron function over Vercel's 300s limit. Exit cleanly when the deadline approaches, and make the partial state visible in logs and Slack so it's not a silent swallow.

  **Requirements:** R1

  **Dependencies:** None

  **Files:**
  - Modify: `src/lib/wrike/dateCatchup.ts`
  - Modify: `src/app/api/cron/sync/route.ts` (surface the deadlineReached signal in the Slack notification)

  **Approach:**
  - Add a `deadlineMs` parameter to `catchUpMissingDates(deadlineMs?: number)`. Default: `Date.now() + 60_000` (60s budget) when called from the cron route; no default inside the function itself (must be passed explicitly by callers that care).
  - Extend `CatchupResult` with: `deadlineReached: boolean`, `foldersProcessed: number`, `foldersTotal: number`.
  - Inside the folder loop: at the top of each iteration, check `if (Date.now() > deadlineMs) { deadlineReached = true; break; }`. Record the current folder name in the warning log.
  - Log at WARN level when the deadline fires: `"catchUpMissingDates deadline reached at folder X after processing Y of Z folders"`.
  - Cron route consumes `deadlineReached` and includes it in the Slack notification (e.g., appends "⚠️ Catchup partial — deadline hit" when true).
  - The work is not lost — tasks already date-fixed stay fixed. Catchup is idempotent, so the next cron run picks up where this one stopped.

  **Patterns to follow:**
  - Existing `CatchupResult` shape in `dateCatchup.ts:9-14`
  - Existing Slack notification format in `cron/sync/route.ts`

  **Test scenarios:**
  - Happy path: catchup completes before deadline — `deadlineReached: false`, all folders processed
  - Happy path: deadline fires mid-loop — `deadlineReached: true`, partial `foldersProcessed` count, WARN logged
  - Edge case: deadline is already in the past when called — returns immediately with `deadlineReached: true`, `foldersProcessed: 0`
  - Integration: cron route Slack notification includes the partial-catchup warning when `deadlineReached: true`

  **Verification:**
  - Hitting the soft deadline never causes the Vercel function to timeout
  - Operators see the partial state in Slack, not just in logs
  - Catchup work completed so far is persisted; the next cron catches up the rest

- [x] **Unit 8: Two-line cache wiring (replaces dropped Unit 4)** *(Shipped in PR #20)*

  **Goal:** Wire `initFolderCommentCache()` / `clearFolderCommentCache()` into the existing sync entry points without extracting a shared function.

  **Requirements:** R1

  **Dependencies:** Unit 2

  **Files:**
  - Modify: `src/lib/syncRunner.ts`
  - Modify: `src/app/api/cron/sync/route.ts`

  **Approach:**
  - In each caller's existing try/finally block (where the sync guard is already released), add `initFolderCommentCache()` at the start of the try and `clearFolderCommentCache()` in the finally alongside the guard release.
  - No shared function extraction. Each entry point retains its own control flow, pre-checks, error handling, and response construction.

  **Test scenarios:**
  - Happy path: sync runs, cache is populated and then cleared
  - Error path: sync throws mid-build, cache is cleared in finally
  - Integration: webhook-triggered `syncTask()` does NOT touch the cache (unchanged)

  **Verification:**
  - No module-level cache state leaks between sync runs

- [ ] **Unit 5: End-to-end timing validation (outstanding)**

  **Goal:** Verify the shipped sync (PR #20) completes well under 300s against real Wrike data, and confirm three consecutive cron runs finish with `deadlineReached: false` before declaring R1 satisfied.

  **Requirements:** R1, R2

  **Dependencies:** Units 2, 2.5, 6, 7, 8 (all landed in PR #20). Does NOT depend on the deferred Units 0, 1A, 1B, 3.

  **Files:**
  - No code changes — observability + manual validation

  **Approach:**
  - Trigger a live sync via `/api/sync/trigger` after PR #20 deploys
  - Record total sync duration, per-branch durations (from logs), and Wrike request count
  - Monitor the next three scheduled cron runs; confirm all three report `deadlineReached: false` on catchup
  - Compare resulting snapshot (task counts, comment counts, flow metrics) against the last pre-PR-#20 snapshot for correctness
  - Record the one-time-per-sync count of completed tasks with null `completedDate` (migration-artifact metric — see R4 and Unit 5b)

  **Test expectation: none** — this is a manual validation step. If timing is out of budget, escalate to Unit 1B (concurrent fetch + throttle reduction).

  **Verification:**
  - Sync duration < 180s (50% safety margin under 300s)
  - Three consecutive crons complete with `deadlineReached: false`
  - Snapshot data matches pre-PR-#20 output within the 90-day window
  - No Wrike rate limit errors (429s)

- [ ] **Unit 5b: Null-completedDate population telemetry (outstanding, follow-up to Unit 2.5)**

  **Goal:** Quantify the size and trajectory of the Feb–early-Mar 2026 migration artifact (completed tasks with null `completedDate`) so we know whether the conservative "include" policy from Unit 2.5 remains safe.

  **Requirements:** R4

  **Dependencies:** Unit 5 (collect during timing validation runs)

  **Files:**
  - No code changes initially; capture counts from existing log line
  - If the count is unbounded or trending up: modify `isCompletedBeyondCutoff` in `src/lib/wrike/fetcher.ts` to use `updatedDate` as the cutoff surrogate when `completedDate` is null

  **Approach:**
  - Record the null-`completedDate` count from each of the next ~10 sync runs
  - If the count is stable and small (< ~50 per sync): policy stays conservative, no change
  - If the count is large or growing: switch to `updatedDate` surrogate and re-validate against R2 correctness

  **Verification:**
  - Clear decision in memory: conservative-include is either confirmed safe or replaced with a documented surrogate

- [ ] **Unit 9: UI audit for 90-day cutoff (outstanding, product-gap finding)**

  **Goal:** Surface every dashboard surface that currently assumes completed-task history beyond 90 days, and either constrain the surface to the 90-day window or tune `COMPLETED_TASK_CUTOFF_DAYS` to match the widest legitimate view.

  **Requirements:** R4

  **Dependencies:** None — can run in parallel with Unit 5

  **Files:**
  - Audit only — `src/app/**/*.tsx`, any KPI widgets, flow views, weekly reports, quarterly/annual comparison views
  - Possible modify: `src/lib/config.ts` if cutoff needs tuning; or UI copy/filters to make the 90-day boundary explicit to users

  **Approach:**
  - Enumerate every view that reads completed-task data. For each, answer: does this assume >90 days of history?
  - If a view assumes more history: either (a) tune `COMPLETED_TASK_CUTOFF_DAYS`, or (b) constrain the view to 90 days and add UI copy indicating the boundary
  - Document the decision per view in the audit output, with owner sign-off for anything that loses data

  **Test scenarios:**
  - Each completed-task UI surface lists its assumed retention window and the audit decision
  - If cutoff is tuned, re-run Unit 5 timing validation to confirm the larger payload still fits the 300s budget

  **Verification:**
  - Zero views silently assume data that Unit 2.5 now drops
  - KPI-reporting owner has signed off on the 90-day boundary or an adjusted value

- [ ] **Unit 10: Partial-sync state visible in dashboard UI (outstanding, product-gap finding)**

  **Goal:** Make it explicit to dashboard users when the last sync hit the catchup soft deadline (Unit 7) or partially failed, so stale active data isn't mistaken for fresh truth.

  **Requirements:** R1 (observability leg), R5

  **Dependencies:** None — the data already exists in the sync result payload

  **Files:**
  - Modify: whatever dashboard shell / header component displays "last synced at ..."
  - Possible modify: `src/lib/types.ts` if a new field is needed on the saved snapshot
  - Modify: `src/app/api/cron/sync/route.ts` and `src/lib/syncRunner.ts` if the snapshot needs to carry a `syncHealth: "ok" | "catchup_partial" | "partial_error"` flag

  **Approach:**
  - Decide where the partial-sync signal lives: on the snapshot (preferred — survives reload) vs. a separate Redis key
  - Wire `deadlineReached`, `memberErrors.length`, and `flowFolderErrors` into a single `syncHealth` signal
  - Surface it in the dashboard header next to the "last synced at" timestamp: e.g., yellow badge "Last sync: catchup incomplete — some dates may be stale" or "Last sync: 1 member failed — X not included"
  - Copy should tell the user what's stale, not just that something happened

  **Test scenarios:**
  - Happy path: full sync → header shows normal "last synced at X"
  - Partial: `deadlineReached: true` → header shows catchup warning + absolute time
  - Partial: member error → header names the affected member or client folder
  - Edge case: both signals present → header shows the more severe one and links to logs

  **Verification:**
  - No user sees a stale snapshot without a visible indicator that it's partial
  - Operators can triage from the UI alone without consulting Vercel logs for the common cases

## System-Wide Impact

- **Interaction graph:** The comment cache is sync-scoped and does not affect webhook-triggered `syncTask()`, which fetches a single task's comments directly. The `WrikeClient` throttle chain is shared by all 7 parallel branches (3 members + 4 client folders) — slot reservation serializes at 1100ms, but network waits and fetch execution overlap, so effective throughput is the Unit 6 win. The `catchUpMissingDates()` call in the cron route makes its own Wrike API calls through the same throttle chain — unchanged and bounded by the Unit 7 soft deadline (60s default).
- **Error propagation:** A per-task comment fetch failure propagates up through `Promise.all` to the member/client branch, and up again to the build. Errors from one branch don't cancel peer branches (collected via error-aware parallel pattern), but an unrecoverable error aborts the whole sync. The guard is released in the finally block.
- **State lifecycle risks:** The Promise-valued comment cache must be cleared after every sync run (including failures) to prevent stale data. Using a finally block matches the existing guard cleanup pattern. `initFolderCommentCache()` unconditionally creates a fresh Map to handle Vercel warm-start edge cases. The rejection-evict `.catch` handler prevents a transient failure from poisoning every subsequent caller for that folder.
- **API surface parity:** Both the cron route and `syncRunner.runSync()` wire `initFolderCommentCache()` / `clearFolderCommentCache()` at their own try/finally boundaries (Unit 8). No shared extraction; each entry point retains its guard, pre-checks, and response shape.
- **Time budget note:** The cron route runs `catchUpMissingDates()` after the builds through the same throttle chain, with a 60s soft deadline (Unit 7). The 180s target applies to the build portion; the cron route's total can approach ~240s in the worst case before Vercel's 300s cap. Per-task comment fetches are not cached across builds (folder comments are), so overlapping unmapped tasks between weekly and flow builds are fetched twice in this release — acceptable given the current throughput. If Unit 5 shows this is insufficient, the deferred Unit 3 refactors both builds to batch/concurrent per-task fetches.
- **Unchanged invariants:** The webhook `syncTask` path, Redis storage keys, cron schedule, and sync guard TTL (600s = 2x maxDuration) are all unchanged. Snapshot data format is unchanged in shape but now bounded in content (only active + completed <90d tasks).
- **Storage bounding (R4):** Excluding completed tasks older than 90 days reduces the per-snapshot task count from potentially thousands (full Wrike history) to a bounded working set. This also reduces the per-sync Wrike API call count proportionally.
- **Partial-sync semantics (R5):** Active-first ordering inside the per-task fallback loop means an in-loop interruption cuts the completed tail first. However, a Vercel timeout that kills the function *inside* `buildWeeklySnapshot` or `buildFlowSnapshot` (before the snapshot is saved) persists nothing — users see the prior sync's full snapshot, not a partial active-only snapshot. If true partial-snapshot survival becomes a requirement, it needs a two-phase save (explicitly rejected in Unit 2.5) — see R5 Non-guarantee.
- **Display parity:** Any dashboard UI that currently shows tasks older than 90 days (completed) must be reviewed — those tasks will no longer appear in snapshots. Unit 9 is the audit; Unit 10 surfaces partial-sync state in the UI.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Shipped design is insufficient — sync still exceeds budget | Unit 5 validates against real data. Tripwire: three consecutive crons with `deadlineReached: false` (R1 success definition). Escalation path: Unit 1B (concurrent fetch + throttle reduction) then Unit 3 (fetcher refactor). |
| Comment cache serves stale data on Vercel warm-start | `initFolderCommentCache()` unconditionally creates a fresh Map, replacing any pre-existing state (Unit 2, landed). |
| Concurrent parallel branches race to fetch the same folder comments | Cache is Promise-valued: concurrent callers `await` the same in-flight Promise. Rejection evicts the entry so one transient failure doesn't poison subsequent callers (Unit 2, landed). Load-bearing for Unit 6. |
| Per-task comment failure in one branch kills the whole sync | Error-aware `Promise.all` pattern: one branch failure is collected into `memberErrors` / `flowFolderErrors` without canceling peers. Full branch failure still aborts the sync with a clean guard release (Unit 6, landed). |
| `catchUpMissingDates` pushes function over Vercel's 300s cap | 60s soft deadline with loud telemetry (`deadlineReached`, `foldersProcessed`, `foldersTotal`) surfaces partial state in Slack. Catchup is idempotent; the next cron picks up where this one stopped (Unit 7, landed). |
| Concurrent `get()` calls interact with `requestSlotChain` | The chain serializes slot reservation but not network/fetch execution — concurrent callers overlap their waits safely. Verified by reading the throttle implementation (Unit 6 correctness). |
| 90-day cutoff silently drops tasks users expect to see | Unit 9 audits every UI surface. `COMPLETED_TASK_CUTOFF_DAYS` is a `config.ts` constant so it can be tuned if a view legitimately needs more history. |
| Completed tasks with null `completedDate` (Feb–early-Mar 2026 migration artifact) behave unpredictably | Conservative include with a one-time per-sync log line (Unit 2.5, landed). Unit 5b quantifies the population; if it's unbounded, switch to `updatedDate` surrogate. |
| Vercel timeout kills a build mid-flight → users see prior snapshot, not a partial | Explicitly acknowledged in R5 Non-guarantee. Active-first ordering only protects the in-loop interruption case. True partial-snapshot survival would require the rejected two-phase save — out of scope. |
| Users don't know when the last sync was partial | Unit 10 surfaces partial-sync state in the dashboard UI (catchup deadline, member errors, flow folder errors). |
| Deferred Units 1A/1B/3 (batch + concurrent) never ship and shipped design silently regresses as data grows | Unit 5's three-consecutive-runs tripwire is the early-warning. If triggered, the deferred units are the documented escalation path and their dependencies/files are already enumerated. |

## Sources & References

- Related code: `src/lib/wrike/fetcher.ts`, `src/lib/wrike/client.ts`, `src/lib/syncRunner.ts`, `src/app/api/cron/sync/route.ts`
- Wrike API docs: batch operations support comma-separated IDs on entity endpoints (sub-resource support unconfirmed — Unit 0 validates)
- Memory: `project_wrike_api_comment_filter.md` — comments endpoint rejects `updatedDate`
