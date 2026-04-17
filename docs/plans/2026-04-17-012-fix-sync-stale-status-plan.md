---
title: "fix: Dashboard shows stale task status after Wrike completion"
type: fix
status: active
date: 2026-04-17
related_bug: "Task 4431857454 (Update MxD Site / Homepage) completed in Wrike at 00:21 on 2026-04-17, still shown as In Review on dashboard at 09:08 with 9.7h stage age and prior assignee."
---

# fix: Dashboard shows stale task status after Wrike completion

## Overview

The dashboard is rendering a ticket as "In Review" more than 8 hours after it was actually set to "Completed" in Wrike. The stored snapshot clearly predates the completion event, and neither the 3×/day cron nor the `TaskStatusChanged` webhook auto-sync has re-patched the ticket. This plan diagnoses the exact failure mode, recovers the stuck ticket, and hardens the sync pipeline so a single missed cron or webhook drop no longer yields a full day of stale data on a ticket that a human can see is wrong.

## Problem Frame

### Observed behavior

- Wrike activity feed for task ID `4431857454` (Wrike ID `IEAGV532...` internally) shows:
  - 16 Apr: Changed status to **In review** by Ivan Fazlic.
  - 17 Apr 00:21: Changed status to **Completed**, reassigned from Matthew Sliedrecht, scheduled for 17 Apr.
- Dashboard at 09:08 on 17 Apr renders the same ticket:
  - Stage: **In review** (orange badge).
  - Assignee: **Ivan**.
  - Current-stage age: **9.7h** (≈ 9h 42m — consistent with "time since the In Review transition entered at ~23:25 on 16 Apr").

### Why this matters

`currentStage`, `currentStageEnteredAt`, `currentStageAgeHours`, and `assigneeContactId` are all frozen at snapshot-build time (`src/lib/flowBuilder.ts:124-170`). The only ways those values change are:

1. A full `buildFlowSnapshot` run (cron at `src/app/api/cron/sync/route.ts`, or `runSync` from `src/lib/syncRunner.ts:34`).
2. A single-task patch (`patchFlowSnapshotForTask` via `syncTask`), triggered by either the webhook (`src/app/api/webhook/wrike/route.ts:97-110`) or the per-row "resync" button (`src/app/api/sync/task/route.ts`).

The displayed 9.7h age means the snapshot represents the task *before* the 00:21 Completed transition. Neither of the refresh paths has run against this task since. That is the bug.

### Top hypotheses (ranked)

