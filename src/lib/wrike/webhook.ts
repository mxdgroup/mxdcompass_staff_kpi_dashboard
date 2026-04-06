import crypto from "node:crypto";
import { kv } from "@vercel/kv";

const redis = kv;

// ---------- Types ----------

export interface WrikeWebhookEvent {
  webhookId: string;
  eventAuthorId: string;
  eventType: string;
  taskId: string;
  oldCustomStatusId: string;
  customStatusId: string;
  lastUpdatedDate: string;
}

export interface TransitionEntry {
  taskId: string;
  fromStatusId: string;
  toStatusId: string;
  timestamp: string;
  eventAuthorId: string;
}

// ---------- Signature validation ----------

export function validateSignature(body: string, signature: string): boolean {
  const secret = process.env.WRIKE_WEBHOOK_SECRET;
  if (!secret) {
    console.error("WRIKE_WEBHOOK_SECRET is not set");
    return false;
  }
  const expected = crypto
    .createHmac("sha256", secret)
    .update(body, "utf8")
    .digest("hex");
  return crypto.timingSafeEqual(
    Buffer.from(expected, "hex"),
    Buffer.from(signature, "hex"),
  );
}

// ---------- ISO-week helper ----------

/** Returns ISO week string like "2026-W15" for a given date. */
function isoWeekKey(date: Date): string {
  // Algorithm: ISO 8601 week date
  const d = new Date(
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()),
  );
  // Set to nearest Thursday: current date + 4 - current day number (Mon=1..Sun=7)
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(
    ((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7,
  );
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

export function redisKeyForWeek(date: Date): string {
  return `kpi:transitions:${isoWeekKey(date)}`;
}

// ---------- Store transition ----------

const TTL_SECONDS = 365 * 24 * 60 * 60; // 365 days

export async function storeTransition(
  event: WrikeWebhookEvent,
): Promise<void> {
  const eventDate = new Date(event.lastUpdatedDate);
  const score = Math.floor(eventDate.getTime() / 1000);
  const key = redisKeyForWeek(eventDate);

  const dedupKey = `${event.taskId}:${event.oldCustomStatusId}:${event.customStatusId}`;

  const entry: TransitionEntry = {
    taskId: event.taskId,
    fromStatusId: event.oldCustomStatusId,
    toStatusId: event.customStatusId,
    timestamp: event.lastUpdatedDate,
    eventAuthorId: event.eventAuthorId,
  };

  // Dedup: check if a member with this dedupKey already exists.
  // Members are stored as JSON with a _dedup field for fast checking.
  const memberValue = JSON.stringify({ ...entry, _dedup: dedupKey });

  // Check existing members for this dedup key (scan the sorted set).
  // For efficiency we use a simple approach: store a dedup set alongside.
  const dedupSetKey = `${key}:dedup`;
  const alreadyExists = await redis.sismember(dedupSetKey, dedupKey);
  if (alreadyExists) {
    return; // duplicate, skip
  }

  // Use a pipeline for atomicity
  const pipe = redis.pipeline();
  pipe.zadd(key, { score, member: memberValue });
  pipe.sadd(dedupSetKey, dedupKey);

  // Set TTL only on first insert (use expire with NX semantics).
  // Upstash doesn't have EXPIRE NX directly, so we check TTL first.
  const ttl = await redis.ttl(key);
  if (ttl === -1 || ttl === -2) {
    // -2 means key doesn't exist yet, -1 means no TTL set
    pipe.expire(key, TTL_SECONDS);
    pipe.expire(dedupSetKey, TTL_SECONDS);
  }

  pipe.set("kpi:webhook:last_event", Math.floor(Date.now() / 1000));

  await pipe.exec();
}
