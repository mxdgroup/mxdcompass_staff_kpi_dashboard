---
title: "fix: Optimize full sync to fit within Vercel 300s timeout"
type: fix
status: active
date: 2026-04-16
deepened: 2026-04-16
scope_locked: 2026-04-17
---

> **Execution scope (2026-04-17):** After document review, scope reduced to the simplest set of changes that should meet R1-R5 without needing a live Wrike token to validate unconfirmed API behavior.
>
> **In scope:** Unit 2 (folder cache), Unit 2.5 (90-day cutoff + active-first batching), new Unit 6 (outer-loop parallelism), new Unit 7 (catchUpMissingDates soft deadline with telemetry), two-line cache wiring in syncRunner + cron route, Unit 5 (timing validation).
>
> **Deferred (fallback if Unit 5 shows timing gap):** Unit 0 (batch endpoint validation — requires live token), Unit 1A (batch fetch), Unit 1B (concurrent fetch + throttle reduction), Unit 3 (fetcher refactor to use batch/concurrent), Unit 4 (shared runSyncBuilds extraction — replaced by two-line wiring).
>
> **Key rationale:** 90-day cutoff dramatically bounds the payload (unmapped-task count drops from ~200 to ~30-50). Outer-loop parallelism multiplies that by ~4x speedup on the member/client iteration. Combined with the folder cache and soft catchup deadline, the sync should land well under 180s without touching the global throttle or committing to unconfirmed batch API behavior.

# fix: Optimize full sync to fit within Vercel 300s timeout

## Overview

The full Wrike-to-dashboard sync takes ~10 minutes, far exceeding Vercel's 300s function timeout. The three daily crons will timeout and fail. This plan optimizes the sync to complete well under 300s through four complementary strategies:

1. **90-day completed-task cutoff** (design constraint) — the dashboard only stores completed tasks within the last 90 days. Tasks completed earlier are excluded from sync before any expensive fetches (comments, timelogs). This bounds the payload.
2. **Active-first batching** — within the sync, process active tasks first and save a partial snapshot before processing completed-within-90d tasks. If timeout hits mid-sync, the dashboard still has fresh active data.
3. **Shared folder-comment cache** between the two builds.
4. **Batch (or concurrent) comment fetching** for unmapped tasks.

## Problem Frame

Both `buildWeeklySnapshot` and `buildFlowSnapshot` independently fetch comments for every task — the same Wrike API calls happen twice per sync. Within each build, tasks whose comments aren't found at the folder level fall back to sequential per-task fetches, each throttled to 1.1s apart. With ~200 unmapped tasks across both builds, that alone is 220s of wall-clock time before counting task/timelog fetches.

The current fetchers also have no completed-task cutoff — `fetchClientTasks` merges `recentTasks` (updatedDate window) with all `activeTasks` and fetches comments for the union, but long-tail completed tasks that Wrike returns in the "recent" window because they were touched recently still end up incurring comment fetches. As the Wrike history grows, this compounds.

The Wrike rate limit is 400 req/min (~6.7 req/s), but the current code makes at most ~1 req/1.1s. There is significant headroom for concurrent requests.

## Requirements Trace

- R1. Full sync completes within 300s on Vercel (with safety margin, target <180s)
- R2. Data correctness preserved within the new 90-day storage boundary — all in-scope tasks (active + completed <90d) have the same comments, tasks, and timelogs as before
- R3. Stay within Wrike's 400 req/min rate limit
- R4. **90-day completed-task cutoff (design rule):** tasks where `status == completed && completedDate < today - 90d` are not synced, not stored, and not displayed. Applies at the earliest point in the fetch pipeline, before comments/timelogs are requested for those tasks. **Active (non-completed) tasks are NEVER filtered by age** — an active task that has been open for 6 months or 2 years stays in scope indefinitely. The 90-day rule is exclusively about completed-task retention.
- R5. **Active-first ordering:** active (non-completed) tasks are fetched and persisted before completed tasks, so a partial snapshot with fresh active data is available even if the sync times out on the completed portion.

## Scope Boundaries

- This plan does NOT split the sync into multiple Vercel function invocations (fan-out). "Active-first batching" (R5) runs within a single Vercel invocation with incremental snapshot saves between batches.
- This plan does NOT change the cron schedule or add new API routes.
- This plan DOES change what data is fetched — tasks completed more than 90 days ago are excluded (R4). This is a deliberate design decision for storage/memory bounding, not a performance workaround.

## Context & Research

