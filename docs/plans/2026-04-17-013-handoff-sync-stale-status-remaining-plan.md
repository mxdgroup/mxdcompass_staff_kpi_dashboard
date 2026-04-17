---
title: "handoff: remaining work on sync stale-status hardening"
type: fix
status: active
date: 2026-04-17
origin: docs/plans/2026-04-17-012-fix-sync-stale-status-plan.md
---

# Handoff: remaining work on sync stale-status hardening

## Purpose

This is a **handoff document** for a fresh chat. The parent plan (`docs/plans/2026-04-17-012-fix-sync-stale-status-plan.md`) defines the full hardening sweep; this doc captures what has shipped, what is verified in production, what is still pending, and what the next chat should do first.

**Entry instruction for the new chat:** read this doc, then read the parent plan 012 for unit-level detail. Do not re-diagnose the original bug — Units 1+2 are done and verified. Start at Unit 12 (below), which is a new, unplanned blocker.

## Current production state (verified 2026-04-17 ~09:15 UTC)

### Shipped

| PR | Commit | What it delivered |
|---|---|---|
| #23 | `f8e4fb2` | Unit 7: `/api/debug/transitions` endpoint. Fixed `patchFlowSnapshotForTask` by dropping the now-rejected `fields` param on `GET /tasks/{id}`. |
| #25 | `5072ada` | Unit 11 (new, unplanned): self-healing Wrike webhook registrar — reconciles webhook identity on every cron via `/webhooks` list + `hookUrl` match. Redis `kpi:wrike:webhook_id` is source of truth; env `WRIKE_WEBHOOK_ID` is bootstrap-only. Adds manual trigger `POST /api/admin/webhook/ensure` (Bearer `CRON_SECRET`). |
| #26 | `94ce8fe` | Unit 11 fixes: correct Wrike create endpoint is `POST /webhooks` (`/accounts/{id}/webhooks` returns `method_not_found`). Stale-sibling cleanup now runs on every reconcile, not only on re-register. |

### Production facts verified live

- Wrike account `IEAGV532` has **exactly one** webhook: `IEAGV532JAACB454`, Active, hookUrl `https://mxdcompass-staff-kpi-dashboard.vercel.app/internal/kpis/api/webhook/wrike`.
- Old suspended webhook `IEAGV532JAACBO6C` (with stale `/kpi/` path from pre-rename) was **auto-deleted** by the reconciler.
- `POST /internal/kpis/api/admin/webhook/ensure` returned `{ action: "noop", webhookId: "IEAGV532JAACB454", cleanedUp: ["IEAGV532JAACBO6C"] }`.
- `/internal/kpis/api/sync/health` returns `registeredWebhookId: "IEAGV532JAACB454"`, `trackedTasks: 314`, `lastSyncedAt: 2026-04-17T08:53:51Z`.
- `webhookHealthy: false` is expected — last event is from 2026-04-09 because the webhook was broken for the entire interim. The next real Wrike status change will flip it true.
- Unit 1+2 recovery: task `MAAAAAEIKMcu` ("Update MxD Site / Homepage") now shows `currentStage: "Completed"` in the snapshot. Root cause (per Unit 1 diagnosis): **H1a + webhook identity drift** — `WRIKE_WEBHOOK_ID` env pointed at a deleted webhook while a different, Suspended webhook with a stale `/kpi/` URL lingered in Wrike. PR #25/#26 permanently closes this class of failure.

## Pending user ops (block nothing in code, but must happen)

1. **Rotate `WRIKE_PERMANENT_ACCESS_TOKEN`.** The previous token was pasted in chat on 2026-04-17 ~08:xx UTC and is compromised. Regenerate in Wrike → Apps & Integrations → API → Permanent Access Tokens, then update the value in Vercel env (Production, Preview, Development all three).
2. **Optional: delete `WRIKE_WEBHOOK_ID` env var.** Nothing reads it after PR #25. Leaving it is harmless but misleading.

## Remaining implementation work

All remaining units live in parent plan 012. Summary below; open the parent for goals, files, approach, test scenarios, and verification criteria.

### Unit 12 (NEW — unplanned blocker for Cluster 3) — diagnose 300s cron regression

**Why new:** During Unit 11 verification, noticed that **4 out of 4** scheduled production cron runs in the last 24h 504'd at 300s. This is a regression from the PR #20 baseline (which brought p95 under 180s). Shipping Unit 3 (`*/30 8-20 * * 1-5` intraday cadence) on top of a cron that already times out would multiply failures ~10×, so Unit 3 is blocked until Unit 12 lands.

**Goal:** Identify which step of `runSync` has grown past its budget since PR #20, and restore p95 to ≤180s so Unit 3 can ship safely.

**Requirements this satisfies:** R5 (preserve 300s budget; the intraday cadence must not push p95 closer to the ceiling).

**Dependencies:** None. Diagnostic-first; fixes follow.

