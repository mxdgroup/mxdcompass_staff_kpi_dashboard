import { loadOverridesFromRedis, getUnmappedMembers } from "@/lib/bootstrap";
import { config } from "@/lib/config";
import { NextResponse } from "next/server";
import { acquireSyncGuard, releaseSyncGuard, saveSnapshot } from "@/lib/storage";
import { buildWeeklySnapshot } from "@/lib/aggregator";
import { buildFlowSnapshot } from "@/lib/flowBuilder";
import { saveFlowSnapshot } from "@/lib/flowStorage";
import { getCurrentWeek } from "@/lib/week";

export const maxDuration = 300;

export async function POST(request: Request) {
  // P27: Require auth (same bearer token as cron)
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // P22: Fail if overrides can't load — blank contact IDs produce empty snapshots
  const overrideResult = await loadOverridesFromRedis();
  if (!overrideResult.loaded) {
    return NextResponse.json(
      { error: `Config override load failed: ${overrideResult.error}` },
      { status: 500 },
    );
  }

  // P23: Reject if all members are unmapped (bootstrap never ran or overrides corrupt)
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
      { status: 409 }
    );
  }

  try {
    const week = getCurrentWeek();
    const snapshot = await buildWeeklySnapshot(week);
    await saveSnapshot(snapshot);

    // Build flow dashboard snapshot
    const flowSnapshot = await buildFlowSnapshot(week);
    await saveFlowSnapshot(flowSnapshot);

    const duration = Math.round((Date.now() - startTime) / 1000);

    return NextResponse.json({
      ok: true,
      week,
      duration: `${duration}s`,
      membersProcessed: snapshot.employees.length,
      memberErrors: snapshot.memberErrors.length,
      flowTickets: flowSnapshot.tickets.length,
    });
  } finally {
    await releaseSyncGuard(guard.owner);
  }
}
