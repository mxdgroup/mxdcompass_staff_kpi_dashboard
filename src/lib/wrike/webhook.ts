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
const WRIKE_WEBHOOK_IP_CIDRS = [
  "160.19.162.0/23",
  "34.73.3.211/32",
  "35.196.104.95/32",
  "34.72.158.28/32",
  "185.157.64.0/22",
  "146.148.2.222/32",
];

function getConfiguredWebhookSecret(): string | null {
  const secret = process.env.WRIKE_WEBHOOK_SECRET;
  if (!secret) {
    console.error(
      "[webhook] Missing WRIKE_WEBHOOK_SECRET — secure webhook validation cannot run.",
    );
  }
  return secret ?? null;
}

// ---------- Signature validation ----------

export async function validateSignature(body: string, signature: string): Promise<boolean> {
  const secret = getConfiguredWebhookSecret();
  if (!secret) {
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

export function signHookSecret(hookSecret: string): string {
  const secret = getConfiguredWebhookSecret();
  if (!secret) {
    throw new Error("Missing WRIKE_WEBHOOK_SECRET");
  }
  return crypto
    .createHmac("sha256", secret)
    .update(hookSecret, "utf8")
    .digest("hex");
}

export function getForwardedRequestIp(request: Request): string | null {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (!forwardedFor) return null;
  const first = forwardedFor.split(",")[0]?.trim();
  return first || null;
}

export function isTrustedWrikeWebhookIp(ip: string | null): boolean {
  if (!ip) return false;
  const normalized = normalizeIpv4(ip);
  if (!normalized) return false;
  return WRIKE_WEBHOOK_IP_CIDRS.some((cidr) => ipInCidr(normalized, cidr));
}

function normalizeIpv4(ip: string): string | null {
  const parts = ip.trim().split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((part) => Number(part));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return null;
  }
  return nums.join(".");
}

function ipToInt(ip: string): number {
  return ip
    .split(".")
    .map(Number)
    .reduce((acc, octet) => (acc << 8) + octet, 0) >>> 0;
}

function ipInCidr(ip: string, cidr: string): boolean {
  const [rangeIp, prefixStr] = cidr.split("/");
  const prefix = Number(prefixStr);
  if (!rangeIp || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    return false;
  }

  const ipInt = ipToInt(ip);
  const rangeInt = ipToInt(rangeIp);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipInt & mask) === (rangeInt & mask);
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
  const r = getSharedRedis();
  if (!r) {
    console.warn("[webhook] Redis unavailable — transition not stored, comment parser will backfill");
    return;
  }

  const eventDate = new Date(event.lastUpdatedDate);
  const score = Math.floor(eventDate.getTime() / 1000);
  const key = redisKeyForWeek(eventDate);

  // P11: Include 4-hour time bucket so legitimate repeated transitions aren't dropped
  const timeBucket = Math.floor(score / (4 * 3600));
  const dedupKey = `${event.taskId}:${event.oldCustomStatusId}:${event.customStatusId}:${timeBucket}`;

  const entry: TransitionEntry = {
    taskId: event.taskId,
    fromStatusId: event.oldCustomStatusId,
    toStatusId: event.customStatusId,
    timestamp: event.lastUpdatedDate,
    eventAuthorId: event.eventAuthorId,
  };

  const memberValue = JSON.stringify({ ...entry, _dedup: dedupKey });

  // P12: Atomic dedup — SADD and ZADD are in the same pipeline so either both
  // persist or neither does. Prevents orphaned dedup keys on partial failure.
  const dedupSetKey = `${key}:dedup`;

  const ttl = await r.ttl(key);

  const pipe = r.pipeline();
  pipe.sadd(dedupSetKey, dedupKey);                          // index 0: 1=new, 0=dup
  pipe.zadd(key, { nx: true }, { score, member: memberValue });  // index 1: NX guards concurrent pipelines

  if (ttl === -1 || ttl === -2) {
    pipe.expire(key, TTL_SECONDS);
    pipe.expire(dedupSetKey, TTL_SECONDS);
  }

  pipe.set("kpi:webhook:last_event", Math.floor(Date.now() / 1000));

  const results = await pipe.exec();
  const wasNew = results?.[0] === 1;

  if (wasNew) {
    console.log(`[webhook] Stored transition: ${event.taskId} ${event.oldCustomStatusId} -> ${event.customStatusId}`);
  }
}
