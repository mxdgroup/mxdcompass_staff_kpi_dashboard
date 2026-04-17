import { loadOverridesFromRedis, getUnmappedMembers } from "@/lib/bootstrap";
import { config } from "@/lib/config";
import { NextResponse } from "next/server";
import { acquireSyncGuard, releaseSyncGuard, saveSnapshot, getWebhookLastEvent } from "@/lib/storage";
import { buildWeeklySnapshot } from "@/lib/aggregator";
import { buildFlowSnapshot } from "@/lib/flowBuilder";
import { saveFlowSnapshot } from "@/lib/flowStorage";
import { getCurrentWeek } from "@/lib/week";
import { ensureWebhookRegistered } from "@/lib/wrike/webhookRegistrar";
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

    // Webhook event-flow health (are events actually arriving?)
    // P26: Treat missing timestamp as stale (first deploy, Redis flush, or dead webhook)
    const lastEvent = await getWebhookLastEvent();
    const webhookStale =
      lastEvent === null || Date.now() - lastEvent * 1000 > 48 * 60 * 60 * 1000;

    // Webhook registration health (is Wrike still configured to POST us?)
    // Runs every cron — one API call; reconciles suspension / deletion / URL drift.
    const webhookRegistration = await ensureWebhookRegistered();
    if (webhookRegistration.action === "failed") {
      console.error(
        "[cron/sync] Webhook registration reconciliation failed:",
        webhookRegistration.reason,
      );
    } else if (webhookRegistration.action !== "noop") {
      console.log(
        `[cron/sync] Webhook ${webhookRegistration.action}: ${webhookRegistration.webhookId}` +
          (webhookRegistration.cleanedUp
            ? ` (cleaned up ${webhookRegistration.cleanedUp.length} stale)`
            : ""),
      );
    }

    const week = getCurrentWeek();
    const snapshot = await buildWeeklySnapshot(week);
    await saveSnapshot(snapshot);

    // Build flow dashboard snapshot
    const flowSnapshot = await buildFlowSnapshot(week);
    await saveFlowSnapshot(flowSnapshot);

    const duration = Math.round((Date.now() - startTime) / 1000);

    const registrationFailed = webhookRegistration.action === "failed";
    const hasErrors =
      snapshot.memberErrors.length > 0 || webhookStale || registrationFailed;
    if (hasErrors && process.env.NOTIFICATION_WEBHOOK_URL) {
      await notifySlack(snapshot, webhookStale, webhookRegistration, duration).catch(() => {});
    }

    return NextResponse.json({
      ok: true,
      week,
      duration: `${duration}s`,
      membersProcessed: snapshot.employees.length,
      memberErrors: snapshot.memberErrors.length,
      webhookStale,
      webhookRegistration: {
        action: webhookRegistration.action,
        webhookId: webhookRegistration.webhookId,
        hookUrl: webhookRegistration.hookUrl,
        reason: webhookRegistration.reason,
        cleanedUp: webhookRegistration.cleanedUp,
      },
      flowTickets: flowSnapshot.tickets.length,
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
  registration: import("@/lib/wrike/webhookRegistrar").WebhookRegistrationResult,
  duration: number,
): Promise<void> {
  const url = process.env.NOTIFICATION_WEBHOOK_URL;
  if (!url) return;

  const issues: string[] = [];
  switch (registration.action) {
    case "reactivated":
      issues.push(`Wrike webhook was suspended — auto-reactivated (${registration.webhookId})`);
      break;
    case "reregistered":
      issues.push(
        `Wrike webhook was missing — re-registered as ${registration.webhookId}` +
          (registration.cleanedUp ? ` (cleaned up ${registration.cleanedUp.length} stale)` : ""),
      );
      break;
    case "adopted":
      issues.push(`Wrike webhook adopted from existing record (${registration.webhookId})`);
      break;
    case "failed":
      issues.push(`Wrike webhook reconciliation FAILED: ${registration.reason ?? "unknown"}`);
      break;
  }
  if (webhookStale && registration.action === "noop") {
    issues.push(
      "Wrike webhook registered + Active but no events in 48h — check dashboards for delivery failures",
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
