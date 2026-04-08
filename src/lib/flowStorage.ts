import * as fs from "node:fs";
import * as path from "node:path";
import { isRedisAvailable } from "./storage";
import type { FlowSnapshot } from "./types";

const DATA_DIR = path.join(process.cwd(), ".data");
const FLOW_PREFIX = "kpi:flow:";
const FLOW_LATEST_KEY = "kpi:flow:latest";
const TTL_SECONDS = 365 * 24 * 60 * 60;

// ---------------------------------------------------------------------------
// Local file helpers (same pattern as storage.ts)
// ---------------------------------------------------------------------------

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function localPath(key: string): string {
  const safe = key.replace(/:/g, "-");
  return path.join(DATA_DIR, `${safe}.json`);
}

// ---------------------------------------------------------------------------
// Redis helpers (lazy import to avoid crash when Redis unavailable)
// ---------------------------------------------------------------------------

async function getRedis() {
  if (!isRedisAvailable()) return null;
  const { Redis } = await import("@upstash/redis");
  return Redis.fromEnv();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function saveFlowSnapshot(snapshot: FlowSnapshot): Promise<void> {
  const key = `${FLOW_PREFIX}${snapshot.week}`;
  const json = JSON.stringify(snapshot);

  const redis = await getRedis();
  if (redis) {
    await redis.set(key, json, { ex: TTL_SECONDS });
    await redis.set(FLOW_LATEST_KEY, snapshot.week);
    return;
  }

  // Local file fallback
  ensureDataDir();
  fs.writeFileSync(localPath(key), json, "utf-8");
  fs.writeFileSync(localPath(FLOW_LATEST_KEY), JSON.stringify(snapshot.week), "utf-8");
}

export async function getFlowSnapshot(
  week: string,
): Promise<FlowSnapshot | null> {
  const key = `${FLOW_PREFIX}${week}`;

  const redis = await getRedis();
  if (redis) {
    // Upstash auto-parses JSON, returns the object directly
    const data = await redis.get<FlowSnapshot>(key);
    if (!data) return null;
    return data;
  }

  // Local file fallback
  const fp = localPath(key);
  if (!fs.existsSync(fp)) return null;
  return JSON.parse(fs.readFileSync(fp, "utf-8")) as FlowSnapshot;
}

export async function getFlowLatestWeek(): Promise<string | null> {
  const redis = await getRedis();
  if (redis) {
    return redis.get<string>(FLOW_LATEST_KEY);
  }

  const fp = localPath(FLOW_LATEST_KEY);
  if (!fs.existsSync(fp)) return null;
  return JSON.parse(fs.readFileSync(fp, "utf-8")) as string;
}
