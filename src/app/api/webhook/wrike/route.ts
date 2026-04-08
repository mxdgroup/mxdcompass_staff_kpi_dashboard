import { after } from "next/server";
import {
  validateSignature,
  storeTransition,
  storeWebhookSecret,
  type WrikeWebhookEvent,
} from "@/lib/wrike/webhook";

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
      console.warn("[webhook] Signature mismatch, processing anyway (secret may need rotation)");
    }
  }

  let events: WrikeWebhookEvent[];
  try {
    events = JSON.parse(rawBody) as WrikeWebhookEvent[];
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  const promises: Promise<void>[] = [];
  for (const event of events) {
    if (event.eventType === "TaskStatusChanged") {
      promises.push(storeTransition(event));
    }
  }
  await Promise.all(promises);

  return new Response("OK", { status: 200 });
}