### Relevant Code and Patterns

- `src/lib/wrike/fetcher.ts` — `fetchWeeklyMemberData()` (line 191) and `fetchClientTasks()` (line 301) both fetch comments independently
- `src/lib/wrike/client.ts` — `WrikeClient` with 1.1s throttle via `requestSlotChain` (serialized promise chain)
- `src/lib/syncRunner.ts` — `runSync()` calls `buildWeeklySnapshot` then `buildFlowSnapshot` sequentially
- `src/lib/aggregator.ts` — `buildWeeklySnapshot()` iterates team members sequentially, calling `fetchWeeklyMemberData` per member
- `src/lib/flowBuilder.ts` — `buildFlowSnapshot()` calls `fetchClientTasks` per client folder
- `src/lib/config.ts` — 4 client folders, 3 team members
- `src/lib/storage.ts` — sync guard with 600s TTL (already 2x maxDuration — no change needed)
- `src/app/api/cron/sync/route.ts` — inline duplicate of sync logic (does NOT call `syncRunner.runSync()`)
- `src/lib/wrike/dateCatchup.ts` — `catchUpMissingDates()` runs after the builds in the cron route. Iterates the 4 client folders, paginates `/folders/{id}/tasks?descendants=true` per folder, and issues one PUT per task needing a date fix. Uses the shared `WrikeClient` singleton (same throttle chain as the builds).

### Institutional Learnings

- Wrike comments endpoint rejects `updatedDate` param (HTTP 400) — all date filtering must happen client-side after fetching
- Wrike rate limit is 400 req/min — current usage ~20-30 req/sync, massive headroom for parallelism
- Sync guard TTL is already 600s (2x maxDuration) — already satisfies the lock-outlives-function principle
- `after()` is fire-and-forget and unreliable for critical work — don't use it for sync chunking

## Key Technical Decisions

- **Shared comment cache between builds**: Add a module-level `Map<string, WrikeComment[]>` in `fetcher.ts` (following the existing `_cachedStatuses` pattern) that caches folder-level comment responses within a single sync run. Both `fetchWeeklyMemberData` and `fetchClientTasks` check the cache before calling `/folders/{id}/comments`. The cache stores **unfiltered** responses — each consumer applies its own date filtering post-cache. `fetchClientTasks` applies a 4-week lookback cutoff; `fetchWeeklyMemberData` does not filter by date.
- **Batch comment fetching (primary strategy)**: Wrike API v4 supports comma-separated IDs on entity endpoints (`/tasks/{id1},{id2},...,{idN}`). If this also works for the `/comments` sub-resource, it collapses N per-task calls into ceil(N/50) calls — the single biggest optimization. **This must be validated with a test API call before implementation.** "Batch" here means a single API request with comma-separated task IDs (`/tasks/id1,id2,.../comments`) returning all comments in one response.
- **Concurrent per-task fetches (fallback strategy)**: If the batch sub-resource endpoint returns 400/404, fall back to `Promise.all` over all unmapped task IDs. "Concurrent" here means multiple per-task API requests (`/tasks/{id}/comments`) issued via `Promise.all`, each going through the existing throttle chain individually. **Important**: The `requestSlotChain` serializes all requests at 1.1s intervals regardless of how many concurrent callers await it, so concurrent callers queue — they do not run in parallel. To achieve meaningful speedup, `MIN_REQUEST_INTERVAL_MS` must be reduced from 1100ms to ~180ms (the rate limit of 400 req/min allows ~150ms between requests, so 180ms provides safety margin). At 180ms per request, 200 tasks take ~36s instead of 220s.
- **Extract shared build function, keep separate entry points**: The cron route at `src/app/api/cron/sync/route.ts` has its own inline `runSync()` that duplicates `syncRunner.ts`. These can't simply be collapsed because: (1) both acquire the sync guard independently — calling `syncRunner.runSync()` from the cron route would double-acquire; (2) `syncRunner.runSync()` returns `SyncResult` while the cron route returns `NextResponse` with cron-specific fields (`webhookStale`, `dateCatchup`); (3) both duplicate `loadOverridesFromRedis()` and `getUnmappedMembers()` pre-checks. Instead, extract the core build logic (`initFolderCommentCache` → `buildWeeklySnapshot` → `saveSnapshot` → `buildFlowSnapshot` → `saveFlowSnapshot` → `clearFolderCommentCache`) into a shared `runSyncBuilds(week: string)` function in `syncRunner.ts`. Both `runSync()` and the cron route call `runSyncBuilds()` inside their own guard-protected try blocks, keeping their own pre-checks, error handling, and post-processing.

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

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce. The "Optimized flow" shows the post-Unit-4 state where both entry points call the shared `runSyncBuilds()` function.*

