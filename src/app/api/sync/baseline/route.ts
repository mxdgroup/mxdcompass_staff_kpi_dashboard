import { loadRuntimeOverrides, getUnmappedMembers } from "@/lib/bootstrap";
import { config } from "@/lib/config";
import { NextResponse } from "next/server";
import { acquireSyncGuard, releaseSyncGuard, saveSnapshot, getSharedRedis } from "@/lib/storage";
import { buildWeeklySnapshot } from "@/lib/aggregator";
import { buildFlowSnapshot } from "@/lib/flowBuilder";
import { saveFlowSnapshotWithGuard } from "@/lib/flowStorage";
import { getCurrentWeek, getWeekRange } from "@/lib/week";
import { resolveWorkflowStatuses, fetchClientTasks } from "@/lib/wrike/fetcher";
import { redisKeyForWeek, type TransitionEntry } from "@/lib/wrike/webhook";
import { BASELINE_AUTHOR_ID } from "@/lib/wrike/transitions";

export const maxDuration = 300;

/**
 * POST /api/sync/baseline
 *
 * Seeds a baseline transition for every active (non-completed) task with
 * today's timestamp, then runs a full sync. This resets all "time in status"
 * counters to 0 so measurement starts fresh from today.
 *
 * Baseline transitions are stored in the same Redis sorted sets as real
 * webhook events, so future syncs naturally build on top of them.
 * They are excluded from weekly metric queries (pipeline movement, return-for-review,
 * approval cycle time) by the BASELINE_AUTHOR_ID filter in transitions.ts.
 *
 * Atomicity: all client folders must fetch successfully before any transitions
 * are seeded. If any folder fails, the entire operation is aborted.
 *
 * Idempotency: the member value uses a stable key (task ID + status ID) without
 * the timestamp, so ZADD NX makes retries true no-ops within the same week.
 */
