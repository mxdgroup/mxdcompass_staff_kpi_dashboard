# KPI Dashboard Production Sync Follow-Up Handoff

Date: 2026-04-18
Repo: `mxdgroup/mxdcompass_staff_kpi_dashboard`
Vercel project: `mxdgroup/mxdcompass-staff-kpi-dashboard`
Current branch: `main`
Latest pushed commit: `56c04d1`
Latest commit message: `fix: speed up full sync comment fetching`

## Purpose

This document is the continuation handoff after the earlier remediation pass and deploy. It captures:

- what production issue was investigated,
- what root cause was confirmed,
- what fix was made,
- what has already been revalidated on live production,
- and what still needs follow-up in the next chat.

## Important Project / Deployment Clarification

The correct Vercel project is:

- `https://vercel.com/mxdgroup/mxdcompass-staff-kpi-dashboard`

There is also an accidental separate Vercel project named `repo`, but it is not the dashboard project and was not the target of this investigation.

The GitHub-triggered production deployment for the latest fix is:

- deployment id: `dpl_aLm5ACPLEkTzU9bJEXF2U5rjN5Xc`
- deployment url: `https://mxdcompass-staff-kpi-dashboard-d3hzx102u-mxdgroup.vercel.app`

Production aliases shown by `vercel inspect`:

- `https://mxdcompass-staff-kpi-dashboard.vercel.app`
- `https://mxdcompass-staff-kpi-dashboard-mxdgroup.vercel.app`
- `https://mxdcompass-staff-kpi-dashboard-git-main-mxdgroup.vercel.app`

## Original Production Incident Investigated

At the start of this follow-up, production appeared stuck:

- `POST /internal/kpis/api/sync/trigger` returned `{"error":"Sync already in progress"}`
- `GET /internal/kpis/api/sync/health` returned `healthy: false`
- webhook state appeared stale

The task was to determine whether production was genuinely mid-sync or stuck behind a stale lock, fix it if needed, and then complete live full-sync validation.

## Root Cause Confirmed

The production lock was **not** permanently stale.

What was actually happening:

1. A real full sync would start and acquire Redis key `kpi:sync:running`.
2. The full sync would exceed Vercel's 300-second runtime limit.
3. Vercel would terminate the request with `504`.
4. The Redis sync guard would remain in place for its normal 600-second TTL.
5. During that TTL window, subsequent manual trigger attempts would correctly return:
   - `409 {"error":"Sync already in progress"}`

This was confirmed with:

- Vercel logs showing real `POST /internal/kpis/api/sync/trigger` timeouts at 300 seconds
- direct Upstash Redis inspection showing `kpi:sync:running` existed with a live, decreasing TTL
- later retries returning `409` while that TTL was still active

So the lock symptom was secondary. The actual bug was: **full sync was too slow for production runtime limits**.

## What Was Slow

The remaining slow path was the fallback Wrike comment-fetch logic:

- unmapped task comments were still fetched sequentially, one task at a time
- the shared Wrike throttle was still set to `1100ms` per request

Earlier optimization work had already landed:

- shared folder comment cache
- 90-day completed-task cutoff
- active-first task ordering
- parallel outer loops across members / client folders

But the heavier deferred optimization had not yet been applied:

- concurrent per-task comment fallback

## Wrike API Investigation Performed

The next escalation path from the plan was tested directly against live Wrike:

- tested batch comment endpoint idea: `/tasks/{id1},{id2}/comments`
- Wrike returned `{"errorDescription":"Invalid Task ID","error":"invalid_request"}`

This strongly indicated the batch comment subresource is not supported.

Single-task comment endpoint for the same task ID still worked:

- `/tasks/MAAAAAEHJcZM/comments` returned a valid response

Because batch comments were not supported, the implementation used the planned fallback:

- concurrent per-task comment fetching

## Exact Fix Made

Commit:

- `56c04d1` — `fix: speed up full sync comment fetching`

Files changed:

- `src/lib/wrike/client.ts`
- `src/lib/wrike/fetcher.ts`

### `src/lib/wrike/client.ts`

Changed:

- reduced `MIN_REQUEST_INTERVAL_MS` from `1100` to `180`
- added `WrikeClient.getCommentsByTaskIds(taskIds: string[])`

Behavior:

- comment fetches for unmapped tasks now run concurrently
- the throttle still gates requests, but at a much faster safe interval

### `src/lib/wrike/fetcher.ts`

Changed both fallback paths:

- `fetchWeeklyMemberData()`
- `fetchClientTasks()`

Old behavior:

- loop over each unmapped task
- call `/tasks/{id}/comments` sequentially

New behavior:

- collect unmapped task IDs
- call `client.getCommentsByTaskIds(unmappedTaskIds)`
- merge returned comments into the existing maps

## Local Validation Already Performed

After the code change:

- `npm install`
- `npm run lint`
- `npx tsc --noEmit`

All passed.

## High-Signal Local Runtime Validation

A local Next dev server was run with the **pulled production environment variables**.

Then:

- `POST /internal/kpis/api/sync/trigger`

returned:

- `{"ok":true,"week":"2026-W16","duration":"108s","membersProcessed":3,"memberErrors":0,"flowTickets":349}`

This was the key pre-deploy confidence check:

- full sync completed in ~108s locally against production data/env
- far below Vercel's 300s runtime limit

## Live Production Validation Already Performed

After pushing `56c04d1` to `main`, the GitHub -> Vercel production deployment completed successfully.

### Manual full sync

A real live manual trigger was executed against the current production deployment and completed successfully:

