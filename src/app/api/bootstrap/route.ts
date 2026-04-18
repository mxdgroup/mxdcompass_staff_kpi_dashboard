import { NextResponse } from "next/server";
import { discoverWrikeConfig } from "@/lib/bootstrap";
import { buildFlowSnapshot } from "@/lib/flowBuilder";
import { saveFlowSnapshotWithGuard } from "@/lib/flowStorage";
import { buildWeeklySnapshot } from "@/lib/aggregator";
import { saveSnapshot, acquireSyncGuard, releaseSyncGuard } from "@/lib/storage";
import { getCurrentWeek } from "@/lib/week";

export const maxDuration = 300;

export async function POST(request: Request) {
  // P27: Require auth (same bearer token as cron)
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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
    // Step 1: Discover Wrike config (contacts, custom fields)
    console.log("[bootstrap] Step 1: Discovering Wrike config...");
    const overrides = await discoverWrikeConfig();

    // Step 2: Build weekly snapshot (for Team Velocity page)
    const week = getCurrentWeek();
    console.log(`[bootstrap] Step 2: Building weekly snapshot for ${week}...`);
    let weeklyError: string | null = null;
    let flowSaveError: string | undefined;
    try {
      const snapshot = await buildWeeklySnapshot(week);
      const weeklyResult = await saveSnapshot(snapshot);
      if (!weeklyResult.saved) {
        weeklyError = weeklyResult.reason ?? "Weekly snapshot save failed";
      } else {
        console.log(`[bootstrap] Weekly snapshot saved: ${snapshot.employees.length} employees`);
      }
    } catch (err) {
      weeklyError = err instanceof Error ? err.message : String(err);
      console.error("[bootstrap] Weekly snapshot failed:", weeklyError);
    }

    // Step 3: Build flow snapshot
    console.log("[bootstrap] Step 3: Building flow snapshot...");
    const flowSnapshot = await buildFlowSnapshot(week);
    const flowResult = await saveFlowSnapshotWithGuard(flowSnapshot);
    if (!flowResult.saved) {
      flowSaveError = flowResult.reason;
    } else {
      console.log(`[bootstrap] Flow snapshot saved: ${flowSnapshot.tickets.length} tickets`);
    }

    const duration = Math.round((Date.now() - startTime) / 1000);

    return NextResponse.json({
      ok: true,
      week,
      duration: `${duration}s`,
      contactsDiscovered: Object.keys(overrides.contactIds).length,
      effortFieldFound: !!overrides.effortCustomFieldId,
      flowTickets: flowSnapshot.tickets.length,
      weeklyError,
      flowSaveError,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[bootstrap] Failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  } finally {
    await releaseSyncGuard(guard.owner);
  }
}
