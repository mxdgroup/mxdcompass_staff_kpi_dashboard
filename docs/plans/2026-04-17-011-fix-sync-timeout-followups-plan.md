---
title: "fix: Sync timeout optimization follow-ups (validate, audit, partial-UI)"
type: fix
status: active
date: 2026-04-17
origin: docs/plans/2026-04-16-010-fix-sync-timeout-optimization-plan.md
related_pr: "#20"
---

# fix: Sync timeout optimization follow-ups

## Overview

PR #20 shipped the core sync-timeout optimization (Units 2, 2.5, 6, 7, 8 of the origin plan). This follow-up plan closes the three outstanding gaps from that work:

1. **Unit 5 — timing validation.** Verify the shipped design actually fits under Vercel's 300s cap on live data, and establish the tripwire for the deferred batch/concurrent units.
2. **Unit 9 — UI audit for the 90-day completed-task cutoff.** Catch any dashboard surface that silently assumed longer retention and either constrain the view or tune the cutoff.
3. **Unit 10 — partial-sync state visible in the dashboard UI.** Make catchup soft-deadline hits and partial-sync errors explicit to users instead of hidden in Vercel logs.

Plus one small telemetry follow-up (Unit 5b) that falls out of Unit 5.

These are small, independent units — none blocks the others. They can ship separately or bundled.

## Problem Frame

PR #20's shipped changes were aggressive: parallel member/client loops, a shared Promise-valued folder cache, a 90-day completed-task cutoff, active-first ordering inside the per-task fallback loop, and a catchup soft deadline. Most of this was validated against unit tests and a code review, but three categories of risk remain:

- **Unmeasured in production.** The 180s target is an estimate. Only live cron data will confirm whether the design fits the 300s budget with margin, or whether Unit 5's tripwire fires and we need to activate the deferred Units 1A/1B/3.
- **Product-contract breakage.** The 90-day cutoff is a product decision about what the dashboard represents. If any view silently assumed 180-day or annual comparisons, those views now show truncated data with no user indicator.
- **Silent partial state.** The catchup soft deadline, member errors, and flow folder errors all already flow through to logs and Slack. Dashboard users don't see them. A "last synced 5 minutes ago" timestamp can be simultaneously technically true and substantively misleading.

## Requirements Trace

- F1. Three consecutive cron runs complete with `deadlineReached: false` on catchup (satisfies R1 from the origin plan).
- F2. Sync duration stays under 180s (50% safety margin under 300s) on the measurement runs.
- F3. Every dashboard surface that reads completed-task data is explicitly documented as either (a) safe under the 90-day window or (b) constrained with visible UI copy or (c) motivating a tuned cutoff.
- F4. Users can see, from the dashboard header alone, whether the last sync was full, catchup-partial, or had member/folder errors — without consulting logs.
- F5. The null-`completedDate` migration-artifact population is quantified, and the conservative-include policy is either confirmed safe or replaced.

## Scope Boundaries

- **In scope:** Measurement, audit, a small UI addition, and a conditional code change if Unit 5b's telemetry says the null-`completedDate` policy needs revising.
- **Not in scope:** The deferred Units 1A/1B/3 (batch/concurrent fetch + throttle reduction). Those only activate if Unit 5's tripwire fires. They remain documented in the origin plan.
- **Not in scope:** Any change to the 90-day constant itself unless Unit 9 surfaces a concrete view that needs it. Tuning the constant is a downstream product decision, not a default action of this plan.
- **Not in scope:** A true partial-snapshot save (the two-phase save explicitly rejected in Unit 2.5). Unit 10 is purely a UI visibility unit — it makes partial state visible, it does not make more partial state survive.

## Relevant Code and Patterns

- `src/lib/wrike/fetcher.ts` — `isCompletedBeyondCutoff()`, null-`completedDate` log line, per-task fallback loop
- `src/lib/wrike/dateCatchup.ts` — `CatchupResult.deadlineReached`, `foldersProcessed`, `foldersTotal`
- `src/app/api/cron/sync/route.ts` — response payload including `dateCatchup` field and Slack notification
- `src/lib/syncRunner.ts` — `SyncResult` shape (membersProcessed, memberErrors, flowTickets, flowFolderErrors, saveErrors)
- `src/lib/types.ts` — `WeeklySnapshot` and `FlowSnapshot` shapes (for Unit 10 if a new field is needed)
- `src/lib/config.ts` — `COMPLETED_TASK_CUTOFF_DAYS`
- Dashboard header / shell component — location of the "last synced at" indicator (to be identified in Unit 10)

