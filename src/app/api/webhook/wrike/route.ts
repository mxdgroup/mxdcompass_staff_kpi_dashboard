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
  // Wrike sends X-Hook-Secret during registration. Echo it back immediately,
  // then store the secret in Redis after the response is sent.
  const hookSecret = request.headers.get("x-hook-secret");
  if (hookSecret) {
    after(async () => {
      await storeWebhookSecret(hookSecret);
    });
    return new Response(null, {
      status: 200,
      headers: { "X-Hook-Secret": hookSecret },
    });
  }

  // --- EVENTS ---
  const rawBody = await request.text();

  const signature = request.headers.get("x-hook-signature");
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

  let events: WrikeWebhookEvent[];
  try {
    events = JSON.parse(rawBody) as WrikeWebhookEvent[];
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  const statusChangedEvents = events.filter(
    (e) => e.eventType === "TaskStatusChanged",
  );

  // Store transitions in background after response is sent
  after(async () => {
    try {
      const promises: Promise<void>[] = [];
      for (const event of statusChangedEvents) {
        promises.push(storeTransition(event));
      }
      await Promise.all(promises);
    } catch (err) {
      console.error("[webhook] Failed to process events in after():", err);
    }
  });

  // Write dates back to Wrike after the response is sent
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
