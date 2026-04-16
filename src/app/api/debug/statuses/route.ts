// Diagnostic endpoint: dumps resolved workflow statuses and cross-references
// with recent webhook transitions to find mismatches.
// Protected by CRON_SECRET Bearer auth.

import { NextResponse } from "next/server";
import { clearStatusCache, resolveWorkflowStatuses } from "@/lib/wrike/fetcher";
import { getTransitionsInRange } from "@/lib/wrike/transitions";
import { getCurrentWeek, getWeekRange } from "@/lib/week";
import { setCachedWorkflowStatuses } from "@/lib/storage";

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Clear both in-memory and Redis caches to force fresh resolution
  clearStatusCache();
  try {
    // Invalidate Redis cache by overwriting with empty (will be replaced by fresh data)
    await setCachedWorkflowStatuses({
      returnForReviewId: null,
      clientReviewId: null,
      completedIds: [],
      plannedIds: [],
      inProgressId: null,
      inReviewId: null,
      clientPendingId: null,
      allStatuses: [],
    });
  } catch {
    // Redis cache clear failed, continue anyway
  }

  // Resolve fresh from Wrike API
  const statuses = await resolveWorkflowStatuses();

  // Build lookup
  const knownIds = new Set(statuses.allStatuses.map((s) => s.id));
  const statusById = new Map(statuses.allStatuses.map((s) => [s.id, s.name]));

  // Check for duplicate names (different IDs, same name)
  const nameToIds = new Map<string, string[]>();
  for (const s of statuses.allStatuses) {
    const lower = s.name.toLowerCase();
    const arr = nameToIds.get(lower) ?? [];
    arr.push(s.id);
    nameToIds.set(lower, arr);
  }
  const duplicateNames = Array.from(nameToIds.entries())
    .filter(([, ids]) => ids.length > 1)
    .map(([name, ids]) => ({ name, ids }));

  // Get this week's transitions and check for unknown IDs
  const week = getCurrentWeek();
  const range = getWeekRange(week);
  const startTs = Math.floor(range.startTimestamp / 1000);
  const endTs = Math.floor(range.endTimestamp / 1000);
  const transitions = await getTransitionsInRange(startTs, endTs);

  const unknownStatusIds = new Set<string>();
  for (const t of transitions) {
    if (t.toStatusId && !knownIds.has(t.toStatusId)) unknownStatusIds.add(t.toStatusId);
    if (t.fromStatusId && !knownIds.has(t.fromStatusId)) unknownStatusIds.add(t.fromStatusId);
  }

  return NextResponse.json({
    week,
    resolvedStatuses: {
      returnForReviewId: statuses.returnForReviewId,
      clientReviewId: statuses.clientReviewId,
      completedIds: statuses.completedIds,
      plannedIds: statuses.plannedIds,
      inProgressId: statuses.inProgressId,
      inReviewId: statuses.inReviewId,
      clientPendingId: statuses.clientPendingId,
    },
    allStatuses: statuses.allStatuses.map((s) => ({
      id: s.id,
      name: s.name,
      group: s.group,
    })),
    duplicateNames,
    transitionsThisWeek: transitions.length,
    unknownStatusIds: Array.from(unknownStatusIds).map((id) => ({
      id,
      resolvedName: statusById.get(id) ?? "UNKNOWN",
    })),
    healthy: unknownStatusIds.size === 0 && duplicateNames.length === 0,
  });
}
