import { getRedis } from "./redis";
import type { WeeklySnapshot } from "./types";
import { getPriorWeeks } from "./week";

const SNAPSHOT_PREFIX = "kpi:snapshot:";
const LATEST_KEY = "kpi:latest";
const SYNC_GUARD_KEY = "kpi:sync:running";
const TTL_DAYS = 365;
const TTL_SECONDS = TTL_DAYS * 24 * 60 * 60;

// --- Snapshot Storage ---

export async function saveSnapshot(snapshot: WeeklySnapshot): Promise<void> {
  const redis = getRedis();
  const key = `${SNAPSHOT_PREFIX}${snapshot.week}`;
  await redis.set(key, JSON.stringify(snapshot), "EX", TTL_SECONDS);
  await redis.set(LATEST_KEY, snapshot.week);
}

export async function getSnapshot(week: string): Promise<WeeklySnapshot | null> {
  const redis = getRedis();
  const key = `${SNAPSHOT_PREFIX}${week}`;
  const data = await redis.get(key);
  if (!data) return null;
  return JSON.parse(data);
}

export async function getLatestWeek(): Promise<string | null> {
  const redis = getRedis();
  return redis.get(LATEST_KEY);
}

export async function getLatestSnapshot(): Promise<WeeklySnapshot | null> {
  const week = await getLatestWeek();
  if (!week) return null;
  return getSnapshot(week);
}

export async function getSnapshotWithHistory(
  week: string,
  historyCount: number = 4
): Promise<{ current: WeeklySnapshot | null; history: WeeklySnapshot[] }> {
  const current = await getSnapshot(week);
  const priorWeeks = getPriorWeeks(week, historyCount);
  const history: WeeklySnapshot[] = [];

  for (const w of priorWeeks) {
    const snap = await getSnapshot(w);
    if (snap) history.push(snap);
  }

  return { current, history };
}

// --- Sync Guard ---

export async function acquireSyncGuard(): Promise<boolean> {
  const redis = getRedis();
  const result = await redis.set(SYNC_GUARD_KEY, "1", "EX", 300, "NX");
  return result === "OK";
}

export async function releaseSyncGuard(): Promise<void> {
  const redis = getRedis();
  await redis.del(SYNC_GUARD_KEY);
}

// --- Workflow Cache ---

const WORKFLOW_CACHE_KEY = "kpi:workflow:statuses";
const WORKFLOW_CACHE_TTL = 24 * 60 * 60; // 24 hours

export interface CachedWorkflowStatuses {
  returnForReviewId: string | null;
  clientReviewId: string | null;
  completedIds: string[];
  allStatuses: Array<{ id: string; name: string; group: string }>;
}

export async function getCachedWorkflowStatuses(): Promise<CachedWorkflowStatuses | null> {
  const redis = getRedis();
  const data = await redis.get(WORKFLOW_CACHE_KEY);
  if (!data) return null;
  return JSON.parse(data);
}

export async function setCachedWorkflowStatuses(statuses: CachedWorkflowStatuses): Promise<void> {
  const redis = getRedis();
  await redis.set(WORKFLOW_CACHE_KEY, JSON.stringify(statuses), "EX", WORKFLOW_CACHE_TTL);
}

// --- Webhook Health ---

export async function getWebhookLastEvent(): Promise<number | null> {
  const redis = getRedis();
  const ts = await redis.get("kpi:webhook:last_event");
  return ts ? parseInt(ts, 10) : null;
}