**Files (diagnostic phase — no repo changes yet):**
- Read-only: Vercel Functions logs for `api/cron/sync` invocations in the last 7 days.
- Read-only: `src/lib/flowBuilder.ts` (`buildFlowSnapshot`, `fetchClientTasks` call sites).
- Read-only: `src/lib/wrike/fetcher.ts` (`fetchClientTasks`, `initFolderCommentCache`, per-folder comment fallback).
- Read-only: `src/lib/wrike/dateCatchup.ts` (`catchUpMissingDates`).
- Read-only: `src/app/api/cron/sync/route.ts` (the inline `runSync()` — NOT the shared `syncRunner.runSync()`).

**Approach — structured diagnosis:**

1. **Pull Vercel function logs for the last 24h** for `/internal/kpis/api/cron/sync`. For each invocation, record:
   - Start time, duration, terminal status (200 / 504 / 5xx).
   - The `duration` field from the success JSON response (when present in the log) vs wall-clock time.
   - Any `[cron/sync] ...` log lines between start and terminal.
   - Whether the `Date catch-up hit soft deadline` log appears (soft deadline is `Date.now() + 60_000` in `src/app/api/cron/sync/route.ts`).
2. **Isolate which phase consumed the budget.** The cron route has explicit phase order: `loadOverridesFromRedis` → `getUnmappedMembers` → `acquireSyncGuard` → `initFolderCommentCache` → `getWebhookLastEvent` → `ensureWebhookRegistered` → `buildWeeklySnapshot` → `saveSnapshot` → `buildFlowSnapshot` → `saveFlowSnapshot` → `catchUpMissingDates` (60s soft deadline) → Slack notify → `clearFolderCommentCache` → release guard. The usual suspects at 300s are:
   - **`fetchClientTasks` pagination blow-up.** Wrike's `nextPageToken` can keep issuing non-empty pages for a long tail of completed tasks. Check whether the 90d cutoff is being honored pre-pagination (it's a post-filter — see `isCompletedBeyondCutoff`); if Wrike is returning the full year, pagination dominates.
   - **`catchUpMissingDates`.** Issues Wrike PUT writes folder-by-folder with a 60s soft deadline. If the deadline is being consumed every run but foldersProcessed < foldersTotal is reported, catch-up is pushing the clock but staying under its 60s; the time is being spent elsewhere.
   - **Comment-endpoint fallback loop.** `fetcher.ts` (per user-memory, comments endpoint rejects `updatedDate` — there's a workaround that filters in code). If the fallback pulls all comments per folder unconditionally on every sync, it scales with total folder comment history, not recent activity.
   - **`ensureWebhookRegistered` (shipped in PR #25).** Adds one `GET /webhooks` call per cron, ≤1s. Rule out as a cause unless logs show it near the top of the time budget.
3. **Cross-reference with commit history since PR #20 (`55fd5d8`).** Any commits to `src/lib/wrike/fetcher.ts`, `src/lib/flowBuilder.ts`, or `src/lib/wrike/dateCatchup.ts` are the first suspects. `git log --oneline 55fd5d8..HEAD -- src/lib/wrike/ src/lib/flowBuilder.ts src/lib/wrike/dateCatchup.ts` is the starting query.
4. **Measure, don't guess.** Before proposing a fix, add timing breadcrumbs to the cron route (`console.log` with `performance.now()` deltas between each phase) and deploy to production for **one** cron run. The 3x daily cadence means the next run is soon; one data point is enough to rule phases in or out. Remove the breadcrumbs in the same PR that ships the fix.

**Root-cause → fix mapping (green-light matrix):**

| Finding | Fix shape |
|---|---|
| `fetchClientTasks` pagination explodes because 90d cutoff is post-filter | Push the date filter into the Wrike query params (`createdDate` / `updatedDate` range in the list request), so Wrike returns only in-window tasks. Regress-test: total `trackedTasks` count on `/api/sync/health` stays near the current `314`. |
| Comment-fallback loop pulls full folder history every sync | Cache comment-last-seen timestamp per folder in Redis (`kpi:wrike:folder-comments:<folderId>:last_seen`), and filter comments client-side by `updatedDate > last_seen`. Invalidate on a manual nightly key if needed. |
| `catchUpMissingDates` genuinely can't finish in 60s | The soft deadline is already there; this isn't the bug. Look elsewhere. If folderProcessed consistently < foldersTotal, split the catchup into its own cron route and shorten its deadline further. |
| A post-PR-#20 regression in one of the above files | Revert or fix the offending change; don't paper over it. |

**Execution note:** diagnostic-first; no code-change commits until the phase-level timing is captured from production. This is characterization work — do not reshape `fetchClientTasks` speculatively.

**Patterns to follow:**
- Timing breadcrumbs pattern: plain `console.log` with elapsed ms (the cron route already uses `startTime = Date.now()` and reports `duration` in the response JSON).
- If the fix touches `fetchClientTasks`, mirror the existing Wrike filter-query pattern in `src/lib/wrike/fetcher.ts` — don't invent a new filter layer.

**Test scenarios:**
- Happy path: A single production cron run completes in ≤180s with the breadcrumbs in place; the slow phase is identified.
- Integration: After fix, three consecutive cron runs (00:00, 02:20, 12:00 UTC) all return 200 with `duration` ≤180s.
- Regression: `trackedTasks` on `/api/sync/health` stays in the 300–330 range post-fix (no tasks accidentally filtered out).
- Regression: Task status changes in Wrike still appear in the snapshot within one cron cycle after the fix.
- Edge case: A Wrike 429 during pagination causes a retry (client already retries via `isRetryable`) — total duration may spike above 180s but must still clear 300s.

**Verification:**
- Three consecutive production cron runs (any three, over ~8h) all return 200 with `duration` ≤180s.
- `/api/sync/health` `lastSyncedAt` stays current within each cron interval.
- No new 5xx errors on the cron route in the 48h post-deploy.
- Only then: **unblock Cluster 3 (Unit 3).**

### Cluster 2 — Slack visibility (Units 4 + 5 + 10)

Parent plan: §Implementation Units 4, 5, 10. Status: **unblocked** — can ship independently of Unit 12. Recommend shipping as three commits in one PR; the three units share the `NOTIFICATION_WEBHOOK_URL` plumbing.

- **Unit 4:** Slack alerts from webhook `after()` path (signature mismatch with 5-min dedup, syncTask errors, skipped-vs-ok distinction).
- **Unit 5:** Same Slack path from `POST /api/sync/task` failure.
- **Unit 10:** 12h proactive webhook-staleness warning from the cron route, with daily Redis INCR rate-limiter.

### Cluster 3 — Intraday cron cadence (Unit 3)

Parent plan: §Implementation Unit 3. Status: **BLOCKED by Unit 12.** Do not ship until Unit 12 restores p95 ≤180s.

When unblocked: confirm Vercel plan tier supports sub-hourly crons first, ship `*/30 8-20 * * 1-5` with `?catchup=skip` on the intraday path, trim `SYNC_GUARD_TTL` from 600s → ~320s, update the hardcoded `cronSchedule` string in `src/app/api/sync/health/route.ts`.

### Cluster 4 — CAS re-read in `patchFlowSnapshotForTask` (Unit 6)

Parent plan: §Implementation Unit 6. Status: **unblocked.** Ships easier after Unit 3 (the cadence is its forcing function), but can ship standalone. No deps.

### Cluster 5 — Small orthogonal fixes (Units 8 + 9)

Parent plan: §Implementation Units 8, 9. Status: **unblocked.** One PR, two small commits.

- **Unit 8:** Resolve `clientName` from `task.parentIds` in `patchFlowSnapshotForTask` instead of `"Unknown"` fallback.
- **Unit 9:** One-line change — pin `syncTask` to `getCurrentWeek()` (close the H5 Monday-rollover edge).

## Recommended sequencing

```
Now (parallel)
├─ Cluster 2 (Units 4+5+10) ── Slack visibility
├─ Cluster 5 (Units 8+9)    ── orthogonal small fixes
└─ Unit 12                  ── cron regression diagnosis
                               │
                               ▼ (when p95 ≤180s verified)
                             Cluster 3 (Unit 3) ── intraday cadence
                               │
                               ▼ (forcing function active)
                             Cluster 4 (Unit 6) ── CAS re-read
```

User ops (token rotation, `WRIKE_WEBHOOK_ID` cleanup) block nothing and can happen any time.

## Entry prompt for the new chat

> Working on parent plan `docs/plans/2026-04-17-012-fix-sync-stale-status-plan.md`. Read this handoff at `docs/plans/2026-04-17-013-handoff-sync-stale-status-remaining-plan.md` first. Start with Unit 12 (new — cron 300s regression diagnosis). Units 1/2/7/11 are shipped and verified live; do not redo. Units 4/5/6/8/9/10 are unblocked in parallel. Unit 3 is blocked on Unit 12.

## Sources & References

- Parent plan: `docs/plans/2026-04-17-012-fix-sync-stale-status-plan.md`
- Related plan (coordinate, don't duplicate): `docs/plans/2026-04-17-011-fix-sync-timeout-followups-plan.md` (that plan owns the UI "last synced at" badge)
- PR #25: self-healing webhook registrar — https://github.com/mxdgroup/mxdcompass_staff_kpi_dashboard/pull/25
- PR #26: create-endpoint fix + universal cleanup — https://github.com/mxdgroup/mxdcompass_staff_kpi_dashboard/pull/26
- PR #23: single-task sync unblock + transitions inspector — https://github.com/mxdgroup/mxdcompass_staff_kpi_dashboard/pull/23
- Related production baseline: PR #20 (commit `55fd5d8`) — 300s optimization; the regression in Unit 12 is measured against this.
