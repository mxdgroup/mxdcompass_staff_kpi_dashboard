import { after } from "next/server";
import {
  validateSignature,
  storeTransition,
  storeWebhookSecret,
  type WrikeWebhookEvent,
} from "@/lib/wrike/webhook";
import { applyDateForStatusChange } from "@/lib/wrike/dateWriter";

export async function POST(request: Request): Promise<Response> {
  // --- HANDSHAKE ---
  // Wrike sends X-Hook-Secret during registration. Echo it back immediately.
  const hookSecret = request.headers.get("x-hook-secret");
  if (hookSecret) {
    // P8: Store secret synchronously before returning (was in after(), could be lost)
    try {
      await storeWebhookSecret(hookSecret);
    } catch (err) {
      console.error("[webhook] CRITICAL: Failed to store handshake secret:", err);
      // Still return the header so Wrike completes handshake; secret will be retried
    }
    return new Response(null, {
      status: 200,
      headers: { "X-Hook-Secret": hookSecret },
    });
  }

  // --- EVENTS ---
  const rawBody = await request.text();

  // P9: Require signature on all non-handshake requests
  const signature = request.headers.get("x-hook-signature");
  if (!signature) {
    console.warn("[webhook] Missing signature header — rejecting unsigned request");
    return new Response(JSON.stringify({ error: "Missing webhook signature" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const valid = await validateSignature(rawBody, signature);
  if (!valid) {
    console.warn("[webhook] Signature mismatch — rejecting request");
    return new Response(JSON.stringify({ error: "Invalid webhook signature" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  let events: WrikeWebhookEvent[];
  try {
    events = JSON.parse(rawBody) as WrikeWebhookEvent[];
  } catch {
    return new Response("Bad Request", { status: 400 });
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
  }

  return new Response("OK", { status: 200 });
}
