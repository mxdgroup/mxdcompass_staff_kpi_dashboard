import crypto from "node:crypto";
import { redis as redisClient } from "../storage";

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

// ---------- Webhook secret storage ----------

const WEBHOOK_SECRET_KEY = "kpi:webhook:secret";

export async function storeWebhookSecret(secret: string): Promise<void> {
  if (!redisClient) {
    console.error("[webhook] No Redis available, cannot store secret");
    return;
  }
  await redisClient.set(WEBHOOK_SECRET_KEY, secret);
  console.log("[webhook] Handshake secret stored in Redis");
}

async function getWebhookSecret(): Promise<string | null> {
  if (redisClient) {
    const stored = await redisClient.get<string>(WEBHOOK_SECRET_KEY);
    if (stored) return stored;
  }
  return process.env.WRIKE_WEBHOOK_SECRET ?? null;
}

// ---------- Signature validation ----------

export async function validateSignature(body: string, signature: string): Promise<boolean> {
  const secret = await getWebhookSecret();
  if (!secret) {
    console.error("[webhook] No webhook secret available (not in Redis or env)");
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
  if (!redisClient) return;

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

  const memberValue = JSON.stringify({ ...entry, _dedup: dedupKey });

  const dedupSetKey = `${key}:dedup`;
  const alreadyExists = await redisClient.sismember(dedupSetKey, dedupKey);
  if (alreadyExists) return;

  const pipe = redisClient.pipeline();
  pipe.zadd(key, { score, member: memberValue });
  pipe.sadd(dedupSetKey, dedupKey);

  const ttl = await redisClient.ttl(key);
  if (ttl === -1 || ttl === -2) {
    pipe.expire(key, TTL_SECONDS);
    pipe.expire(dedupSetKey, TTL_SECONDS);
  }

  pipe.set("kpi:webhook:last_event", Math.floor(Date.now() / 1000));

  await pipe.exec();
  console.log(`[webhook] Stored transition: ${event.taskId} ${event.oldCustomStatusId} -> ${event.customStatusId}`);
}
