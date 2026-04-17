import { NextResponse } from "next/server";
import * as crypto from "node:crypto";
import { catchUpMissingDates } from "@/lib/wrike/dateCatchup";
import { acquireCatchupGuard, releaseCatchupGuard } from "@/lib/storage";

export const maxDuration = 300;

// Soft deadline: leaves 30s inside the 300s function budget for response,
// logging, and lock release. Catch-up is idempotent — any work left for the
// next scheduled slot is safe.
const CATCHUP_DEADLINE_MS = 270_000;

function isAuthorized(authHeader: string | null): boolean {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return false;
  if (!authHeader) return false;

  const expected = `Bearer ${cronSecret}`;
  const authBuf = Buffer.from(authHeader);
  const expectedBuf = Buffer.from(expected);
  // Length check before timingSafeEqual — it throws on unequal-length buffers.
  if (authBuf.length !== expectedBuf.length) return false;

  return crypto.timingSafeEqual(authBuf, expectedBuf);
}

export async function GET(request: Request) {
  if (!isAuthorized(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return runCatchup();
}

export async function POST(request: Request) {
  if (!isAuthorized(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return runCatchup();
}

async function runCatchup(): Promise<NextResponse> {
  const startTime = Date.now();

  const guard = await acquireCatchupGuard();
  if (!guard.acquired) {
    // 409 is expected back-pressure (overlapping cron, manual re-trigger) —
    // do not page Slack.
    return NextResponse.json(
      { error: "Catch-up already in progress" },
      { status: 409 },
    );
  }

  try {
    const result = await catchUpMissingDates(Date.now() + CATCHUP_DEADLINE_MS);
    const duration = Math.round((Date.now() - startTime) / 1000);

    const shouldNotify = result.deadlineReached || result.errors > 0;
    if (shouldNotify) {
      await notifySlack(result, duration).catch(() => {});
    }

    return NextResponse.json({
      ok: true,
      duration: `${duration}s`,
      scanned: result.scanned,
      startDatesSet: result.startDatesSet,
      dueDatesSet: result.dueDatesSet,
      errors: result.errors,
      deadlineReached: result.deadlineReached,
      foldersProcessed: result.foldersProcessed,
      foldersTotal: result.foldersTotal,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[cron/catchup] Top-level failure:", message);

    const webhookUrl = process.env.NOTIFICATION_WEBHOOK_URL;
    if (webhookUrl) {
      await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: `KPI Catchup FAILED: ${message}` }),
      }).catch(() => {});
    }

    return NextResponse.json({ error: message }, { status: 500 });
  } finally {
    await releaseCatchupGuard(guard.owner);
  }
}

async function notifySlack(
  result: {
    scanned: number;
    startDatesSet: number;
    dueDatesSet: number;
    errors: number;
    deadlineReached: boolean;
    foldersProcessed: number;
    foldersTotal: number;
  },
  duration: number,
): Promise<void> {
  const url = process.env.NOTIFICATION_WEBHOOK_URL;
  if (!url) return;

  const issues: string[] = [];
  if (result.errors > 0) {
    issues.push(
      `${result.errors} error(s) during catchup (folders=${result.foldersProcessed}/${result.foldersTotal}) — check Vercel logs for [dateCatchup] entries`,
    );
  }
  if (result.deadlineReached) {
    issues.push(
      `Catchup hit soft deadline — processed ${result.foldersProcessed}/${result.foldersTotal} folders; next cron will resume`,
    );
  }

  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: `KPI Catchup: ${issues.length} issue(s) in ${duration}s (scanned=${result.scanned}, startDatesSet=${result.startDatesSet}, dueDatesSet=${result.dueDatesSet})\n${issues.join("\n")}`,
    }),
  });
}
