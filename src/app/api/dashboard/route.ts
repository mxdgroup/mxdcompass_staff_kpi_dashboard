import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { getLatestWeek, getSnapshotWithHistory } from "@/lib/storage";
import type { DashboardApiResponse } from "@/lib/types";

const ISO_WEEK_REGEX = /^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/;

export async function GET(request: Request) {
  const authed = await isAuthenticated();
  if (!authed) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const weekParam = searchParams.get("week");

  let week: string;
  if (weekParam && weekParam !== "current") {
    if (!ISO_WEEK_REGEX.test(weekParam)) {
      return NextResponse.json({ error: "Invalid week format. Use YYYY-Www (e.g. 2026-W14)" }, { status: 400 });
    }
    week = weekParam;
  } else {
    const latest = await getLatestWeek();
    if (!latest) {
      const response: DashboardApiResponse = {
        current: null,
        history: [],
        lastSynced: null,
      };
      return NextResponse.json(response);
    }
    week = latest;
  }

  const { current, history } = await getSnapshotWithHistory(week, 4);

  const response: DashboardApiResponse = {
    current,
    history,
    lastSynced: current?.syncedAt ?? null,
  };

  return NextResponse.json(response);
}
