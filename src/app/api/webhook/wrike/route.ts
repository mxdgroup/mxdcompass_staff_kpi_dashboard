import { after } from "next/server";
import {
  getForwardedRequestIp,
  isTrustedWrikeWebhookIp,
  signHookSecret,
  validateSignature,
  storeTransition,
  type WrikeWebhookEvent,
} from "@/lib/wrike/webhook";
import { applyDateForStatusChange } from "@/lib/wrike/dateWriter";
import { syncTask } from "@/lib/syncRunner";
import { getSharedRedis } from "@/lib/storage";
import { WEBHOOK_ID_KEY } from "@/lib/wrike/webhookRegistrar";

// after() runs within this function's lifetime — needs time for per-task sync patches
export const maxDuration = 60;

export async function POST(request: Request): Promise<Response> {
  const rawBody = await request.text();
  const hookSecret = request.headers.get("x-hook-secret");
  const signature = request.headers.get("x-hook-signature");

  // --- HANDSHAKE ---
  // Wrike secure webhooks send a random X-Hook-Secret challenge plus a
  // signature over the body. Respond with HMAC(secret, challenge) per docs.
  if (hookSecret) {
    if (!signature) {
      console.warn("[webhook] Missing signature header on handshake — rejecting request");
      return new Response(JSON.stringify({ error: "Missing webhook signature" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    const valid = await validateSignature(rawBody, signature);
    if (!valid) {
      console.warn("[webhook] Handshake signature mismatch — rejecting request");
      return new Response(JSON.stringify({ error: "Invalid webhook signature" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    try {
      return new Response(null, {
        status: 200,
        headers: { "X-Hook-Secret": signHookSecret(hookSecret) },
      });
    } catch (err) {
      console.error("[webhook] Handshake failed: webhook secret not configured:", err);
      return new Response(JSON.stringify({ error: "Webhook secret not configured" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  // --- EVENTS ---
  let events: WrikeWebhookEvent[];
  try {
    events = JSON.parse(rawBody) as WrikeWebhookEvent[];
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  if (!signature) {
    const requestIp = getForwardedRequestIp(request);
    const trustedIp = isTrustedWrikeWebhookIp(requestIp);
    const redis = getSharedRedis();
    let registeredWebhookId: string | null = null;
    if (redis) {
      try {
        registeredWebhookId = await redis.get<string>(WEBHOOK_ID_KEY);
      } catch (err) {
        console.warn(
          `[webhook] Failed to read registered webhook id from Redis: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    const bodyWebhookIds = [...new Set(events.map((event) => event.webhookId))];

    if (!trustedIp) {
      console.warn(
        `[webhook] Missing signature header — rejecting unsigned request (ip=${requestIp ?? "unknown"} webhookIds=${bodyWebhookIds.join(",") || "none"})`,
      );
      return new Response(JSON.stringify({ error: "Missing webhook signature" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (
      registeredWebhookId &&
      (bodyWebhookIds.length !== 1 || bodyWebhookIds[0] !== registeredWebhookId)
    ) {
      console.warn(
        `[webhook] Unsigned delivery webhookId mismatch from trusted Wrike IP ${requestIp}; registered=${registeredWebhookId} body=${bodyWebhookIds.join(",") || "none"} — accepting fallback auth`,
      );
    }

    console.warn(
      `[webhook] Missing signature header from trusted Wrike IP ${requestIp}; accepting fallback auth`,
    );
  }

  if (signature) {
    const valid = await validateSignature(rawBody, signature);
    if (!valid) {
      console.warn("[webhook] Signature mismatch — rejecting request");
      return new Response(JSON.stringify({ error: "Invalid webhook signature" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  const statusChangedEvents = events.filter(
    (e) => e.eventType === "TaskStatusChanged",
  );

  // P7: Store transitions synchronously before returning (was in after(), events could be lost)
  const failedEvents: string[] = [];
  for (const event of statusChangedEvents) {
    try {
      await storeTransition(event);
    } catch (err) {
      const msg = `task=${event.taskId} from=${event.oldCustomStatusId} to=${event.customStatusId}`;
      console.error(`[webhook] Failed to store transition (${msg}):`, err);
      failedEvents.push(msg);
    }
  }

  if (failedEvents.length > 0) {
    console.error(`[webhook] ${failedEvents.length} transition(s) failed — manual replay needed`);
  }

  // Date writes are best-effort — keep in after() (Wrike is source of truth for dates)
  if (statusChangedEvents.length > 0) {
    after(async () => {
      for (const event of statusChangedEvents) {
        try {
          await applyDateForStatusChange(event);
        } catch (err) {
          console.error(`[webhook] Date write failed for task ${event.taskId}:`, err);
        }
      }
    });

    // Auto-sync: patch the flow snapshot for each affected task so the dashboard
    // reflects changes immediately. Uses targeted single-task fetch (~2 Wrike API
    // calls per task) instead of a full rebuild (~20+ calls).
    const affectedTaskIds = [...new Set(statusChangedEvents.map((e) => e.taskId))];
    after(async () => {
      for (const taskId of affectedTaskIds) {
        try {
          const result = await syncTask(taskId);
          if (result.ok) {
            console.log(`[webhook] Auto-synced task ${taskId}`);
          } else {
            console.error(`[webhook] Auto-sync failed for task ${taskId}: ${result.error}`);
          }
        } catch (err) {
          console.error(`[webhook] Auto-sync error for task ${taskId}:`, err);
        }
      }
    });
  }

  return new Response("OK", { status: 200 });
}
