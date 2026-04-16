---
title: "fix: Make ticket cycle position always visible regardless of transition data"
type: fix
status: active
date: 2026-04-16
---

# fix: Make ticket cycle position always visible regardless of transition data

## Overview

The dashboard ticket table shows dashes (—) in every status column and Cycle column for all 27 tickets, even after PR #17 extended the comment lookback to 4 weeks. The pipeline distribution bar at the top correctly shows where tickets are (New: 5, Planned: 4, In Progress: 10, etc.) because it reads from `ticket.currentStage` which derives from the Wrike API directly. But the per-ticket status columns rely on transition history data which is consistently empty.

The root problem: **the system depends on two unreliable data sources (webhook events and comment parsing) for transition history, and when both fail, the synthetic fallback produces data but the stale Redis snapshot predates the fixes.** Even when the code is correct, the data isn't being refreshed.

This plan takes a two-pronged approach:
1. **Make the current status always visible** — the table should show where each ticket IS right now, always, with zero dependency on transition history
2. **Fix the data pipeline** — diagnose why transitions are empty and add the Wrike task audit log as a third, more reliable data source

## Problem Frame

The user has sent screenshots multiple times showing the same empty status columns. Each fix (PRs #12-#17) addresses one failure mode, but the fundamental issue remains: the status columns require populated `stageDurations[]` arrays, which require transition data from webhooks or comment parsing. Both sources are fragile:

- **Webhooks**: Dead/suspended (documented in plan 001). No events → empty Redis sorted sets.
- **Comment parsing**: The regex `changed status from X to Y` only matches Wrike system comments. If comments don't exist, use a different format, or the status names don't resolve → 0 transitions.
- **Synthetic fallback**: Creates 1 transition for the current stage. Should show data in one column. But the Redis snapshot may be stale (built before the fix).

The pipeline distribution bar works because it reads `currentStage` (derived from the live Wrike `customStatusId`), not transition history. The fix must bring the same reliability to the per-ticket columns.

## Requirements Trace

- R1. Every ticket must show its current stage position in the status columns — no full rows of dashes
- R2. The current stage cell must show how long the ticket has been in that stage (age)
- R3. Historical stages should show dates and durations when transition data is available
- R4. The Cycle column must show time from Planned to current (or Planned to Completed) when data exists
- R5. A manual sync must immediately rebuild the flow snapshot with the latest code
- R6. The system must not depend solely on comment parsing or webhooks for basic status visibility
- R7. No regressions to the pipeline distribution bar, team cards, or overview metrics

## Scope Boundaries

- NOT redesigning the webhook pipeline (covered by plan 001)
- NOT adding new stages or statuses
- NOT changing the weekly snapshot or team metrics pipeline
- Diagnostic/investigation work for the Wrike audit log API is in scope as a potential third transition source

## Context & Research

### Relevant Code and Patterns

**Current stage (reliable, always works):**
- `src/lib/flowBuilder.ts:176-180` — `currentStage` computed from `customStatusId` via `resolveStatusName()` + `normalizeStage()`
- `src/lib/flowBuilder.ts:183-187` — `currentStageAgeHours` computed from last transition timestamp
- `src/components/TicketFlowTable.tsx:227` — `isCurrent = ticket.currentStage === stage` — this variable EXISTS but is only used for styling (ring highlight), not as a fallback for missing data

**Stage durations (unreliable, depends on transitions):**
- `src/lib/flowBuilder.ts:120-147` — `computeStageDurations()` derives from `transitions[]`
- `src/components/TicketFlowTable.tsx:226-258` — renders `stageDurations` or dashes

**Synthetic fallback (should work but Redis may be stale):**
- `src/lib/flowBuilder.ts:462-476` — creates 1 synthetic transition when both sources empty
- Uses `task.updatedDate` as timestamp

**Known status names (match STAGES array):**
- `src/lib/wrike/fetcher.ts:88-95` — hardcoded: New, Planned, In Progress, In Review, Client Pending, Completed
- `src/components/TicketFlowTable.tsx:13-20` — STAGES: same names, same order

### Institutional Learnings

- Plan 008 identified the comment date filter bug and extended lookback (PR #17). The fix is deployed to `origin/main` but may not have produced a fresh snapshot yet.
- Webhook is likely dead/suspended (plan 001). Comment parser is the only fallback.
- Previous plans caused compounding regressions (P1-P30). Changes to shared functions must trace all callers.
- Empty snapshots can overwrite good data (plan 003). The `saveFlowSnapshot` guard rejects 0-ticket snapshots.

### External References

- Wrike API v4: `/tasks/{taskId}/audit_log` endpoint may provide authoritative status change history (needs investigation)

## Key Technical Decisions

- **Guarantee a current-stage StageDuration in the backend**: Rather than only fixing the frontend, ensure `buildTicketFlow()` always includes a StageDuration entry for the current stage. This makes both the table AND the flow metrics/charts (AgingWipChart, CFD, flow efficiency) benefit from the fix. The synthetic fallback already does this when `transitions.length === 0`, but when there ARE partial transitions (e.g., 1-2 comment transitions found) that don't include the current stage, no StageDuration is created for it. Fix: after `computeStageDurations()`, check if the current stage is represented. If not, inject a synthetic duration entry.
- **Fix `currentStageAgeHours` fallback when no transitions**: Currently, `currentStageAgeHours` is `0` when `transitions` is empty (before synthetic fallback fires). The synthetic fallback fixes this for the `transitions` array, but the calculation uses `lastTransition` which may have a misleading timestamp (`updatedDate` reflects any field change, not just status changes). Add `currentStageEnteredAt` as a new field with a better fallback chain: last transition timestamp → `createdDate` (if status is "New") → `updatedDate`.
- **Frontend fallback for defense-in-depth**: Even with the backend fix, add a frontend fallback that renders `currentStage` + `currentStageAgeHours` when `getStageDuration()` returns undefined. This handles stale Redis snapshots that predate the backend fix.
- **Investigate Wrike audit log as a third transition source**: The Wrike API may have `/tasks/{id}/audit_log` or similar that returns authoritative history. If available, this is more reliable than both comments and webhooks.
- **Force-sync after deployment**: The "Sync Now" button already calls `fetchData("current")` on success (verified at `page.tsx:89`), so the UI auto-refreshes. The user just needs to click sync after the new code deploys.

## Open Questions

### Resolved During Planning

- **Q: Why does the pipeline bar show correct data but status columns don't?** The bar reads `ticket.currentStage` (from Wrike `customStatusId`, always available). The columns read `ticket.stageDurations` (from transitions, often empty). Two different data sources with different reliability.
- **Q: Should the synthetic fallback already make the current stage visible?** Yes — it creates 1 transition → 1 StageDuration. But if the Redis snapshot was built before the synthetic fallback was added or before the comment lookback fix, the cached data has empty `stageDurations`. A sync must run to rebuild.
- **Q: Why hasn't the cron rebuilt the snapshot?** Cron runs at midnight, 2:20am, noon UTC. If PR #17 was deployed after noon UTC today, no cron has run yet. Or the cron may be failing (config load, sync guard stuck, Wrike API error).

### Deferred to Implementation

- **Q: Does Wrike's API have an audit log endpoint for tasks?** Investigate during implementation. If it exists and returns status changes, it's a reliable third source.
- **Q: What format are the actual Wrike system comments?** Run the task-lookup diagnostic endpoint to inspect real comment text and verify the regex matches.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```
Data flow (current — broken):
  Wrike API → comments → parse regex → transitions → stageDurations → table cells
                                               ↑                          ↑
  Redis sorted sets → webhook entries ─────────┘                   (often empty)
  (both sources empty → synthetic transition → 1 stageDuration → but Redis stale)

Data flow (proposed — resilient, two layers):

  Layer 1 (backend — buildTicketFlow):
    transitions → computeStageDurations() → durations[]
    IF currentStage NOT in durations[] →
      inject synthetic StageDuration { currentStage, enteredAt: fallback chain, exitedAt: null }
    → EVERY ticket has stageDurations.length >= 1
    → FlowMetrics, charts, table all benefit

  Layer 2 (frontend — TicketFlowTable, defense-in-depth):
    getStageDuration(stage) found → render normally
    getStageDuration(stage) NOT found AND isCurrent → render fallback cell
    → handles stale Redis snapshots that predate the backend fix
```

Two-layer approach: the backend fix (Layer 1) ensures fresh snapshots always have current-stage data for the table, charts, and metrics. The frontend fix (Layer 2) handles stale cached snapshots gracefully.

## Implementation Units

- [ ] **Unit 1: Backend — guarantee current-stage StageDuration and add `currentStageEnteredAt`**

  **Goal:** Ensure every ticket's `stageDurations[]` always contains at least an entry for its current stage, and add a `currentStageEnteredAt` field. This fixes the table, flow metrics, charts (AgingWipChart, CFD, flow efficiency, bottleneck detection) all at once.

  **Requirements:** R1, R2, R6, R7

  **Dependencies:** None

  **Files:**
  - Modify: `src/lib/types.ts`
  - Modify: `src/lib/flowBuilder.ts`

  **Approach:**
  - Add `currentStageEnteredAt: string | null` to `TicketFlowEntry` interface
  - In `buildTicketFlow()`, after `computeStageDurations()` returns, check if the `currentStage` has a matching `StageDuration` entry. If not, compute a best-effort `enteredAt` using the fallback chain: (1) last transition's timestamp if transitions exist, (2) `task.createdDate` if status is "New", (3) `task.updatedDate` as general fallback. Inject a synthetic `StageDuration` entry: `{ stageName: currentStage, stageId: task.customStatusId, enteredAt, exitedAt: null, durationHours: (now - enteredAt) in hours }`.
  - Set `currentStageEnteredAt` to the same `enteredAt` value used above (or from the existing StageDuration if one already exists for the current stage)
  - Recalculate `currentStageAgeHours` from `currentStageEnteredAt` instead of from `lastTransition.timestamp`. This fixes the bug where `currentStageAgeHours` is `0` when there are no transitions.
  - Do NOT modify `fetchWeeklyMemberData()`, `fetchClientTasks()`, or any other function. Only `buildTicketFlow()` and the `TicketFlowEntry` interface change.

  **Patterns to follow:**
  - Existing synthetic fallback at `flowBuilder.ts:462-476` (creates a transition — this unit creates a StageDuration)
  - Existing `enteredPlanDate` field (nullable ISO string with fallback chain)

  **Test scenarios:**
  - Happy path: Ticket with real transitions that include current stage → no change, existing StageDuration used
  - Happy path: Ticket with real transitions that DON'T include current stage (e.g., has New→Planned transitions but is now In Progress) → synthetic StageDuration injected for "In Progress"
  - Happy path: Ticket with no transitions (synthetic-only) → StageDuration entry created for current stage with `updatedDate`-based timestamp
  - Edge case: New ticket with no transitions → uses `createdDate` as enteredAt
  - Edge case: Completed ticket with no transitions → StageDuration entry for "Completed" with `updatedDate`
  - Edge case: `currentStageAgeHours` is now > 0 for all tickets with a known stage (not 0 as before)
  - Regression: `computeFlowMetrics()` receives tickets with current-stage StageDurations → `flowEfficiency`, `bottleneckStage`, and `stageDwellTotals` now have data
  - Regression: `buildDailyFlow()` reads from `ticket.transitions` not `stageDurations` — unaffected by this change

  **Verification:**
  - Every ticket in the flow snapshot has `stageDurations.length >= 1`
  - Every ticket has `currentStageEnteredAt !== null`
  - `currentStageAgeHours > 0` for tickets not just created
  - `FlowMetrics.flowEfficiency` is non-null
  - `FlowMetrics.bottleneckStage` is non-null when there are active tickets

- [ ] **Unit 2: Frontend — fallback rendering for stale snapshots**

  **Goal:** When a ticket has no StageDuration for its current stage (stale Redis snapshot predating Unit 1), render a fallback cell using `currentStage` + `currentStageAgeHours`. Defense-in-depth — ensures current stage is always visible even with old data.

  **Requirements:** R1, R6

  **Dependencies:** None (can be done in parallel with Unit 1)

  **Files:**
  - Modify: `src/components/TicketFlowTable.tsx`

  **Approach:**
  - In the stage column rendering loop (lines 225-258), when `getStageDuration()` returns undefined AND `ticket.currentStage === stage`, render a fallback cell instead of a dash
  - The fallback cell shows: `currentStageAgeHours` formatted as duration (or `currentStageEnteredAt` via `formatTimestamp()` if available), with a dashed border to visually distinguish from tracked data
  - For `currentStageAgeHours === 0` (old snapshot, no data), show a blue dot or "current" label instead of "0m" to indicate position without misleading duration
  - Handle `currentStageEnteredAt` being `undefined` (old snapshot) vs `null` (new snapshot, no data) — treat both as "no timestamp available"
  - Keep the dash (—) for stages that are NOT the current stage and have no duration data

  **Patterns to follow:**
  - Existing `durationColor()` and `formatDuration()` functions
  - The `isCurrent` variable already exists at line 227

  **Test scenarios:**
  - Happy path: Ticket with currentStage="In Progress" and empty stageDurations → "In Progress" column shows fallback indicator, all other columns show dashes
  - Happy path: Ticket with full stageDurations (post-Unit 1 sync) → renders normally, no fallback triggered
  - Happy path: Ticket with partial stageDurations + currentStage not in them → current stage shows fallback
  - Edge case: `currentStageAgeHours === 0` → shows position indicator, not "0m"
  - Edge case: Old snapshot without `currentStageEnteredAt` field → gracefully omits timestamp
  - Edge case: Switching between All/Active/Completed filter → `stagesWithData` set recomputes correctly, includes fallback-rendered stages

  **Verification:**
  - Zero ticket rows with all-dash status columns
  - Visual distinction between real data (solid background) and fallback data (dashed border)

- [ ] **Unit 3: Deploy, sync, and verify end-to-end**

  **Goal:** Deploy Units 1-2, run a full sync, and verify the dashboard shows ticket cycle positions.

  **Requirements:** R5, R7

  **Dependencies:** Units 1 and 2

  **Files:**
  - No code changes — operational verification

  **Approach:**
  - Deploy to Vercel (push to main, or PR merge)
  - Click "Sync Now" on the dashboard (or `POST /api/sync/trigger`). The button already auto-refreshes the page on success (`page.tsx:89`)
  - Check the sync response: `flowTickets` count should be > 0
  - Check Vercel function logs for `[flow]` log lines — verify per-task transition counts and how many are `(synthetic)` vs real
  - If ALL tickets are synthetic, use the task-lookup endpoint (`GET /api/debug/task-lookup?permalink=<id>`) to inspect a sample ticket's actual Wrike comments and diagnose whether the comment parser is matching anything
  - Verify: (1) every ticket row shows at least the current stage cell with data, (2) the pipeline distribution bar still works, (3) Flow Details page charts have non-empty data, (4) team cards on Overview are unaffected

  **Test expectation: none -- operational verification, not code change**

  **Verification:**
  - Dashboard ticket table: every row has at least one colored cell in the status columns
  - Flow Details page: AgingWipChart and CFD render with data
  - Pipeline bar: same counts as before
  - Team section: member task counts and metrics unchanged

- [ ] **Unit 4: Investigate Wrike audit log API for reliable transition history**

  **Goal:** Determine if the Wrike API offers a task audit log or history endpoint that provides authoritative status change records, as a more reliable alternative to comment parsing. This would populate FULL transition history (all stages a ticket passed through), not just the current stage.

  **Requirements:** R3, R6

  **Dependencies:** Unit 3 (need diagnostic data first to confirm whether comment parsing works at all)

  **Files:**
  - Potentially modify: `src/lib/wrike/fetcher.ts` (if audit log API exists)
  - Potentially modify: `src/lib/flowBuilder.ts` (to use new data source)
  - Potentially create: `src/lib/wrike/auditLog.ts` (if warranting separate module)

  **Approach:**
  - Check Wrike API v4 docs for `/tasks/{taskId}/audit_log`, `/tasks/{taskId}/history`, or similar endpoints
  - If available: make a test call for a known task and inspect the response format
  - If it returns status change events with timestamps: implement a parser and add it as a third transition source in `mergeTransitions()` or alongside it
  - If not available: document that the system depends on comments + webhooks. Focus on ensuring the synthetic fallback (Unit 1) provides sufficient visibility, and improve the comment parser's logging to surface regex mismatches

  **Test scenarios:**
  - Happy path: Audit log returns status changes → new parser extracts transitions matching `StageTransition` shape
  - Happy path: Audit log unavailable → graceful fallback to existing comment + webhook sources
  - Integration: Audit log transitions merge correctly with existing webhook/comment data (dedup within 5-min window)

  **Verification:**
  - After implementation, tickets have multiple populated stage columns (full history, not just current stage)
  - Or: documented finding that audit log is not available, with next-steps recommendation

## System-Wide Impact

- **Interaction graph:** Unit 1 modifies `buildTicketFlow()` which is called by `buildFlowSnapshot()` and `patchFlowSnapshotForTask()`. Both callers benefit from guaranteed StageDurations. `computeFlowMetrics()` reads `stageDurations` for flow efficiency, bottleneck, and dwell time — all improve with the guaranteed current-stage entry. `buildDailyFlow()` reads `transitions` (not `stageDurations`) — unaffected by the StageDuration injection, but the synthetic transition already handles this case.
- **Error propagation:** The injected StageDuration uses the same `now` reference already passed to `buildTicketFlow()`. No new external calls. Cannot fail independently. The frontend fallback (Unit 2) uses data already on the ticket object.
- **State lifecycle risks:** Unit 1 changes the `TicketFlowEntry` shape (new `currentStageEnteredAt` field). Old snapshots in Redis won't have it. Frontend Unit 2 handles `undefined` gracefully. After one sync, all snapshots will have the field.
- **API surface parity:** The `/api/flow` response shape changes (new field + guaranteed StageDuration entries). No external consumers — only the dashboard frontend reads this.
- **Integration coverage:** The Flow Details page's `AgingWipChart`, `CumulativeFlowDiagram`, `FlowKPICards` all read from `FlowMetrics` which is computed from `stageDurations`. Unit 1's backend fix ensures these metrics have data, not just the table.
- **Unchanged invariants:**
  - `buildWeeklySnapshot()` and `fetchWeeklyMemberData()` — completely unaffected (different pipeline)
  - Pipeline distribution bar — reads `currentStage`, unaffected (but verified during Unit 3)
  - Webhook processing — unaffected
  - Sync guard and empty-snapshot protection — unaffected
  - `mergeTransitions()` — unaffected (StageDuration injection happens after transition merging)

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Old Redis snapshots lack `currentStageEnteredAt` field | Frontend treats undefined as null — same fallback behavior. Fresh sync rebuilds with new field. |
| Wrike audit log API doesn't exist or requires higher plan | Unit 4 is investigative — no code deployed until viability confirmed. Fallback: improve comment parser logging. |
| "Sync Now" doesn't trigger due to stuck sync guard | Check `sync/health` endpoint. If guard is stuck, it auto-expires after 5 minutes (P1 fix). |
| Comment parser regex still matches nothing | Unit 1 makes current stage visible regardless. Unit 4 investigates alternative source. |

## Sources & References

- **Related plans:** `docs/plans/2026-04-16-008-fix-dashboard-empty-status-dates-plan.md` (comment lookback fix)
- **Related plans:** `docs/plans/2026-04-16-001-fix-wrike-webhook-suspension-plan.md` (webhook reliability)
- **Related code:** `src/lib/flowBuilder.ts`, `src/components/TicketFlowTable.tsx`, `src/lib/wrike/fetcher.ts`
- **Related PRs:** #17 (comment lookback), #15 (per-task resync), #13 (sync guard rails)
