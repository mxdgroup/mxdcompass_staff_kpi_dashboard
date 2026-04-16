// Core orchestrator: builds a FlowSnapshot from Wrike data for a given week

import {
  config,
  getMemberByContactId,
} from "./config";
import type {
  FlowSnapshot,
  FlowMetrics,
  EmployeeFlowMetrics,
  TicketFlowEntry,
  StageTransition,
  StageDuration,
} from "./types";
import { getWeekRange } from "./week";
import {
  resolveWorkflowStatuses,
  fetchClientTasks,
  type ResolvedStatuses,
} from "./wrike/fetcher";
import { getWrikeClient } from "./wrike/client";
import type { WrikeTask, WrikeComment } from "./wrike/types";
import { parseStatusChangesFromComments } from "./wrike/commentParser";
import { getTransitionsInRange } from "./wrike/transitions";
import type { TransitionEntry } from "./wrike/webhook";
import {
  computeFlowMetrics,
  computeEmployeeFlowMetrics,
  normalizeStage,
} from "./flowMetrics";

function resolveStatusName(
  statusId: string,
  statuses: ResolvedStatuses,
): string {
  const found = statuses.allStatuses.find((s) => s.id === statusId);
  return found?.name ?? "Unknown";
}

// ---------------------------------------------------------------------------
// Merge webhook + comment transitions
// ---------------------------------------------------------------------------

function mergeTransitions(
  webhookEntries: TransitionEntry[],
  commentTransitions: StageTransition[],
  statuses: ResolvedStatuses,
): StageTransition[] {
  // Convert webhook entries to StageTransition
  const fromWebhook: StageTransition[] = webhookEntries.map((e) => ({
    fromStage: resolveStatusName(e.fromStatusId, statuses),
    toStage: resolveStatusName(e.toStatusId, statuses),
    fromStageId: e.fromStatusId,
    toStageId: e.toStatusId,
    timestamp: e.timestamp,
    source: "webhook" as const,
  }));

  // Deduplicate: webhook wins if a comment transition has the same toStageId
  // within a 5-minute window
  const DEDUP_WINDOW_MS = 5 * 60 * 1000;
  const deduped: StageTransition[] = [...fromWebhook];

  for (const ct of commentTransitions) {
    const ctTime = new Date(ct.timestamp).getTime();
    const isDuplicate = fromWebhook.some((wt) => {
      const wtTime = new Date(wt.timestamp).getTime();
      return (
        wt.toStageId === ct.toStageId &&
        Math.abs(wtTime - ctTime) < DEDUP_WINDOW_MS
      );
    });
    if (!isDuplicate) {
      deduped.push(ct);
    }
  }

  // Sort chronologically
  deduped.sort(
    (a, b) =>
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );

  return deduped;
}

// ---------------------------------------------------------------------------
// Compute stage durations from transitions
// ---------------------------------------------------------------------------

function computeStageDurations(
  transitions: StageTransition[],
  now: Date,
): StageDuration[] {
  if (transitions.length === 0) return [];

  const durations: StageDuration[] = [];

  for (let i = 0; i < transitions.length; i++) {
    const t = transitions[i];
    const enteredAt = t.timestamp;
    const exitedAt =
      i + 1 < transitions.length ? transitions[i + 1].timestamp : null;
    const enteredMs = new Date(enteredAt).getTime();
    const exitedMs = exitedAt ? new Date(exitedAt).getTime() : now.getTime();
    const durationHours = (exitedMs - enteredMs) / (1000 * 60 * 60);

    durations.push({
      stageName: normalizeStage(t.toStage),
      stageId: t.toStageId,
      enteredAt,
      exitedAt,
      durationHours: Math.round(durationHours * 100) / 100,
    });
  }

  return durations;
}

// ---------------------------------------------------------------------------
// Build a TicketFlowEntry from a task
// ---------------------------------------------------------------------------