export async function POST(request: Request) {
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const overrideResult = await loadRuntimeOverrides();
  if (!overrideResult.loaded) {
    return NextResponse.json(
      { error: `Config override load failed: ${overrideResult.error}` },
      { status: 500 },
    );
  }

  const unmapped = getUnmappedMembers();
  if (unmapped.length === config.team.length) {
    return NextResponse.json(
      { error: "All team members unmapped — run bootstrap first" },
      { status: 500 },
    );
  }

  const startTime = Date.now();

  const guard = await acquireSyncGuard();
  if (!guard.acquired) {
    return NextResponse.json(
      { error: "Sync already in progress" },
      { status: 409 },
    );
  }

  try {
    const now = new Date();
    const nowIso = now.toISOString();
    const score = Math.floor(now.getTime() / 1000);
    const week = getCurrentWeek();

    // Resolve workflow statuses to identify completed IDs
    const statuses = await resolveWorkflowStatuses();
    const completedIds = new Set(statuses.completedIds);

    const { start: weekStart, end: weekEnd } = getWeekRange(week);

    // Phase 1: Fetch ALL client folders. Abort if any fail.
    const clientData: Array<{
      clientName: string;
      tasks: Awaited<ReturnType<typeof fetchClientTasks>>["tasks"];
    }> = [];

    for (const client of config.clients) {
      let data;
      try {
        data = await fetchClientTasks(client.wrikeFolderId, {
          start: weekStart,
          end: weekEnd,
        });
      } catch (err) {
        const msg = `Failed to fetch ${client.name}: ${err instanceof Error ? err.message : String(err)}`;
        console.error(`[baseline] ${msg} — aborting baseline (no transitions seeded)`);
        return NextResponse.json(
          { error: `Baseline aborted: ${msg}. No transitions were seeded.` },
          { status: 500 },
        );
      }
      clientData.push({ clientName: client.name, tasks: data.tasks });
    }

    // Phase 2: All fetches succeeded. Collect active tasks to seed.
    interface SeedEntry {
      taskId: string;
      customStatusId: string;
      statusName: string;
      clientName: string;
    }
    const toSeed: SeedEntry[] = [];
    let skippedCompleted = 0;
    const statusBreakdown: Record<string, number> = {};
    const clientBreakdown: Record<string, number> = {};

    for (const { clientName, tasks } of clientData) {
      for (const task of tasks) {
        if (task.customStatusId && completedIds.has(task.customStatusId)) {
          skippedCompleted++;
          continue;
        }
        if (!task.customStatusId) continue;

        const statusObj = statuses.allStatuses.find(
          (s) => s.id === task.customStatusId,
        );
        const statusName = statusObj?.name ?? "Unknown";

        toSeed.push({
          taskId: task.id,
          customStatusId: task.customStatusId,
          statusName,
          clientName,
        });

        statusBreakdown[statusName] = (statusBreakdown[statusName] ?? 0) + 1;
        clientBreakdown[clientName] = (clientBreakdown[clientName] ?? 0) + 1;
      }
    }

    // Phase 3: Seed baseline transitions into Redis.
    const redis = getSharedRedis();
    if (redis && toSeed.length > 0) {
      const key = redisKeyForWeek(now);
      const dedupSetKey = `${key}:dedup`;
      const TTL_SECONDS = 365 * 24 * 60 * 60;

      let ttl = -2;
      let canSeedBaseline = true;
      try {
        ttl = await redis.ttl(key);
      } catch (err) {
        canSeedBaseline = false;
        console.warn(
          `[sync/baseline] Redis TTL lookup failed; skipping baseline seeding: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      const needsTtl = ttl === -1 || ttl === -2;

      if (canSeedBaseline) {
        for (const seed of toSeed) {
          // Stable dedup key: task + status, no timestamp. Retries within the same
          // week produce the same member value, so ZADD NX is a true no-op.
          const dedupKey = `baseline:${seed.taskId}:${seed.customStatusId}`;

          const entry: TransitionEntry = {
            taskId: seed.taskId,
            fromStatusId: "",
            toStatusId: seed.customStatusId,
            timestamp: nowIso,
            eventAuthorId: BASELINE_AUTHOR_ID,
          };

          const memberValue = JSON.stringify({ ...entry, _dedup: dedupKey });

          const pipe = redis.pipeline();
          pipe.sadd(dedupSetKey, dedupKey);
          pipe.zadd(key, { nx: true }, { score, member: memberValue });

          if (needsTtl) {
            pipe.expire(key, TTL_SECONDS);
            pipe.expire(dedupSetKey, TTL_SECONDS);
          }

          try {
            await pipe.exec();
          } catch (err) {
            console.warn(
              `[sync/baseline] Redis pipeline failed; stopping baseline seeding: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
            break;
          }
        }
      }
    }

    // Phase 4: Run full sync to rebuild snapshots with baseline data.
    const snapshot = await buildWeeklySnapshot(week);
    const weeklyResult = await saveSnapshot(snapshot);

    const flowSnapshot = await buildFlowSnapshot(week);
    const flowResult = await saveFlowSnapshotWithGuard(flowSnapshot);

    const duration = Math.round((Date.now() - startTime) / 1000);

    const saveErrors: string[] = [];
    if (!weeklyResult.saved) saveErrors.push(`Weekly: ${weeklyResult.reason}`);
    if (!flowResult.saved) saveErrors.push(`Flow: ${flowResult.reason}`);

    return NextResponse.json({
      ok: saveErrors.length === 0,
      baselineTimestamp: nowIso,
      week,
      duration: `${duration}s`,
      seededTasks: toSeed.length,
      skippedCompleted,
      statusBreakdown,
      clientBreakdown,
      flowTickets: flowSnapshot.tickets.length,
      saveErrors: saveErrors.length > 0 ? saveErrors : undefined,
    });
  } finally {
    await releaseSyncGuard(guard.owner);
  }
}
