import { loadOverridesFromRedis } from "@/lib/bootstrap";
import { NextResponse } from "next/server";
import { acquireSyncGuard, releaseSyncGuard, saveSnapshot, getWebhookLastEvent } from "@/lib/storage";
import { buildWeeklySnapshot } from "@/lib/aggregator";
import { buildFlowSnapshot } from "@/lib/flowBuilder";
import { saveFlowSnapshot } from "@/lib/flowStorage";
import { getCurrentWeek } from "@/lib/week";
import { reactivateWebhook } from "@/lib/wrike/api";

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

  await loadOverridesFromRedis();

  // Acquire sync guard
  const acquired = await acquireSyncGuard();
  if (!acquired) {
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
    // Check webhook health and auto-reactivate if stale
    const lastEvent = await getWebhookLastEvent();
    const webhookStale =
      lastEvent !== null && Date.now() - lastEvent * 1000 > 48 * 60 * 60 * 1000;

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

    const duration = Math.round((Date.now() - startTime) / 1000);

    // Notify on errors if Slack webhook is configured
    const hasErrors = snapshot.memberErrors.length > 0 || webhookStale;
    if (hasErrors && process.env.NOTIFICATION_WEBHOOK_URL) {
      await notifySlack(snapshot, webhookStale, webhookReactivated, duration).catch(() => {});
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
      summary: {
        tasksCompleted: snapshot.teamSummary.tasksCompleted,
        pipelineMovement: snapshot.teamSummary.pipelineMovement,
        returnForReview: snapshot.teamSummary.returnForReviewCount,
      },
    });
  } finally {
    await releaseSyncGuard();
  }
}

async function notifySlack(
  snapshot: import("@/lib/types").WeeklySnapshot,
  webhookStale: boolean,
  webhookReactivated: boolean,
  duration: number
): Promise<void> {
  const url = process.env.NOTIFICATION_WEBHOOK_URL;
  if (!url) return;

  const issues: string[] = [];
  if (webhookStale && webhookReactivated) {
    issues.push("Wrike webhook was stale (no events in 48h) — auto-reactivated successfully");
  } else if (webhookStale) {
    issues.push("Wrike webhook stale (no events in 48h) — auto-reactivation FAILED, manual intervention needed");
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