function buildTicketFlow(
  task: {
    id: string;
    title: string;
    permalink: string;
    status: string;
    customStatusId?: string;
    responsibleIds: string[];
    customFields: { id: string; value?: string }[];
    completedDate?: string;
    createdDate?: string;
    updatedDate?: string;
  },
  transitions: StageTransition[],
  clientName: string,
  statuses: ResolvedStatuses,
  now: Date,
): TicketFlowEntry {
  const durations = computeStageDurations(transitions, now);

  // Find assignee
  const contactId = task.responsibleIds?.[0] ?? "";
  const member = getMemberByContactId(contactId);

  // Current stage
  const currentStage = normalizeStage(
    task.customStatusId
      ? resolveStatusName(task.customStatusId, statuses)
      : task.status,
  );

  // Best-effort "entered current stage" timestamp:
  // 1. Last transition timestamp (if any transitions exist)
  // 2. createdDate (if status is "New" — never transitioned)
  // 3. updatedDate (general fallback)
  const lastTransition = transitions[transitions.length - 1];
  const currentStageEnteredAt: string | null =
    lastTransition?.timestamp ??
    (currentStage === "New" && task.createdDate ? task.createdDate : null) ??
    task.updatedDate ??
    null;

  // Current stage age: time since entered current stage
  const currentStageAgeHours = currentStageEnteredAt
    ? (now.getTime() - new Date(currentStageEnteredAt).getTime()) /
      (1000 * 60 * 60)
    : 0;

  // Find when it first entered a planned status
  const plannedSet = new Set(statuses.plannedIds);
  const firstPlanned = transitions.find((t) => plannedSet.has(t.toStageId));
  const enteredPlanDate = firstPlanned?.timestamp ?? null;

  // Find when it first entered In Review
  const firstInReview = statuses.inReviewId
    ? transitions.find((t) => t.toStageId === statuses.inReviewId)
    : undefined;

  // Find when it first hit a completed status
  const completedSet = new Set(statuses.completedIds);
  const firstCompleted = transitions.find((t) =>
    completedSet.has(t.toStageId),
  );

  // Execution time: Planned → In Review
  let executionHours: number | null = null;
  if (enteredPlanDate && firstInReview) {
    executionHours =
      Math.round(
        ((new Date(firstInReview.timestamp).getTime() -
          new Date(enteredPlanDate).getTime()) /
          (1000 * 60 * 60)) *
          100,
      ) / 100;
  }

  // Total cycle: Planned → Complete
  let totalCycleHours: number | null = null;
  if (enteredPlanDate && firstCompleted) {
    totalCycleHours =
      Math.round(
        ((new Date(firstCompleted.timestamp).getTime() -
          new Date(enteredPlanDate).getTime()) /
          (1000 * 60 * 60)) *
          100,
      ) / 100;
  }

  // Effort score from custom fields
  let effortScore: number | null = null;
  if (config.effortCustomFieldId) {
    const cf = task.customFields?.find(
      (f) => f.id === config.effortCustomFieldId,
    );
    if (cf?.value) {
      const parsed = parseFloat(cf.value);
      if (!isNaN(parsed)) effortScore = parsed;
    }
  }

  // Guarantee the current stage has a StageDuration entry.
  // This ensures the table, flow metrics, and charts always have data for
  // where each ticket IS right now, even without full transition history.
  const hasCurrentStageDuration = durations.some(
    (d) => d.stageName === currentStage,
  );
  if (!hasCurrentStageDuration && currentStage && currentStageEnteredAt) {
    const enteredMs = new Date(currentStageEnteredAt).getTime();
    const durationHours = (now.getTime() - enteredMs) / (1000 * 60 * 60);
    durations.push({
      stageName: currentStage,
      stageId: task.customStatusId ?? "",
      enteredAt: currentStageEnteredAt,
      exitedAt: null,
      durationHours: Math.round(durationHours * 100) / 100,
    });
  }

  return {
    taskId: task.id,
    title: task.title,
    permalink: task.permalink,
    assigneeContactId: contactId,
    assigneeName: member?.name ?? "Unknown",
    clientName,
    effortScore,
    transitions,
    stageDurations: durations,
    currentStage,
    currentStageEnteredAt,
    currentStageAgeHours: Math.round(currentStageAgeHours * 100) / 100,
    enteredPlanDate,
    completedDate: task.completedDate ?? firstCompleted?.timestamp ?? null,
    totalCycleHours,
    executionHours,
  };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function buildFlowSnapshot(
  week: string,
): Promise<FlowSnapshot> {
  const { start: weekStart, end: weekEnd } = getWeekRange(week);
  const statuses = await resolveWorkflowStatuses();
  const now = new Date();

  // P19: Extend transition lookback 4 weeks before the selected week for accurate cycle times
  const weekStartMs = new Date(weekStart).getTime();
  const lookbackStartMs = weekStartMs - 4 * 7 * 24 * 60 * 60 * 1000;
  const startTs = Math.floor(lookbackStartMs / 1000);
  const endTs = Math.floor(new Date(weekEnd).getTime() / 1000);
  const allWebhookTransitions = await getTransitionsInRange(startTs, endTs);

  // Group webhook transitions by taskId
  const webhookByTask = new Map<string, TransitionEntry[]>();
  for (const t of allWebhookTransitions) {
    const arr = webhookByTask.get(t.taskId) ?? [];
    arr.push(t);
    webhookByTask.set(t.taskId, arr);
  }

  // Fetch tasks from each client folder in parallel. Shared throttle chain
  // serializes requests; parallelism overlaps network round-trips.
  const folderErrors: string[] = [];
  const clientResults = await Promise.all(
    config.clients.map(async (client) => {
      try {
        const data = await fetchClientTasks(client.wrikeFolderId, {
          start: weekStart,
          end: weekEnd,
        });
        return { client, data, error: null as string | null };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[flow] Failed to fetch tasks for ${client.name} (folder ${client.wrikeFolderId}): ${msg}`);
        return { client, data: null, error: `${client.name}: ${msg}` };
      }
    }),
  );

  const allTickets: TicketFlowEntry[] = [];
  for (const { client, data, error } of clientResults) {
    if (error) {
      folderErrors.push(error);
      continue;
    }
    if (!data) continue;

    for (const task of data.tasks) {
      const taskComments = data.comments.get(task.id) ?? [];
      const commentTransitions = parseStatusChangesFromComments(
        taskComments,
        statuses.allStatuses,
      );

      const taskWebhook = webhookByTask.get(task.id) ?? [];

      const transitions = mergeTransitions(
        taskWebhook,
        commentTransitions,
        statuses,
      );

      if (transitions.length === 0 && task.customStatusId) {
        const statusName = resolveStatusName(task.customStatusId, statuses);
        if (statusName !== "Unknown") {
          transitions.push({
            fromStage: "Unknown",
            toStage: statusName,
            fromStageId: "",
            toStageId: task.customStatusId,
            timestamp: task.updatedDate ?? now.toISOString(),
            source: "comment" as const,
          });
        }
      }

      const ticket = buildTicketFlow(
        task,
        transitions,
        client.name,
        statuses,
        now,
      );

      const isSynthetic = taskWebhook.length === 0 && commentTransitions.length === 0;
      console.log(
        `[flow] ${task.id} "${task.title.slice(0, 40)}" — webhook:${taskWebhook.length} comment:${commentTransitions.length} merged:${transitions.length}${isSynthetic ? " (synthetic)" : ""}`,
      );

      allTickets.push(ticket);
    }
  }

  // Deduplicate tickets (a task could appear in multiple fetches)
  const seen = new Set<string>();
  const dedupedTickets = allTickets.filter((t) => {
    if (seen.has(t.taskId)) return false;
    seen.add(t.taskId);
    return true;
  });

  // Compute agency-wide metrics
  const agencyMetrics = computeFlowMetrics(dedupedTickets, weekStart, weekEnd);

  // Compute per-client metrics
  const clientMetrics: Record<string, FlowMetrics> = {};
  for (const client of config.clients) {
    const clientTickets = dedupedTickets.filter(
      (t) => t.clientName === client.name,
    );
    if (clientTickets.length > 0) {
      clientMetrics[client.name] = computeFlowMetrics(
        clientTickets,
        weekStart,
        weekEnd,
      );
    }
  }

  // Compute per-employee metrics
  const employeeMetrics: Record<string, EmployeeFlowMetrics> = {};
  const ticketsByEmployee = new Map<string, TicketFlowEntry[]>();
  for (const ticket of dedupedTickets) {
    const cid = ticket.assigneeContactId;
    if (!cid) continue;
    const arr = ticketsByEmployee.get(cid) ?? [];
    arr.push(ticket);
    ticketsByEmployee.set(cid, arr);
  }

  for (const [contactId, empTickets] of ticketsByEmployee) {
    const member = getMemberByContactId(contactId);
    if (!member) continue;

    const empMetrics = computeEmployeeFlowMetrics(empTickets, weekStart, weekEnd);

    employeeMetrics[contactId] = {
      ...empMetrics,
      name: member.name,
      contactId,
      role: member.role,
      tickets: empTickets,
    };
  }

  const syntheticOnly = dedupedTickets.filter(
    (t) => t.transitions.length === 1 && t.transitions[0].fromStage === "Unknown" && t.transitions[0].source === "comment",
  ).length;
  const withReal = dedupedTickets.length - syntheticOnly;
  console.log(`[flow] Summary: ${dedupedTickets.length} tickets, ${withReal} with real transitions, ${syntheticOnly} synthetic-only`);
  if (folderErrors.length > 0) {
    console.error(`[flow] Folder fetch errors (${folderErrors.length}/${config.clients.length} folders failed): ${folderErrors.join(" | ")}`);
  }
  if (dedupedTickets.length === 0 && folderErrors.length > 0) {
    console.error(`[flow] ALL folders failed — likely an auth issue. Check WRIKE_PERMANENT_ACCESS_TOKEN.`);
  }

  return {
    week,
    syncedAt: now.toISOString(),
    tickets: dedupedTickets,
    agencyMetrics,
    clientMetrics,
    employeeMetrics,
    folderErrors: folderErrors.length > 0 ? folderErrors : undefined,
  };
}

// ---------------------------------------------------------------------------
// Single-task patch: fetch one task from Wrike, rebuild its flow entry,
// and splice it into the existing snapshot. Much faster than a full rebuild.
// ---------------------------------------------------------------------------

export async function patchFlowSnapshotForTask(
  taskId: string,
  existing: FlowSnapshot,
): Promise<FlowSnapshot> {
  const statuses = await resolveWorkflowStatuses();
  const now = new Date();
  const client = getWrikeClient();

  // Fetch just this task + its comments from Wrike API (2 requests)
  const [tasks, comments] = await Promise.all([
    client.get<WrikeTask>(`/tasks/${taskId}`, {
      fields: JSON.stringify(["customFields", "responsibleIds", "briefDescription"]),
    }),
    client.get<WrikeComment>(`/tasks/${taskId}/comments`),
  ]);

  const task = tasks[0];
  if (!task) {
    console.warn(`[flow] patchFlowSnapshotForTask: task ${taskId} not found in Wrike`);
    return existing;
  }

  // Get all webhook transitions for the lookback window (same as full build)
  const { start: weekStart, end: weekEnd } = getWeekRange(existing.week);
  const weekStartMs = new Date(weekStart).getTime();
  const lookbackStartMs = weekStartMs - 4 * 7 * 24 * 60 * 60 * 1000;
  const startTs = Math.floor(lookbackStartMs / 1000);
  const endTs = Math.floor(new Date(weekEnd).getTime() / 1000);
  const allTransitions = await getTransitionsInRange(startTs, endTs);
  const taskWebhook = allTransitions.filter((t) => t.taskId === taskId);

  // Parse comment transitions
  const commentTransitions = parseStatusChangesFromComments(comments, statuses.allStatuses);

  // Merge
  const transitions = mergeTransitions(taskWebhook, commentTransitions, statuses);

  // Synthetic transition for stale tickets
  if (transitions.length === 0 && task.customStatusId) {
    const statusName = resolveStatusName(task.customStatusId, statuses);
    if (statusName !== "Unknown") {
      transitions.push({
        fromStage: "Unknown",
        toStage: statusName,
        fromStageId: "",
        toStageId: task.customStatusId,
        timestamp: task.updatedDate ?? now.toISOString(),
        source: "comment" as const,
      });
    }
  }

  // Determine client name from existing ticket or folder membership
  const existingTicket = existing.tickets.find((t) => t.taskId === taskId);
  const clientName = existingTicket?.clientName ?? "Unknown";

  // Build the updated ticket flow entry
  const updatedTicket = buildTicketFlow(task, transitions, clientName, statuses, now);

  // Replace or add in the ticket list
  const tickets = existing.tickets.filter((t) => t.taskId !== taskId);
  tickets.push(updatedTicket);

  // Recompute all metrics with the updated ticket list
  const agencyMetrics = computeFlowMetrics(tickets, weekStart, weekEnd);

  const clientMetrics: Record<string, FlowMetrics> = {};
  for (const c of config.clients) {
    const clientTickets = tickets.filter((t) => t.clientName === c.name);
    if (clientTickets.length > 0) {
      clientMetrics[c.name] = computeFlowMetrics(clientTickets, weekStart, weekEnd);
    }
  }

  const employeeMetrics: Record<string, EmployeeFlowMetrics> = {};
  const ticketsByEmployee = new Map<string, TicketFlowEntry[]>();
  for (const ticket of tickets) {
    const cid = ticket.assigneeContactId;
    if (!cid) continue;
    const arr = ticketsByEmployee.get(cid) ?? [];
    arr.push(ticket);
    ticketsByEmployee.set(cid, arr);
  }

  for (const [contactId, empTickets] of ticketsByEmployee) {
    const member = getMemberByContactId(contactId);
    if (!member) continue;

    const empMetrics = computeEmployeeFlowMetrics(empTickets, weekStart, weekEnd);

    employeeMetrics[contactId] = {
      ...empMetrics,
      name: member.name,
      contactId,
      role: member.role,
      tickets: empTickets,
    };
  }

  return {
    week: existing.week,
    syncedAt: now.toISOString(),
    tickets,
    agencyMetrics,
    clientMetrics,
    employeeMetrics,
  };
}
