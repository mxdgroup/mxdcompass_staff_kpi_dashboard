import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { acquireSyncGuard, releaseSyncGuard, saveSnapshot } from "@/lib/storage";
import { buildWeeklySnapshot } from "@/lib/aggregator";
import { getCurrentWeek } from "@/lib/week";
import { config } from "@/lib/config";

export const maxDuration = 300;

export async function POST() {
  const authed = await isAuthenticated();
  if (!authed) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Check config is populated
  const hasTeam = config.team.some((m) => m.wrikeContactId !== "");
  const hasFolders = config.wrikeFolderIds.length > 0;
  if (!hasTeam || !hasFolders) {
    return NextResponse.json({
      error: "Config not populated",
      details: {
        hasTeamContactIds: hasTeam,
        hasFolderIds: hasFolders,
        hint: "Call GET /api/setup to discover Wrike contacts and folders, then update src/lib/config.ts",
      },
    }, { status: 400 });
  }

  const startTime = Date.now();

  const acquired = await acquireSyncGuard();
  if (!acquired) {
    return NextResponse.json({ error: "Sync already in progress" }, { status: 409 });
  }

  try {
    const week = getCurrentWeek();
    const snapshot = await buildWeeklySnapshot(week);
    await saveSnapshot(snapshot);

    const duration = Math.round((Date.now() - startTime) / 1000);

    return NextResponse.json({
      ok: true,
      week,
      duration: `${duration}s`,
      membersProcessed: snapshot.employees.length,
      memberErrors: snapshot.memberErrors.length,
      errors: snapshot.memberErrors,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: "Sync failed", details: message }, { status: 500 });
  } finally {
    await releaseSyncGuard();
  }
}
