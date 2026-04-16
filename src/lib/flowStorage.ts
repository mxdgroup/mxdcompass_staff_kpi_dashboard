import * as fs from "node:fs";
import * as path from "node:path";
import { getSharedRedis, isRedisAvailable } from "./storage";
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
// Public API
// ---------------------------------------------------------------------------

export async function saveFlowSnapshot(
  snapshot: FlowSnapshot,
): Promise<{ saved: boolean; reason?: string }> {
  // P4: Reject empty snapshots to prevent overwriting good data
  if (snapshot.tickets.length === 0) {
    const reason = "Flow snapshot rejected: 0 tickets (possible Wrike outage)";
    console.warn(`[flowStorage] ${reason}`);
    return { saved: false, reason };
  }

  const key = `${FLOW_PREFIX}${snapshot.week}`;
  const json = JSON.stringify(snapshot);

  // P6: Reuse shared Redis instance from storage.ts
  const redis = getSharedRedis();
  if (redis) {
    // P5: Atomic persistence via pipeline
    const pipe = redis.pipeline();
    pipe.set(key, json, { ex: TTL_SECONDS });
    pipe.set(FLOW_LATEST_KEY, snapshot.week);
    await pipe.exec();
    return { saved: true };
  }

  // Local file fallback
  ensureDataDir();
  fs.writeFileSync(localPath(key), json, "utf-8");
  fs.writeFileSync(localPath(FLOW_LATEST_KEY), JSON.stringify(snapshot.week), "utf-8");
  return { saved: true };
}

export async function getFlowSnapshot(
  week: string,
): Promise<FlowSnapshot | null> {
  const key = `${FLOW_PREFIX}${week}`;

  const redis = getSharedRedis();
  if (redis) {
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
  const redis = getSharedRedis();
  if (redis) {
    return redis.get<string>(FLOW_LATEST_KEY);
  }

  const fp = localPath(FLOW_LATEST_KEY);
  if (!fs.existsSync(fp)) return null;
  return JSON.parse(fs.readFileSync(fp, "utf-8")) as string;
}
