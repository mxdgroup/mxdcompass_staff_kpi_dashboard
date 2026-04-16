---
title: "fix: Repair date-setting webhook coverage and reliability"
type: fix
status: active
date: 2026-04-16
---

# fix: Repair date-setting webhook coverage and reliability

## Overview

The webhook-driven date automation (`applyDateForStatusChange`) had multiple issues causing dates not to be set across the Wrike task list. This plan covers the investigation and fixes applied.

## Problem Frame

Users expect that moving any Wrike task to Planned/In Progress sets a start date, and moving to In Review/Client Pending/Completed sets an end date. Dates were being missed because: (a) "Client Pending" wasn't wired as a due-date trigger, (b) "New" was incorrectly triggering start dates, (c) due dates were being overwritten on re-entry instead of being idempotent, (d) `after()` could silently drop date writes, and (e) there was no fallback for missed webhook events.

## Requirements Trace

- R1. "Client Pending" status must trigger end-date logic (same as In Review/Completed)
- R2. "New" status must NOT trigger start-date logic (only Planned/In Progress)
- R3. Both start and due dates are idempotent — never overwrite existing dates
- R4. A cron-based catch-up must backfill missing dates for tasks in trigger statuses
- R5. Recurring MxD task integration — deferred (not relevant right now per user)

## Scope Boundaries

- NOT fixing the NX secret bug or dedup atomicity (covered by existing plan 004)
- NOT changing webhook registration scope (already account-level)
- NOT modifying transition storage (already synchronous)
- NOT moving date writes from `after()` to synchronous (risk of webhook timeout on bulk moves; cron catch-up provides reliability backstop)
- NOT integrating with Wrike recurring tasks (deferred)

## Context & Research

### Relevant Code and Patterns

- `src/lib/wrike/dateWriter.ts` — `applyDateForStatusChange()` contains all date logic
- `src/app/api/webhook/wrike/route.ts` — webhook handler, date writes in `after()`
- `src/lib/wrike/fetcher.ts` — `resolveWorkflowStatuses()` resolves status names to IDs
- `src/lib/config.ts` — status name configuration; `clientPendingStatusName` was already defined but unused by date writer
- `src/app/api/cron/sync/route.ts` — existing 3x-daily cron job, now includes date catch-up

### Institutional Learnings

- P7: `after()` is fire-and-forget on Vercel — events can be permanently lost
- P11: Dedup key ignores timestamp, can drop legitimate repeat transitions
- The date writer had zero catch-up capability; relied entirely on webhook delivery

## Key Technical Decisions

- **Add "Client Pending" as a due-date trigger**: Resolve all matching IDs across workflows (same multi-workflow pattern as In Review)
- **Exclude "New" from start triggers**: `plannedIds` includes New for the flow dashboard, but only Planned/In Progress should set start dates. Filter at the date-writer level.
- **Make due dates idempotent**: Never overwrite an existing due date — same guard as start dates. Per spec requirement.
- **Cron catch-up instead of synchronous writes**: Moving date writes synchronous risks webhook timeout on bulk status changes (20 tasks = 44s+ of API calls). The cron catch-up (3x daily) provides a reliability backstop without risking webhook suspension.

## Open Questions

### Resolved During Planning

- **Is the webhook scope correct?** Yes — account-level, no folder filtering. All tasks are eligible.
- **Does "Pending Clients" = "Client Pending"?** Yes — `flowBuilder.ts:55-56` normalizes both.
- **Should due dates overwrite?** No — idempotent per spec. Only set when empty.
- **Should "New" trigger start dates?** No — only Planned and In Progress.
- **Recurring MxD tasks?** Deferred — no existing code in this repo; not relevant right now.

### Deferred to Implementation

- **How many tasks currently have missing dates?** Will be visible once catch-up runs — logged on first execution.

## Implementation Units

- [x] **Unit 1: Add "Client Pending" as due trigger + exclude "New" from start triggers + idempotent due dates**

**Goal:** Fix the three logic gaps in `applyDateForStatusChange()`

**Requirements:** R1, R2, R3

**Dependencies:** None

**Files:**
- Modify: `src/lib/wrike/dateWriter.ts`

**Changes made:**
- Resolved `clientPendingStatusName` across all workflows (same pattern as `allInReviewIds`)
- Added `allClientPendingIds` to the `isDueTrigger` condition
- Filtered `plannedIds` to exclude statuses named "New" when building `startTriggerIds`
- Added `hasDue` guard before due-date write path (same pattern as `hasStart` guard)

**Verification:**
- TypeScript compiles clean
- `TaskStatusChanged` events for Client Pending now trigger due-date writes
- Tasks in "New" status no longer get start dates
- Tasks with existing due dates are not overwritten

---

- [x] **Unit 2: Add cron-based date catch-up**

**Goal:** Backfill missing dates for tasks already in trigger statuses

**Requirements:** R4, R3

**Dependencies:** Unit 1

**Files:**
- Create: `src/lib/wrike/dateCatchup.ts`
- Modify: `src/app/api/cron/sync/route.ts`

**Changes made:**
- New `catchUpMissingDates()` function that scans all configured client folders
- Checks each task's `customStatusId` against the same trigger sets as dateWriter
- Respects all idempotency guards (skip if dates already exist)
- Integrated into cron sync route — runs after snapshot builds
- Results included in sync response JSON for observability

**Verification:**
- TypeScript compiles clean
- Cron response includes `dateCatchup` field with scan/backfill counts

## System-Wide Impact

- **Interaction graph:** Date writer called from webhook (real-time) and cron (catch-up). Both share status resolution logic.
- **Error propagation:** Webhook date write failures logged but don't affect 200 response. Cron catch-up failures logged per-task, don't block other sync operations.
- **API surface parity:** Both entry points use the same trigger sets — adding Client Pending covers both.
- **Unchanged invariants:** Transition storage, KPI aggregation, flow visualization, webhook registration/validation all unaffected.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Cron catch-up hits Wrike API rate limits | Sequential processing with existing retry/backoff in WrikeClient; partial progress is fine |
| Backfill sets "today" as date instead of actual transition date | Acceptable — webhook handles real-time cases accurately; catch-up is for missed events only |
| `after()` can still drop webhook date writes | Cron catch-up runs 3x daily as reliability backstop |

## Sources & References

- Related plans: `docs/plans/2026-04-16-001-feat-auto-set-task-dates-plan.md` (original feature)
- Related plans: `docs/plans/2026-04-16-003-fix-comprehensive-reliability-audit.md` (P7, P11 issues)
- Key code: `src/lib/wrike/dateWriter.ts`, `src/lib/wrike/dateCatchup.ts`, `src/app/api/cron/sync/route.ts`
