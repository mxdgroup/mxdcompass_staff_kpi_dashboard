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
const WEBHOOK_SECRET_VERSION_KEY = "kpi:wrike:webhook:secret_version";
const WEBHOOK_SECRET_VERSION = "v1";
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

export async function ensureWebhookRegistered(): Promise<WebhookRegistrationResult> {
  const client = getWrikeClient();
  const redis = getSharedRedis();
  const signingSecret = process.env.WRIKE_WEBHOOK_SECRET;

  const expectedUrl = getExpectedHookUrl();
  if (!expectedUrl) {
    return {
      action: "failed",
      webhookId: null,
      hookUrl: null,
      reason: "No hook URL configured — set WRIKE_WEBHOOK_HOOK_URL or VERCEL_PROJECT_PRODUCTION_URL",
    };
  }
  if (!signingSecret) {
    return {
      action: "failed",
      webhookId: null,
      hookUrl: expectedUrl,
      reason: "No WRIKE_WEBHOOK_SECRET configured for secure webhook registration",
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
  const deploymentHost = safeHost(expectedUrl);
  const secretVersion = redis
    ? await redis.get<string>(WEBHOOK_SECRET_VERSION_KEY)
    : WEBHOOK_SECRET_VERSION;
  const needsSecureRotation =
    !!redis && !!match && secretVersion !== WEBHOOK_SECRET_VERSION;

  // Clean up sibling webhooks whose hookUrl points at this deployment host
  // but a wrong path. Runs on every reconciliation, so stale entries from
  // base-path renames get removed the first time we notice them.
  async function cleanupStaleSiblings(keepId: string | null): Promise<string[]> {
    const cleaned: string[] = [];
    if (!deploymentHost) return cleaned;
    for (const w of existing) {
      if (w.id === keepId) continue;
      const host = safeHost(w.hookUrl ?? "");
      if (host === deploymentHost && w.hookUrl !== expectedUrl) {
        try {
          await client.delete(`/webhooks/${w.id}`);
          cleaned.push(w.id);
        } catch (err) {
          console.warn(
            `[webhookRegistrar] Failed to clean up stale webhook ${w.id}:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
    }
    return cleaned;
  }

  if (match && !needsSecureRotation) {
    const action: WebhookAction =
      match.status === "Active"
        ? "noop"
        : match.status === "Suspended"
          ? "reactivated"
          : "adopted";

    if (match.status !== "Active") {
      try {
        await client.put(`/webhooks/${match.id}`, { status: "Active" });
      } catch (err) {
        return {
          action: "failed",
          webhookId: match.id,
          hookUrl: expectedUrl,
          reason: `Reactivate failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    if (redis) {
      await redis.set(WEBHOOK_ID_KEY, match.id);
      await redis.set(WEBHOOK_SECRET_VERSION_KEY, WEBHOOK_SECRET_VERSION);
    }
    const cleanedUp = await cleanupStaleSiblings(match.id);
    return {
      action,
      webhookId: match.id,
      hookUrl: expectedUrl,
      cleanedUp: cleanedUp.length > 0 ? cleanedUp : undefined,
    };
  }

  if (match && needsSecureRotation) {
    try {
      await client.delete(`/webhooks/${match.id}`);
      existing = existing.filter((w) => w.id !== match.id);
    } catch (err) {
      return {
        action: "failed",
        webhookId: match.id,
        hookUrl: expectedUrl,
        reason: `Delete legacy unsigned webhook failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // No webhook pointing at the right URL — register a fresh one.
  //
  // POST /webhooks creates an account-scoped webhook under the token's
  // account. /accounts/{id}/webhooks returns method_not_found.
  let created: WrikeWebhook | undefined;
  try {
    const response = await client.post<WrikeWebhook>(
      "/webhooks",
      {
        hookUrl: expectedUrl,
        secret: signingSecret,
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
      reason: "POST /webhooks returned no id",
    };
  }

  if (redis) {
    await redis.set(WEBHOOK_ID_KEY, created.id);
    await redis.set(WEBHOOK_SECRET_VERSION_KEY, WEBHOOK_SECRET_VERSION);
  }
  const cleanedUp = await cleanupStaleSiblings(created.id);

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
