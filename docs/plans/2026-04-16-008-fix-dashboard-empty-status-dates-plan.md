---
title: "fix: Repair empty status dates, missing tasks, and flow data on dashboard"
type: fix
status: active
date: 2026-04-16
---

# fix: Repair empty status dates, missing tasks, and flow data on dashboard

## Overview

Two distinct failures on the dashboard:

1. **All 27 visible tickets show dashes in every status column** — the comment-based transition parser (the only reliable fallback when the webhook is dead) is date-filtered to the current week, so it never sees historical status change comments. Every task falls to the synthetic single-point fallback.

2. **Specific tasks are completely missing from the dashboard** — task `4429989943` was created >10 days ago and moved multiple times but doesn't appear at all. This is a separate bug from empty status dates: the task fetch itself is failing to find the task, likely because it's either not in a configured folder or its Wrike status group doesn't match the `"Active"` filter.

Both must be fixed. The Flow Details page (Aging Work Items, Cumulative Flow Diagram) is empty as a consequence of problem #1.

## Problem Frame

### Problem 1: Empty status dates

The system has two sources for transition data:
1. **Webhook transitions** (Redis sorted sets) — only populated when the Wrike webhook fires. If dead/suspended, no data.
2. **Comment-parsed transitions** — Wrike auto-generates "changed status from X to Y" comments. The parser works, BUT `fetchClientTasks()` date-filters comments to the current week only (`updatedDate: wrikeDateRange(dateRange)` at `fetcher.ts:340-343` and `:360-361`). Historical status change comments from weeks ago are invisible.

When both return empty → `flowBuilder.ts:464-475` creates one synthetic transition → one `StageDuration` → all other columns show `—`.

### Problem 2: Missing tasks

Task `4429989943` (permalink from Wrike URL) doesn't appear on the dashboard despite being created 10+ days ago and moved multiple times. `fetchClientTasks()` fetches tasks via:
- `updatedDate` filter (recently updated within the week) — misses stale tasks
- `status: "Active"` (no date filter) — should catch active tasks, but fails if the task uses a custom status whose `group` is not `"Active"`, or if the task is not in any of the 4 configured folders

The plan must **use the Wrike API to investigate** why this task is missing rather than guessing. A diagnostic endpoint will look up the task directly and report its folder membership, status, and whether it falls within the configured folder set.

## Requirements Trace

- R1. Status columns must show entry timestamps and duration for every stage a ticket has passed through
- R2. Flow Details page (Aging, CFD) must render real data from transition history
- R3. Tickets moved days/weeks ago must have their full transition history from Wrike comments
- R4. The fix must not require the webhook to be healthy — comments alone should produce a timeline
- R5. New tickets appearing within the current week must also have their transitions captured
- R6. Task `4429989943` must appear on the dashboard with correct status history
- R7. Task `4436847867` must appear on the dashboard with correct status history
- R8. **No regressions** — changes to `fetchClientTasks()` must not break `buildFlowSnapshot()`, `POST /api/sync/baseline`, `buildWeeklySnapshot()`, or `fetchWeeklyMemberData()` (these are separate functions but share the same module)

## Scope Boundaries

- NOT redesigning the webhook pipeline or fixing webhook reliability (covered by plans 001, 003, 004)
- NOT changing the date catch-up logic for Wrike start/due dates (covered by plan 007)
- NOT adding new UI features — only fixing data flow so existing components render correctly

## Context & Research

### Relevant Code and Patterns

**Comment fetch (the core bug):**
- `src/lib/wrike/fetcher.ts:340-343` — folder-level comment fetch: `{ updatedDate: wrikeDateRange(dateRange) }` restricts to current week
- `src/lib/wrike/fetcher.ts:360-361` — per-task comment fallback: same date restriction
- `src/lib/flowBuilder.ts:414-418` — webhook transition lookback already extends 4 weeks before selected week. Comments should match.

**Task fetch (missing task):**
- `src/lib/wrike/fetcher.ts:314-326` — two parallel queries: `updatedDate` + `status: "Active"`. Task could be missed if folder mismatch or status group mismatch.
- `src/lib/config.ts:38-43` — 4 configured folders: Clinic 27, Hacker Kitchens, Suzanne Code, MxD (Internal)

**Callers of `fetchClientTasks()` — regression scope:**
1. `src/lib/flowBuilder.ts:435` — `buildFlowSnapshot()` — uses comments for transition parsing
2. `src/app/api/sync/baseline/route.ts:87` — `POST /api/sync/baseline` — uses tasks only, ignores comments entirely (only reads `data.tasks`, never `data.comments`)

