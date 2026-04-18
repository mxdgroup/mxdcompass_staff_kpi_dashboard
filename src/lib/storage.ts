import { Redis } from "@upstash/redis";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { WeeklySnapshot } from "./types";
import { getPriorWeeks } from "./week";

// ---------------------------------------------------------------------------
// Dual-mode storage: Redis when available, local JSON files when not
// ---------------------------------------------------------------------------

const DATA_DIR = path.join(process.cwd(), ".data");

const hasRedis =
  !!process.env.UPSTASH_REDIS_REST_URL &&
  !!process.env.UPSTASH_REDIS_REST_TOKEN;

let _redis: Redis | null = null;
function getRedis(): Redis | null {
  if (!hasRedis) return null;
  if (!_redis) _redis = Redis.fromEnv();
  return _redis;
}

// Re-export for modules that need direct Redis access
export const redis = hasRedis ? Redis.fromEnv() : (null as unknown as Redis);

/** Lazy Redis getter for modules that need it after cold start. */
export function getSharedRedis(): Redis | null {
  return getRedis();
}

// ---------------------------------------------------------------------------
// Local file helpers
// ---------------------------------------------------------------------------

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function localPath(key: string): string {
  // Sanitize key: replace colons with dashes for filesystem
  const safe = key.replace(/:/g, "-");
  return path.join(DATA_DIR, `${safe}.json`);
}

async function localGet<T>(key: string): Promise<T | null> {
  const fp = localPath(key);
  if (!fs.existsSync(fp)) return null;
  const raw = fs.readFileSync(fp, "utf-8");
  return JSON.parse(raw) as T;
}

async function localSet(key: string, value: string): Promise<void> {
  ensureDataDir();
  fs.writeFileSync(localPath(key), value, "utf-8");
}

async function localDel(key: string): Promise<void> {
  const fp = localPath(key);
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
}

// ---------------------------------------------------------------------------
// Generic get/set that route to Redis or local
// ---------------------------------------------------------------------------

async function kvGet<T>(key: string): Promise<T | null> {
  const r = getRedis();
  if (r) {
    // Upstash auto-parses JSON, so r.get() returns the parsed value directly.
    const data = await r.get<T>(key);
    if (data === null || data === undefined) return null;
    return data;
  }
  return localGet<T>(key);
}

async function kvSet(key: string, value: string, _ttl?: number): Promise<void> {
  const r = getRedis();
  if (r) {
    if (_ttl) {
      await r.set(key, value, { ex: _ttl });
    } else {
      await r.set(key, value);
    }
    return;
  }
  await localSet(key, value);
}

async function kvDel(key: string): Promise<void> {
  const r = getRedis();
  if (r) {
    await r.del(key);
    return;
  }
  await localDel(key);
}

// ---------------------------------------------------------------------------
// Public: Redis availability check
// ---------------------------------------------------------------------------

export function isRedisAvailable(): boolean {
  return hasRedis;
}

// ---------------------------------------------------------------------------
// Generic guard helpers
// ---------------------------------------------------------------------------

async function acquireGuard(
  key: string,
  ttlSeconds: number,
): Promise<SyncGuardResult> {
  if (!hasRedis) {
    if (process.env.VERCEL) {
      console.error(`[storage] Redis unavailable in production — guard failed closed (${key})`);
      return { acquired: false, owner: "" };
    }
    return { acquired: true, owner: "local" };
  }

  const owner = crypto.randomUUID();
  const r = getRedis()!;
  const result = await r.set(key, owner, { ex: ttlSeconds, nx: true });
  return { acquired: result === "OK", owner };
}

async function releaseGuard(key: string, owner: string): Promise<void> {
  if (!hasRedis || owner === "local") return;
  const r = getRedis()!;
  const script = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;
  try {
    await r.eval(script, [key], [owner]);
  } catch (err) {
    console.warn(`[storage] Lua eval failed for ${key}; letting lock expire via TTL:`, err);
  }
}

// ---------------------------------------------------------------------------
// Snapshot Storage
// ---------------------------------------------------------------------------

const SNAPSHOT_PREFIX = "kpi:snapshot:";
const LATEST_KEY = "kpi:latest";
const TTL_SECONDS = 365 * 24 * 60 * 60;

export async function saveSnapshot(
  snapshot: WeeklySnapshot,
): Promise<{ saved: boolean; reason?: string }> {
  // P4: Reject empty snapshots to prevent overwriting good data
  if (snapshot.employees.length === 0) {
    const reason = "Snapshot rejected: 0 employees (possible Wrike outage)";
    console.warn(`[storage] ${reason}`);
    return { saved: false, reason };
  }

  const key = `${SNAPSHOT_PREFIX}${snapshot.week}`;
  const json = JSON.stringify(snapshot);

  // P5: Atomic persistence via pipeline when Redis available
  const r = getRedis();
  if (r) {
    const pipe = r.pipeline();
    pipe.set(key, json, { ex: TTL_SECONDS });
    pipe.set(LATEST_KEY, snapshot.week);
    await pipe.exec();
    return { saved: true };
  }

  // Local file fallback (non-atomic, acceptable for dev)
  // P30: Wrap in try-catch — Vercel's read-only FS will throw
  try {
    await kvSet(key, json, TTL_SECONDS);
    await kvSet(LATEST_KEY, snapshot.week);
    return { saved: true };
  } catch (err) {
    const reason = `Local file write failed: ${err instanceof Error ? err.message : String(err)}`;
    console.warn(`[storage] ${reason}`);
    return { saved: false, reason };
  }
}

