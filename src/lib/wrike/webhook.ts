import crypto from "node:crypto";
import { getSharedRedis } from "../storage";

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

// ---------- Constants ----------

const TTL_SECONDS = 365 * 24 * 60 * 60;
const WEBHOOK_SECRET_KEY = "kpi:webhook:secret";

export async function storeWebhookSecret(secret: string): Promise<void> {
  const r = getSharedRedis(); if (!r) {
    console.error("[webhook] No Redis available, cannot store secret");
    return;
  }
  await r.set(WEBHOOK_SECRET_KEY, secret, { ex: TTL_SECONDS });
  console.log("[webhook] Handshake secret stored in Redis with TTL");
}

async function getWebhookSecret(): Promise<string | null> {
  const r = getSharedRedis();
  if (r) {
    const stored = await r.get<string>(WEBHOOK_SECRET_KEY);
    if (stored) return stored;
  }
  const envSecret = process.env.WRIKE_WEBHOOK_SECRET;
  if (envSecret) {
    console.warn("[webhook] Redis secret missing, falling back to WRIKE_WEBHOOK_SECRET env var");
    return envSecret;
  }
  return null;
}

// ---------- Signature validation ----------

export async function validateSignature(body: string, signature: string): Promise<boolean> {
  const secret = await getWebhookSecret();
  if (!secret) {
    console.error("[webhook] No webhook secret available — check Redis key 'kpi:webhook:secret' and WRIKE_WEBHOOK_SECRET env var. Webhook may need re-registration.");
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

export async function storeTransition(
  event: WrikeWebhookEvent,
): Promise<void> {
  const r = getSharedRedis(); if (!r) return;

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
  const alreadyExists = await r.sismember(dedupSetKey, dedupKey);
  if (alreadyExists) return;

  const pipe = r.pipeline();
  pipe.zadd(key, { score, member: memberValue });
  pipe.sadd(dedupSetKey, dedupKey);

  const ttl = await r.ttl(key);
  if (ttl === -1 || ttl === -2) {
    pipe.expire(key, TTL_SECONDS);
    pipe.expire(dedupSetKey, TTL_SECONDS);
  }

  pipe.set("kpi:webhook:last_event", Math.floor(Date.now() / 1000));

  await pipe.exec();
  console.log(`[webhook] Stored transition: ${event.taskId} ${event.oldCustomStatusId} -> ${event.customStatusId}`);
}
