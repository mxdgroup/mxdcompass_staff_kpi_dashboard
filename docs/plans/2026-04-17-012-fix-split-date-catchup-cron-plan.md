---
title: "fix: Split date catch-up into its own cron endpoint"
type: fix
status: active
date: 2026-04-17
related_plans:
  - docs/plans/2026-04-16-010-fix-sync-timeout-optimization-plan.md
  - docs/plans/2026-04-17-011-fix-sync-timeout-followups-plan.md
---

# fix: Split date catch-up into its own cron endpoint

## Overview

The production sync endpoint (`/internal/kpis/api/cron/sync`) hit a hard Vercel `FUNCTION_INVOCATION_TIMEOUT` at 300.5s when triggered manually on 2026-04-17. The function was killed mid-execution, so:

- The response body was never delivered (no `dateCatchup` block to inspect)
- The Slack alert never fired (it only fires on a successful response)
- The date catch-up — which runs *after* the weekly and flow snapshots with a soft 60s budget — either ran briefly or not at all

Today users are reporting Wrike tasks in **Planned** or **In Progress** that have no start date even though the auto-start-date feature is deployed. The cron catch-up in `src/app/api/cron/sync/route.ts:128` is its reliability backstop — and it is being starved (or killed) by the snapshot work that runs before it.

This plan isolates date catch-up into its own cron endpoint on its own 300s budget, independent of the snapshot pipeline. That way a slow or failing snapshot no longer starves date catch-up, and catch-up failures surface as their own HTTP response with their own Slack alert.