**Functions NOT affected (different code path):**
- `fetchWeeklyMemberData()` — called by `src/lib/aggregator.ts:53` — completely separate function, own date filtering, not touched by this fix
- `buildWeeklySnapshot()` — calls `fetchWeeklyMemberData()`, not `fetchClientTasks()`

### Institutional Learnings

- **P16 created the comment bug**: Date filter added to "prevent unbounded comment fetching" — correct for `fetchWeeklyMemberData()` but wrong for `fetchClientTasks()` which needs history
- **Previous plans have caused regressions**: The P1-P30 fix chain introduced compounding issues. This plan must explicitly verify no regressions by tracing all callers.

### Regression Risk Assessment

| Function | Called by | Uses comments? | Affected by this change? |
|---|---|---|---|
| `fetchClientTasks()` | `buildFlowSnapshot()` | Yes — for transition parsing | Yes — comment lookback extended (the fix) |
| `fetchClientTasks()` | `POST /api/sync/baseline` | **No** — only reads `data.tasks`, ignores `data.comments` | Harmless — wider comment fetch is wasted work but doesn't change behavior |
| `fetchWeeklyMemberData()` | `buildWeeklySnapshot()` | Yes — for weekly member view | **No** — separate function, not modified |
| `patchFlowSnapshotForTask()` | webhook auto-sync | Yes — fetches comments directly via Wrike client, not `fetchClientTasks()` | **No** — uses its own per-task comment fetch with no date filter |

## Key Technical Decisions

- **Extend comment lookback to match webhook lookback (4 weeks)**: Bounds API calls while capturing the history that matters. `fetchClientTasks()` already accepts a `dateRange` parameter — compute a wider lookback range for comments only, keep task fetch unchanged.
- **Add a diagnostic API endpoint**: Rather than guessing why tasks are missing, add `GET /api/debug/task-lookup?permalink=<id>` that queries the Wrike API directly for the task and reports: task ID, folder parents, current status, whether it falls in configured folders. This is a dev tool, protected by `CRON_SECRET`.
- **No changes to `fetchWeeklyMemberData()`**: It's a completely separate function. The comment date filter is correct there (weekly member view doesn't need multi-week comment history).

## Open Questions

### Resolved During Planning

- **Q: Why doesn't the 4-week webhook lookback help?** Redis sorted sets are empty if the webhook was never active or was suspended. The lookback reads empty sets.
- **Q: Why do 27 tasks show up if comments are filtered?** Tasks and comments are fetched separately. Tasks use `status: "Active"` (no date limit). Only the comment fetch is date-restricted.
- **Q: Could changing `fetchClientTasks()` break the baseline sync?** No. Baseline sync (`POST /api/sync/baseline`) reads `data.tasks` but never reads `data.comments`. The wider comment window is fetched but unused — wasted API calls but no behavioral change. Verified by reading `src/app/api/sync/baseline/route.ts:99` which destructures `{ clientName, tasks }` only.
- **Q: What folder is task `4429989943` in?** Cannot determine from code alone. The diagnostic endpoint (Unit 2) will use the Wrike API to look up the task by permalink and identify its parent folders. If it's outside the 4 configured folders, the fix is to either add the folder or recognize this is expected.

### Deferred to Implementation

- **Q: Exact Wrike API rate limit impact of wider comment window?** Monitor after deployment.
- **Q: Does Wrike's `/tasks/{id}` API accept permalink IDs or only internal IDs?** If permalink IDs don't work, the diagnostic endpoint will need to search across configured folders. Determine during implementation.

## Implementation Units