```
Current flow (sequential, ~10 min):
  buildWeeklySnapshot
    for each member:
      for each folder:
        fetch folder comments          ← 4 API calls
        for each unmapped task:
          fetch task comments           ← N sequential calls @ 1.1s each
  buildFlowSnapshot
    for each client folder:
      fetch folder comments             ← 4 API calls (DUPLICATE)
      for each unmapped task:
        fetch task comments             ← M sequential calls @ 1.1s each

Optimized flow (batched + cached, target <180s):
  buildWeeklySnapshot
    for each member:
      for each folder:
        check folder comment cache → hit or fetch+cache  ← 4 calls on first pass, 0 after
        batch-fetch unmapped task comments                ← ceil(N/50) calls (or concurrent fallback)
  buildFlowSnapshot
    for each client folder:
      check folder comment cache → hit                    ← 0 API calls (already cached)
      batch-fetch unmapped task comments                  ← ceil(M/50) calls (or concurrent fallback)
```

**Estimated API call reduction:**
- Folder comments: 16 calls → 4 calls (3 members × 4 folders in weekly build + 4 flow folders = 16, cached to 4 unique)
- Per-task comments (batch path): ~200 sequential calls → ~4 batch calls (50 IDs each)
- Per-task comments (concurrent fallback): see Open Questions — throttle serialization limits the speedup
- Total time estimate: batch path ~15s for comments; concurrent fallback requires throttle adjustment (see Key Technical Decisions)

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

- [ ] **Unit 2: Add folder comment cache in fetcher.ts**

  **Goal:** Cache folder-level comment responses within a sync run so `buildWeeklySnapshot` and `buildFlowSnapshot` don't re-fetch the same folder comments.

  **Requirements:** R1, R2

  **Dependencies:** None (parallel with Unit 1)

  **Files:**
  - Modify: `src/lib/wrike/fetcher.ts`

  **Approach:**
  - Add a module-level `_folderCommentCache: Map<string, WrikeComment[]> | undefined` following the `_cachedStatuses` pattern
  - Add `clearFolderCommentCache()` (exported) that sets the Map to undefined
  - Add `initFolderCommentCache()` (exported) that **unconditionally** creates a fresh Map (replacing any stale state from a killed prior Vercel warm-start)
  - In `fetchWeeklyMemberData` and `fetchClientTasks`: check the cache before calling `/folders/{id}/comments`; on miss, fetch and store in cache
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

