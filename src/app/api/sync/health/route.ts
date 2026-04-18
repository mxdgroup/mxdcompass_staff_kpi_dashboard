import { NextResponse } from "next/server";
import { getFlowSnapshot, getFlowLatestWeek } from "@/lib/flowStorage";
import { getWebhookLastEvent, getSharedRedis } from "@/lib/storage";
import { WEBHOOK_ID_KEY } from "@/lib/wrike/webhookRegistrar";

/**
 * GET /api/sync/health
 *
 * Read-only health check for the sync pipeline. Returns:
 * - Snapshot freshness / overall sync health
 * - Webhook delivery recency as a separate degraded signal
 * - Task counts by status and client
 * - Cron schedule info
 *
 * No auth required — exposes only aggregate counts, no task details.
 */
export async function GET() {
  const latestWeek = await getFlowLatestWeek();

  let lastSyncedAt: string | null = null;
  let trackedTasks = 0;
  const tasksByStatus: Record<string, number> = {};
  const tasksByClient: Record<string, number> = {};

  if (latestWeek) {
    const snapshot = await getFlowSnapshot(latestWeek);
    if (snapshot) {
      lastSyncedAt = snapshot.syncedAt;
      trackedTasks = snapshot.tickets.length;

      for (const ticket of snapshot.tickets) {
        const stage = ticket.currentStage;
        tasksByStatus[stage] = (tasksByStatus[stage] ?? 0) + 1;
        tasksByClient[ticket.clientName] =
          (tasksByClient[ticket.clientName] ?? 0) + 1;
      }
    }
  }

  const lastWebhookEvent = await getWebhookLastEvent();
  const webhookHealthy =
    lastWebhookEvent !== null &&
    Date.now() - lastWebhookEvent * 1000 < 48 * 60 * 60 * 1000;
  const syncHealthy = lastSyncedAt !== null;
  const degraded = syncHealthy && !webhookHealthy;
  const issues: string[] = [];

  if (!syncHealthy) {
    issues.push("No flow snapshot has been synced yet");
  }
  if (!webhookHealthy) {
    issues.push("No TaskStatusChanged webhook deliveries observed in the last 48h");
  }

  const redis = getSharedRedis();
  const registeredWebhookId = redis
    ? await redis.get<string>(WEBHOOK_ID_KEY)
    : null;

  return NextResponse.json({
    healthy: syncHealthy,
    syncHealthy,
    degraded,
    issues,
    lastSyncedAt,
    latestWeek,
    lastWebhookEvent: lastWebhookEvent
      ? new Date(lastWebhookEvent * 1000).toISOString()
      : null,
    webhookHealthy,
    registeredWebhookId,
    trackedTasks,
    tasksByStatus,
    tasksByClient,
    cronSchedule: "3x daily (00:00, 02:20, 12:00 UTC)",
  });
}
