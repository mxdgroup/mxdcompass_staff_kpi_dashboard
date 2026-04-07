import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { loadOverridesFromRedis } from "@/lib/bootstrap";
import { getTransitionsInRange } from "@/lib/wrike/transitions";
import { resolveWorkflowStatuses } from "@/lib/wrike/fetcher";
import { getFlowLatestWeek, getFlowSnapshot } from "@/lib/flowStorage";
import { config, getMemberByContactId } from "@/lib/config";
import type { TicketFlowEntry } from "@/lib/types";

export interface YesterdayTransition {
  taskId: string;
  taskTitle: string;
  permalink: string;
  fromStage: string;
  toStage: string;
  timestamp: string;
  isCompletion: boolean;
}

export interface YesterdayMember {
  name: string;
  role: string;
  contactId: string;
  transitions: YesterdayTransition[];
  totalMoves: number;
  totalCompletions: number;
}

export interface YesterdayApiResponse {
  date: string; // YYYY-MM-DD
  dateLabel: string; // "Monday, 7 April 2026"
  members: YesterdayMember[];
}

export async function GET() {
  await loadOverridesFromRedis();

  const authed = await isAuthenticated();
  if (!authed) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Compute yesterday midnight-to-midnight UTC
  const now = new Date();
  const yesterday = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1),
  );
  const startTs = Math.floor(yesterday.getTime() / 1000);
  const endTs = startTs + 86400 - 1; // 23:59:59

  const dateStr = yesterday.toISOString().slice(0, 10);
  const dateLabel = yesterday.toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

  // Fetch transitions
  const transitions = await getTransitionsInRange(startTs, endTs);

  // Resolve status names
  let allStatuses: { id: string; name: string }[] = [];
  let completedIds: string[] = [];
  try {
    const resolved = await resolveWorkflowStatuses();
    allStatuses = resolved.allStatuses;
    completedIds = resolved.completedIds;
  } catch {
    // If Wrike API is unavailable, use empty statuses
  }

  const statusMap = new Map(allStatuses.map((s) => [s.id, s.name]));

  // Load latest flow snapshot for task titles
  const ticketMap = new Map<string, TicketFlowEntry>();
  try {
    const latestWeek = await getFlowLatestWeek();
    if (latestWeek) {
      const snapshot = await getFlowSnapshot(latestWeek);
      if (snapshot) {
        for (const ticket of snapshot.tickets) {
          ticketMap.set(ticket.taskId, ticket);
        }
      }
    }
  } catch {
    // Flow snapshot unavailable — titles will fall back
  }

  const completedSet = new Set(completedIds);

  // Group by eventAuthorId
  const grouped = new Map<string, YesterdayTransition[]>();
  for (const t of transitions) {
    const authorId = t.eventAuthorId;
    if (!grouped.has(authorId)) {
      grouped.set(authorId, []);
    }

    const ticket = ticketMap.get(t.taskId);
    const taskTitle = ticket?.title ?? `Task ${t.taskId}`;
    const permalink =
      ticket?.permalink ?? `https://www.wrike.com/open.htm?id=${t.taskId}`;
    const fromStage = statusMap.get(t.fromStatusId) ?? t.fromStatusId;
    const toStage = statusMap.get(t.toStatusId) ?? t.toStatusId;
    const isCompletion = completedSet.has(t.toStatusId);

    grouped.get(authorId)!.push({
      taskId: t.taskId,
      taskTitle,
      permalink,
      fromStage,
      toStage,
      timestamp: t.timestamp,
      isCompletion,
    });
  }

  // Build per-member response
  const members: YesterdayMember[] = [];

  for (const [contactId, memberTransitions] of grouped) {
    const member = getMemberByContactId(contactId);
    const name = member?.name ?? contactId;
    const role = member?.role ?? "unknown";

    // Sort by timestamp ascending
    memberTransitions.sort(
      (a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );

    const totalCompletions = memberTransitions.filter(
      (t) => t.isCompletion,
    ).length;

    members.push({
      name,
      role,
      contactId,
      transitions: memberTransitions,
      totalMoves: memberTransitions.length,
      totalCompletions,
    });
  }

  // Also include team members with no transitions (so standup sees everyone)
  for (const teamMember of config.team) {
    if (
      teamMember.wrikeContactId &&
      !grouped.has(teamMember.wrikeContactId)
    ) {
      members.push({
        name: teamMember.name,
        role: teamMember.role,
        contactId: teamMember.wrikeContactId,
        transitions: [],
        totalMoves: 0,
        totalCompletions: 0,
      });
    }
  }

  // Sort: members with activity first, then alphabetical
  members.sort((a, b) => {
    if (a.totalMoves > 0 && b.totalMoves === 0) return -1;
    if (a.totalMoves === 0 && b.totalMoves > 0) return 1;
    return a.name.localeCompare(b.name);
  });

  const response: YesterdayApiResponse = {
    date: dateStr,
    dateLabel,
    members,
  };

  return NextResponse.json(response);
}
