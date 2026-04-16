// Resync a single task by ID. No Bearer auth (server-side only, same as /sync/trigger).
// POST /api/sync/task { taskId: "IEAGV532..." }

import { NextResponse } from "next/server";
import { syncTask } from "@/lib/syncRunner";

export async function POST(request: Request) {
  let body: { taskId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const taskId = body.taskId?.trim();
  if (!taskId) {
    return NextResponse.json({ error: "Missing taskId" }, { status: 400 });
  }

  const startTime = Date.now();
  const result = await syncTask(taskId);
  const duration = Math.round((Date.now() - startTime) / 1000);

  if (!result.ok) {
    return NextResponse.json({ error: result.error, duration: `${duration}s` }, { status: 500 });
  }

  return NextResponse.json({ ok: true, taskId, duration: `${duration}s` });
}
