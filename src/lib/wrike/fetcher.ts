// High-level Wrike data fetching for the KPI dashboard

import { getWrikeClient } from "./client";
import type {
  WrikeTask,
  WrikeComment,
  WrikeTimelog,
  WrikeWorkflow,
  WrikeCustomStatus,
} from "./types";
import { config, COMPLETED_TASK_CUTOFF_DAYS } from "../config";
import { getCachedWorkflowStatuses, setCachedWorkflowStatuses } from "../storage";

// ---------------------------------------------------------------------------
// 90-day completed cutoff
//
// Completed tasks whose completedDate is older than COMPLETED_TASK_CUTOFF_DAYS
// are dropped at fetch time — they're not synced, stored, or shown. Active
// (non-completed) tasks are NEVER filtered by age.
// ---------------------------------------------------------------------------

// Per-sync telemetry: unique task IDs with status=Completed but no completedDate
// (the Wrike Feb–early-Mar 2026 migration cohort). initNullCompletedDateCounter
// at sync start, reportNullCompletedDateCounter at end. Feeds Unit 5b decision
// on whether to switch isCompletedBeyondCutoff to an updatedDate surrogate.
let _nullCompletedDateTaskIds: Set<string> | null = null;

export function initNullCompletedDateCounter(): void {
  _nullCompletedDateTaskIds = new Set();
}

export function reportNullCompletedDateCounter(): void {
  const count = _nullCompletedDateTaskIds?.size ?? 0;
  console.log(
    `[fetcher] null-completedDate completed-task count for this sync: ${count}`,
  );
  _nullCompletedDateTaskIds = null;
}

function isCompletedBeyondCutoff(task: WrikeTask): boolean {
  if (task.status !== "Completed") return false;
  if (!task.completedDate) {
    _nullCompletedDateTaskIds?.add(task.id);
    return false;
  }
  const ageMs = Date.now() - new Date(task.completedDate).getTime();
  return ageMs > COMPLETED_TASK_CUTOFF_DAYS * 24 * 60 * 60 * 1000;
}

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

function isValidCachedStatuses(
  cached: Awaited<ReturnType<typeof getCachedWorkflowStatuses>>,
): cached is NonNullable<Awaited<ReturnType<typeof getCachedWorkflowStatuses>>> {
  return !!cached && Array.isArray(cached.allStatuses) && cached.allStatuses.length > 0;
}

