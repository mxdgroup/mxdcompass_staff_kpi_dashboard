// Server-side sync trigger — no Bearer auth needed.
// The frontend calls this instead of /api/sync (which requires CRON_SECRET).
// This route IS the auth boundary: it runs server-side and imports sync logic directly.

import { NextResponse } from "next/server";
import { runSync } from "@/lib/syncRunner";

export const maxDuration = 300;

export async function POST() {
  try {
    const result = await runSync();

    if (result.error) {
      return NextResponse.json({ error: result.error }, { status: 500 });
    }

    if (result.skipped) {
      return NextResponse.json(
        { error: "Sync already in progress" },
        { status: 409 },
      );
    }

    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[sync/trigger] Failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
