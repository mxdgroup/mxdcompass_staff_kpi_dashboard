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
  _folderIds: string[],
  contactId: string,
  dateRange: { start: string; end: string },
): Promise<WeeklyMemberData> {
  const client = getWrikeClient();
  const commentsByTask = new Map<string, WrikeComment[]>();

  // ---- Tasks (account-level with responsibles filter) ----
  // This avoids folder ID issues and gets all tasks assigned to the member
  const tasks = await client.get<WrikeTask>("/tasks", {
    responsibles: JSON.stringify([contactId]),
    updatedDate: JSON.stringify({ start: `${dateRange.start}T00:00:00Z`, end: `${dateRange.end}T23:59:59Z` }),
    fields: JSON.stringify([
      "description",
      "customFields",
      "responsibleIds",
      "subTaskIds",
      "briefDescription",
    ]),
  });

  // ---- Comments (per-task, since account-level has no folder to scope) ----
  // Limit to first 20 tasks to avoid excessive API calls
  const tasksToFetchComments = tasks.slice(0, 20);
  for (const task of tasksToFetchComments) {
    try {
      const taskComments = await client.get<WrikeComment>(
        `/tasks/${task.id}/comments`,
      );
      if (taskComments.length > 0) {
        commentsByTask.set(task.id, taskComments);
      }
    } catch {
      // Skip comment fetch failures silently
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

  return { tasks, comments: commentsByTask, timelogs, totalHours };
}