export async function resolveWorkflowStatuses(): Promise<ResolvedStatuses> {
  // Check in-memory cache first
  if (_cachedStatuses && Date.now() - _cachedStatuses.cachedAt < STATUS_CACHE_TTL_MS) {
    return _cachedStatuses.data;
  }

  // P25: Check Redis cache on cold start before hitting Wrike API
  try {
    const cached = await getCachedWorkflowStatuses();
    if (isValidCachedStatuses(cached)) {
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
    if (cached) {
      console.warn("[fetcher] Ignoring invalid cached workflow statuses");
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
// Per-sync folder comment cache
//
// Both fetchWeeklyMemberData (per-member) and fetchClientTasks (per-client
// in the flow build) call `/folders/{id}/comments` with the same folderId.
// Across a full sync this hits Wrike ~16 times for the same 4 folders.
// This cache is scoped to a single sync — init at the top of runSync,
// clear in the finally. No TTL, no cross-sync reuse.
// ---------------------------------------------------------------------------

let _folderCommentCache: Map<string, Promise<WrikeComment[]>> | null = null;

export function initFolderCommentCache(): void {
  _folderCommentCache = new Map();
}

export function clearFolderCommentCache(): void {
  _folderCommentCache = null;
}

async function getFolderComments(folderId: string): Promise<WrikeComment[]> {
  const client = getWrikeClient();
  if (_folderCommentCache) {
    const existing = _folderCommentCache.get(folderId);
    if (existing) return existing;
    const pending = client.get<WrikeComment>(`/folders/${folderId}/comments`);
    // Evict rejected entries so a transient Wrike error doesn't poison every
    // subsequent member/client that shares the folder in this sync.
    pending.catch(() => {
      if (_folderCommentCache?.get(folderId) === pending) {
        _folderCommentCache.delete(folderId);
      }
    });
    _folderCommentCache.set(folderId, pending);
    return pending;
  }
  return client.get<WrikeComment>(`/folders/${folderId}/comments`);
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

  const taskMap = new Map<string, WrikeTask>();
  const commentsByTask = new Map<string, WrikeComment[]>();

  const mergeComments = (taskId: string, incoming: WrikeComment[]) => {
    if (incoming.length === 0) return;
    const merged = new Map<string, WrikeComment>();
    for (const comment of commentsByTask.get(taskId) ?? []) {
      merged.set(comment.id, comment);
    }
    for (const comment of incoming) {
      merged.set(comment.id, comment);
    }
    commentsByTask.set(
      taskId,
      Array.from(merged.values()).sort((a, b) =>
        a.createdDate.localeCompare(b.createdDate),
      ),
    );
  };

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

    // Filter to tasks this member is responsible for, and drop completed
    // tasks older than the 90-day cutoff before any per-task comment work.
    const memberTasks = tasks.filter(
      (t) =>
        t.responsibleIds?.includes(contactId) &&
        !isCompletedBeyondCutoff(t),
    );
    for (const task of memberTasks) {
      const existingTask = taskMap.get(task.id);
      if (!existingTask || new Date(task.updatedDate).getTime() > new Date(existingTask.updatedDate).getTime()) {
        taskMap.set(task.id, task);
      }
    }

    // ---- Comments (folder-level) ----
    // Wrike comments endpoint does NOT support updatedDate filter — fetch all
    // and filter in code below. Uses per-sync folder cache to dedupe across
    // members/flow.
    const folderComments = await getFolderComments(folderId);

    // Build a set of member task IDs for quick lookup
    const memberTaskIds = new Set(memberTasks.map((t) => t.id));

    // Map comments that have a taskId directly
    const mappedTaskIds = new Set<string>();
    for (const comment of folderComments) {
      if (comment.taskId && memberTaskIds.has(comment.taskId)) {
        mergeComments(comment.taskId, [comment]);
        mappedTaskIds.add(comment.taskId);
      }
    }

    // Fallback: for member tasks that had no folder-level comments mapped,
    // fetch per-task comments (the folder endpoint may omit taskId in some cases).
    // Active tasks are fetched before Completed so an interrupted loop still
    // covers the most-relevant work (R5: active-first).
    const unmappedTaskIds = memberTasks
      .filter((t) => !mappedTaskIds.has(t.id))
      .sort((a, b) => (a.status === "Completed" ? 1 : 0) - (b.status === "Completed" ? 1 : 0))
      .map((t) => t.id);

    const unmappedComments = await client.getCommentsByTaskIds(unmappedTaskIds);
    for (const [taskId, taskComments] of unmappedComments) {
      mergeComments(taskId, taskComments);
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

  return {
    tasks: Array.from(taskMap.values()),
    comments: commentsByTask,
    timelogs,
    totalHours,
  };
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
  // Drop completed tasks older than the 90-day cutoff before fetching comments.
  const tasks = Array.from(taskMap.values()).filter(
    (t) => !isCompletedBeyondCutoff(t),
  );

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
  // filter in code by the extended lookback window. Uses per-sync folder cache.
  const allFolderComments = await getFolderComments(folderId);
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

  // Fallback per-task comment fetch for unmapped tasks (same extended lookback).
  // Active tasks first so an interrupted loop still covers the most-relevant work.
  const unmappedTaskIds = tasks
    .filter((t) => !mappedTaskIds.has(t.id))
    .sort((a, b) => (a.status === "Completed" ? 1 : 0) - (b.status === "Completed" ? 1 : 0))
    .map((t) => t.id);
  const unmappedComments = await client.getCommentsByTaskIds(unmappedTaskIds);
  for (const [taskId, allTaskComments] of unmappedComments) {
    const taskComments = allTaskComments.filter((c) => {
      const ts = new Date(c.createdDate ?? "").getTime();
      return ts >= commentCutoff;
    });
    if (taskComments.length > 0) {
      commentsByTask.set(taskId, taskComments);
    }
  }

  return { folderId, tasks, comments: commentsByTask };
}