- [ ] **Unit 2.5: Apply 90-day completed-task cutoff and active-first ordering**

  **Goal:** Filter out completed tasks older than 90 days before any expensive per-task work (comments, timelogs), and order the remaining work so active tasks are fetched and saved first.

  **Requirements:** R1, R4, R5

  **Dependencies:** None (can ship before or alongside Unit 1/2/3)

  **Files:**
  - Modify: `src/lib/wrike/fetcher.ts`
  - Modify: `src/lib/aggregator.ts` (or wherever weekly snapshot orchestrates the member loop)
  - Modify: `src/lib/flowBuilder.ts` (client folder loop)
  - Modify: `src/lib/syncRunner.ts` (for incremental snapshot save between active/completed phases)
  - Test: `src/lib/wrike/__tests__/fetcher.test.ts`

  **Approach:**
  - In `fetchWeeklyMemberData` (fetcher.ts:201): after `tasks.filter(responsibleIds)`, apply a second filter that drops ONLY completed tasks older than 90 days: `tasks.filter(t => t.status !== "Completed" || (t.completedDate && new Date(t.completedDate) >= today - 90d))`. The predicate keeps everything non-completed (active tasks of any age pass through), and among completed, keeps only those within the 90-day window. This filter runs BEFORE the folder-comment-to-task mapping and BEFORE the per-task comment fallback, so those old-completed tasks never trigger comment fetches.
  - In `fetchClientTasks` (fetcher.ts:301): after the recent/active merge at line 333, apply the same 90-day cutoff to the merged `tasks` array before the comment-fetch phase.
  - Define the cutoff as a single exported constant `COMPLETED_TASK_CUTOFF_DAYS = 90` in `config.ts` so it's easy to tune.
  - Active-first batching: restructure the orchestrators so each phase saves snapshot before the next begins:
    - **Phase A (active):** run both builds with `includeCompleted: false`. `fetchWeeklyMemberData` and `fetchClientTasks` skip the merge of completed tasks and only process active ones. Save weekly snapshot + flow snapshot.
    - **Phase B (completed <90d):** run both builds again with `includeCompleted: true, activeAlreadyFetched: Set<taskId>`. Skip tasks already processed in Phase A. Merge results into the same-week snapshot and re-save.
  - If Phase B throws or the function nears the time budget (e.g., `Date.now() - startTime > 240_000`), commit Phase A's snapshot and exit cleanly with a warning, not a timeout.

  **Patterns to follow:**
  - Existing `recentTasks + activeTasks` merge pattern at `fetcher.ts:313-333`
  - Existing `saveSnapshot` / `saveFlowSnapshot` call sites for incremental persistence

  **Test scenarios:**
  - Happy path: task with `status: Completed` and `completedDate` 95 days ago is excluded from sync; task with `status: Completed` and `completedDate` 89 days ago is included
  - Happy path: task with `status: Active` and no `completedDate` is always included regardless of age (even if `createdDate` is 2+ years old)
  - Happy path: task with `status: Active` that was updated 6 months ago still passes the filter — active tasks never age out
  - Edge case: task with `status: Completed` but null `completedDate` (migration artifact — see Wrike data migration memory) — treat as in-scope (conservative) OR exclude with warning, documented explicitly
  - Edge case: Phase A completes but Phase B throws — Phase A snapshot is persisted, sync returns partial-success status
  - Edge case: Phase B soft-timeout (elapsed > 240s) — exit gracefully, log, Phase A snapshot stands
  - Integration: comments endpoint is NOT called for tasks filtered out by the cutoff (observable via request count)

  **Verification:**
  - API request count for completed-task-heavy folders drops proportionally to the filtered-out ratio
  - On a forced Phase B timeout in test, the dashboard still reflects active-task changes made since the last sync
  - 90-day boundary is tunable via `config.ts` constant, not hardcoded in fetchers

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

- [ ] **Unit 4: Extract shared build function and wire cache lifecycle**

  **Goal:** Extract the core build+save logic into a shared `runSyncBuilds()` function that both `syncRunner.runSync()` and the cron route call, with comment cache init/clear managed inside it.

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

- [ ] **Unit 6: Outer-loop parallelism (replaces throttle reduction from Unit 1B)**

  **Goal:** Parallelize the `for (member of members)` loop in `buildWeeklySnapshot` and the `for (client of clients)` loop in `buildFlowSnapshot` so all members (and all client folders) are fetched concurrently, without touching the global `MIN_REQUEST_INTERVAL_MS`.

  **Requirements:** R1

  **Dependencies:** Unit 2 (folder cache must be in place so concurrent callers don't race on the cache init — Unit 2's `initFolderCommentCache()` runs once at sync start, reads/writes within the loop go through the shared Map which is fine for ordered awaits)

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

- [ ] **Unit 7: catchUpMissingDates soft deadline with loud telemetry**

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

- [ ] **Unit 8: Two-line cache wiring (replaces dropped Unit 4)**

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

- [ ] **Unit 5: End-to-end timing validation**

  **Goal:** Verify the optimized sync completes well under 300s with real Wrike data.

  **Requirements:** R1, R2

  **Dependencies:** Units 1-4

  **Files:**
  - No file changes — manual or scripted validation

  **Approach:**
  - Run the sync locally or via the `/api/sync/trigger` endpoint
  - Compare duration against the pre-optimization ~10 minute baseline
  - Verify data correctness: compare snapshot contents (task counts, comment counts, flow metrics) against a known-good snapshot
  - Check Wrike API request count to confirm reduction

  **Test expectation: none** — this is a manual validation step

  **Verification:**
  - Sync duration < 180s (50% safety margin under 300s)
  - Snapshot data matches pre-optimization output
  - No Wrike rate limit errors (429s)

## System-Wide Impact