export async function getSnapshot(week: string): Promise<WeeklySnapshot | null> {
  return kvGet<WeeklySnapshot>(`${SNAPSHOT_PREFIX}${week}`);
}

export async function getLatestWeek(): Promise<string | null> {
  return kvGet<string>(LATEST_KEY);
}

export async function getLatestSnapshot(): Promise<WeeklySnapshot | null> {
  const week = await getLatestWeek();
  if (!week) return null;
  return getSnapshot(week);
}

export async function getSnapshotWithHistory(
  week: string,
  historyCount: number = 4,
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

// ---------------------------------------------------------------------------
// Sync Guard
// ---------------------------------------------------------------------------

const SYNC_GUARD_KEY = "kpi:sync:running";
const SYNC_GUARD_TTL = 600; // 2x maxDuration (P2: lock outlives function)

export interface SyncGuardResult {
  acquired: boolean;
  owner: string;
}

export async function acquireSyncGuard(): Promise<SyncGuardResult> {
  return acquireGuard(SYNC_GUARD_KEY, SYNC_GUARD_TTL);
}

export async function releaseSyncGuard(owner: string): Promise<void> {
  await releaseGuard(SYNC_GUARD_KEY, owner);
}

// ---------------------------------------------------------------------------
// Catchup Guard — prevents overlapping catch-up cron runs
// ---------------------------------------------------------------------------

const CATCHUP_GUARD_KEY = "kpi:catchup:running";
const CATCHUP_GUARD_TTL = 600; // 2x maxDuration — lock outlives the function

export interface CatchupGuardResult {
  acquired: boolean;
  owner: string;
}

export async function acquireCatchupGuard(): Promise<CatchupGuardResult> {
  return acquireGuard(CATCHUP_GUARD_KEY, CATCHUP_GUARD_TTL);
}

export async function releaseCatchupGuard(owner: string): Promise<void> {
  await releaseGuard(CATCHUP_GUARD_KEY, owner);
}

// ---------------------------------------------------------------------------
// Flow Snapshot Guard — prevents overlapping writes to the same week snapshot
// ---------------------------------------------------------------------------

const FLOW_SNAPSHOT_GUARD_TTL = 600;

function flowSnapshotGuardKey(week: string): string {
  return `kpi:flow:write:${week}`;
}

export async function acquireFlowSnapshotGuard(
  week: string,
): Promise<SyncGuardResult> {
  return acquireGuard(flowSnapshotGuardKey(week), FLOW_SNAPSHOT_GUARD_TTL);
}

interface GuardRetryOptions {
  attempts?: number;
  delayMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function acquireFlowSnapshotGuardWithRetry(
  week: string,
  options: GuardRetryOptions = {},
): Promise<SyncGuardResult> {
  const attempts = Math.max(options.attempts ?? 1, 1);
  const delayMs = Math.max(options.delayMs ?? 250, 0);

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const result = await acquireFlowSnapshotGuard(week);
    if (result.acquired) return result;
    if (attempt < attempts) {
      await sleep(delayMs);
    }
  }

  return { acquired: false, owner: "" };
}

export async function releaseFlowSnapshotGuard(
  week: string,
  owner: string,
): Promise<void> {
  await releaseGuard(flowSnapshotGuardKey(week), owner);
}

// ---------------------------------------------------------------------------
// Workflow Cache
// ---------------------------------------------------------------------------

const WORKFLOW_CACHE_KEY = "kpi:workflow:statuses";

export interface CachedWorkflowStatuses {
  returnForReviewId: string | null;
  clientReviewId: string | null;
  completedIds: string[];
  plannedIds: string[];
  inProgressId: string | null;
  inReviewId: string | null;
  clientPendingId: string | null;
  allStatuses: Array<{ id: string; name: string; group: string }>;
}

export async function getCachedWorkflowStatuses(): Promise<CachedWorkflowStatuses | null> {
  return kvGet<CachedWorkflowStatuses>(WORKFLOW_CACHE_KEY);
}

export async function setCachedWorkflowStatuses(
  statuses: CachedWorkflowStatuses,
): Promise<void> {
  const ttl = 24 * 60 * 60;
  await kvSet(WORKFLOW_CACHE_KEY, JSON.stringify(statuses), ttl);
}

export async function clearCachedWorkflowStatuses(): Promise<void> {
  await kvDel(WORKFLOW_CACHE_KEY);
}

// ---------------------------------------------------------------------------
// Webhook Health
// ---------------------------------------------------------------------------

export async function getWebhookLastEvent(): Promise<number | null> {
  const ts = await kvGet<string>("kpi:webhook:last_event");
  return ts ? parseInt(ts, 10) : null;
}
