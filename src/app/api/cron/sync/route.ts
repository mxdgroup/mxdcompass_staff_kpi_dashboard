import { loadOverridesFromRedis, getUnmappedMembers } from "@/lib/bootstrap";
import { config } from "@/lib/config";
import { NextResponse } from "next/server";
import { acquireSyncGuard, releaseSyncGuard, saveSnapshot, getWebhookLastEvent } from "@/lib/storage";
import { buildWeeklySnapshot } from "@/lib/aggregator";
import { buildFlowSnapshot } from "@/lib/flowBuilder";
import { saveFlowSnapshot } from "@/lib/flowStorage";
import { getCurrentWeek } from "@/lib/week";
import { reactivateWebhook } from "@/lib/wrike/api";
import { catchUpMissingDates } from "@/lib/wrike/dateCatchup";
import { initFolderCommentCache, clearFolderCommentCache } from "@/lib/wrike/fetcher";

export const maxDuration = 300;

export async function GET(request: Request) {
  // Verify cron secret
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return runSync();
}

export async function POST(request: Request) {
  // Verify cron secret (Vercel sends GET, but support POST too)
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return runSync();
}

async function runSync(): Promise<NextResponse> {
  const startTime = Date.now();

  // P22: Fail if overrides can't load — blank contact IDs produce empty snapshots
  const overrideResult = await loadOverridesFromRedis();
  if (!overrideResult.loaded) {
    const message = `Config override load failed: ${overrideResult.error}`;
    console.error(`[cron/sync] ${message}`);
    const webhookUrl = process.env.NOTIFICATION_WEBHOOK_URL;
    if (webhookUrl) {
      await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: `KPI Sync FAILED: ${message}` }),
      }).catch(() => {});
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }

  // P23: Reject if all members are unmapped (bootstrap never ran or overrides corrupt)
  const unmapped = getUnmappedMembers();
  if (unmapped.length === config.team.length) {
    const message = "All team members unmapped — run bootstrap first";
    console.error(`[cron/sync] ${message}`);
    const webhookUrl = process.env.NOTIFICATION_WEBHOOK_URL;
    if (webhookUrl) {
      await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: `KPI Sync FAILED: ${message}` }),
      }).catch(() => {});
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }

  // Acquire sync guard (P1: owner-token based lock)
  const guard = await acquireSyncGuard();
  if (!guard.acquired) {
    const webhookUrl = process.env.NOTIFICATION_WEBHOOK_URL;
    if (webhookUrl) {
      await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: "KPI Sync skipped: sync guard still held (possible stuck lock)",
        }),
      }).catch(() => {});
    }
    return NextResponse.json(
      { error: "Sync already in progress" },
      { status: 409 }
    );
  }

  try {
    initFolderCommentCache();

    // Check webhook health and auto-reactivate if stale
    // P26: Treat missing timestamp as stale (first deploy, Redis flush, or dead webhook)
    const lastEvent = await getWebhookLastEvent();
    const webhookStale =
      lastEvent === null || Date.now() - lastEvent * 1000 > 48 * 60 * 60 * 1000;

    let webhookReactivated = false;
    if (webhookStale) {
      webhookReactivated = await reactivateWebhook();
    }

    const week = getCurrentWeek();
    const snapshot = await buildWeeklySnapshot(week);
    await saveSnapshot(snapshot);

    // Build flow dashboard snapshot
    const flowSnapshot = await buildFlowSnapshot(week);
    await saveFlowSnapshot(flowSnapshot);

    // Catch up missing dates for tasks in trigger statuses.
    // Soft deadline of 60s protects the 300s function budget — the catch-up
    // is idempotent, so the next cron picks up any skipped folders.
    let dateCatchup: {
      startDatesSet: number;
      dueDatesSet: number;
      scanned: number;
      errors: number;
      deadlineReached: boolean;
      foldersProcessed: number;
      foldersTotal: number;
    } | null = null;
    try {
      dateCatchup = await catchUpMissingDates(Date.now() + 60_000);
    } catch (err) {
      console.error("[cron/sync] Date catch-up failed:", err);
    }

    const duration = Math.round((Date.now() - startTime) / 1000);

    // Notify on errors if Slack webhook is configured
    const catchupDeadlineHit = dateCatchup?.deadlineReached ?? false;
    const hasErrors = snapshot.memberErrors.length > 0 || webhookStale || catchupDeadlineHit;
    if (hasErrors && process.env.NOTIFICATION_WEBHOOK_URL) {
      await notifySlack(snapshot, webhookStale, webhookReactivated, duration, dateCatchup).catch(() => {});
    }

    return NextResponse.json({
      ok: true,
      week,
      duration: `${duration}s`,
      membersProcessed: snapshot.employees.length,
      memberErrors: snapshot.memberErrors.length,
      webhookStale,
      webhookReactivated,
      flowTickets: flowSnapshot.tickets.length,
      dateCatchup: dateCatchup
        ? {
            scanned: dateCatchup.scanned,
            startDatesSet: dateCatchup.startDatesSet,
            dueDatesSet: dateCatchup.dueDatesSet,
            errors: dateCatchup.errors,
            deadlineReached: dateCatchup.deadlineReached,
            foldersProcessed: dateCatchup.foldersProcessed,
            foldersTotal: dateCatchup.foldersTotal,
          }
        : null,
      summary: {
        tasksCompleted: snapshot.teamSummary.tasksCompleted,
        pipelineMovement: snapshot.teamSummary.pipelineMovement,
        returnForReview: snapshot.teamSummary.returnForReviewCount,
      },
    });
  } catch (err) {
    // P28: Slack alert on top-level sync failure
    const message = err instanceof Error ? err.message : String(err);
    console.error("[cron/sync] Top-level sync failure:", message);
    const webhookUrl = process.env.NOTIFICATION_WEBHOOK_URL;
    if (webhookUrl) {
      await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: `KPI Sync FAILED: ${message}`,
        }),
      }).catch(() => {});
    }
    return NextResponse.json({ error: message }, { status: 500 });
  } finally {
    clearFolderCommentCache();
    await releaseSyncGuard(guard.owner);
  }
}

async function notifySlack(
  snapshot: import("@/lib/types").WeeklySnapshot,
  webhookStale: boolean,
  webhookReactivated: boolean,
  duration: number,
  dateCatchup: { deadlineReached: boolean; foldersProcessed: number; foldersTotal: number } | null,
): Promise<void> {
  const url = process.env.NOTIFICATION_WEBHOOK_URL;
  if (!url) return;

  const issues: string[] = [];
  if (webhookStale && webhookReactivated) {
    issues.push("Wrike webhook was stale (no events in 48h) — auto-reactivated successfully");
  } else if (webhookStale) {
    issues.push("Wrike webhook stale (no events in 48h) — auto-reactivation FAILED, manual intervention needed");
  }
  if (dateCatchup?.deadlineReached) {
    issues.push(
      `Date catch-up hit soft deadline — processed ${dateCatchup.foldersProcessed}/${dateCatchup.foldersTotal} folders; next cron will resume`,
    );
  }
  for (const err of snapshot.memberErrors) {
    issues.push(`${err.name}: ${err.error}`);
  }

  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: `KPI Sync (${snapshot.week}): ${issues.length} issue(s) in ${duration}s\n${issues.join("\n")}`,
    }),
  });
}
