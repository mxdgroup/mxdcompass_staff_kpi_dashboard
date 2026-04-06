import { kv } from "@vercel/kv";
import type { WeeklySnapshot } from "./types";
import { getPriorWeeks } from "./week";

const redis = kv;

const SNAPSHOT_PREFIX = "kpi:snapshot:";
const LATEST_KEY = "kpi:latest";
const SYNC_GUARD_KEY = "kpi:sync:running";
const TTL_DAYS = 365;
const TTL_SECONDS = TTL_DAYS * 24 * 60 * 60;

// --- Snapshot Storage ---

export async function saveSnapshot(snapshot: WeeklySnapshot): Promise<void> {
  const key = `${SNAPSHOT_PREFIX}${snapshot.week}`;
  await redis.set(key, JSON.stringify(snapshot), { ex: TTL_SECONDS });
  await redis.set(LATEST_KEY, snapshot.week);
}

export async function getSnapshot(week: string): Promise<WeeklySnapshot | null> {
  const key = `${SNAPSHOT_PREFIX}${week}`;
  const data = await redis.get<string>(key);
  if (!data) return null;
  return typeof data === "string" ? JSON.parse(data) : data as unknown as WeeklySnapshot;
}

export async function getLatestWeek(): Promise<string | null> {
  return redis.get<string>(LATEST_KEY);
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
  // SET NX returns true if key was set (no concurrent sync)
  const result = await redis.set(SYNC_GUARD_KEY, "1", { ex: 300, nx: true });
  return result === "OK";
}

export async function releaseSyncGuard(): Promise<void> {
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
  const data = await redis.get<string>(WORKFLOW_CACHE_KEY);
  if (!data) return null;
  return typeof data === "string" ? JSON.parse(data) : data as unknown as CachedWorkflowStatuses;
}

export async function setCachedWorkflowStatuses(statuses: CachedWorkflowStatuses): Promise<void> {
  await redis.set(WORKFLOW_CACHE_KEY, JSON.stringify(statuses), { ex: WORKFLOW_CACHE_TTL });
}

// --- Webhook Health ---

export async function getWebhookLastEvent(): Promise<number | null> {
  const ts = await redis.get<string>("kpi:webhook:last_event");
  return ts ? parseInt(ts, 10) : null;
}

// --- Generic Redis export ---

export { redis };