**Scope honesty:** This plan fixes the *backstop coupling*, not the end-user-visible missing-date problem in full. If the main sync continues to exceed 300s (as today's 504 suggests), the dashboard will still show stale snapshot data. Restoring the user-visible "tasks appear with their dates" experience requires both this plan AND Unit 5 of the `2026-04-17-011` follow-up plan landing. Communicate that framing when merging.

## Problem Frame

**Observed:** Manual trigger of `/internal/kpis/api/cron/sync` returned HTTP 504 at 300.5s on 2026-04-17. Multiple Wrike tasks currently in Planned / In Progress have no start date despite the webhook + cron catch-up feature being deployed (shipped in PR #14 on 2026-04-16 — see commit `9a60cd3`).

**Why catch-up isn't running reliably today:**

1. `runSync()` in `src/app/api/cron/sync/route.ts` calls `buildWeeklySnapshot` → `buildFlowSnapshot` → `catchUpMissingDates(Date.now() + 60_000)`. Catch-up only gets 60s of the 300s function budget, and only if the snapshot work leaves time for it.
2. When the function exceeds 300s, Vercel kills it. No response is sent, the `dateCatchup` block in the response body is never observed, and the Slack alert — which only fires on a 200 response where `catchupDeadlineHit` is true — does not fire. Today's failure mode is silent.
3. The `2026-04-16-010` sync-timeout plan (PR #20, shipped 2026-04-17) explicitly rejected splitting the cron ("rejected because it doubles cron complexity and doesn't address the 90-day retention question independently"). That reasoning assumed the snapshot optimizations would be sufficient. Today's 504 shows they are not sufficient in isolation, and splitting catch-up is now the lower-risk path.

**Why splitting helps immediately:**

- Catch-up is **idempotent** (see `src/lib/wrike/dateCatchup.ts:104-124` — skips tasks that already have the relevant date set). Running it on its own schedule is safe.
- Catch-up's work is **independent** of snapshot work — it reads task dates and writes dates via separate Wrike API endpoints; it does not consume the snapshot output.
- Catch-up runs against `config.wrikeFolderIds` with `descendants: true`, same as the flow build — so if the flow build fits in 300s, so will catch-up.
- Decoupling restores the failure-alert contract: a failed catch-up cron now returns a non-200 or a 200 with `deadlineReached: true`, either of which the existing `NOTIFICATION_WEBHOOK_URL` plumbing can alert on.

## Requirements Trace

- R1. Date catch-up runs on its own Vercel function invocation with its own 300s budget, independent of `buildWeeklySnapshot` and `buildFlowSnapshot`.
- R2. A catch-up failure (timeout, Wrike API error, partial completion) is observable — either via the response body, a Slack notification, or both — without having to read Vercel runtime logs.
- R3. Catch-up continues to use the existing idempotent scan in `src/lib/wrike/dateCatchup.ts`. No change to which tasks it targets or which dates it writes.
- R4. The existing sync cron (`/api/cron/sync`) no longer runs catch-up. Removing it must not change the snapshot output or the sync's Slack alerting on snapshot errors.
- R5. The new catch-up cron is scheduled 3× per day at times that do not overlap the three existing sync crons (`0 0`, `20 2`, `0 12` UTC), preserving today's effective recovery cadence (catch-up piggybacks on 3 sync crons → will run on its own 3 slots).
- R6. Both endpoints share the existing `CRON_SECRET` auth pattern and the 300s `maxDuration` convention used in `src/app/api/cron/sync/route.ts`.
- R7. Catch-up holds a lightweight Redis-backed concurrency guard while running, so a retry storm, manual `curl` during a scheduled run, or accidental double-schedule cannot fire overlapping scans that burn Wrike rate-limit budget the sync cron needs.
- R8. The catch-up module's log lines do not include task titles — only task IDs. Wrike task titles in an agency context may contain client names, project code names, or other sensitive identifiers that should not flow to third-party log drains.

## Scope Boundaries

- **Not in scope:** Fixing whatever is making the main sync exceed 300s. That is Unit 5 in `docs/plans/2026-04-17-011-fix-sync-timeout-followups-plan.md` and may require activating the deferred batch/concurrent fetch units from the `2026-04-16-010` plan. This plan's success criterion is "catch-up runs reliably on its own clock," not "sync no longer times out."
- **Not in scope:** Changing which tasks catch-up scans, which statuses it treats as start/due triggers, or which dates it writes. The logic in `src/lib/wrike/dateCatchup.ts` is unchanged.
- **Not in scope:** Moving off Vercel to Railway or another persistent-container platform. That was considered and deferred in conversation — the local fix is smaller and sufficient.
- **Not in scope:** Pagination/cursor state across catch-up runs. With a full 300s budget (vs 60s) and the existing flow-build precedent, a single catch-up run should complete all folders. If it doesn't, the soft-deadline + next-run-restart behavior still applies and remains idempotent.
- **Not in scope:** Removing or changing the webhook-driven path in `src/lib/wrike/dateWriter.ts`. Catch-up remains a backstop for webhook gaps, not a replacement.

## Context & Research

### Relevant Code and Patterns

- `src/app/api/cron/sync/route.ts` — existing cron endpoint. The full shape to mirror for auth, `maxDuration`, sync-guard pattern, `NOTIFICATION_WEBHOOK_URL` alerting, and response envelope. Catch-up is wired in at line 128 and its result feeds the Slack notifier via `notifySlack(..., dateCatchup)`.
- `src/lib/wrike/dateCatchup.ts` — `catchUpMissingDates(deadlineMs?)`. Already parameterized on a deadline, already returns a structured `CatchupResult` with `scanned`, `startDatesSet`, `dueDatesSet`, `errors`, `deadlineReached`, `foldersProcessed`, `foldersTotal`. Ready to be called from a different cron with a different deadline without modification.
- `src/lib/storage.ts` — `acquireSyncGuard()` / `releaseSyncGuard()` protect the snapshot work from concurrent runs. Catch-up does not need the same guard — it is idempotent and safe to overlap with itself or with a sync, though R5 schedules to avoid that anyway.
- `vercel.json` — three existing cron entries. Next catch-up schedule should slot between them without introducing overlap with the in-flight sync.
- `src/app/api/cron/sync/route.ts:189-221` — `notifySlack()` formatter. Useful reference for the format the catch-up endpoint should produce, though catch-up's envelope is narrower (no snapshot fields).

### Institutional Learnings

- Both related plans (`2026-04-16-010` and `2026-04-17-011`) document the 300s Vercel function limit as the binding constraint and the "last sync = silent on timeout" failure mode. This plan's observability requirement (R2) is a direct response to that learned pain point.
- `2026-04-16-007-fix-date-webhook-coverage-plan.md` established the catch-up-as-backstop architecture and the idempotency guarantees this plan depends on.

### External References

None needed. The problem is bounded by the existing Vercel cron + Wrike API patterns already in this repo.

## Key Technical Decisions

- **New endpoint path: `/api/cron/catchup`.** Mirrors the `/api/cron/sync` naming. The route lives at `src/app/api/cron/catchup/route.ts` and is served under the Next.js basePath of `/internal/kpis`, so the vercel.json cron entry must include that prefix (matching existing sync entries).
- **Lightweight catch-up concurrency guard.** Acquire a Redis-backed lock at entry (`SET catchup:lock <owner-token> NX EX 600`) and release on normal exit. If the lock is held, return HTTP 409 immediately without scanning. Idempotency prevents corruption under overlap, but overlapping runs duplicate ~225s of Wrike API pressure which can collide with the sync cron. The guard costs one Redis round-trip per invocation — cheap, and eliminates a whole class of future operational pain (retry storms, ad-hoc `curl` during a scheduled run, accidental double-schedule). Follow the existing `acquireSyncGuard` / `releaseSyncGuard` pattern in `src/lib/storage.ts` — separate Redis key, separate owner token, same TTL-based self-healing on crash.
- **Catch-up deadline: 270s.** Leaves 30s of safety margin inside the 300s function budget for the final log line, response envelope, and lock release.

  **Back-of-envelope:** `config.wrikeFolderIds` has 4 entries today (`src/lib/config.ts:43-48`). Per folder, catch-up does one paginated `GET /folders/{id}/tasks?descendants=true` followed by up to N `PUT /tasks/{id}` writes for tasks missing dates. Each request goes through the client's 1.1s throttle slot (`src/lib/wrike/client.ts:7,39-58`). Assuming ≤50 date-writes per folder on a typical run, expected wall time is 4 × (1 paginated GET + 50 PUTs) × 1.1s ≈ ~225s — inside the 270s budget but not by a comfortable margin. First-run telemetry (`foldersProcessed / foldersTotal`) is required to validate. If actual runtime consistently approaches 270s, pagination-resume (deferred in Scope Boundaries) becomes urgent, not optional.

- **Schedule: 3× daily at 03:30, 11:30, 19:30 UTC.** Eight-hour spacing, all clear of the sync slots (`0 0`, `20 2`, `0 12` UTC). Preserves today's effective catch-up cadence (3× piggybacking on sync) so webhook-gap recovery does not regress. The code already supports a 48h webhook-staleness auto-reactivation path (`src/app/api/cron/sync/route.ts:98-105`) — during those windows catch-up is the only path, and reducing cadence from 3× to 1× would visibly slow self-heal.

- **Sync route delta: pure removal.** Delete the `catchUpMissingDates` call, the `dateCatchup` local, the `dateCatchup` field in the response, and the `dateCatchup` argument to `notifySlack`. Update the `notifySlack` signature accordingly. The snapshot behavior is unchanged.
- **Catch-up response envelope.** Returns `{ ok, duration, scanned, startDatesSet, dueDatesSet, errors, deadlineReached, foldersProcessed, foldersTotal }` plus any Wrike-resolution failures surfaced as a top-level error. Add `{ error: "Catch-up already in progress" }` with HTTP 409 when the concurrency lock is held.
- **Timing-safe bearer comparison.** Use `crypto.timingSafeEqual` on equal-length buffers for the bearer-token check rather than JavaScript strict equality. The existing sync route uses `!==` (`src/app/api/cron/sync/route.ts:20`), which is technically side-channel-exploitable against a low-entropy secret. Unit 1 introduces the timing-safe comparison; the sync route can adopt the same helper in a follow-up (tracked separately).
- **Task-title log hygiene.** `src/lib/wrike/dateCatchup.ts:110,123` currently logs `[dateCatchup] Set start date ${today} on task ${task.id} (${task.title})`. Task titles in an agency PM system may contain client names and internal code names that should not flow to third-party log drains. Drop the title from the info-level log; keep the task ID.

## Open Questions

### Resolved During Planning

- **Should the catch-up cron reuse `CRON_SECRET` or have its own secret?** Reuse `CRON_SECRET`. No reason to diverge; reduces rotation surface.
- **Should catch-up share the sync guard to avoid running while a sync is in flight?** No — separate concern, separate lock. Catch-up uses its *own* Redis-backed lock (R7) that only prevents overlapping catch-up runs, not concurrency with sync. The sync guard protects snapshot-write atomicity; the catch-up guard protects Wrike rate-limit budget from duplicate scans.
- **Should catch-up get a pagination cursor so successive runs resume where the last left off?** Not yet. With 300s (vs 60s), it should finish all folders in one run. Revisit only if real-world telemetry after this ships shows `deadlineReached: true` consistently.
- **Why 3 schedules instead of 1?** Preserves today's 3× effective cadence (catch-up currently piggybacks on 3 sync crons). Reducing to 1× would regress webhook-gap recovery from ~every 4–12h to ~every 24h during the 48h windows when webhooks can be stale.

### Deferred to Implementation

- **Exact Slack alert copy for catch-up-only failures.** Mirror the sync notifier's tone; finalize during implementation once the return shape is wired.
- **Whether to emit a one-line success log even when nothing was written.** Lean "yes" for observability, but it's a copy/log-level question, not a design question.

## Implementation Units

- [ ] **Unit 1: Stand up `/api/cron/catchup` with concurrency guard and Slack alerting**

  **Goal:** Create the standalone catch-up endpoint with everything needed for safe production operation: auth, 270s deadline, Redis concurrency guard, structured response, and Slack notifications on failure. Shipped as one atomic unit so the endpoint never exists without alerting or without overlap protection.

  **Requirements:** R1, R2, R3, R6, R7

  **Dependencies:** None

  **Files:**
  - Create: `src/app/api/cron/catchup/route.ts`
  - Modify: `src/lib/storage.ts` (add `acquireCatchupGuard` / `releaseCatchupGuard` mirroring the existing sync-guard helpers)
  - Test: `src/app/api/cron/catchup/__tests__/route.test.ts` *(confirm test-framework convention from the sync route at implementation time)*

  **Approach:**
  - Mirror the auth + `maxDuration` shape of `src/app/api/cron/sync/route.ts` (GET + POST handlers, `Bearer ${CRON_SECRET}`, `export const maxDuration = 300`).
  - Use `crypto.timingSafeEqual` on equal-length `Buffer`s for the bearer-token check — not JavaScript strict equality. Return `401` on length mismatch *before* calling `timingSafeEqual`.
  - Acquire the catch-up guard (`SET catchup:lock <owner-token> NX EX 600` via Upstash Redis) after auth and before calling `catchUpMissingDates`. On lock-already-held, return HTTP 409 with `{ error: "Catch-up already in progress" }` immediately — do not notify Slack (409 is expected back-pressure, not a failure).
  - Call `catchUpMissingDates(Date.now() + 270_000)` so the function reserves 30s of headroom for response, logging, and lock release.
  - Return a JSON response with `ok`, `duration`, and all fields from `CatchupResult`.
  - After the catch-up call returns, conditionally notify Slack via `NOTIFICATION_WEBHOOK_URL`:
    - `deadlineReached: true` → notify with folder progress (`X of Y folders processed`).
    - `errors > 0` → notify with the error count.
    - `foldersProcessed > 0 && errors === foldersProcessed` → notify ("catchup failed every folder fetch — likely Wrike auth or API issue"). Do NOT alert on `scanned === 0` alone: a folder can legitimately contain zero tasks matching trigger statuses.
  - If `NOTIFICATION_WEBHOOK_URL` is unset, skip notification silently.
  - Keep the notifier call on a best-effort `.catch(() => {})` — a failed Slack post must not cause the catch-up response to fail.
  - Catch top-level errors, log them, notify Slack with the error message, release the lock in `finally`, and return a 500 — mirroring the sync route's top-level failure pattern at `src/app/api/cron/sync/route.ts:168-182`.

  **Patterns to follow:**
  - `src/app/api/cron/sync/route.ts` — auth header check, `maxDuration`, try/catch/finally structure, response envelope, `notifySlack` shape.
  - `src/lib/storage.ts` — `acquireSyncGuard` / `releaseSyncGuard` owner-token pattern (separate Redis key, same TTL-based self-healing on crash).

  **Test scenarios:**
  - Happy path — valid `Bearer ${CRON_SECRET}`, lock acquired, mocked `catchUpMissingDates` returning a populated `CatchupResult` with `errors: 0, deadlineReached: false` → HTTP 200 with all fields echoed through and `ok: true`, no Slack fetch.
  - Happy path (legitimate zero-scan) — `CatchupResult` with `errors: 0, deadlineReached: false, scanned: 0, foldersProcessed: 4, foldersTotal: 4` → HTTP 200, no Slack fetch.
  - Error path — missing `Authorization` header → HTTP 401, no lock acquired.
  - Error path — wrong bearer token (correct length, wrong value) → HTTP 401.
  - Error path — wrong-length bearer token → HTTP 401 without calling `timingSafeEqual`.
  - Edge case — catch-up lock already held → HTTP 409 with `{ error: "Catch-up already in progress" }`, no Slack fetch, no call to `catchUpMissingDates`.
  - Error path — `CatchupResult` with `deadlineReached: true, foldersProcessed: 2, foldersTotal: 5` → HTTP 200, one Slack fetch containing "deadline" and "2/5", lock released.
  - Error path — `CatchupResult` with `errors: 3` → HTTP 200, one Slack fetch containing "3 error".
  - Error path — all-folder-failure: `CatchupResult` with `foldersProcessed: 4, errors: 4` → one Slack fetch containing "failed every folder fetch".
  - Error path — `catchUpMissingDates` throws "Wrike auth failed" → HTTP 500 with error in body, one Slack fetch containing "Wrike auth failed", lock released via `finally`.
  - Edge case — `NOTIFICATION_WEBHOOK_URL` unset → no Slack fetch attempted; response still returns normally.
  - Edge case — Slack fetch itself throws → catch-up response still returns normally (best-effort notifier).
  - Edge case — function crashes mid-scan → lock self-expires after 600s TTL; next scheduled invocation proceeds normally.

  **Verification:**
  - Manual `curl` with `CRON_SECRET` against a preview deployment returns a populated JSON envelope and runs to completion.
  - A second `curl` fired while the first is still in flight returns HTTP 409 immediately.
  - A deliberately broken catch-up run (e.g., revoked Wrike token in preview) surfaces a Slack message within the function's lifetime.
  - A healthy catch-up run (no `deadlineReached`, no errors) produces no Slack noise.
  - New route shows up in the Vercel Functions dashboard with `maxDuration: 300`.

- [ ] **Unit 2: Remove catch-up from the sync cron route**

  **Goal:** Restore `/api/cron/sync` to pure snapshot work so it no longer bears the catch-up dependency.

  **Requirements:** R4

  **Dependencies:** Unit 1 and Unit 3 (the new endpoint must exist AND be scheduled before sync stops running catch-up)

  **Files:**
  - Modify: `src/app/api/cron/sync/route.ts`
  - Test: if `src/app/api/cron/sync/__tests__/route.test.ts` or similar exists, update it; confirm at implementation.

  **Approach:**
  - Delete the `import { catchUpMissingDates } from "@/lib/wrike/dateCatchup"` line.
  - Delete the `let dateCatchup: { ... } | null = null;` block and the `try { dateCatchup = await catchUpMissingDates(...) } catch { ... }` call.
  - Remove the `dateCatchup` field from the response JSON.
  - Remove the `dateCatchup` argument from the `notifySlack` call and from the `notifySlack` function signature.
  - Remove the `catchupDeadlineHit` local and its contribution to `hasErrors`.
  - Remove the `if (dateCatchup?.deadlineReached)` branch inside `notifySlack`.
  - Leave everything else untouched — overrides load, unmapped-members guard, sync guard, webhook-stale check, snapshot builds, `initFolderCommentCache` / `clearFolderCommentCache` all stay exactly as they are.

  **Patterns to follow:**
  - The sync route's existing structure — keep the try/finally guard discipline unchanged.

  **Test scenarios:**
  - Happy path — existing sync-route test (if any) still passes with `dateCatchup` fields removed from the assertion. Confirm by reading the test file before editing; only update the assertions that reference catch-up.
  - Integration — hitting the sync endpoint returns a response without any `dateCatchup` field. Snapshot `membersProcessed`, `memberErrors`, `flowTickets`, `webhookStale`, `webhookReactivated` all still populate as before.

  **Verification:**
  - `rg "dateCatchup" src/app/api/cron/sync/route.ts` returns no matches.
  - `rg "catchUpMissingDates"` in the repo returns only `src/lib/wrike/dateCatchup.ts` (definition) and `src/app/api/cron/catchup/route.ts` (new caller).
  - Manual curl against a preview deployment of the sync endpoint returns 200 with a clean envelope.

- [ ] **Unit 3: Wire catch-up cron into `vercel.json`**

  **Goal:** Schedule the new endpoint 3× daily at times that do not overlap the three existing sync crons, preserving today's effective catch-up cadence.

  **Requirements:** R5

  **Dependencies:** Unit 1

  **Files:**
  - Modify: `vercel.json`

  **Approach:**
  - Add three new entries, each with `"path": "/internal/kpis/api/cron/catchup"`:
    - `"schedule": "30 3 * * *"` — 03:30 UTC (after 02:20 sync)
    - `"schedule": "30 11 * * *"` — 11:30 UTC (between 00:00 and 12:00 sync buffer)
    - `"schedule": "30 19 * * *"` — 19:30 UTC (late in the day, well clear of all syncs)
  - Keep the three existing sync entries unchanged.
  - Each catch-up slot gives the preceding sync at least 65 minutes of settle-time (syncs run ≤300s by definition — Vercel kills them otherwise).
  - **Vercel tier:** the project already ships three cron entries, which exceeds the Hobby limit of 2 crons/project. By inductive proof, this project is already on Pro or Team tier, where the per-project cron cap is well above 6. No tier upgrade is required.
  - **Deployment strategy:** ship all units in a single PR. The moment the PR deploys, sync stops running catch-up (Unit 2) but the new standalone cron does not fire until the next of the 3 scheduled slots — a gap of up to ~8 hours. This is tolerable because the webhook-driven `src/lib/wrike/dateWriter.ts` path is the primary (real-time) date setter and continues to run; catch-up is the backstop. Trigger `/internal/kpis/api/cron/catchup` once manually via authenticated `curl` immediately after deploy to close the initial gap.

  **Test expectation:** none — pure config change verified by observability.

  **Verification:**
  - After deploy, the Vercel dashboard → Settings → Cron Jobs lists six entries, three of which point to `/internal/kpis/api/cron/catchup`.
  - Within 24 hours, at least one successful invocation of each catch-up slot appears in Vercel logs with a `[dateCatchup] Done:` log line.

- [ ] **Unit 4: Redact task titles from catch-up logs**

  **Goal:** Stop logging Wrike task titles from `catchUpMissingDates`. Task IDs remain — they're sufficient for debugging and do not leak client or project names to third-party log drains.

  **Requirements:** R8

  **Dependencies:** None (independent of Units 1–3; can ship in the same PR)

  **Files:**
  - Modify: `src/lib/wrike/dateCatchup.ts`

  **Approach:**
  - Change `src/lib/wrike/dateCatchup.ts:110` from:
    ```
    console.log(`[dateCatchup] Set start date ${today} on task ${task.id} (${task.title})`);
    ```
    to:
    ```
    console.log(`[dateCatchup] Set start date ${today} on task ${task.id}`);
    ```
  - Change `src/lib/wrike/dateCatchup.ts:123` from:
    ```
    console.log(`[dateCatchup] Set due date ${today} on task ${task.id} (${task.title})`);
    ```
    to:
    ```
    console.log(`[dateCatchup] Set due date ${today} on task ${task.id}`);
    ```
  - Leave the surrounding logic, the error-path `console.error` at line 127, and the summary log at line 133-134 unchanged (they already avoid titles).

  **Patterns to follow:**
  - The existing summary log at `src/lib/wrike/dateCatchup.ts:133-134` — aggregate counts and IDs, no titles.

  **Test scenarios:**
  - None required — log-content change only. Verify by reading the file post-edit.

  **Verification:**
  - `rg "task.title" src/lib/wrike/dateCatchup.ts` returns no matches.
  - After the first post-deploy catch-up run, a representative info log in the Vercel console reads `[dateCatchup] Set start date 2026-04-17 on task IEAABCDEFKQABCDE` with no parenthesized title.

## System-Wide Impact

- **Interaction graph:** The webhook-driven `src/lib/wrike/dateWriter.ts` path is untouched. The sync pipeline (`buildWeeklySnapshot`, `buildFlowSnapshot`, `syncRunner`) is untouched. A new consumer of `catchUpMissingDates` exists (the new cron endpoint) in addition to the existing one being removed from the sync route.
- **Rate limiting across invocations:** The Wrike client's `nextRequestSlotAt` and `requestSlotChain` are *instance* fields (`src/lib/wrike/client.ts:23-24`) and the singleton (`src/lib/wrike/client.ts:240`) is per-process. Vercel invocations run in separate isolates, so the 1.1s slot throttle is NOT shared between the sync cron and the catch-up cron. Cross-invocation concurrency is handled by Wrike's server-side 429 responses plus the client's retry-with-backoff logic (`isRetryable` + `getRetryAfterMs`). The R5 schedule separation is the real overlap mitigation, not client-side throttling.
- **Error propagation:** A top-level catch-up exception now returns an HTTP 500 from `/api/cron/catchup` (new behavior — previously a catch-up exception inside sync was caught and logged, never surfaced). Unit 1 adds Slack notification on that path to close the observability gap.
- **State lifecycle risks:** Catch-up writes dates directly to Wrike via `/tasks/{id}` PUT. Running it on its own schedule introduces no new write path. Idempotency (skip when date already set) means running twice in rapid succession is harmless — it just scans and skips.
- **Breaking change — sync response JSON:** `/api/cron/sync` response JSON changes — the `dateCatchup` field is removed. Anything reading that field externally (monitoring dashboards, Slack parsers) will need to update. No known external consumers; verify during implementation.
- **Integration coverage:** The new endpoint is exercised by Vercel's cron runner and by manual `curl` testing. Unit tests cover auth and response shape; live catch-up behavior is exercised via the existing `catchUpMissingDates` function which already has coverage in its own tests (verify existence at implementation time).
- **Unchanged invariants:** The webhook-driven dateWriter path, the trigger-status sets (Planned/In Progress for start, In Review/Client Pending/Completed for due), idempotency of date writes, and the `config.wrikeFolderIds` scope all remain exactly as they are.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Removing catch-up from sync leaves a gap until the first scheduled catch-up cron fires | Ship all units in one PR and trigger `/api/cron/catchup` once manually post-deploy via authenticated `curl`. Webhook-driven date-setting (`src/lib/wrike/dateWriter.ts`) continues as the primary path, so the backstop gap of up to ~8h between scheduled slots is tolerable. |
| New cron entries exceed Vercel plan cron limit | Project already has 3 crons, which exceeds the Hobby cap of 2 → project is already on Pro/Team tier where the per-project cron cap is well above 6. Inductively safe. |
| Catch-up slot collides with an in-flight sync if that sync runs long | Each catch-up slot is offset ≥65 min from any sync. If a sync is running over 300s and being killed (the condition this plan does not fix), it won't still be alive at the catch-up slot — Vercel will have killed it at its 300s ceiling. Cross-process Wrike throttling is handled by Wrike's server-side 429 + the client's retry-with-backoff, not client-side serialization (see System-Wide Impact → Rate limiting). |
| Two catch-up crons overlap (e.g. one runs long while the next fires) | Redis-backed concurrency guard (R7, Unit 1) returns HTTP 409 on the second run. TTL of 600s on the lock key ensures a crashed run self-heals before the next scheduled slot. |
| Catch-up itself takes longer than 270s in production, on its own budget | The back-of-envelope estimate (~225s for 4 folders × up to 50 PUTs each at 1.1s throttle) leaves only ~45s margin. First-run telemetry (`foldersProcessed / foldersTotal`) validates. If actual runtime approaches or exceeds 270s, pagination-resume (deferred in Scope Boundaries) becomes required, not optional. Idempotency means restart-from-folder-0 is safe. |
| Starvation premise is inferred from a single 504, not directly observed | The `dateCatchup` response block was never captured because the function timed out. If PR #20's optimizations actually do fit in 300s on scheduled runs (to be confirmed by Unit 5 of `2026-04-17-011`), today's 504 may have been a cold-start or transient-Wrike anomaly. Splitting catch-up is still a net positive even if so — it removes a coupling and adds observability — but that framing should be explicit when reviewing outcomes. |
| The sync is *also* timing out and this plan doesn't fix that | This plan's success criterion is "catch-up runs reliably on its own clock," not "users no longer see missing dates." If the snapshot itself continues to exceed 300s, dashboard staleness persists for users until Unit 5 of `docs/plans/2026-04-17-011-fix-sync-timeout-followups-plan.md` lands. Communicate this explicitly when merging. |

## Documentation / Operational Notes

- Update `.env.example` only if a new env var is introduced — this plan reuses `CRON_SECRET` and `NOTIFICATION_WEBHOOK_URL`, so no change expected.
- After deploy, confirm in the Vercel dashboard → Settings → Cron Jobs that six entries are listed (3 sync + 3 catchup).
- After the first successful catch-up cron run (within 8 hours of deploy), read the Vercel log line `[dateCatchup] Done: scanned=… startDatesSet=… dueDatesSet=… errors=… folders=X/Y`. Record those numbers so we can tell whether the standalone run is scanning more folders than the starved 60s version was.
- If `foldersProcessed < foldersTotal` on the first run with its own 300s budget, the next action is to plan pagination (out of scope for this plan).
- The catch-up Redis lock lives under a dedicated key (separate from the sync guard). If a run is killed mid-scan before the `finally` releases the lock, the 600s TTL self-heals before the next scheduled slot — no manual intervention needed. To force-clear a stuck lock in an incident, delete the catchup lock key directly in Upstash.

## Sources & References

- Related plans:
  - `docs/plans/2026-04-16-010-fix-sync-timeout-optimization-plan.md` (PR #20, shipped 2026-04-17 — the predecessor that rejected splitting cron)
  - `docs/plans/2026-04-17-011-fix-sync-timeout-followups-plan.md` (Unit 5 is where the broader sync-timeout investigation lives)
  - `docs/plans/2026-04-16-007-fix-date-webhook-coverage-plan.md` (origin of the catch-up backstop architecture)
- Related code:
  - `src/app/api/cron/sync/route.ts`
  - `src/lib/wrike/dateCatchup.ts`
  - `src/lib/wrike/dateWriter.ts`
  - `vercel.json`
- Related PRs/issues: #14 (catch-up backstop), #20 (sync timeout optimization)
- Trigger event: 2026-04-17 manual trigger of `/internal/kpis/api/cron/sync` returned HTTP 504 at 300.5s wall time.