| # | Hypothesis | Evidence for | Evidence against |
|---|---|---|---|
| H1 | The `TaskStatusChanged` webhook silently failed for this event. Split sub-cases: **H1a** Wrike never sent the event (webhook suspended, handshake lost); **H1b** Wrike sent it but signature validation rejected it (console-warn only, `src/app/api/webhook/wrike/route.ts:46-52`); **H1c** event was stored in Redis but `after()` `syncTask` threw (console-error only, `src/app/api/webhook/wrike/route.ts:97-110`). | Each sub-case has a different signal and different fix. H1a is only caught by the 48h stale-reactivation path in the cron route. H1b and H1c are console-only today. | Need targeted checks: (a) Vercel access log for a signed POST at ~00:21, (b) Redis `kpi:transitions:2026-W16` for a transition on task 4431857454, (c) Vercel function log for `[webhook] Auto-sync failed`. |
| H2 | No successful cron has rebuilt the snapshot since 00:21. Daily crons at 00:00, 02:20, 12:00 UTC (`vercel.json`). 00:21 UTC falls *after* the 00:00 cron but *before* 02:20. For the dashboard at 09:08 to still show the In-Review state, the **02:20 UTC cron must have failed or been skipped** (guard held, auth fail, folder fetch failed). The "9.5h gap" framing glosses this. | 9.7h stage age matches "hours since the In Review transition entered at ~23:25 on 16 Apr". If *any* post-00:21 cron had rebuilt the snapshot with the webhook-stored 00:21 Completed transition, `currentStageEnteredAt` would be 00:21 and the displayed age would be ≈8.8h, not 9.7h. The 0.9h delta is itself evidence that no post-00:21 rebuild has run OR the 00:21 transition wasn't in the merge output (points at H1/H6). | Confirm via `/api/sync/health` `lastSyncedAt` and Vercel cron history. |
| H3 | The 00:00 or 02:20 UTC cron ran but failed on the client folder containing this task. `buildFlowSnapshot` uses per-branch try/catch inside `Promise.all` (`src/lib/flowBuilder.ts:291-305`). A folder-level failure drops that folder's tickets from the rebuilt array but does NOT preserve the prior snapshot — `saveFlowSnapshot` only rejects `tickets.length === 0`; a partial snapshot writes through (`src/lib/flowStorage.ts:34`). | If the folder failed in the most-recent successful-save run, the ticket would **vanish**, not linger. It lingers as stale, so either (a) no post-00:21 cron wrote successfully (collapses into H2), or (b) the patch path wrote the stale row (collapses into H4). | H3 as originally stated is not an independent root cause; it collapses into H2 or H4 depending on the `lastSyncedAt` reading. |
| H4 | Webhook fired, `syncTask` ran, but `patchFlowSnapshotForTask` produced a wrong result. | Code reading (`src/lib/flowBuilder.ts:494-502`) shows it rebuilds the ticket via `buildTicketFlow` from the freshly-fetched `/tasks/{id}` response. Only `clientName` is reused from the existing snapshot; `currentStage`, `currentStageEnteredAt`, and `assigneeContactId` all come from the live Wrike data. So a successful patch cannot leave the ticket pre-completion — unless the patch never ran (H1c) or the Wrike fetch itself returned stale data (never observed on `/tasks/{id}`). | Low likelihood. But: if `existing.tickets` did not contain this task before the patch (first-ever webhook for a new task), `clientName` falls back to `"Unknown"`, which breaks per-client metrics aggregation. Flag as a secondary bug if Unit 1 finds `clientName: "Unknown"`. |
| H5 | The task moved to a week other than the current ISO week and the dashboard is reading the wrong week's snapshot. | `buildFlowSnapshot(getCurrentWeek())` is what runs from every sync entry point. `syncTask` resolves the week from `getFlowLatestWeek() ?? getCurrentWeek()` — on a Monday 00:00 UTC rollover this can patch last week's snapshot, but that window doesn't apply to 2026-04-17 (Friday). | Not relevant for this specific bug. Called out as a known residual issue for future work. |
| H6 | Webhook event was delivered and stored in Redis, but `mergeTransitions` dedup or `resolveStatusName` dropped the 00:21 Completed event before `buildTicketFlow` saw it (e.g., 5-min dedup window collision with the reassignment event, or the Completed-status ID wasn't recognized because the `kpi:workflow:statuses` cache was stale). | Consistent with the 9.7h observation: `lastTransition.timestamp` would be the prior 23:25 In-Review event, not the 00:21 Completed event. | Needs a direct Redis read of the transition list for this task — not covered by any existing diagnostic endpoint. |

The strongest candidates after adversarial review are **H1 (particularly H1a/H1c) and H2**, with **H6** added because the 9.7h–vs–8.8h delta implicates the merge pipeline. Each has a different fix: H1a/H1c ⇒ Unit 4 visibility; H2 ⇒ Unit 3 cadence; H6 ⇒ not in this plan's scope (would be a follow-up to fix `mergeTransitions` or `resolveStatusName`). A one-off fix for this ticket is cheap (`POST /api/sync/task`), but the systemic fix is to make "stale data because a cron or webhook dropped" no longer plausible for ≥8 hours. If Unit 1 diagnosis points at H6, Units 3–5 still ship but a new unit must be opened against the merge pipeline before calling this bug closed.

## Requirements Trace

**Diagnosis & Recovery**
- **R1.** Identify the specific failure mode behind the reported bug (task 4431857454) before prescribing any code fix. Diagnosis must distinguish H1a vs H1b vs H1c, and separate those from H2 and H6.
- **R2.** Recover the reported ticket immediately so the dashboard reflects truth.

**Hardening & Observability**
- **R3.** Reduce the maximum plausible "stale data" window from ~10 hours to ≤30 minutes under normal business-hours operation.
- **R4a.** Make webhook auto-sync failures visible instead of console-only (inside the webhook's `after()` loop).
- **R4b.** Make `/api/sync/task` failures visible to Slack in addition to the existing HTTP 500 surface.
- **R6.** Prevent `syncTask` × full-sync snapshot corruption at the new cadence (patch-path read/write must not clobber a concurrent full-rebuild's other-ticket updates).
- **R7.** Provide a diagnostic endpoint that exposes raw Redis transitions for a given task so H6-class failures (merge/resolve drop) are inspectable without Upstash console access.
- **R8.** Fix `clientName="Unknown"` fallback in `patchFlowSnapshotForTask` for tickets whose first snapshot entry arrives via webhook (new task never seen by a full cron).
- **R9.** Close the week-rollover edge in `syncTask` (H5) so a webhook fired between 00:00 UTC Monday and the first Monday cron patches the correct week's snapshot.
- **R10.** Alert on webhook staleness earlier than the existing 48h auto-reactivation threshold, so H1a failures surface as a warning rather than a silent day-plus outage.

**Constraints**
- **R5.** Preserve the existing 300s Vercel function budget and the design rules in `docs/plans/2026-04-16-010-fix-sync-timeout-optimization-plan.md`. Specifically, the intraday cadence must not push p95 cron duration closer to the ceiling than today's baseline allows.

## Scope Boundaries

- **In scope:** diagnostic gating, cron frequency, webhook auto-sync reliability, one-off recovery, patch-path race closure, week-rollover fix, `clientName` fallback fix, and a transitions debug endpoint. Schema-free changes to the existing sync routes.
- **Out of scope:** dashboard "last synced at" indicator UI (already covered by Unit 10 of `docs/plans/2026-04-17-011-fix-sync-timeout-followups-plan.md` — this plan should coordinate with that work, not duplicate it).
- **Out of scope:** rebuilding `patchFlowSnapshotForTask` beyond the targeted fixes in Units 6 and 8. We don't refactor prophylactically.
- **Out of scope:** fixing `mergeTransitions` / `resolveStatusName` pipeline bugs (H6). Unit 7 makes H6 inspectable; the fix itself is a follow-up plan if Unit 1 diagnosis confirms it.
- **Out of scope:** changing the 90-day completed cutoff or the 45-day archive threshold.
- **Out of scope:** moving off Upstash or introducing a relational store.

## Context & Research

### Relevant Code and Patterns

- `src/app/api/cron/sync/route.ts` — cron entry. Handles webhook reactivation, builds both snapshots, runs catch-up with 60s soft deadline, posts to Slack on errors. Inline `runSync()` — NOT the shared `syncRunner.runSync()`.
- `src/lib/syncRunner.ts` — shared `runSync()` (full rebuild) and `syncTask(taskId)` (single-task patch). `syncTask` in its common path does NOT acquire the sync guard. **Important caveat:** when `getFlowSnapshot(week)` returns null (fresh Redis, cold start, or week rollover), `syncTask` falls back to `runSync()`, which *does* acquire the guard — and if the guard is held, `runSync()` returns `{ ok: true, skipped: true }`. The webhook handler treats `result.ok` as success regardless of `skipped`, so a skipped fallback masquerades as a successful auto-sync in logs (see Unit 4).
- `src/lib/flowBuilder.ts:44-170` — `mergeTransitions`, `computeStageDurations`, `buildTicketFlow`. These freeze `currentStage` and `currentStageEnteredAt` at build time.
- `src/lib/flowBuilder.ts:441-548` — `patchFlowSnapshotForTask`. Live-fetches `/tasks/{id}` + comments, re-derives transitions, rebuilds the single ticket, replaces it in the existing snapshot, recomputes metrics, re-saves. Does NOT use the sync guard.
- `src/lib/wrike/fetcher.ts:360-420` — `fetchClientTasks`. Two parallel fetches: `updatedDate: wrikeDateRange(dateRange)` + `status: "Active"`. A 00:21 completion on 2026-04-17 falls inside the current ISO week (`2026-W16`, 04-13 → 04-19) so it should be in `recentTasks`. Then `isCompletedBeyondCutoff` drops completed tasks older than 90 days.
- `src/app/api/webhook/wrike/route.ts` — accepts Wrike webhook, stores transition synchronously, kicks off `syncTask(taskId)` via `after()`. Auto-sync errors land in `console.error` only; no Slack alert, no retry.
- `src/app/api/sync/health/route.ts` — read-only health endpoint. Returns `lastSyncedAt`, `webhookHealthy`, `tasksByStatus`, `tasksByClient`. First stop for diagnosis.
- `src/app/api/debug/task-lookup/route.ts` — Bearer-auth'd. Resolves a Wrike permalink to a task and dumps `status`, `dates`, `responsibleIds`, `folders`, `comments.statusChangeComments`, `diagnosis`. Second stop for diagnosis.
- `vercel.json` — three daily crons at `0 0 * * *`, `20 2 * * *`, `0 12 * * *` — all UTC.
- `src/lib/config.ts:6` — `COMPLETED_TASK_CUTOFF_DAYS = 90`.
- `src/lib/storage.ts` — `getWebhookLastEvent`, `acquireSyncGuard` (10-minute Redis TTL).
- `src/lib/flowStorage.ts` — `saveFlowSnapshot` rejects `tickets.length === 0` to preserve last good data.

### Institutional Learnings

- `docs/solutions/` does not exist in this repo. The only related institutional knowledge is in user memory:
  - Wrike comments endpoint rejects `updatedDate` — handled in `fetcher.ts:412-419`.
  - Some completed tasks have `completedDate: null` (Feb–early Mar 2026 Wrike migration). `isCompletedBeyondCutoff` conservatively *includes* those.
  - Active-tasks-first ordering and 90-day completed cutoff are hard design rules.

### External References

None needed — this is purely an internal reliability and observability fix on existing Wrike + Upstash + Vercel plumbing.

### Related Prior Work

- `docs/plans_completed/.../PR #20` (commit `55fd5d8`): 300s timeout optimization (folder comment cache, per-folder parallelism, active-first ordering, 90-day cutoff, catchup soft deadline).
- `docs/plans/2026-04-17-011-fix-sync-timeout-followups-plan.md`: **Unit 10** already covers "make partial-sync state visible in dashboard UI" — this plan coordinates with it but does not duplicate the UI work. Unit 10 is the right home for the user-facing "last synced at" badge and the freshness warning. This plan's scope ends at the API/scheduling layer.

## Key Technical Decisions

- **Diagnose before prescribing.** Unit 1 gates Units 2–5. Unit 1 must distinguish H1a/H1b/H1c/H2/H6 — if the root cause is H6 (merge-pipeline drop), Units 3–5 still ship (they're independent reliability improvements), but this bug is not considered fixed until a follow-up unit addresses the merge pipeline.
- **Raise cron frequency, don't replace the architecture.** The sync pipeline just got significant investment (PR #20). Moving to an event-stream architecture or an external queue is not warranted for a 3-cron gap. Add intraday crons instead.
- **Intraday cron cadence:** every 30 minutes, business hours only (08:00–20:30 UTC via `*/30 8-20 * * 1-5`), plus the existing 00:00 / 02:20 / 12:00 UTC daily runs. UTC-fixed — not shifted to local team time — for operational simplicity. Business-hours-only avoids burning Wrike API quota and Vercel invocations overnight. This cadence requires a Vercel plan tier that supports sub-hourly crons; verified before Unit 3 merges.
- **Webhook failure signaling goes to Slack, not a retry queue.** The webhook already writes the transition to Redis synchronously before the `after()` patch runs, so even if `syncTask` fails the transition isn't lost — the next full cron will reconcile via `mergeTransitions` (assuming H6 is not in play). What we need is visibility so a persistent webhook failure is noticed in hours, not days. Add Slack alert on `syncTask` failure (and on the `skipped: true` fallback path) inside the webhook handler, and on the per-task `/api/sync/task` endpoint.
- **Close the `syncTask` × full-sync race in-plan via CAS-style re-read (Unit 6).** At 30-min cadence the race becomes plausible during each intraday slot — accepting it as residual risk would fight Unit 3's own goal (fewer stale rows). Chosen shape: `patchFlowSnapshotForTask` re-reads the latest snapshot immediately before `saveFlowSnapshot`, merges its own `updatedTicket` into that fresh read, and writes. No new Redis keys or guard on the patch path. Rejected alternatives: (a) a dedicated patch-lock (adds another lock to reason about), (b) pessimistic full-sync guard on the patch (makes every webhook wait behind cron).
- **Proactive webhook-staleness alert at 12h (Unit 10).** The cron route already auto-reactivates at 48h (`src/app/api/cron/sync/route.ts`). We add an earlier "warning" at 12h to surface H1a well before the 48h threshold. Chosen threshold is 12h — long enough to cover a quiet weekend morning without paging, short enough that weekday webhook silence is flagged by the next intraday cron. Paired with Unit 3, this is the H1a early-warning path.
- **No schema or Redis-key changes.** The bug does not implicate storage. Unit 6's CAS re-read reuses the existing `kpi:flow:<week>` blob. Unit 10 reuses the existing `kpi:webhook:last_event` key.

## Open Questions

### Resolved During Planning

- "Does `patchFlowSnapshotForTask` correctly overwrite `currentStage` and `assigneeContactId`?" → Code reading (`src/lib/flowBuilder.ts:497-502`) confirms it rebuilds via `buildTicketFlow` from the freshly-fetched Wrike task. The only `existing.tickets`-derived field it reuses is `clientName`. If the task isn't already in the snapshot, `clientName` falls back to `"Unknown"` — which is a secondary bug for brand-new tasks, but orthogonal to this plan's scope.
- "Is the 00:21 completion inside the current-week fetch window?" → Yes. `fetchClientTasks` uses `wrikeDateRange` over `getCurrentWeek()`. 2026-04-17 is a Friday inside ISO week 2026-W16.
- "Does `tickets.length === 0` rejection matter here?" → No. The snapshot contains other tickets; `saveFlowSnapshot` only rejects if every ticket is gone. Partial-folder failures write through.
- "Does `syncTask` skip the sync guard unconditionally?" → No. Common path yes; cold-snapshot fallback takes the `runSync` guard-acquiring path. Unit 4 must handle the `result.skipped === true` case.
- "Business hours cron window: UTC-fixed or local?" → UTC-fixed. Local-shift is not worth the cron expression complexity; team is informed via plan review.

### Deferred to Implementation

- Exact Slack message format for webhook auto-sync failures — will match the existing cron-failure format in `src/app/api/cron/sync/route.ts:189-221` when implemented.
- Exact cron expression dialect validation — confirm `*/30 8-20 * * 1-5` parses via `cron-parser` locally before committing, and smoke-test first fire post-deploy.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```
Current failure mode
────────────────────
  Wrike                Webhook               Snapshot
  00:21 Completed ──▶ TaskStatusChanged ──▶ syncTask (after())  ╳ silent fail
                                                                 │
  Cron                                                           │
  00:00, 02:20, 12:00 UTC ─────────────────────▶ buildFlowSnapshot (next run: 12:00)
                                                                 │
  User views dashboard at 09:08 ─── reads last snapshot (pre-00:21) ─── shows stale "In Review"

Target after this plan
──────────────────────
  Wrike                Webhook               Snapshot
  00:21 Completed ──▶ TaskStatusChanged ──▶ syncTask (after())
                                             │  on error → Slack alert (Unit 4)
                                             ▼
                                           patchFlowSnapshotForTask
                                             │
                                             ▼
                                           CAS re-read (Unit 6) → save
                                             ▼
                                           patched within seconds
  Cron (intraday every 30m, 08:00–20:30 UTC) ────────▶ buildFlowSnapshot (Unit 3)
                                             │
                                             └─▶ webhook staleness ≥12h? → Slack warning (Unit 10)
  Cron (daily 00:00, 02:20, 12:00 UTC) ───────────────▶ buildFlowSnapshot + catchup

  Diagnostic:  GET /api/debug/transitions?taskId=… (Unit 7)
  Resilience:  syncTask pinned to getCurrentWeek() (Unit 9), clientName resolved from parentIds (Unit 8)

  Worst-case staleness under single webhook drop: ≤30 min during business hours.
  Worst-case staleness overnight: unchanged (next daily cron).
  Webhook silence surfaces in Slack at 12h instead of 48h.
```

## Implementation Units

- [ ] **Unit 1: Diagnose the specific failure — no code changes**

**Goal:** Identify which hypothesis (H1a/H1b/H1c, H2, H3-as-H2-or-H4, H4, H5, H6) caused the observed bug before writing any production code. Record findings as a new "Root Cause" appendix in this plan.

**Requirements:** R1

**Dependencies:** None

**Files:**
- No repo changes. Diagnostic output captured in the plan and/or `.context/sync-bug-diagnosis.md` if useful to share across agents.

**Approach — six targeted checks, in order:**

1. **Cron firing history (H2).** `GET /internal/kpis/api/sync/health` — record `lastSyncedAt`, `webhookHealthy`, `lastWebhookEvent`, `tasksByStatus`. Cross-check Vercel → Crons dashboard: did the 00:00 UTC and 02:20 UTC crons on 2026-04-17 each fire and complete 2xx? Any 5xx, timeout, or guard-held 409?
2. **Wrike-side ground truth.** `GET /internal/kpis/api/debug/task-lookup?permalink=https://www.wrike.com/open.htm?id=4431857454` with `Authorization: Bearer $CRON_SECRET`. (The endpoint accepts the full permalink URL; if a bare numeric form fails, use the URL.) Confirm `task.id` (the internal `IEAGV...` ID — needed for Unit 2), `status`, `dates.completed`, `responsibleIds`, `folders`, `comments.statusChangeComments`.
3. **Webhook delivery & storage (H1a/H1b/H1c).** Vercel function logs for `/internal/kpis/api/webhook/wrike`, 2026-04-17 00:15–00:30 UTC window:
   - **H1a signal:** no POST in that window at all → Wrike didn't deliver.
   - **H1b signal:** `[webhook] Signature mismatch` → the handshake secret is out of sync with what Wrike is signing with.
   - **H1c signal:** `[webhook] Auto-sync failed for task <id>` or `[webhook] Auto-sync error` → `after()` threw.
4. **Transition persistence (H6).** Confirm the 00:21 Completed transition is actually in Redis for this task. Preferred route: hit `GET /internal/kpis/api/debug/transitions?taskId=<id>` (Unit 7) once it's deployed. Stopgap while Unit 7 is in flight: open the Upstash console directly and read `kpi:transitions:2026-W16`. Look for an entry with `taskId=<internal ID>` and timestamp ≈ 00:21 UTC. If the webhook log shows delivery but Redis has no transition, `storeTransition` failed — that's a distinct fix site.
5. **Snapshot shape (H4, clientName fallback, H5 rollover).** Using Upstash console, read `kpi:flow:latest` then `kpi:flow:<that-week>`. Find the ticket for this taskId in `snapshot.tickets[]`. Record its `taskId` form (internal `IEAGV...` vs numeric), `currentStage`, `currentStageEnteredAt`, `assigneeContactId`, `clientName`. If `clientName === "Unknown"`, Unit 8 is green-lit. If the `taskId` form is numeric, Unit 2's recovery must use the numeric form to avoid a duplicate row.
6. **Timezone sanity.** The Wrike activity feed renders "Today 00:21" in the viewer's locale. Confirm whether that timestamp is UTC or Shanghai local (UTC+8). If Shanghai local, 00:21 local = 16:21 UTC on 2026-04-16 — which means both the 00:00 and 02:20 UTC crons on 2026-04-17 fired AFTER the completion and the root cause narrows dramatically to H1/H6 (not H2).

**Classification matrix — maps findings to which subsequent units are green-lit:**

| Finding | Units 2–5 (base) | Units 6–10 | Extra follow-up? |
|---|---|---|---|
| H1a only (Wrike didn't deliver) | GREEN — Unit 3 closes gap, Unit 4 adds visibility | Unit 10 CRITICAL (earlier staleness alert) | — |
| H1b only (signature mismatch) | GREEN — Unit 4 CRITICAL (surfaces mismatch) | Unit 10 HELPFUL | — |
| H1c only (`after()` threw) | GREEN — Unit 4 CRITICAL (exact fix) | Unit 10 HELPFUL | — |
| H2 only (02:20 cron failed) | GREEN — Unit 3 CRITICAL | Unit 10 HELPFUL | Investigate why 02:20 cron failed |
| H4 confirmed (patch produced wrong result) | GREEN — Unit 2 validates patch path | Unit 8 CRITICAL if `clientName` cause; otherwise new unit | Dedicated `patchFlowSnapshotForTask` fix if neither Unit 6 nor 8 covers |
| H5 (week rollover) | GREEN | Unit 9 CRITICAL (pin to `getCurrentWeek()`) | — |
| H6 (merge/resolve drop) | GREEN — Unit 7 makes raw transitions inspectable | Unit 6 helps (prevents patch clobber from hiding the drop) | Follow-up plan against `mergeTransitions` / `resolveStatusName` |

**Patterns to follow:**
- Existing diagnostic endpoints as documented in `src/app/api/debug/task-lookup/route.ts` and `src/app/api/sync/health/route.ts`. No new endpoints unless Check 4 requires an `/api/debug/transitions` route.

**Test scenarios:**
- *Test expectation: none — this unit is a diagnostic pass, no production code changes.*

**Verification:**
- A "Root Cause" appendix is added to this plan naming exactly one of H1a / H1b / H1c / H2 / H4 / H5 / H6 (or a combination). Units 2–10 are green-lit or adjusted using the matrix above. If Check 4 can't be answered via the Upstash console, expedite Unit 7 (transitions endpoint) before continuing.

- [ ] **Unit 2: Recover the reported ticket**

**Goal:** Force-patch task `4431857454` so the dashboard immediately reflects its Completed status and correct assignee. Also validates that the patch path is healthy end-to-end.

**Requirements:** R2

**Dependencies:** Unit 1 (we want to diagnose before we "fix" the symptom — if the patch path itself is broken, we need to know).

**Files:**
- No repo changes. Uses existing endpoint.

**Approach:**
- Use the `task.id` from Unit 1 Check 2. Pass the form that matches what's stored in `existing.tickets[*].taskId` (confirmed in Unit 1 Check 5). If the stored form is the internal `IEAGV...` ID but the call uses the numeric permalink (or vice versa), `patchFlowSnapshotForTask`'s `filter((t) => t.taskId !== taskId)` at `src/lib/flowBuilder.ts:501` won't dedupe and you'll end up with two rows for the same task.
- `POST /internal/kpis/api/sync/task` with body `{"taskId":"<matching-form>"}`.
- If the response is `{ok:true}` the dashboard is correct on refresh. If the response is `{ok:true, skipped:true}` (the webhook-path fallback), a concurrent full sync is in flight — re-try after 5 minutes. If the response is an error, capture the message as a direct lead on the underlying bug.

**Patterns to follow:**
- The per-row "resync" button at `src/components/TicketFlowTable.tsx:311-339` already does exactly this call — follow that exact request shape.

**Test scenarios:**
- *Test expectation: none — this is an operational recovery step against production, not a code change.*

**Verification:**
- The dashboard row for task 4431857454 renders as **Completed** on the next page load.
- If the call succeeds but the row still shows In Review, we've found a real bug in the patch path — stop, open a new unit, and do not proceed to Units 3–5 until it's understood.

- [ ] **Unit 3: Add intraday cron slots to close the 9.5h gap**

**Goal:** Ensure a full sync runs at least every 30 minutes during business hours so a single webhook drop cannot produce >30 min of stale data on a weekday.

**Requirements:** R3, R5

**Dependencies:** Unit 1 (if diagnosis shows the 02:20 cron has been reliably failing for a platform reason, frequency won't fix that). Also gated on: (a) confirming the Vercel plan tier supports sub-hourly crons, (b) measuring current p95 cron duration from the last 7 days of Vercel logs — if p95 > ~180s, drop to hourly (`0 8-20 * * 1-5`) as a stated fallback. 1-hour staleness is still a ~10× improvement.

**Files:**
- Modify: `vercel.json`
- Modify: `src/app/api/sync/health/route.ts` — update the hardcoded `cronSchedule` string.
- Consider: `src/app/api/cron/sync/route.ts` — see "Intraday catchup" decision below.

**Approach:**
- Keep the existing three daily crons (`0 0`, `20 2`, `0 12`) — they carry the webhook-reactivation health check and the nightly catchup pass.
- Add intraday crons every 30 minutes from 08:00–20:30 UTC. Concretely: `*/30 8-20 * * 1-5` (fires at :00 and :30 for hours 08 through 20 inclusive, Mon–Fri). Pre-validate via `cron-parser` locally before merging.
- **Intraday catchup decision:** `catchUpMissingDates` makes Wrike PUT writes and today runs on every cron. Moving from 3 daily to ~28 weekday runs multiplies Wrike write volume by ~9×. Skip catchup on intraday runs via a query-string or environment signal (e.g., add `?catchup=skip` to the intraday cron paths in `vercel.json`, and have `runSync` in the cron route branch on it). Nightly runs keep full catchup.
- The cron route already acquires the sync guard, so overlapping triggers skip with a 409. Guard TTL is 600s — consider trimming to ~320s (maxDuration + small margin) now that crons run every 30m; a stuck lock at the old TTL blocks up to 20 min of cron invocations.
- Cron-count math: `*/30 8-20 * * 1-5` = 26 fires/day × 5 = 130/week, plus 21 nightly = **151/week** total cron invocations.

**Execution note:** Pre-merge check — run `*/30 8-20 * * 1-5` through `cron-parser` locally and confirm the next 5 fire times match expectations. Post-deploy — trigger one manual `/api/cron/sync` invocation immediately, then watch for the first scheduled intraday fire within 30 minutes.

**Patterns to follow:**
- Existing `vercel.json` cron structure.
- `acquireSyncGuard` overlap protection in `src/app/api/cron/sync/route.ts:75-91`.

**Test scenarios:**
- Happy path: At a scheduled intraday time, the cron invokes `/internal/kpis/api/cron/sync`, `runSync()` completes, `lastSyncedAt` advances.
- Integration: Overlapping cron triggers — first takes the guard, second returns 409 cleanly, no double-run. Existing `acquireSyncGuard` behavior must not regress.
- Edge case: The intraday cron fires with `?catchup=skip` — `catchUpMissingDates` is NOT called. `lastSyncedAt` still advances. Wrike write count unchanged from pre-intraday baseline.
- Edge case: Outside business hours — no intraday crons fire. The 00:00 / 02:20 / 12:00 UTC runs are unaffected and still run full catchup.
- Error path: Wrike API returns 429 during an intraday run. The cron fails or saves partial — rollback trigger (see Risks) kicks in if 429 rate exceeds threshold.

**Verification:**
- `/internal/kpis/api/sync/health` `lastSyncedAt` advances at least every 30 minutes during 08:00–20:30 UTC on weekdays after deploy.
- No net-new 5xx errors on the cron route in the 72 hours following deploy (not 24).
- Wrike 429 rate does not increase compared to the 7-day baseline before deploy.
- Slack "guard-held" skip alerts do not spike above ~2/day baseline.

- [ ] **Unit 4: Surface webhook auto-sync failures to Slack**

**Goal:** When the webhook's `after()` auto-sync fails, send a Slack alert instead of only writing to `console.error`. Makes persistent webhook drops visible within minutes instead of days.

**Requirements:** R4a

**Dependencies:** Confirm `NOTIFICATION_WEBHOOK_URL` is set in the Vercel environment (the cron route already uses it — confirm before shipping, don't assume).

**Files:**
- Modify: `src/app/api/webhook/wrike/route.ts` (wrap `syncTask` failure in a Slack notify using `NOTIFICATION_WEBHOOK_URL`; also distinguish `skipped: true` from success)
- Modify: `src/app/api/webhook/wrike/route.ts` — add Slack notify on `[webhook] Signature mismatch` with a per-5-min rate limiter (Redis INCR with TTL) to catch H1b without alert storms.
- Optionally modify: `src/lib/syncRunner.ts` if it's cleaner to emit from inside `syncTask` and keep the route handler thin.
- Test: `src/app/api/webhook/wrike/route.test.ts` (create if no test file exists for this route; otherwise add cases).

**Approach:**
- In the webhook's `after()` auto-sync loop:
  - On `result.ok && result.skipped === true` — the fallback runSync path found the guard held. Log `[webhook] Auto-sync skipped (sync in progress) for task <id>` and do NOT claim success. No Slack (expected during concurrent cron).
  - On `result.ok === false` or caught error — best-effort `fetch(NOTIFICATION_WEBHOOK_URL, …)` with a message including `taskId`, the transition `from → to`, and the error message. Reuse the `fetch(url, ...).catch(() => {})` pattern from `src/app/api/cron/sync/route.ts:47-54`.
  - On `result.ok === true && !skipped` — keep the existing `[webhook] Auto-synced task <id>` log, no Slack.
- On signature-mismatch (`src/app/api/webhook/wrike/route.ts:46-52`), use a Redis INCR key `alert:webhook:sigmismatch:<minute-bucket>` with TTL 300s. If count ≤ 1 in the bucket, post a Slack alert. This keeps H1b visible without storming Slack if Wrike rotates a secret and fires hundreds of invalid signatures.
- Do not retry inside the webhook handler. The transition is already persisted to Redis synchronously before `after()` runs, and the next full cron reconciles. The goal is visibility, not recovery.
- Keep the existing `console.error` and `console.warn` lines — they're useful in Vercel logs even with Slack present.

**Patterns to follow:**
- Slack notify call shape at `src/app/api/cron/sync/route.ts:47-54` and `:172-181`. Same payload format: `{ text: "..." }`.
- Best-effort error handling — never let Slack failure break a webhook response.

**Test scenarios:**
- Happy path: Webhook fires, `syncTask` returns `{ok:true}` (not skipped), no Slack call is made. `[webhook] Auto-synced task {id}` logged.
- Happy path (skipped): `syncTask` returns `{ok:true, skipped:true}` (runSync fallback + guard held). A distinct log line fires (`[webhook] Auto-sync skipped (sync in progress) for task {id}`). No Slack.
- Error path: `syncTask` returns `{ok:false, error:"Wrike 401 unauthorized"}`. A Slack POST is made with a message containing the task ID and the error. The webhook still returns 200 to Wrike.
- Error path: `syncTask` throws. The catch block posts to Slack and logs. Webhook response unaffected.
- Error path: `NOTIFICATION_WEBHOOK_URL` is unset. No Slack call attempted. `console.error` still runs.
- Error path: Signature mismatch with empty rate-limit bucket. Slack POST fires once. Second signature mismatch within 5 min — Redis INCR > 1, no Slack. Third mismatch after TTL expiry — Slack fires again.
- Edge case: `NOTIFICATION_WEBHOOK_URL` is set but Slack is down (fetch rejects). The `.catch(() => {})` swallows it; the handler completes normally.
- Edge case: Redis INCR fails (Upstash outage). Signature-mismatch Slack alert still fires (fail-open on rate limiter — prefer noise to silence on a signature issue).

**Verification:**
- A synthetic failing task ID fed to `syncTask` (e.g., a non-existent Wrike ID that triggers 404) produces a Slack message and a console log.
- No change to webhook response time for the happy path.

- [ ] **Unit 5: Extend the same Slack signal to `/api/sync/task`**

**Goal:** The manual per-row "resync" button and any future direct callers get the same failure visibility as the webhook auto-sync path. Unit 4 covers the common case; this closes the loophole where an on-demand recovery silently fails and the user doesn't notice the error toast.

**Requirements:** R4b

**Dependencies:** Unit 4 (keep the Slack notify shape consistent). Same `NOTIFICATION_WEBHOOK_URL` env dependency.

**Files:**
- Modify: `src/app/api/sync/task/route.ts` — on `!result.ok`, best-effort Slack notify before returning 500.
- Consider: extracting the Slack-notify helper used in Units 4 and 5 into `src/lib/notify.ts` rather than duplicating. Only extract if it's called from 3+ places after this plan lands — otherwise two inlined calls are fine per the project's preference for removing premature abstractions.
- Test: `src/app/api/sync/task/route.test.ts` (create or extend).

**Approach:**
- Same Slack payload shape as Unit 4: `{ text: "KPI syncTask failed: task=<id> error=<msg>" }`.
- Best-effort fetch. Don't let Slack errors change the HTTP response to the client.
- The `/api/sync/task` endpoint returns 500 to the caller on failure; that already shows a red toast in the UI (`src/components/TicketFlowTable.tsx` resync handler). Slack is additive.

**Patterns to follow:**
- Whatever emerged in Unit 4.

**Test scenarios:**
- Happy path: `syncTask` returns ok, HTTP 200, no Slack notify.
- Error path: `syncTask` returns `{ok:false, error:"..."}`, HTTP 500, Slack message sent, UI toast shown.
- Edge case: Slack unreachable → still HTTP 500, no thrown error.

**Verification:**
- Manually triggering a failing resync produces both an error toast in the UI and a Slack message.

- [ ] **Unit 6: Close the `syncTask` × full-sync race via CAS re-read**

**Goal:** Prevent `patchFlowSnapshotForTask` from clobbering other tickets' updates when a full `runSync` commits between the patch path's read and write. At Unit 3's 30-minute cadence plus webhook traffic, the race becomes plausible during each intraday slot.

**Requirements:** R6

**Dependencies:** Unit 3 (raises the forcing function). Can ship concurrently with Unit 3 or immediately after.

**Files:**
- Modify: `src/lib/flowBuilder.ts:441-548` (`patchFlowSnapshotForTask`).
- Possibly modify: `src/lib/syncRunner.ts:145-173` (`syncTask`) if the re-read is cleaner to orchestrate at the caller layer.
- Test: co-located test for `patchFlowSnapshotForTask` (create if none exists; the existing flowBuilder test file is the natural home).

**Approach:**
- Keep the live Wrike fetch and single-ticket rebuild exactly as today.
- Immediately before writing, re-read `getFlowSnapshot(week)` into `currentSnapshot`. If `currentSnapshot === null` (someone deleted the week), fall through to the same `runSync` fallback path that already exists in `syncTask`.
- If `currentSnapshot.generatedAt !== existing.generatedAt` (a full rebuild landed between the original read and now), rebuild the output by: applying the single-ticket replacement against `currentSnapshot.tickets` (not the original `existing.tickets`), then re-running `recomputeMetrics` / whatever aggregate derivation the function already does, then saving.
- If `generatedAt` matches, the original `existing` is still authoritative; save as today.
- No new Redis keys, no new locks. The comparison field is already present on saved snapshots; if it isn't on the type, add it in the same change.

**Patterns to follow:**
- `saveFlowSnapshot` already rejects `tickets.length === 0` (`src/lib/flowStorage.ts:34`). The re-read pattern is conceptually a mini-CAS — it matches how the codebase favors lightweight consistency over introducing a second lock.

**Test scenarios:**
- Happy path: Snapshot unchanged between read and write — patched ticket replaces the original exactly as today, no behavioral change.
- Race path: Concurrent `runSync` commits between patch-read and patch-write. Re-read detects the change via `generatedAt`, patch is applied on top of the fresh tickets, and no other ticket's state is reverted. Assertion: after the patch save, all tickets updated by the concurrent `runSync` retain the new values.
- Edge case: Re-read returns `null` (snapshot wiped). Patch path falls through to the existing `runSync` fallback rather than writing a single-ticket-only snapshot.
- Regression: `syncTask` return shape (`{ ok, error? }`) unchanged so webhook and `/api/sync/task` callers are unaffected.

**Verification:**
- Unit test demonstrates the race is closed (mock two overlapping writes — the patched ticket lands, concurrent updates survive).
- Post-deploy: at 30-min cadence for 72h, no reports of "ticket reverted" and Unit 4 Slack alerts don't show a stream of snapshot-corruption symptoms.

- [ ] **Unit 7: `/api/debug/transitions` endpoint for raw transition inspection**

**Goal:** Expose the raw Redis transitions for a given taskId so H6-class bugs (merge-pipeline drop, `resolveStatusName` cache staleness, `storeTransition` failure) are inspectable without Upstash console access. Small, read-only, auth-gated.

**Requirements:** R7

**Dependencies:** None. Can ship before Unit 1 completes.

**Files:**
- Create: `src/app/api/debug/transitions/route.ts`.
- Test: `src/app/api/debug/transitions/route.test.ts`.

**Approach:**
- `GET /internal/kpis/api/debug/transitions?taskId=<id>&weeks=<n>` with `Authorization: Bearer ${CRON_SECRET}` (same pattern as `/api/debug/task-lookup`).
- Default `weeks=2` (current + prior ISO week) to keep payload bounded; cap at 8.
- Read `kpi:transitions:<week>` sorted sets via the same helper `getTransitionsInRange` that the merge pipeline consumes. Do not re-implement the key format.
- Response: `{ taskId, weeks: ["2026-W16", ...], transitions: [{ timestamp, from, to, source, weekKey }, ...] }`, sorted by timestamp asc.
- 404 if the taskId produces zero transitions across the scanned weeks.

**Patterns to follow:**
- `src/app/api/debug/task-lookup/route.ts` for auth, error envelope, and logging shape.
- `getTransitionsInRange` consumer pattern from `src/lib/flowBuilder.ts`.

**Test scenarios:**
- Happy path: Task with transitions across two weeks returns all of them sorted ascending.
- Empty: Task with no transitions in-range returns 404.
- Auth: Missing or wrong Bearer returns 401.
- Edge case: `weeks=1` returns only current ISO week. `weeks=9` clamps to 8 with a response note.

**Verification:**
- Hitting the endpoint with the bug-ticket taskId during Unit 1 Check 4 returns the expected transitions (including the 00:21 Completed event if H6 is NOT the root cause; absent if H6 IS the root cause).

- [ ] **Unit 8: Fix `clientName="Unknown"` fallback in `patchFlowSnapshotForTask`**

**Goal:** When a webhook patches a task that's not yet in the snapshot (brand-new task), derive `clientName` from `task.parentIds` / folder membership instead of falling back to `"Unknown"`. Today's fallback silently breaks per-client aggregation for freshly-created tasks.

**Requirements:** R8

**Dependencies:** None. Strictly orthogonal to the other units.

**Files:**
- Modify: `src/lib/flowBuilder.ts:494-495` (the `existingTicket?.clientName ?? "Unknown"` line).
- Possibly touch: `src/lib/wrike/fetcher.ts` if a helper is needed to resolve `parentIds` to a client folder name. Prefer reusing what `buildFlowSnapshot` already uses rather than introducing a new resolver.
- Test: co-located test for `patchFlowSnapshotForTask`.

**Approach:**
- When `existingTicket` is `undefined`, look up the task's `parentIds` against the configured client folders (`config.clients` or the active lookup the snapshot builder already uses). If a match is found, use that client's display name. If multiple parents match, prefer the one that appears in the configured client list.
- Fall back to `"Unknown"` only when no configured client folder matches — and log at `console.warn` so the occurrence is auditable.
- Do not add a new Wrike API call for this; the `/tasks/{id}` response already includes `parentIds`.

**Patterns to follow:**
- Whatever `buildFlowSnapshot` uses to attach `clientName` per ticket in the full-rebuild path. Reuse that helper verbatim.

**Test scenarios:**
- Happy path: New task with `parentIds` matching a configured client → patched entry has the correct `clientName`.
- Edge case: Task with multiple `parentIds` where exactly one matches a configured client → correct client used.
- Edge case: Task whose parents don't map to any configured client → falls back to `"Unknown"` AND emits `console.warn` with the taskId.
- Regression: Existing ticket with a non-Unknown `clientName` is unchanged (still prefers `existingTicket.clientName`).

**Verification:**
- Unit test with a mocked new-task Wrike response showing `clientName` correctly resolved.
- Post-deploy: no new `"Unknown"` entries appear in per-client aggregates for tasks created after the fix.

- [ ] **Unit 9: Pin `syncTask` to `getCurrentWeek()` to close the H5 week-rollover edge**

**Goal:** A webhook fired between 00:00 UTC Monday and the first Monday cron currently patches last week's snapshot (because `getFlowLatestWeek()` returns the previous week until the Monday cron writes the new-week blob). Dashboard reads the current week and sees nothing.

**Requirements:** R9

**Dependencies:** None.

**Files:**
- Modify: `src/lib/syncRunner.ts:151` — change `const week = await getFlowLatestWeek() ?? getCurrentWeek();` to `const week = getCurrentWeek();`.
- Test: `src/lib/syncRunner.test.ts` (or co-located; create if absent).

**Approach:**
- One-line change. Remove the `getFlowLatestWeek()` call from the patch path. The current-week snapshot is always the correct target for a live-state patch.
- The only caller-visible effect is the cold-start case: on a fresh Redis where `getFlowSnapshot(getCurrentWeek())` returns `null`, `syncTask` still falls through to `runSync()` exactly as today (`runSync` itself uses `getCurrentWeek()`). So behavior is preserved except on the narrow Monday-rollover window, which is the bug being fixed.

**Patterns to follow:**
- Existing `runSync()` body, which already uses `getCurrentWeek()` directly.

**Test scenarios:**
- Happy path (mid-week): `syncTask` patches the current-week snapshot, no behavior change vs. today.
- Bug-fix path (Monday 00:05 UTC, prior-week snapshot still the "latest"): `syncTask` now targets the current-week snapshot. If current-week snapshot doesn't yet exist, falls through to `runSync()` which initializes it.
- Regression: cold-start flow (Redis empty) still calls `runSync` once and returns `{ ok: true }`.

**Verification:**
- Unit test that mocks `getFlowLatestWeek` returning "W15" while `getCurrentWeek` returns "W16", then asserts `syncTask` writes to the W16 snapshot (or invokes `runSync` if W16 is absent).

- [ ] **Unit 10: Proactive webhook-staleness alert at 12h**

**Goal:** Alert to Slack when no webhook event has been received for ≥12h, well before the existing 48h auto-reactivation threshold in `src/app/api/cron/sync/route.ts`. Closes the H1a early-warning gap — today we only notice webhook drops when a user sees stale data or after 48h triggers a re-subscription.

**Requirements:** R10

**Dependencies:** Unit 4 (Slack plumbing). Relies on the existing `getWebhookLastEvent` accessor in `src/lib/storage.ts`.

**Files:**
- Modify: `src/app/api/cron/sync/route.ts` — after the reactivation check, add the staleness-warning check.
- Test: the existing cron route test (or add one if absent).

**Approach:**
- At the start of each cron invocation, read `lastWebhookEvent = await getWebhookLastEvent()`.
- Compute `ageHours = (Date.now() - lastWebhookEvent.at) / 3_600_000`.
- If `ageHours >= 12 && ageHours < 48` (the 48h path already auto-reactivates), post a Slack warning with a rate-limiter: Redis key `alert:webhook:stale:<day-bucket>` with TTL 86400s, INCR'd before posting — only post if the returned count is 1. This caps warnings at once per day even when many intraday crons fire.
- Message shape: `"⚠️ Wrike webhook stale for {ageHours.toFixed(1)}h (last event: {lastWebhookEvent.at}). Auto-reactivation at 48h."` Reuse the existing Slack payload pattern from `src/app/api/cron/sync/route.ts:47-54`.
- Do not touch the existing 48h auto-reactivation branch; Unit 10 is strictly additive.

**Patterns to follow:**
- Redis rate-limiter pattern in Unit 4 (INCR + TTL for per-bucket deduping).
- Existing Slack notification helper in the cron route.

**Test scenarios:**
- Happy path: `ageHours < 12` — no Slack.
- Warning path: `ageHours == 15`, rate-limit key absent → Slack fires, INCR returns 1.
- Dedup: `ageHours == 18` (later same-day cron), INCR returns 2 → no Slack.
- Auto-reactivation path: `ageHours >= 48` — warning branch skipped, reactivation branch runs as today.
- Edge case: `lastWebhookEvent` is `null` (never received an event) — treat as non-stale (cold start), no Slack.
- Edge case: Redis INCR fails (Upstash outage) — fail-open, Slack fires (consistent with Unit 4's signature-mismatch rate-limiter behavior).

**Verification:**
- Unit test with mocked `getWebhookLastEvent` at 15h age produces one Slack post across multiple simulated cron fires within the day.
- Post-deploy: if the webhook goes quiet (test by temporarily revoking the subscription), a warning appears in Slack within 30 min (next intraday cron).

## System-Wide Impact

- **Interaction graph:** `vercel.json` cron schedule → cron handler → `buildFlowSnapshot` → `saveFlowSnapshot`. Webhook → `storeTransition` → `after()` → `syncTask` → `patchFlowSnapshotForTask` → CAS re-read (Unit 6) → `saveFlowSnapshot`. Both paths converge on the same `kpi:flow:<week>` blob in Redis.
- **Error propagation:** Cron failures already fan out to `NOTIFICATION_WEBHOOK_URL`. Webhook auto-sync failures and signature mismatches currently do not — Unit 4 closes that gap. `/api/sync/task` failures surface to the UI as 500 toasts — Unit 5 adds Slack. Webhook staleness (<48h) currently silent — Unit 10 adds a 12h warning.
- **State lifecycle — `syncTask` × full-sync race (Unit 6).** `syncTask` does `getFlowSnapshot(week)` → mutate → `saveFlowSnapshot(patched)`. Today, if `runSync` commits between the read and the write, the patch clobbers the other tickets that the full sync just updated. Unit 6 closes this by re-reading the snapshot immediately before save and applying the single-ticket replacement against the fresh copy when `generatedAt` changed. Reuses the existing `kpi:flow:<week>` blob; no new Redis keys.
- **Week-rollover edge (H5) — Unit 9.** `syncTask` previously used `getFlowLatestWeek() ?? getCurrentWeek()`. On Monday 00:00 UTC, a webhook that fires before the first new-week cron would patch last week's snapshot. Unit 9 pins to `getCurrentWeek()` unconditionally; cold-start behavior preserved via the existing `runSync` fallback.
- **`clientName` fallback (Unit 8).** First-ever webhook-patched tasks (not yet in the snapshot) previously got `clientName="Unknown"`, silently breaking per-client aggregation. Unit 8 resolves from `task.parentIds` using the same helper the full-rebuild path uses.
- **New read-only API surface — Unit 7.** Adds `GET /internal/kpis/api/debug/transitions?taskId=…&weeks=…` behind `CRON_SECRET`. No public surface change; internal diagnostic only.
- **Intraday catchup load.** `catchUpMissingDates` issues Wrike PUT writes; moving from 3 to ~28 weekday runs multiplies write volume ~9× unless skipped on intraday runs (see Unit 3's `?catchup=skip` decision).
- **Integration coverage:** Unit 4 and Unit 5 need tests that verify the Slack path doesn't change the HTTP response even when Slack fails — mocks-only tests can miss this. Unit 4 also needs a test that the skipped-vs-ok distinction is logged correctly. Unit 6 needs an overlapping-write test that can't be satisfied by mocks alone — prefer an integration test that exercises two real concurrent writes against a test Redis. Unit 10 needs a test that the daily rate-limiter survives across multiple cron invocations within the bucket.
- **Unchanged invariants:** `saveFlowSnapshot` empty-rejection guard stays. `COMPLETED_TASK_CUTOFF_DAYS = 90` stays. 300s function budget stays — additional crons don't change per-invocation duration, but Unit 3's verification explicitly tracks p95 to confirm. Sync-guard lock semantics stay. Webhook signature verification stays. 48h auto-reactivation stays (Unit 10 is strictly additive).

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Unit 3 pushes Wrike API quota over a limit during peak hours (both reads and intraday catchup writes). | Read-side is bounded by PR #20's folder cache. Write-side is skipped on intraday runs via the `?catchup=skip` branch in the cron route. Monitor Wrike 429s in Vercel logs for 72h post-deploy; roll back to hourly (`0 8-20 * * 1-5`, 60/week) if quota pressure appears. |
| Vercel plan-level cron caps on the active subscription prevent shipping Unit 3 as specified. | Confirm the current Vercel plan at implementation time. If the plan cannot support ~150 invocations/week or sub-hourly schedules, fall back to hourly. 1-hour staleness is still a ~10× improvement. |
| Current cron p95 duration is already close to the 300s ceiling; 24× more runs means 24× more chances to time out. | Measure p95 from the last 7 days of Vercel logs before merging Unit 3. If p95 > ~180s, either (a) drop to hourly, or (b) ship Unit 3 with `?catchup=skip` as a hard requirement (intraday runs do pure rebuilds, strictly under 180s by design of PR #20). |
| **`syncTask` × full-sync race corrupts the snapshot at the new cadence.** Patch-path reads a snapshot, full-sync writes a new one, patch writes the stale read back. | Closed by Unit 6 (CAS re-read before save). Unit 4's Slack alerts remain as a secondary signal if the CAS logic itself misbehaves. |
| Unit 6's CAS re-read introduces a new failure mode: re-read returns `null` (snapshot wiped between reads). | Fall through to the existing `runSync` fallback path that `syncTask` already uses for the cold-snapshot case. Covered in Unit 6 test scenarios. |
| Unit 10 rate-limiter bucket resets at UTC midnight but webhook staleness accumulates continuously, so a warning fired at 23:50 UTC is followed by another at 00:00 UTC (2 warnings in 10 min). | Acceptable — crossing midnight during an active incident is a useful nudge, not alert noise. Keep the day bucket; don't pre-optimize. |
| Stuck sync guard (600s TTL) blocks up to 20 minutes of intraday crons if the Lua release fails. | Trim `SYNC_GUARD_TTL` from 600s to ~320s (Unit 3 scope). `maxDuration=300` + 20s margin. Long TTLs made sense at 8h cadence; they are costly at 30m. |
| Slack webhook URL leaks to logs or the bundle. | The URL is already used from the cron route via `process.env.NOTIFICATION_WEBHOOK_URL`; same usage here. Don't log the URL. |
| Slack alert storms on bulk failure modes (auth outage during a migration-era replay — user memory notes Feb–early Mar 2026 Wrike migration left many tasks with null `completedDate`; a backfill could mass-retrigger webhooks). | Unit 4 includes a 1-per-5-min Redis INCR rate limiter on signature-mismatch alerts. Extend the same pattern to `syncTask` failure alerts in Unit 4 if initial field telemetry shows bursts. Keep `console.error` so Vercel logs retain full fidelity. |
| Unit 3 masks the real problem by hiding webhook drops behind rapid syncs — we notice stale data less often but the underlying webhook drop goes undiagnosed. | Unit 4 + Unit 5 explicitly restore visibility at the event level. Cron frequency alone wouldn't be enough; the two must ship together. |
| Unit 1's transition-persistence check (H6) requires reading raw Redis transitions, but no endpoint exposes them. | If Upstash console access is unavailable at diagnosis time, open Unit 1.5 to add `/api/debug/transitions?taskId=…` behind `CRON_SECRET`. Lightweight — reads the same sorted set `getTransitionsInRange` already consumes. |

## Documentation / Operational Notes

- Update `src/app/api/sync/health/route.ts` `cronSchedule` string when Unit 3 lands (currently hardcoded to `"3x daily (00:00, 02:20, 12:00 UTC)"`).
- After Unit 3 deploys, watch Vercel Functions logs for 48h:
  - Confirm intraday crons fire on schedule.
  - Confirm `acquireSyncGuard` 409s stay rare (a few per day max).
  - Confirm Wrike API call volume doesn't trip 429s.
- After Unit 6 deploys, watch for unexpected CAS-miss frequency. If `generatedAt` mismatches more than a few times per day, something upstream is churning the snapshot and warrants a look.
- After Unit 10 deploys, confirm the 12h warning fires in a dry run (e.g., temporarily lie about `lastWebhookEvent.at` in a staging branch, or use a synthetic test).
- Coordinate with the Unit 10 work in `docs/plans/2026-04-17-011-fix-sync-timeout-followups-plan.md` (different "Unit 10" — that plan owns the UI freshness indicator). Ideally Units 3–5 ship first (so the clock the UI reads is actually fresh) and then the UI Unit 10 lands on top. **Do not confuse** that plan's Unit 10 with this plan's Unit 10 (webhook-staleness alert).

## Sources & References

- Bug report: User message on 2026-04-17, including screenshots at `.context/attachments/Screenshot 2026-04-17 at 09.08.02.png` and `.context/attachments/Screenshot 2026-04-17 at 09.08.22.png`.
- Related code: `src/app/api/cron/sync/route.ts`, `src/app/api/webhook/wrike/route.ts`, `src/lib/flowBuilder.ts:441-548`, `src/lib/syncRunner.ts`, `vercel.json`.
- Related prior plans:
  - `docs/plans/2026-04-16-010-fix-sync-timeout-optimization-plan.md` — 300s timeout design rules, must not regress.
  - `docs/plans/2026-04-17-011-fix-sync-timeout-followups-plan.md` — Unit 10 covers the user-facing freshness indicator; avoid duplicating.
- Wrike link for the example bug ticket: https://www.wrike.com/open.htm?id=4431857454