## Implementation Units

- [ ] **Unit 5: End-to-end timing validation**

  **Goal:** Confirm the shipped sync fits the 300s budget with margin on live data, and establish whether the deferred batch/concurrent units need to activate.

  **Requirements:** F1, F2

  **Dependencies:** PR #20 deployed to production

  **Files:**
  - No code changes

  **Approach:**
  - Trigger a live sync via `/api/sync/trigger` after PR #20 lands in production
  - Capture total duration, per-branch timing (if available in logs), Wrike request count, and the response payload's `dateCatchup` block
  - Monitor the next three scheduled cron runs. Record `duration`, `deadlineReached`, `foldersProcessed`/`foldersTotal`, `memberErrors.length`, and `flowFolderErrors` for each
  - Compare snapshot contents (task counts, comment counts, flow metrics) against the last pre-PR-#20 snapshot for correctness within the 90-day window
  - Record the one-time-per-sync count of null-`completedDate` completed tasks from the log line — feeds Unit 5b

  **Test expectation:** Manual validation, no automated test

  **Verification:**
  - F1: three consecutive crons with `deadlineReached: false`
  - F2: median sync duration < 180s
  - Snapshot data matches pre-PR-#20 output within the 90-day window
  - No Wrike 429s
  - If any of the above fails: open a follow-up work item to activate Units 1B (concurrent fetch + throttle reduction) and 3 (fetcher refactor) from the origin plan

- [ ] **Unit 5b: Null-completedDate telemetry and policy check**

  **Goal:** Quantify the Feb–early-Mar 2026 migration-artifact population and confirm or replace Unit 2.5's conservative-include policy.

  **Requirements:** F5

  **Dependencies:** Unit 5 (collect counts during the same measurement runs)

  **Files:**
  - No code changes initially — read existing log line
  - Conditional modify: `src/lib/wrike/fetcher.ts` — switch `isCompletedBeyondCutoff` to use `updatedDate` as a surrogate when `completedDate` is null, if Unit 5's counts are large or trending up

  **Approach:**
  - From the next ~10 sync runs' logs, tabulate the null-`completedDate` count
  - If stable and small (< ~50 per sync): write a project-memory entry confirming conservative-include is safe; no code change
  - If large or growing: implement the `updatedDate` surrogate, add a test scenario in `src/lib/wrike/__tests__/fetcher.test.ts`, and re-run Unit 5 to confirm correctness

  **Test scenarios (only if code change is triggered):**
  - Happy path: completed task with null `completedDate` and `updatedDate` 95 days ago is excluded
  - Happy path: completed task with null `completedDate` and `updatedDate` 89 days ago is included
  - Edge case: completed task with null `completedDate` and null `updatedDate` — documented fallback (likely: include with a distinct log line)

  **Verification:**
  - Clear, written decision: conservative-include confirmed OR surrogate implemented with new tests passing

- [ ] **Unit 9: UI audit for the 90-day completed-task cutoff**

  **Goal:** Produce a written audit of every dashboard surface that reads completed-task history, with a decision per surface: safe under 90 days, constrained with UI copy, or motivating a cutoff tuning.

  **Requirements:** F3

  **Dependencies:** None — can run in parallel with Unit 5

  **Files:**
  - Read: `src/app/**/*.tsx`, `src/components/**/*.tsx`, any KPI / flow / weekly / comparison views
  - Possible modify: the specific view(s) that need constraint copy or a range guard
  - Possible modify: `src/lib/config.ts` if the audit motivates a tuned value (requires KPI-owner sign-off)

  **Approach:**
  - Enumerate completed-task readers. For each, determine the assumed retention window (literal days, "this quarter", "YTD", "all-time", etc.)
  - For each reader, mark: (a) safe under 90 days, (b) needs visible boundary copy, or (c) needs a tuned cutoff
  - For (b): add UI copy at the reader's surface. Suggested pattern: a tooltip or subtitle saying "Showing completed tasks from the last 90 days"
  - For (c): open a discussion with the KPI-reporting owner before tuning `COMPLETED_TASK_CUTOFF_DAYS`; if tuned, re-run Unit 5 to confirm the larger payload still fits the budget

  **Test scenarios:**
  - Each reader has a decision recorded in the audit output
  - Any UI copy added renders correctly in the affected view (visual check)
  - If the cutoff is tuned, Unit 5 re-run confirms the budget still holds

  **Verification:**
  - Zero readers silently assume data that is now dropped
  - Audit document committed in `docs/audits/` or appended to the origin plan as a reference

