import crypto from "node:crypto";
import { getRedis } from "../redis";

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
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, "hex"),
      Buffer.from(signature, "hex"),
    );
  } catch {
    return false;
  }
}

// ---------- ISO-week helper ----------

function isoWeekKey(date: Date): string {
  const d = new Date(
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()),
  );
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

const TTL_SECONDS = 365 * 24 * 60 * 60;

export async function storeTransition(
  event: WrikeWebhookEvent,
): Promise<void> {
  const redis = getRedis();
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

  const dedupSetKey = `${key}:dedup`;
  const alreadyExists = await redis.sismember(dedupSetKey, dedupKey);
  if (alreadyExists) return;

  const memberValue = JSON.stringify({ ...entry, _dedup: dedupKey });

  const pipe = redis.pipeline();
  pipe.zadd(key, score, memberValue);
  pipe.sadd(dedupSetKey, dedupKey);

  const ttl = await redis.ttl(key);
  if (ttl === -1 || ttl === -2) {
    pipe.expire(key, TTL_SECONDS);
    pipe.expire(dedupSetKey, TTL_SECONDS);
  }

  pipe.set("kpi:webhook:last_event", String(Math.floor(Date.now() / 1000)));

  await pipe.exec();
}
