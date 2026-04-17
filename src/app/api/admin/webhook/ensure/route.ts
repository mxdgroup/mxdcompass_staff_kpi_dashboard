// Manual trigger for webhook registration reconciliation. Protected by
// CRON_SECRET Bearer auth. Useful for immediate recovery without waiting
// for the next scheduled cron.

import { NextResponse } from "next/server";
import { ensureWebhookRegistered } from "@/lib/wrike/webhookRegistrar";

export async function POST(request: Request) {
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await ensureWebhookRegistered();
  const status = result.action === "failed" ? 500 : 200;
  return NextResponse.json(result, { status });
}
