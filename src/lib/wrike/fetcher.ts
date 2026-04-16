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
import { getCachedWorkflowStatuses, setCachedWorkflowStatuses } from "../storage";

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

// P25: Cache with TTL so workflow changes are picked up within 1 hour
const STATUS_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
let _cachedStatuses: { data: ResolvedStatuses; cachedAt: number } | undefined;

/** Clear in-memory status cache so the next call hits Wrike API fresh. */
export function clearStatusCache(): void {
  _cachedStatuses = undefined;
}

export async function resolveWorkflowStatuses(): Promise<ResolvedStatuses> {
  // Check in-memory cache first
  if (_cachedStatuses && Date.now() - _cachedStatuses.cachedAt < STATUS_CACHE_TTL_MS) {
    return _cachedStatuses.data;
  }

  // P25: Check Redis cache on cold start before hitting Wrike API
  try {
    const cached = await getCachedWorkflowStatuses();
    if (cached) {
      const resolved: ResolvedStatuses = {
        returnForReviewId: cached.returnForReviewId ?? undefined,
        clientReviewId: cached.clientReviewId ?? undefined,
        completedIds: cached.completedIds,
        plannedIds: cached.plannedIds ?? [],
        inProgressId: cached.inProgressId ?? undefined,
        inReviewId: cached.inReviewId ?? undefined,
        clientPendingId: cached.clientPendingId ?? undefined,
        allStatuses: cached.allStatuses as WrikeCustomStatus[],
      };
      _cachedStatuses = { data: resolved, cachedAt: Date.now() };
      console.log("[fetcher] Loaded workflow statuses from Redis cache");
      return resolved;
    }
  } catch {
    // Redis read failed — fall through to Wrike API
  }

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

  const resolved: ResolvedStatuses = {
    returnForReviewId,
    clientReviewId,
    completedIds,
    plannedIds,
    inProgressId,
    inReviewId,
    clientPendingId,
    allStatuses,
  };
  _cachedStatuses = { data: resolved, cachedAt: Date.now() };

  // P25: Persist to Redis so other instances / cold starts can reuse
  try {
    await setCachedWorkflowStatuses({
      returnForReviewId: resolved.returnForReviewId ?? null,
      clientReviewId: resolved.clientReviewId ?? null,
      completedIds: resolved.completedIds,
      plannedIds: resolved.plannedIds,
      inProgressId: resolved.inProgressId ?? null,
      inReviewId: resolved.inReviewId ?? null,
      clientPendingId: resolved.clientPendingId ?? null,
      allStatuses: resolved.allStatuses,
    });
  } catch {
    // Redis write failed — in-memory cache still works
  }

  return resolved;
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
    // Wrike comments endpoint does NOT support updatedDate filter — fetch all
    // and filter in code below
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
      // Wrike comments endpoint does NOT support updatedDate — fetch all
      const taskComments = await client.get<WrikeComment>(
        `/tasks/${taskId}/comments`,
      );
      if (taskComments.length > 0) {
        commentsByTask.set(taskId, taskComments);
      }
    }
  }

  // ---- Timelogs ----
  // P17: Filter timelogs by requested week to avoid summing all-time hours
  let timelogs: WrikeTimelog[] = [];
  let totalHours = 0;
  try {
    timelogs = await client.get<WrikeTimelog>(
      `/contacts/${contactId}/timelogs`,
      { trackedDate: wrikeDateRange(dateRange) },
    );
    totalHours = timelogs.reduce((sum, tl) => sum + (tl.hours ?? 0), 0);
  } catch {
    // If trackedDate filter is rejected, fetch all and filter client-side
    try {
      const allTimelogs = await client.get<WrikeTimelog>(
        `/contacts/${contactId}/timelogs`,
      );
      const rangeStart = new Date(dateRange.start).getTime();
      const rangeEnd = new Date(dateRange.end).getTime();
      timelogs = allTimelogs.filter((tl) => {
        const d = new Date(tl.trackedDate).getTime();
        return d >= rangeStart && d <= rangeEnd;
      });
      totalHours = timelogs.reduce((sum, tl) => sum + (tl.hours ?? 0), 0);
    } catch (err) {
      console.warn(`[wrike] Timelogs fetch failed for contact ${contactId}, skipping:`, err);
    }
  }

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
  const fields = JSON.stringify([
    "customFields",
    "responsibleIds",
    "briefDescription",
  ]);

  // P18: Fetch recently updated tasks AND active-status tasks to avoid dropping stale items
  const [recentTasks, activeTasks] = await Promise.all([
    client.get<WrikeTask>(`/folders/${folderId}/tasks`, {
      updatedDate: wrikeDateRange(dateRange),
      fields,
      descendants: true,
    }),
    // Fetch tasks in active statuses regardless of update date
    client.get<WrikeTask>(`/folders/${folderId}/tasks`, {
      status: "Active",
      fields,
      descendants: true,
    }),
  ]);

  // Merge and dedupe by taskId
  const taskMap = new Map<string, WrikeTask>();
  for (const t of recentTasks) taskMap.set(t.id, t);
  for (const t of activeTasks) {
    if (!taskMap.has(t.id)) taskMap.set(t.id, t);
  }
  const tasks = Array.from(taskMap.values());

  // Fetch comments for all tasks
  const commentsByTask = new Map<string, WrikeComment[]>();

  // Extend comment lookback 4 weeks before the selected week so the comment
  // parser can reconstruct full transition history. The task fetch (above) uses
  // the original dateRange — only comments need the wider window.
  // NOTE: fetchWeeklyMemberData() is a separate function with its own narrower
  // comment date range — this change does NOT affect it.
  const commentLookbackMs = 4 * 7 * 24 * 60 * 60 * 1000;
  const commentStartDate = new Date(new Date(dateRange.start).getTime() - commentLookbackMs);
  const commentDateRange = {
    start: commentStartDate.toISOString().slice(0, 10),
    end: dateRange.end,
  };

  // Wrike comments endpoint does NOT support updatedDate — fetch all and
  // filter in code by the extended lookback window
  const allFolderComments = await client.get<WrikeComment>(
    `/folders/${folderId}/comments`,
  );
  const commentCutoff = new Date(commentDateRange.start).getTime();
  const folderComments = allFolderComments.filter((c) => {
    const ts = new Date(c.createdDate ?? "").getTime();
    return ts >= commentCutoff;
  });

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

  // Fallback per-task comment fetch for unmapped tasks (same extended lookback)
  const unmapped = tasks.filter((t) => !mappedTaskIds.has(t.id));
  for (const task of unmapped) {
    // Wrike comments endpoint does NOT support updatedDate — fetch all, filter in code
    const allTaskComments = await client.get<WrikeComment>(
      `/tasks/${task.id}/comments`,
    );
    const taskComments = allTaskComments.filter((c) => {
      const ts = new Date(c.createdDate ?? "").getTime();
      return ts >= commentCutoff;
    });
    if (taskComments.length > 0) {
      commentsByTask.set(task.id, taskComments);
    }
  }

  return { folderId, tasks, comments: commentsByTask };
}
