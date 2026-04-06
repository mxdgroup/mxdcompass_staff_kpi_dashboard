import {
  validateSignature,
  storeTransition,
  type WrikeWebhookEvent,
} from "@/lib/wrike/webhook";

export async function POST(request: Request): Promise<Response> {
  // --- HANDSHAKE ---
  const hookSecret = request.headers.get("x-hook-secret");
  if (hookSecret) {
    return new Response(null, {
      status: 200,
      headers: { "X-Hook-Secret": hookSecret },
    });
  }

  // --- EVENTS ---
  const rawBody = await request.text();

  const signature = request.headers.get("x-hook-signature");
  if (!signature || !validateSignature(rawBody, signature)) {
    return new Response("Unauthorized", { status: 401 });
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