- [ ] **Unit 1: Extend comment lookback in fetchClientTasks()**

  **Goal:** Widen the comment date filter in `fetchClientTasks()` from "current week" to "4 weeks before the selected week" so the comment parser can reconstruct full transition history.

  **Requirements:** R1, R2, R3, R4, R5, R8

  **Dependencies:** None

  **Files:**
  - Modify: `src/lib/wrike/fetcher.ts`

  **Approach:**
  - In `fetchClientTasks()`, compute a `commentLookbackRange` by subtracting 4 weeks from `dateRange.start`. Use this wider range for the folder-level comment fetch (line 340-343) and the per-task comment fallback (line 360-361).
  - Keep the task fetch queries (lines 314-326) exactly as they are — `updatedDate` + `status: "Active"` for tasks is correct.
  - Do NOT touch `fetchWeeklyMemberData()` — it's a separate function with its own correct date filtering.

  **Patterns to follow:**
  - 4-week lookback computation already exists in `src/lib/flowBuilder.ts:414-418`:
    ```
    const weekStartMs = new Date(weekStart).getTime();
    const lookbackStartMs = weekStartMs - 4 * 7 * 24 * 60 * 60 * 1000;
    ```

  **Test scenarios:**
  - Happy path: Task with status change comment from 2 weeks ago → transition appears in flow snapshot after sync
  - Happy path: Task with status change comment from this week → transition still appears (not broken by wider window)
  - Edge case: Task with zero comments → falls through to synthetic transition (same behavior as before)
  - Edge case: Task with non-status-change comments only → falls through to synthetic (same as before)
  - Regression: `fetchWeeklyMemberData()` still uses narrow weekly date range — verify by reading the code (no code change to that function)
  - Regression: `POST /api/sync/baseline` still works — it reads `data.tasks` only, ignores `data.comments`, so wider comment fetch is harmless

  **Verification:**
  - Manual sync produces flow snapshot where tasks with historical status changes have multi-stage `stageDurations`
  - `fetchWeeklyMemberData()` function body is unchanged
  - Baseline sync endpoint still returns expected response

- [ ] **Unit 2: Add task lookup diagnostic endpoint**

  **Goal:** Create a debug endpoint that uses the Wrike API to look up specific tasks by permalink ID and report why they're missing from the dashboard (wrong folder, wrong status, not fetched).

  **Requirements:** R6, R7

  **Dependencies:** None (can be done in parallel with Unit 1)

  **Files:**
  - Create: `src/app/api/debug/task-lookup/route.ts`

  **Approach:**
  - `GET /api/debug/task-lookup?permalink=<numeric_id>` — protected by `Bearer {CRON_SECRET}`
  - Use the Wrike client to search for the task. Try `/tasks?permalink=https://www.wrike.com/open.htm?id={permalink}` first. If that doesn't work, iterate through configured folders searching by title or fetching all tasks.
  - For the found task, report: Wrike task ID, title, `customStatusId`, status name, `parentIds` (folders), whether any `parentIds` match configured folders, `createdDate`, `updatedDate`, `completedDate`, and the task's comments (to verify status change comments exist).
  - Report a clear diagnosis: "Task is in folder X which is NOT in the configured folder list" or "Task is in Completed status — only appears if updated this week" or "Task found in configured folder — should appear on dashboard".

  **Patterns to follow:**
  - Existing diagnostic endpoint: `src/app/api/debug/statuses/route.ts`
  - Existing health endpoint: `src/app/api/sync/health/route.ts`

  **Test scenarios:**
  - Happy path: Lookup for a task in a configured folder → returns task details with "should appear on dashboard"
  - Happy path: Lookup for a task in an unconfigured folder → returns task details with "NOT in configured folders" diagnosis
  - Error path: Lookup for a nonexistent permalink → returns clear "task not found" message
  - Edge case: Task with Completed status → diagnosis explains it won't appear unless recently updated

  **Verification:**
  - Hit the endpoint with permalink `4429989943` and `4436847867` — get clear answers about why each task is/isn't showing

- [ ] **Unit 3: Fix missing task based on diagnostic results**

  **Goal:** Based on the diagnostic output from Unit 2, apply the correct fix for the missing task(s) — either add a missing folder to config, fix the task fetch query, or both.

  **Requirements:** R6, R7, R8

  **Dependencies:** Unit 2 (needs diagnostic output to determine the right fix)

  **Files:**
  - Modify: `src/lib/config.ts` (if folder is missing)
  - Modify: `src/lib/wrike/fetcher.ts` (if task fetch query needs adjustment)

  **Approach:**
  - **If the task is in an unconfigured folder**: Add the folder ID to `config.clients[]`. This is safe — it only adds data, doesn't change existing folder fetches.
  - **If the task is in a configured folder but using an unrecognized custom status**: Add the status to `knownCustomStatuses[]` in `fetcher.ts:88-95`. Verify the status `group` field is correct.
  - **If the task is in "Completed" status and stale**: The current fetch logic is correct (completed + not recently updated = intentionally excluded). Confirm this with the user.

  **Test scenarios:**
  - Regression: All 4 existing client folders still return their tasks after config change
  - Regression: Adding a folder doesn't affect `fetchWeeklyMemberData()` (it uses `config.wrikeFolderIds` which auto-derives from `config.clients`)
  - Happy path: After the fix, the missing task appears in the flow snapshot

  **Verification:**
  - Run a sync and confirm the previously-missing task appears on the dashboard