- response:
  - `{"ok":true,"week":"2026-W16","duration":"101s","membersProcessed":3,"memberErrors":0,"flowTickets":349}`

This is the main incident-resolution proof:

- the old 300s timeout behavior is no longer happening
- the old `409 sync already in progress` loop caused by post-timeout TTL is no longer the active failure mode

### Post-sync read-path validation

After the successful live sync:

- dashboard API `current.syncedAt`:
  - `2026-04-18T13:41:32.973Z`
- flow API `syncedAt`:
  - `2026-04-18T13:41:32.981Z`
- sync health `lastSyncedAt`:
  - `2026-04-18T13:41:32.981Z`

### Current sync health snapshot at handoff time

`GET /internal/kpis/api/sync/health` showed:

- `healthy: false`
- `lastSyncedAt: 2026-04-18T13:41:32.981Z`
- `latestWeek: 2026-W16`
- `lastWebhookEvent: 2026-04-09T15:41:04.000Z`
- `webhookHealthy: false`
- `registeredWebhookId: IEAGV532JAACB5HC`
- `trackedTasks: 349`

Interpretation:

- full sync is now working
- snapshots are current
- health remains false only because webhook event recency is stale

## Webhook State Investigation Already Performed

Direct live Wrike webhook inspection showed:

- webhook id: `IEAGV532JAACB5HC`
- hook URL: `https://mxdcompass-staff-kpi-dashboard.vercel.app/internal/kpis/api/webhook/wrike`
- subscribed event: `TaskStatusChanged`
- status: `Active`

This is important:

- webhook registration is not broken
- webhook URL is correct
- webhook is not suspended

So the remaining webhook issue is **not** "broken registration".

It is specifically:

- `lastWebhookEvent` in Redis is still old
- therefore the app still marks `webhookHealthy: false`

That means the remaining state is about **event recency / delivery observation**, not basic webhook existence.

## Current Best Understanding

### Fully resolved

- full sync timeout incident
- false appearance of a permanently stuck sync lock
- inability to run live full sync E2E

### Not yet resolved

- webhook health signal still reads false because no recent webhook event has updated `kpi:webhook:last_event`

### Important nuance

The webhook is active in Wrike and points to the correct production endpoint, so:

- "webhook health restored" is **not yet true in the app's health endpoint**
- but "webhook registration is valid and active" **is true**

## What Needs To Be Done Next

The next chat should focus on **closing the webhook-health gap** and deciding whether any code change is still needed.

### Recommended next steps

1. Determine whether new Wrike webhook events are actually arriving in production.
   - Check recent Vercel logs for `/internal/kpis/api/webhook/wrike`
   - Look for successful `200` deliveries and/or signature validation failures

2. Verify whether `kpi:webhook:last_event` advances when a real Wrike `TaskStatusChanged` event occurs.
   - If a fresh event is available, compare health before/after

3. If no webhook events are arriving despite active registration:
   - investigate whether Wrike simply hasn't emitted any qualifying recent events
   - or whether Vercel-side request handling is rejecting/never receiving them

4. Decide whether the health endpoint needs refinement.
   - Right now it conflates:
     - snapshot freshness
     - webhook event recency
   - It may be worth separating:
     - `webhookRegisteredAndActive`
     - `webhookRecentEventSeen`

5. Monitor next scheduled production cron runs.
   - Confirm sync stays under budget
   - Watch for any Wrike `429` behavior with the reduced 180ms interval

## Specific Follow-Up Questions For Next Chat

Use these as the next investigation prompts:

- Are real `POST /internal/kpis/api/webhook/wrike` requests hitting production after the fix?
- If yes, are they returning `200`, `401`, or some other status?
- Does `kpi:webhook:last_event` update when those requests arrive?
- If no webhook requests are arriving, is the Wrike webhook actually firing for current task changes?
- Should `/api/sync/health` split registration health from recent-event health?

## Suggested Prompt For The Next Chat

Use something close to this:

> Please read `docs/plans/CHAT_HANDOFF_2026-04-18_PROD_SYNC_FOLLOWUP.md` first. We already fixed the production full-sync timeout in `mxdgroup/mxdcompass_staff_kpi_dashboard` with commit `56c04d1`, and live `POST /internal/kpis/api/sync/trigger` now succeeds in ~101s on Vercel. However, `/internal/kpis/api/sync/health` still reports `healthy: false` because `lastWebhookEvent` is stale even though the Wrike webhook `IEAGV532JAACB5HC` is active and points at the correct production URL. Please investigate why webhook event recency is not recovering, verify whether live webhook deliveries are reaching production, and determine whether the remaining issue is delivery, signature validation, missing qualifying events, or just an overly strict health signal.

## Files Most Relevant For Next Chat

- `src/lib/wrike/client.ts`
- `src/lib/wrike/fetcher.ts`
- `src/app/api/webhook/wrike/route.ts`
- `src/lib/wrike/webhook.ts`
- `src/lib/wrike/webhookRegistrar.ts`
- `src/app/api/sync/health/route.ts`
- `src/app/api/cron/sync/route.ts`
- `src/lib/storage.ts`

## Quick Status Summary

What is done:

- root cause of stuck sync state confirmed
- full sync timeout fixed
- fix pushed to `main`
- GitHub-triggered Vercel production deploy completed
- real live manual full sync succeeded
- dashboard / flow snapshots now refresh successfully on production
- Wrike webhook registration confirmed active and correctly pointed at production

What is still open:

- app health endpoint still reports webhook unhealthy because `lastWebhookEvent` remains stale
- need to determine whether that is due to no recent deliveries, bad deliveries, missing qualifying events, or health-model limitations
