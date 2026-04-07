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
  plannedIds: string[];
  inProgressId: string | undefined;
  inReviewId: string | undefined;
  clientPendingId: string | undefined;
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

  // Fallback: the Client Work space uses a custom task workflow whose statuses
  // are not returned by the /workflows API. Inject known status IDs so that
  // resolveStatusName() can map them. These IDs were discovered empirically
  // from the Wrike account (acc=7010170, space "Client Work").
  const knownCustomStatuses: WrikeCustomStatus[] = [
    { id: "IEAGV532JMGNL7LG", name: "New", color: "Blue", group: "Active" },
    { id: "IEAGV532JMGNL7LQ", name: "Planned", color: "Blue", group: "Active" },
    { id: "IEAGV532JMGNL7L2", name: "In Progress", color: "Green", group: "Active" },
    { id: "IEAGV532JMHGJR2T", name: "In Review", color: "Yellow", group: "Active" },
    { id: "IEAGV532JMGYGIPO", name: "Client Pending", color: "Yellow", group: "Active" },
    { id: "IEAGV532JMGNL7LH", name: "Completed", color: "Green", group: "Completed" },
  ];
  const existingIds = new Set(allStatuses.map((s) => s.id));
  for (const cs of knownCustomStatuses) {
    if (!existingIds.has(cs.id)) {
      allStatuses.push(cs);
    }
  }

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

  // Flow dashboard statuses
  const lowerPlanned = config.plannedStatusNames.map((n) => n.toLowerCase());
  const plannedIds = allStatuses
    .filter((s) => lowerPlanned.includes(s.name.toLowerCase()))
    .map((s) => s.id);

  const inProgressId = allStatuses.find(
    (s) => s.name.toLowerCase() === config.inProgressStatusName.toLowerCase(),
  )?.id;

  const inReviewId = allStatuses.find(
    (s) => s.name.toLowerCase() === config.inReviewStatusName.toLowerCase(),
  )?.id;

  const clientPendingId = allStatuses.find(
    (s) => s.name.toLowerCase() === config.clientPendingStatusName.toLowerCase(),
  )?.id;

  _cachedStatuses = {
    returnForReviewId,
    clientReviewId,
    completedIds,
    plannedIds,
    inProgressId,
    inReviewId,
    clientPendingId,
    allStatuses,
  };
  return _cachedStatuses;
}

// ---------------------------------------------------------------------------
// Date formatting helper — Wrike API requires ISO 8601 with timezone
// ---------------------------------------------------------------------------

function wrikeDateRange(dateRange: { start: string; end: string }): {
  start: string;
  end: string;
} {
  const s = dateRange.start.includes("T")
    ? dateRange.start
    : `${dateRange.start}T00:00:00Z`;
  const e = dateRange.end.includes("T")
    ? dateRange.end
    : `${dateRange.end}T23:59:59Z`;
  return { start: s, end: e };
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
      updatedDate: wrikeDateRange(dateRange),
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
      trackedDate: dateRange,
    },
  );

  const totalHours = timelogs.reduce((sum, tl) => sum + (tl.hours ?? 0), 0);

  return { tasks: allTasks, comments: commentsByTask, timelogs, totalHours };
}

// ---------------------------------------------------------------------------
// Fetch all tasks in a client folder (not filtered by member)
// Used by flow dashboard for client-level views
// ---------------------------------------------------------------------------

export interface ClientFolderData {
  folderId: string;
  tasks: WrikeTask[];
  comments: Map<string, WrikeComment[]>; // taskId -> comments
}

export async function fetchClientTasks(
  folderId: string,
  dateRange: { start: string; end: string },
): Promise<ClientFolderData> {
  const client = getWrikeClient();

  // Fetch all tasks updated in range (no member filter)
  const tasks = await client.get<WrikeTask>(`/folders/${folderId}/tasks`, {
    updatedDate: wrikeDateRange(dateRange),
    fields: JSON.stringify([
      "customFields",
      "responsibleIds",
      "briefDescription",
    ]),
    descendants: true,
  });

  // Fetch comments for all tasks
  const commentsByTask = new Map<string, WrikeComment[]>();

  const folderComments = await client.get<WrikeComment>(
    `/folders/${folderId}/comments`,
  );

  const taskIds = new Set(tasks.map((t) => t.id));
  const mappedTaskIds = new Set<string>();

  for (const comment of folderComments) {
    if (comment.taskId && taskIds.has(comment.taskId)) {
      const existing = commentsByTask.get(comment.taskId) ?? [];
      existing.push(comment);
      commentsByTask.set(comment.taskId, existing);
      mappedTaskIds.add(comment.taskId);
    }
  }

  // Fallback per-task comment fetch for unmapped tasks
  const unmapped = tasks.filter((t) => !mappedTaskIds.has(t.id));
  for (const task of unmapped) {
    const taskComments = await client.get<WrikeComment>(
      `/tasks/${task.id}/comments`,
    );
    if (taskComments.length > 0) {
      commentsByTask.set(task.id, taskComments);
    }
  }

  return { folderId, tasks, comments: commentsByTask };
}