- [ ] **Unit 10: Partial-sync state visible in dashboard UI**

  **Goal:** Show dashboard users when the last sync hit the catchup soft deadline, had member errors, or had flow-folder errors — so they can distinguish a full success from a partial one without reading Vercel logs.

  **Requirements:** F4, R5 observability leg

  **Dependencies:** None — the needed signals already exist in the sync result payload

  **Files:**
  - Possible modify: `src/lib/types.ts` — add `syncHealth: "ok" | "catchup_partial" | "has_errors"` to the saved snapshot, with a nested `syncDetails: { catchupDeadlineReached, memberErrors[], flowFolderErrors[] }` (only if a separate Redis-backed health key is rejected as a location)
  - Modify: `src/lib/syncRunner.ts` and `src/app/api/cron/sync/route.ts` — populate the new field at save time
  - Modify: whatever component renders "last synced at" in the dashboard shell (to be identified)
  - Possible add: a new component for the partial-sync badge / tooltip

  **Approach:**
  - Locate the current "last synced at" indicator (grep for timestamp display in the shell component)
  - Decide signal location: snapshot (preferred — survives reload) vs. a separate Redis key (simpler but decoupled from snapshot data)
  - Populate `syncHealth` from `deadlineReached`, `memberErrors.length`, and `flowFolderErrors` at the cron-route and `syncRunner` return sites
  - Render near the timestamp: green badge for `ok`, yellow badge for `catchup_partial` with tooltip naming the deadline, orange badge for `has_errors` with tooltip naming the affected members/folders
  - Copy should tell the user what's stale, not just that something happened. Examples:
    - "Last sync: catchup incomplete — some dates may be stale"
    - "Last sync: 1 member failed — [name] not included"
    - "Last sync: 1 flow folder failed — [name] not included"

  **Patterns to follow:**
  - Existing snapshot shape and save path in `src/lib/storage.ts`
  - Existing dashboard shell component (identify during implementation)

  **Test scenarios:**
  - Happy path: full sync → green badge, timestamp shown normally
  - Partial: `deadlineReached: true` → yellow badge, tooltip names the deadline and `foldersProcessed`/`foldersTotal`
  - Partial: `memberErrors.length > 0` → orange badge, tooltip names the affected member(s)
  - Partial: `flowFolderErrors.length > 0` → orange badge, tooltip names the affected client folder(s)
  - Edge case: multiple signals present → badge shows the more severe one (errors > catchup-partial); tooltip lists all
  - Accessibility: badge has `aria-label` matching the tooltip text

  **Verification:**
  - No user sees a stale snapshot without a visible partial-state indicator
  - Operators can triage the common partial-state cases from the UI alone
  - The badge renders correctly on initial load and after a manual `/api/sync/trigger` call

## Sequencing

- Unit 5 is the highest-priority runtime risk. Start here.
- Unit 5b starts while Unit 5 runs (collect counts from the same runs).
- Unit 9 can start in parallel with Unit 5 — it's a pure audit with no runtime dependency.
- Unit 10 can start in parallel with Unit 5 — it reads signals that already exist.
- Ship order can be independent: one PR per unit is fine, or Units 9 + 10 can bundle if both touch dashboard code.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Unit 5 reveals shipped design is insufficient | Documented escalation path: activate Units 1B and 3 from the origin plan. Their files and approaches are already enumerated there. |
| Unit 9 finds a view that legitimately needs > 90 days | Tune `COMPLETED_TASK_CUTOFF_DAYS` after KPI-owner sign-off; re-run Unit 5 with the larger payload to confirm budget holds. |
| Unit 10 surfaces partial state but users ignore it | Badge copy names what's stale, not just that something happened. If ignored, the next escalation is a dashboard-level blocking modal — out of scope for this plan. |
| Null-`completedDate` population is larger than expected | Unit 5b's surrogate switch has a complete test plan above; implement if triggered. |
| Follow-ups drift and never ship | Track in the project's normal issue system. Each unit is small enough to ship in a single PR; no unit exceeds ~half a day of work. |

## Sources & References

- Origin plan: `docs/plans/2026-04-16-010-fix-sync-timeout-optimization-plan.md`
- Related PR: #20 (shipped)
- Memory: `project_wrike_data_migration.md` — null-`completedDate` migration artifact
- Memory: `project_sync_task_ordering.md` — active-first design rule
