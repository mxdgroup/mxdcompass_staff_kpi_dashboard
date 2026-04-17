// Self-healing Wrike webhook registration.
//
// The webhook identity (id + hookUrl) has lifecycle: Wrike can suspend after
// repeated delivery failures, or delete entirely; and our deployment URL can
// drift (e.g. base path renames). Previously this was "fixed" by pasting a new
// WRIKE_WEBHOOK_ID into env whenever someone noticed — which is exactly how we
// ended up with env pointing at a deleted webhook while a different suspended
// webhook lingered in Wrike with a stale hookUrl.
//
// Instead, every sync run reconciles reality:
//   1. List all webhooks in the account.
//   2. Find the one whose hookUrl matches our expected URL; adopt it.
//      If suspended, reactivate.
//   3. If none match, POST a new one and delete other webhooks pointing at
//      this app's domain with the wrong path (prevents duplicates from
//      accumulating across URL changes).
//
// Redis (kpi:wrike:webhook_id) is the source of truth for code to read. The
// env var WRIKE_WEBHOOK_ID is a bootstrap-only hint — once Redis is populated,
// env is ignored.

import { getSharedRedis } from "../storage";
import { getWrikeClient } from "./client";

const WEBHOOK_ID_KEY = "kpi:wrike:webhook_id";
const ACCOUNT_ID_KEY = "kpi:wrike:account_id";
const WEBHOOK_PATH = "/internal/kpis/api/webhook/wrike";
const TARGET_EVENTS = ["TaskStatusChanged"];

interface WrikeWebhook {
  id: string;
  accountId?: string;
  hookUrl?: string;
  events?: string[];
  status?: "Active" | "Suspended" | string;
}

export type WebhookAction =
  | "noop"
  | "reactivated"
  | "adopted"
  | "reregistered"
  | "failed";

export interface WebhookRegistrationResult {
  action: WebhookAction;
  webhookId: string | null;
  hookUrl: string | null;
  reason?: string;
  cleanedUp?: string[];
}

export function getExpectedHookUrl(): string | null {
  const explicit = process.env.WRIKE_WEBHOOK_HOOK_URL;
  if (explicit) return explicit;
  const prod = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (prod) return `https://${prod}${WEBHOOK_PATH}`;
  return null;
}

async function resolveAccountId(
  hint: WrikeWebhook[] = [],
): Promise<string | null> {
  const envId = process.env.WRIKE_ACCOUNT_ID;
  if (envId) return envId;

  const redis = getSharedRedis();
  if (redis) {
    const cached = await redis.get<string>(ACCOUNT_ID_KEY);
    if (cached) return cached;
  }

  const fromHint = hint.find((w) => w.accountId)?.accountId;
  if (fromHint) {
    if (redis) await redis.set(ACCOUNT_ID_KEY, fromHint);
    return fromHint;
  }

  // No existing webhook to crib from — fall back to /contacts?me=true.
  try {
    const contacts = await getWrikeClient().get<{ accountId?: string }>(
      "/contacts",
      { me: true },
    );
    const fromContact = contacts[0]?.accountId;
    if (fromContact && redis) await redis.set(ACCOUNT_ID_KEY, fromContact);
    return fromContact ?? null;
  } catch {
    return null;
  }
}

export async function ensureWebhookRegistered(): Promise<WebhookRegistrationResult> {
  const client = getWrikeClient();
  const redis = getSharedRedis();

  const expectedUrl = getExpectedHookUrl();
  if (!expectedUrl) {
    return {
      action: "failed",
      webhookId: null,
      hookUrl: null,
      reason: "No hook URL configured — set WRIKE_WEBHOOK_HOOK_URL or VERCEL_PROJECT_PRODUCTION_URL",
    };
  }

  // Single source of truth: list webhooks in the account and reconcile. This
  // handles every scenario (stale env id, URL drift, suspension, deletion,
  // orphans) uniformly. One Wrike API call.
  let existing: WrikeWebhook[];
  try {
    existing = await client.get<WrikeWebhook>("/webhooks");
  } catch (err) {
    return {
      action: "failed",
      webhookId: null,
      hookUrl: expectedUrl,
      reason: `Listing webhooks failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const match = existing.find((w) => w.hookUrl === expectedUrl);

  if (match) {
    if (match.status === "Active") {
      if (redis) await redis.set(WEBHOOK_ID_KEY, match.id);
      return { action: "noop", webhookId: match.id, hookUrl: expectedUrl };
    }
    // Suspended or unknown → reactivate.
    try {
      await client.put(`/webhooks/${match.id}`, { status: "Active" });
      if (redis) await redis.set(WEBHOOK_ID_KEY, match.id);
      return {
        action: match.status === "Suspended" ? "reactivated" : "adopted",
        webhookId: match.id,
        hookUrl: expectedUrl,
      };
    } catch (err) {
      return {
        action: "failed",
        webhookId: match.id,
        hookUrl: expectedUrl,
        reason: `Reactivate failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // No webhook pointing at the right URL. Register a fresh one, then clean up
  // stale siblings (other webhooks for this app with wrong paths).
  const accountId = await resolveAccountId(existing);
  if (!accountId) {
    return {
      action: "failed",
      webhookId: null,
      hookUrl: expectedUrl,
      reason: "Could not resolve Wrike account ID (set WRIKE_ACCOUNT_ID)",
    };
  }

  let created: WrikeWebhook | undefined;
  try {
    const response = await client.post<WrikeWebhook>(
      `/accounts/${accountId}/webhooks`,
      {
        hookUrl: expectedUrl,
        events: JSON.stringify(TARGET_EVENTS),
      },
    );
    created = response.data[0];
  } catch (err) {
    return {
      action: "failed",
      webhookId: null,
      hookUrl: expectedUrl,
      reason: `Create webhook failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!created?.id) {
    return {
      action: "failed",
      webhookId: null,
      hookUrl: expectedUrl,
      reason: "POST /accounts/{id}/webhooks returned no id",
    };
  }

  if (redis) await redis.set(WEBHOOK_ID_KEY, created.id);

  // Cleanup: delete sibling webhooks whose hookUrl points at our deployment
  // domain but a wrong path. Leaves external webhooks alone.
  const cleanedUp: string[] = [];
  const deploymentHost = safeHost(expectedUrl);
  if (deploymentHost) {
    for (const w of existing) {
      if (w.id === created.id) continue;
      const host = safeHost(w.hookUrl ?? "");
      if (host === deploymentHost && w.hookUrl !== expectedUrl) {
        try {
          await client.delete(`/webhooks/${w.id}`);
          cleanedUp.push(w.id);
        } catch (err) {
          console.warn(
            `[webhookRegistrar] Failed to clean up stale webhook ${w.id}:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
    }
  }

  return {
    action: "reregistered",
    webhookId: created.id,
    hookUrl: expectedUrl,
    cleanedUp: cleanedUp.length > 0 ? cleanedUp : undefined,
  };
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/** Redis key where the reconciled webhook id lives. Exported for callers
 * that want to read it directly (e.g. health endpoints). */
export { WEBHOOK_ID_KEY };