- [ ] **Unit 4: Add diagnostic logging to buildFlowSnapshot**

  **Goal:** Add logging to confirm the fix is working and identify any remaining data gaps.

  **Requirements:** R1, R2

  **Dependencies:** Unit 1

  **Files:**
  - Modify: `src/lib/flowBuilder.ts`

  **Approach:**
  - After merging transitions for each task (after line 460), log: task ID, title (truncated), webhook transition count, comment transition count, total merged, synthetic fallback used (yes/no).
  - At the end of `buildFlowSnapshot()`, log summary: total tickets, tickets with real transitions, tickets with synthetic-only.
  - Keep logs concise — one line per task, one summary line.

  **Test scenarios:**
  - Happy path: After sync, logs show tasks with >0 comment transitions
  - Regression: Log output doesn't affect the return value of `buildFlowSnapshot()` or any downstream consumer

  **Verification:**
  - Trigger manual sync, review Vercel function logs, confirm transitions are flowing

- [ ] **Unit 5: Deploy, sync, and verify end-to-end**

  **Goal:** Deploy all changes, run baseline + full sync, verify the dashboard renders correctly.

  **Requirements:** R1, R2, R3, R5, R6, R7, R8

  **Dependencies:** Units 1-4

  **Files:**
  - No code changes — operational verification

  **Approach:**
  - Deploy to Vercel
  - Run `POST /api/sync/baseline` to seed baseline transitions
  - Run `POST /api/sync/trigger` for full sync with extended comment lookback
  - Verify dashboard: status columns show timestamps/durations instead of dashes
  - Verify Flow Details: Aging Work Items and CFD render with real data
  - Verify tasks `4429989943` and `4436847867` appear with transition history
  - Verify the Overview page (team section) still shows correct data — no regression from the comment fetch change

  **Test expectation: none -- operational verification, not code change**

  **Verification:**
  - Dashboard ticket table shows colored duration badges in status columns
  - Flow Details page shows populated charts
  - Referenced Wrike tickets appear on dashboard
  - Overview page team section data is unchanged (same member tasks, hours, pipeline movement as before)

## System-Wide Impact

- **Interaction graph:** `fetchClientTasks()` is called by `buildFlowSnapshot()` and `POST /api/sync/baseline`. Both callers are safe — baseline ignores comments. No other callers.
- **Error propagation:** If extended comment fetch fails, existing `try/catch` in `buildFlowSnapshot():438-441` catches it and skips that client. Same behavior as before.
- **API surface parity:** `fetchWeeklyMemberData()` is a **completely separate function** — not modified, not affected. It has its own date filtering that remains correct for its purpose (weekly member metrics).
- **Unchanged invariants:**
  - `buildWeeklySnapshot()` calls `fetchWeeklyMemberData()`, NOT `fetchClientTasks()` — entirely unaffected
  - `patchFlowSnapshotForTask()` uses its own direct Wrike API calls with no date filter — unaffected
  - Webhook transition storage and retrieval — unaffected
  - Frontend components — unaffected (they render whatever data the snapshot provides)
  - Synthetic fallback logic in `flowBuilder.ts:462-476` — unaffected (still triggers when both sources return empty)

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Wider comment fetch increases Wrike API calls | 4-week window is bounded. Same window as webhook lookback. Monitor post-deploy. |
| Adding a new folder to config changes pipeline counts | Adding a folder only adds new tasks — existing tasks/counts unchanged. |
| Comment parser regex doesn't match Wrike's actual format | Unit 1 fix exposes this if true — diagnostic logging (Unit 4) will reveal tasks with comments but 0 parsed transitions. Can be fixed as a follow-up. |
| Previous plans caused regressions | Regression risk explicitly traced in this plan. `fetchWeeklyMemberData()` is not touched. `POST /api/sync/baseline` ignores comments. All callers verified. |

## Sources & References

- Related plans: `docs/plans/2026-04-16-001-fix-wrike-webhook-suspension-plan.md`, `docs/plans/2026-04-16-003-fix-comprehensive-reliability-audit.md`
- Related code: `src/lib/wrike/fetcher.ts`, `src/lib/flowBuilder.ts`, `src/lib/wrike/commentParser.ts`, `src/lib/aggregator.ts`
- Related PRs: #12 (P1-P29 reliability), #14 (date-setting webhook coverage), #15 (per-task resync), #16 (baseline sync)
