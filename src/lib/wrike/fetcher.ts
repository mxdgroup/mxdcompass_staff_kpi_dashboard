// High-level Wrike data fetching for the KPI dashboard

import { getWrikeClient } from "./client";
import type {
  WrikeTask,
  WrikeComment,
  WrikeTimelog,
  WrikeWorkflow,
  WrikeCustomStatus,
} from "./types";
import { config } from "../config";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ResolvedStatuses {
  returnForReviewId: string | undefined;
  clientReviewId: string | undefined;
  completedIds: string[];
  allStatuses: WrikeCustomStatus[];
}

export interface WeeklyMemberData {
  tasks: WrikeTask[];
  comments: Map<string, WrikeComment[]>; // taskId -> comments
  timelogs: WrikeTimelog[];
  totalHours: number;
}

// ---------------------------------------------------------------------------
// Workflow status resolution (cached)
// ---------------------------------------------------------------------------

let _cachedStatuses: ResolvedStatuses | undefined;

export async function resolveWorkflowStatuses(): Promise<ResolvedStatuses> {
  if (_cachedStatuses) return _cachedStatuses;

  const client = getWrikeClient();
  const workflows = await client.get<WrikeWorkflow>("/workflows");

  const allStatuses: WrikeCustomStatus[] = workflows.flatMap(
    (wf) => wf.customStatuses ?? [],
  );

  const lowerReturn = config.returnForReviewStatusName.toLowerCase();
  const lowerClient = config.clientReviewStatusName.toLowerCase();
  const lowerCompleted = config.completedStatusNames.map((n) =>
    n.toLowerCase(),
  );

  const returnForReviewId = allStatuses.find(
    (s) => s.name.toLowerCase() === lowerReturn,
  )?.id;

  const clientReviewId = allStatuses.find(
    (s) => s.name.toLowerCase() === lowerClient,
  )?.id;

  const completedIds = allStatuses
    .filter((s) => lowerCompleted.includes(s.name.toLowerCase()))
    .map((s) => s.id);

  _cachedStatuses = { returnForReviewId, clientReviewId, completedIds, allStatuses };
  return _cachedStatuses;
}

// ---------------------------------------------------------------------------
// Weekly member data
// ---------------------------------------------------------------------------

export async function fetchWeeklyMemberData(
  folderIds: string[],
  contactId: string,
  dateRange: { start: string; end: string },
): Promise<WeeklyMemberData> {
  const client = getWrikeClient();

  const allTasks: WrikeTask[] = [];
  const commentsByTask = new Map<string, WrikeComment[]>();

  for (const folderId of folderIds) {
    // ---- Tasks ----
    const tasks = await client.get<WrikeTask>(`/folders/${folderId}/tasks`, {
      updatedDate: JSON.stringify({ start: `${dateRange.start}T00:00:00Z`, end: `${dateRange.end}T23:59:59Z` }),
      fields: JSON.stringify([
        "description",
        "customFields",
        "responsibleIds",
        "subTaskIds",
        "briefDescription",
      ]),
      descendants: true,
    });

    // Filter to tasks this member is responsible for
    const memberTasks = tasks.filter((t) =>
      t.responsibleIds?.includes(contactId),
    );
    allTasks.push(...memberTasks);

    // ---- Comments (folder-level) ----
    const folderComments = await client.get<WrikeComment>(
      `/folders/${folderId}/comments`,
    );

    // Build a set of member task IDs for quick lookup
    const memberTaskIds = new Set(memberTasks.map((t) => t.id));

    // Map comments that have a taskId directly
    let mappedTaskIds = new Set<string>();
    for (const comment of folderComments) {
      if (comment.taskId && memberTaskIds.has(comment.taskId)) {
        const existing = commentsByTask.get(comment.taskId) ?? [];
        existing.push(comment);
        commentsByTask.set(comment.taskId, existing);
        mappedTaskIds.add(comment.taskId);
      }
    }

    // Fallback: for member tasks that had no folder-level comments mapped,
    // fetch per-task comments (the folder endpoint may omit taskId in some cases)
    const unmappedTaskIds = memberTasks
      .filter((t) => !mappedTaskIds.has(t.id))
      .map((t) => t.id);

    for (const taskId of unmappedTaskIds) {
      const taskComments = await client.get<WrikeComment>(
        `/tasks/${taskId}/comments`,
      );
      if (taskComments.length > 0) {
        commentsByTask.set(taskId, taskComments);
      }
    }
  }

  // ---- Timelogs ----
  const timelogs = await client.get<WrikeTimelog>(
    `/contacts/${contactId}/timelogs`,
    {
      trackedDate: JSON.stringify({ start: `${dateRange.start}T00:00:00Z`, end: `${dateRange.end}T23:59:59Z` }),
    },
  );

  const totalHours = timelogs.reduce((sum, tl) => sum + (tl.hours ?? 0), 0);

  return { tasks: allTasks, comments: commentsByTask, timelogs, totalHours };
}
