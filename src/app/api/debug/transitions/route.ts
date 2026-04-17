// Diagnostic endpoint: dump raw Redis transitions for a given taskId across
// one or more recent ISO weeks. Supports H6 diagnosis (merge/resolve drop) by
// making the underlying transition log inspectable without Upstash console access.
// Protected by CRON_SECRET Bearer auth.

import { NextResponse } from "next/server";
import { getTransitionsInRange } from "@/lib/wrike/transitions";
import { getCurrentWeek, getPriorWeeks, getWeekRange } from "@/lib/week";

const MAX_WEEKS = 8;
const DEFAULT_WEEKS = 2;

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const taskId = url.searchParams.get("taskId");
  if (!taskId) {
    return NextResponse.json(
      { error: "Missing ?taskId=<id> parameter" },
      { status: 400 },
    );
  }

  const weeksParam = url.searchParams.get("weeks");
  const parsedWeeks = weeksParam ? parseInt(weeksParam, 10) : DEFAULT_WEEKS;
  const requestedWeeks = Number.isFinite(parsedWeeks) && parsedWeeks > 0 ? parsedWeeks : DEFAULT_WEEKS;
  const effectiveWeeks = Math.min(requestedWeeks, MAX_WEEKS);
  const clamped = effectiveWeeks < requestedWeeks;

  // Build the list of week keys: current + (effectiveWeeks - 1) prior weeks
  const currentWeek = getCurrentWeek();
  const priorWeeks = effectiveWeeks > 1 ? getPriorWeeks(currentWeek, effectiveWeeks - 1) : [];
  const weekKeys = [currentWeek, ...priorWeeks];

  // Compute the overall timestamp range: start of the oldest week → end of the current week
  const oldestWeek = weekKeys[weekKeys.length - 1];
  const currentRange = getWeekRange(currentWeek);
  const oldestRange = getWeekRange(oldestWeek);
  const startTs = Math.floor(oldestRange.startTimestamp / 1000);
  const endTs = Math.floor(currentRange.endTimestamp / 1000);

  const allTransitions = await getTransitionsInRange(startTs, endTs);
  const matching = allTransitions
    .filter((t) => t.taskId === taskId)
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  if (matching.length === 0) {
    return NextResponse.json(
      {
        taskId,
        weeks: weekKeys,
        clamped,
        found: false,
        message: `No transitions found for task ${taskId} across weeks ${weekKeys.join(", ")}.`,
      },
      { status: 404 },
    );
  }

  return NextResponse.json({
    taskId,
    weeks: weekKeys,
    clamped,
    found: true,
    count: matching.length,
    transitions: matching.map((t) => ({
      timestamp: t.timestamp,
      fromStatusId: t.fromStatusId,
      toStatusId: t.toStatusId,
      eventAuthorId: t.eventAuthorId,
    })),
  });
}
