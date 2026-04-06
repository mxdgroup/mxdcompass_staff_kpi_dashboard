import { kv } from "@vercel/kv";
import { redisKeyForWeek, type TransitionEntry } from "./webhook";

const redis = kv;

// ---------- Helpers ----------

/** Enumerate all ISO-week keys that overlap with the given timestamp range. */
function weekKeysBetween(startTs: number, endTs: number): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  // Step day-by-day from start to end to collect unique week keys
  const msPerDay = 86_400_000;
  let cursor = startTs * 1000;
  const endMs = endTs * 1000;
  while (cursor <= endMs) {
    const key = redisKeyForWeek(new Date(cursor));
    if (!seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }
    cursor += msPerDay;
  }
  // Ensure the end date's week is included
  const lastKey = redisKeyForWeek(new Date(endMs));
  if (!seen.has(lastKey)) {
    keys.push(lastKey);
  }
  return keys;
}

function parseISORange(dateRange: {
  start: string;
  end: string;
}): { startTs: number; endTs: number } {
  const startTs = Math.floor(new Date(dateRange.start).getTime() / 1000);
  const endTs = Math.floor(new Date(dateRange.end).getTime() / 1000);
  return { startTs, endTs };
}

function parseMember(raw: string): TransitionEntry & { _dedup?: string } {
  return JSON.parse(raw) as TransitionEntry & { _dedup?: string };
}

// ---------- Core query ----------

export async function getTransitionsInRange(
  startTimestamp: number,
  endTimestamp: number,
): Promise<TransitionEntry[]> {
  const keys = weekKeysBetween(startTimestamp, endTimestamp);
  const results: TransitionEntry[] = [];

  for (const key of keys) {
    const members = (await redis.zrange(key, startTimestamp, endTimestamp, {
      byScore: true,
    })) as string[];
    for (const raw of members) {
      const entry = parseMember(typeof raw === "string" ? raw : JSON.stringify(raw));
      results.push({
        taskId: entry.taskId,
        fromStatusId: entry.fromStatusId,
        toStatusId: entry.toStatusId,
        timestamp: entry.timestamp,
        eventAuthorId: entry.eventAuthorId,
      });
    }
  }

  return results;
}

// ---------- Pipeline movement ----------

export async function getPipelineMovement(
  dateRange: { start: string; end: string },
): Promise<{ total: number; byMember: Record<string, number> }> {
  const { startTs, endTs } = parseISORange(dateRange);
  const transitions = await getTransitionsInRange(startTs, endTs);

  const tasksByMember = new Map<string, Set<string>>();
  const allTasks = new Set<string>();

  for (const t of transitions) {
    allTasks.add(t.taskId);
    const existing = tasksByMember.get(t.eventAuthorId) ?? new Set<string>();
    existing.add(t.taskId);
    tasksByMember.set(t.eventAuthorId, existing);
  }

  const byMember: Record<string, number> = {};
  for (const [memberId, tasks] of tasksByMember) {
    byMember[memberId] = tasks.size;
  }

  return { total: allTasks.size, byMember };
}

// ---------- Return-for-review count ----------

export async function getReturnForReviewCount(
  dateRange: { start: string; end: string },
  returnForReviewStatusId: string,
): Promise<{
  total: number;
  byMember: Record<string, number>;
  tasks: string[];
}> {
  const { startTs, endTs } = parseISORange(dateRange);
  const transitions = await getTransitionsInRange(startTs, endTs);

  const matched = transitions.filter(
    (t) => t.toStatusId === returnForReviewStatusId,
  );

  const taskSet = new Set<string>();
  const byMember: Record<string, number> = {};

  for (const t of matched) {
    taskSet.add(t.taskId);
    byMember[t.eventAuthorId] = (byMember[t.eventAuthorId] ?? 0) + 1;
  }

  return {
    total: matched.length,
    byMember,
    tasks: [...taskSet],
  };
}

// ---------- Approval cycle time ----------

export async function getApprovalCycleTime(
  dateRange: { start: string; end: string },
  ownerContactId: string,
  clientReviewStatusId: string,
  completedStatusIds: string[],
): Promise<{ medianHours: number | null; times: number[] }> {
  const { startTs, endTs } = parseISORange(dateRange);
  const transitions = await getTransitionsInRange(startTs, endTs);

  // Group transitions by taskId, sorted by timestamp
  const byTask = new Map<string, TransitionEntry[]>();
  for (const t of transitions) {
    const arr = byTask.get(t.taskId) ?? [];
    arr.push(t);
    byTask.set(t.taskId, arr);
  }

  const completedSet = new Set(completedStatusIds);
  const times: number[] = [];

  for (const [, taskTransitions] of byTask) {
    // Sort by timestamp ascending
    taskTransitions.sort(
      (a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );

    // Find pairs: transition TO clientReviewStatusId, then TO a completed status
    let reviewStart: number | null = null;

    for (const t of taskTransitions) {
      if (t.toStatusId === clientReviewStatusId) {
        reviewStart = new Date(t.timestamp).getTime();
      } else if (
        reviewStart !== null &&
        completedSet.has(t.toStatusId) &&
        t.eventAuthorId === ownerContactId
      ) {
        const durationHours =
          (new Date(t.timestamp).getTime() - reviewStart) / (1000 * 60 * 60);
        if (durationHours > 0) {
          times.push(durationHours);
        }
        reviewStart = null; // reset for next potential pair
      }
    }
  }

  if (times.length === 0) {
    return { medianHours: null, times: [] };
  }

  // Calculate median
  times.sort((a, b) => a - b);
  const mid = Math.floor(times.length / 2);
  const medianHours =
    times.length % 2 === 0
      ? (times[mid - 1] + times[mid]) / 2
      : times[mid];

  return {
    medianHours: Math.round(medianHours * 100) / 100,
    times,
  };
}