- **Interaction graph:** The comment cache is sync-scoped and does not affect webhook-triggered `syncTask()`, which fetches a single task's comments directly. The `WrikeClient` throttle chain is shared — concurrent/batch calls will queue through it, which is the desired behavior. The `catchUpMissingDates()` call in the cron route makes its own Wrike API calls that go through the same throttle chain — this is fine and unchanged.
- **Error propagation:** A batch/concurrent comment fetch failure will propagate the same way individual fetch failures do today — the build function will throw, the sync will fail, and the guard will be released in the finally block.
- **State lifecycle risks:** The comment cache must be cleared after every sync run (including failures) to prevent stale data. Using a finally block matches the existing guard cleanup pattern. `initFolderCommentCache()` unconditionally creates a fresh Map to handle Vercel warm-start edge cases.
- **API surface parity:** After Unit 4, both the cron route and `syncRunner.runSync()` call the shared `runSyncBuilds()`, so all sync paths automatically benefit from the optimization. Each entry point retains its own guard, pre-checks, and response shape.
- **Time budget note:** The cron route also runs `catchUpMissingDates()` after the builds, which makes its own Wrike API calls through the shared throttle chain. This is unchanged but adds to the cron route's total wall-clock time. The 180s target applies to the build portion; the cron route's total may be slightly higher. Per-task comment fetches are not cached across builds (folder comments are), so overlapping unmapped tasks between weekly and flow builds are fetched twice — this is acceptable given the batch/concurrent optimization dramatically reduces the per-fetch cost.
- **Unchanged invariants:** The webhook `syncTask` path, Redis storage keys, cron schedule, and sync guard TTL (already 600s) are all unchanged. Snapshot data format is unchanged in shape but now bounded in content (only active + completed <90d tasks).
- **Storage bounding (R4):** Excluding completed tasks older than 90 days reduces the per-snapshot task count from potentially thousands (full Wrike history) to a bounded working set. This also reduces the per-sync Wrike API call count proportionally (fewer tasks → fewer comment/timelog fetches).
- **Partial-sync semantics (R5):** Active-first batching means a timeout mid-sync leaves the dashboard with fresh active data from this run + potentially stale completed data from the previous run. This is preferable to losing the whole sync. Callers observing the sync result should be able to distinguish a full success from a "Phase A succeeded, Phase B skipped" partial success (new field on `SyncResult`: `phase: "full" | "active_only"`).
- **Display parity:** Any dashboard UI that currently shows tasks older than 90 days (completed) must be reviewed — those tasks will no longer appear in snapshots. Verify the KPI widgets, flow views, and weekly reports are all constrained to a window that doesn't exceed 90 days of completed history.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Wrike batch endpoint `/tasks/{id1,...}/comments` may not work for sub-resources | Unit 0 validates this upfront. Unit 1B provides a concurrent-fetch fallback with throttle reduction (1100ms → 180ms) that achieves the target. |
| Comments from batch endpoint may lack `taskId` field | Verified in Unit 0. If missing, fall back to Unit 1B concurrent approach. |
| Comment cache serves stale data on Vercel warm-start | `initFolderCommentCache()` unconditionally creates a fresh Map, replacing any pre-existing state. |
| Cron route refactor (Unit 4) may break cron-specific logic | Unit 4 extracts only the build+save logic into `runSyncBuilds()` — cron-specific logic (guard, pre-checks, webhook, catchup, Slack, NextResponse) stays in the cron route untouched. Test scenarios verify all cron-specific behavior. |
| Throttle reduction (1100ms → 180ms) may approach Wrike rate limit | 180ms = ~333 req/min, safely under the 400 req/min limit. Only applies if Unit 1B is used (batch path uses fewer total requests). |
| Concurrent `get()` calls interact with `requestSlotChain` | The chain serializes all requests — concurrent callers queue safely. Verified by reading the throttle implementation. |
| 90-day cutoff silently drops tasks users expect to see | UI/reporting widgets must be audited for any view that currently reads completed-task history beyond 90 days. Make the cutoff a `config.ts` constant so it can be tuned if the requirement changes. |
| Completed tasks with null `completedDate` (migration artifact — see memory) behave unpredictably | Unit 2.5 test scenarios cover this explicitly. Default: include (conservative) with a one-time log, to avoid silently dropping valid data. |
| Phase A succeeds + Phase B times out → partial snapshot is stale on completed side | Phase A's saved snapshot is correctly timestamped; `SyncResult.phase` field surfaces the partial state. Next sync attempt re-runs both phases. |

## Sources & References

- Related code: `src/lib/wrike/fetcher.ts`, `src/lib/wrike/client.ts`, `src/lib/syncRunner.ts`, `src/app/api/cron/sync/route.ts`
- Wrike API docs: batch operations support comma-separated IDs on entity endpoints (sub-resource support unconfirmed — Unit 0 validates)
- Memory: `project_wrike_api_comment_filter.md` — comments endpoint rejects `updatedDate`
