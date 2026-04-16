// Server-side bootstrap trigger — no Bearer auth needed.
// The frontend calls this instead of /api/bootstrap (which requires CRON_SECRET).

import { NextResponse } from "next/server";
import { discoverWrikeConfig } from "@/lib/bootstrap";
import { buildFlowSnapshot } from "@/lib/flowBuilder";
import { saveFlowSnapshot } from "@/lib/flowStorage";
import { buildWeeklySnapshot } from "@/lib/aggregator";
import { saveSnapshot, acquireSyncGuard, releaseSyncGuard } from "@/lib/storage";
import { getCurrentWeek } from "@/lib/week";

export const maxDuration = 300;

export async function POST() {
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
    console.log("[bootstrap/trigger] Step 1: Discovering Wrike config...");
    const overrides = await discoverWrikeConfig();

    // Step 2: Build weekly snapshot
    const week = getCurrentWeek();
    console.log(`[bootstrap/trigger] Step 2: Building weekly snapshot for ${week}...`);
    let weeklyError: string | null = null;
    try {
      const snapshot = await buildWeeklySnapshot(week);
      const result = await saveSnapshot(snapshot);
      if (!result.saved) weeklyError = result.reason ?? "Save failed";
      else console.log(`[bootstrap/trigger] Weekly snapshot saved: ${snapshot.employees.length} employees`);
    } catch (err) {
      weeklyError = err instanceof Error ? err.message : String(err);
      console.error("[bootstrap/trigger] Weekly snapshot failed:", weeklyError);
    }

    // Step 3: Build flow snapshot
    console.log("[bootstrap/trigger] Step 3: Building flow snapshot...");
    const flowSnapshot = await buildFlowSnapshot(week);
    const flowResult = await saveFlowSnapshot(flowSnapshot);
    if (flowResult.saved) {
      console.log(`[bootstrap/trigger] Flow snapshot saved: ${flowSnapshot.tickets.length} tickets`);
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
      flowSaveError: !flowResult.saved ? flowResult.reason : undefined,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[bootstrap/trigger] Failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  } finally {
    await releaseSyncGuard(guard.owner);
  }
}
