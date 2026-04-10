import { loadOverridesFromRedis } from "@/lib/bootstrap";
import { NextResponse } from "next/server";
import { getFlowSnapshot, getFlowLatestWeek } from "@/lib/flowStorage";
import type { FlowApiResponse } from "@/lib/types";

const ISO_WEEK_REGEX = /^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/;

export async function GET(request: Request) {
  await loadOverridesFromRedis();
  const { searchParams } = new URL(request.url);
  const weekParam = searchParams.get("week");

  let week: string;
  if (weekParam && weekParam !== "current") {
    if (!ISO_WEEK_REGEX.test(weekParam)) {
      return NextResponse.json(
        { error: "Invalid week format. Use YYYY-Www (e.g. 2026-W14)" },
        { status: 400 },
      );
    }
    week = weekParam;
  } else {
    const latest = await getFlowLatestWeek();
    if (!latest) {
      const response: FlowApiResponse = { data: null, week: "" };
      return NextResponse.json(response);
    }
    week = latest;
  }

  const data = await getFlowSnapshot(week);
  const response: FlowApiResponse = { data, week };
  return NextResponse.json(response);
}
