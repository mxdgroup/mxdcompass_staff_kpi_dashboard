import { loadOverridesFromRedis } from "@/lib/bootstrap";
import { NextResponse } from "next/server";
import { getTransitionsInRange } from "@/lib/wrike/transitions";
import { resolveWorkflowStatuses } from "@/lib/wrike/fetcher";
import { getFlowLatestWeek, getFlowSnapshot } from "@/lib/flowStorage";
import { getWrikeClient } from "@/lib/wrike/client";
import type { WrikeTask } from "@/lib/wrike/types";
import { config, getMemberByContactId } from "@/lib/config";
import type { Role } from "@/lib/config";

// --- Types (API-specific, imported by the page component) ---

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
  contactId: string;
  name: string;
  role: Role;
  totalMoves: number;
  totalCompletions: number;
  transitions: YesterdayTransition[];
}

export interface YesterdayApiResponse {
  date: string;
  members: YesterdayMember[];
}

export async function GET() {
  await loadOverridesFromRedis();

  // Compute yesterday midnight-to-midnight UTC
  const now = new Date();
  const yesterdayStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1),
  );
  const yesterdayEnd = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const startTs = Math.floor(yesterdayStart.getTime() / 1000);
  const endTs = Math.floor(yesterdayEnd.getTime() / 1000);
  const dateStr = yesterdayStart.toISOString().slice(0, 10);

  // Fetch transitions
  const transitions = await getTransitionsInRange(startTs, endTs);

  // Resolve status names (graceful fallback)
  let statusMap = new Map<string, string>();
  try {
    const statuses = await resolveWorkflowStatuses();
    for (const s of statuses.allStatuses) {
      statusMap.set(s.id, s.name);
    }
  } catch {
    // Use status IDs as fallback names
  }

  // Completed status IDs
  const completedNames = new Set(config.completedStatusNames.map((n) => n.toLowerCase()));
  const completedIds = new Set<string>();
  for (const [id, name] of statusMap) {
    if (completedNames.has(name.toLowerCase())) {
      completedIds.add(id);
    }
  }

  // Enrich task titles from flow snapshot
  const taskTitles = new Map<string, { title: string; permalink: string }>();
  try {
    const latestWeek = await getFlowLatestWeek();
    if (latestWeek) {
      const snapshot = await getFlowSnapshot(latestWeek);
      if (snapshot) {
        for (const ticket of snapshot.tickets) {
          taskTitles.set(ticket.taskId, {
            title: ticket.title,
            permalink: ticket.permalink,
          });
        }
      }
    }
  } catch {
    // Titles fall back to "Task {id}"
  }

  // Fetch titles from Wrike for any tasks not in the flow snapshot
  const missingIds = [
    ...new Set(
      transitions
        .map((t) => t.taskId)
        .filter((id) => !taskTitles.has(id)),
    ),
  ];
  if (missingIds.length > 0) {
    try {
      const client = getWrikeClient();
      const tasks = await client.get<WrikeTask>(
        `/tasks/${missingIds.join(",")}`,
        { fields: '["permalink"]' },
      );
      for (const task of tasks) {
        taskTitles.set(task.id, {
          title: task.title,
          permalink: task.permalink,
        });
      }
    } catch {
      // Fall back to "Task {id}" for these
    }
  }

  // Group transitions by eventAuthorId
  const byAuthor = new Map<string, YesterdayTransition[]>();
  for (const t of transitions) {
    const fromStage = statusMap.get(t.fromStatusId) ?? t.fromStatusId;
    const toStage = statusMap.get(t.toStatusId) ?? t.toStatusId;
    const taskInfo = taskTitles.get(t.taskId);
    const entry: YesterdayTransition = {
      taskId: t.taskId,
      taskTitle: taskInfo?.title ?? `Task ${t.taskId}`,
      permalink: taskInfo?.permalink ?? `https://www.wrike.com/open.htm?id=${t.taskId}`,
      fromStage,
      toStage,
      timestamp: t.timestamp,
      isCompletion: completedIds.has(t.toStatusId),
    };
    const list = byAuthor.get(t.eventAuthorId) ?? [];
    list.push(entry);
    byAuthor.set(t.eventAuthorId, list);
  }

  // Build member list from config (include all, even inactive)
  const members: YesterdayMember[] = [];
  const seenContactIds = new Set<string>();

  for (const teamMember of config.team) {
    const contactId = teamMember.wrikeContactId;
    seenContactIds.add(contactId);
    const memberTransitions = byAuthor.get(contactId) ?? [];
    memberTransitions.sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );
    members.push({
      contactId,
      name: teamMember.name,
      role: teamMember.role,
      totalMoves: memberTransitions.length,
      totalCompletions: memberTransitions.filter((t) => t.isCompletion).length,
      transitions: memberTransitions,
    });
  }

  // Include unknown authors (not in config)
  for (const [authorId, authorTransitions] of byAuthor) {
    if (seenContactIds.has(authorId)) continue;
    authorTransitions.sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );
    members.push({
      contactId: authorId,
      name: getMemberByContactId(authorId)?.name ?? authorId,
      role: "developer",
      totalMoves: authorTransitions.length,
      totalCompletions: authorTransitions.filter((t) => t.isCompletion).length,
      transitions: authorTransitions,
    });
  }

  // Sort: active members first, then alphabetical
  members.sort((a, b) => {
    if (a.totalMoves > 0 && b.totalMoves === 0) return -1;
    if (a.totalMoves === 0 && b.totalMoves > 0) return 1;
    return a.name.localeCompare(b.name);
  });

  return NextResponse.json({ date: dateStr, members } satisfies YesterdayApiResponse);
}
