// Core orchestrator: builds a FlowSnapshot from Wrike data for a given week

import {
  config,
  getMemberByContactId,
  type ClientConfig,
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
import { parseStatusChangesFromComments } from "./wrike/commentParser";
import { getTransitionsInRange } from "./wrike/transitions";
import type { TransitionEntry } from "./wrike/webhook";
import { computePercentile } from "./math";

// ---------------------------------------------------------------------------
// Stage ordering for display and CFD
// ---------------------------------------------------------------------------

const STAGE_ORDER = [
  "New",
  "Planned",
  "In Progress",
  "In Review",
  "Client Pending",
  "Completed",
];

const ACTIVE_STAGES = new Set(["In Progress"]); // for flow efficiency calc
const AGING_THRESHOLD_HOURS = 5 * 24; // 5 days

function resolveStatusName(
  statusId: string,
  statuses: ResolvedStatuses,
): string {
  const found = statuses.allStatuses.find((s) => s.id === statusId);
  return found?.name ?? "Unknown";
}

function normalizeStage(name: string): string {
  // Map similar names to canonical form
  const lower = name.toLowerCase();
  if (lower === "new" || lower === "planned") return name;
  if (lower === "client review" || lower === "client pending")
    return "Client Pending";
  if (lower === "internal review" || lower === "in review") return "In Review";
  if (
    lower === "completed" ||
    lower === "approved" ||
    lower === "complete"
  )
    return "Completed";
  return name;
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

  // Current stage age: time since last transition
  const lastTransition = transitions[transitions.length - 1];
  const currentStageAgeHours = lastTransition
    ? (now.getTime() - new Date(lastTransition.timestamp).getTime()) /
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
    currentStageAgeHours: Math.round(currentStageAgeHours * 100) / 100,
    enteredPlanDate,
    completedDate: task.completedDate ?? firstCompleted?.timestamp ?? null,
    totalCycleHours,
    executionHours,
  };
}

// ---------------------------------------------------------------------------
// Compute FlowMetrics from a set of tickets
// ---------------------------------------------------------------------------

function computeFlowMetrics(
  tickets: TicketFlowEntry[],
  weekStart: string,
  weekEnd: string,
): FlowMetrics {
  const completedSet = new Set(["Completed"]);
  const completed = tickets.filter((t) =>
    completedSet.has(t.currentStage),
  );
  const active = tickets.filter(
    (t) => !completedSet.has(t.currentStage),
  );

  // Cycle times for completed tickets
  const cycleTimes = completed
    .map((t) => t.totalCycleHours)
    .filter((h): h is number => h !== null);

  // Stage distribution
  const stageCounts = new Map<string, number>();
  for (const t of tickets) {
    const stage = t.currentStage;
    stageCounts.set(stage, (stageCounts.get(stage) ?? 0) + 1);
  }
  const stageDistribution = STAGE_ORDER.filter((s) =>
    stageCounts.has(s),
  ).map((s) => ({ stageName: s, count: stageCounts.get(s)! }));
  // Add any stages not in standard order
  for (const [s, count] of stageCounts) {
    if (!STAGE_ORDER.includes(s)) {
      stageDistribution.push({ stageName: s, count });
    }
  }

  // Daily flow for CFD: reconstruct tasks-per-stage for each day
  const dailyFlow = buildDailyFlow(tickets, weekStart, weekEnd);

  // Flow efficiency: % of total duration spent in active stages
  let totalActive = 0;
  let totalAll = 0;
  for (const ticket of tickets) {
    for (const sd of ticket.stageDurations) {
      totalAll += sd.durationHours;
      if (ACTIVE_STAGES.has(sd.stageName)) {
        totalActive += sd.durationHours;
      }
    }
  }
  const flowEfficiency =
    totalAll > 0
      ? Math.round((totalActive / totalAll) * 10000) / 100
      : null;

  // Bottleneck: stage with highest average dwell time (excluding Completed)
  const stageDwellTotals = new Map<string, { total: number; count: number }>();
  for (const ticket of tickets) {
    for (const sd of ticket.stageDurations) {
      if (sd.stageName === "Completed") continue;
      const entry = stageDwellTotals.get(sd.stageName) ?? { total: 0, count: 0 };
      entry.total += sd.durationHours;
      entry.count += 1;
      stageDwellTotals.set(sd.stageName, entry);
    }
  }
  let bottleneckStage: { name: string; avgDwellHours: number } | null = null;
  let maxAvgDwell = 0;
  for (const [name, { total, count }] of stageDwellTotals) {
    const avg = total / count;
    if (avg > maxAvgDwell) {
      maxAvgDwell = avg;
      bottleneckStage = {
        name,
        avgDwellHours: Math.round(avg * 100) / 100,
      };
    }
  }

  return {
    wip: active.length,
    throughput: completed.length,
    cycleTimeP50Hours: computePercentile(cycleTimes, 50),
    cycleTimeP85Hours: computePercentile(cycleTimes, 85),
    agingItems: active.filter(
      (t) => t.currentStageAgeHours > AGING_THRESHOLD_HOURS,
    ).length,
    flowEfficiency,
    bottleneckStage,
    stageDistribution,
    dailyFlow,
  };
}

// ---------------------------------------------------------------------------
// Build daily flow data for CFD
// ---------------------------------------------------------------------------

function buildDailyFlow(
  tickets: TicketFlowEntry[],
  weekStart: string,
  weekEnd: string,
): { date: string; stages: Record<string, number> }[] {
  const start = new Date(weekStart);
  const end = new Date(weekEnd);
  const days: { date: string; stages: Record<string, number> }[] = [];

  for (
    let d = new Date(start);
    d <= end;
    d.setDate(d.getDate() + 1)
  ) {
    const dayEnd = new Date(d);
    dayEnd.setHours(23, 59, 59, 999);
    const dayEndMs = dayEnd.getTime();
    const dateStr = d.toISOString().slice(0, 10);

    const stages: Record<string, number> = {};
    for (const stage of STAGE_ORDER) {
      stages[stage] = 0;
    }

    for (const ticket of tickets) {
      // Find the last transition before or on this day
      let stageAtDay: string | null = null;
      for (const t of ticket.transitions) {
        if (new Date(t.timestamp).getTime() <= dayEndMs) {
          stageAtDay = normalizeStage(t.toStage);
        }
      }
      if (stageAtDay) {
        stages[stageAtDay] = (stages[stageAtDay] ?? 0) + 1;
      }
    }

    days.push({ date: dateStr, stages });
  }

  return days;
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

  // Get webhook transitions for the week
  const startTs = Math.floor(new Date(weekStart).getTime() / 1000);
  const endTs = Math.floor(new Date(weekEnd).getTime() / 1000);
  const allWebhookTransitions = await getTransitionsInRange(startTs, endTs);

  // Group webhook transitions by taskId
  const webhookByTask = new Map<string, TransitionEntry[]>();
  for (const t of allWebhookTransitions) {
    const arr = webhookByTask.get(t.taskId) ?? [];
    arr.push(t);
    webhookByTask.set(t.taskId, arr);
  }

  // Fetch tasks from each client folder
  const allTickets: TicketFlowEntry[] = [];

  for (const client of config.clients) {
    let data;
    try {
      data = await fetchClientTasks(client.wrikeFolderId, {
        start: weekStart,
        end: weekEnd,
      });
    } catch (err) {
      console.error(`[flow] Failed to fetch tasks for ${client.name}:`, err);
      continue;
    }

    for (const task of data.tasks) {
      // Get comment-derived transitions
      const taskComments = data.comments.get(task.id) ?? [];
      const commentTransitions = parseStatusChangesFromComments(
        taskComments,
        statuses.allStatuses,
      );

      // Get webhook transitions for this task
      const taskWebhook = webhookByTask.get(task.id) ?? [];

      // Merge both sources
      const transitions = mergeTransitions(
        taskWebhook,
        commentTransitions,
        statuses,
      );

      const ticket = buildTicketFlow(
        task,
        transitions,
        client.name,
        statuses,
        now,
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

    const base = computeFlowMetrics(empTickets, weekStart, weekEnd);

    // Execution times (Planned → In Review)
    const execTimes = empTickets
      .map((t) => t.executionHours)
      .filter((h): h is number => h !== null);

    // Effort scores
    const efforts = empTickets
      .map((t) => t.effortScore)
      .filter((e): e is number => e !== null);

    // Flow efficiency: % of total duration spent in active stages
    let totalActive = 0;
    let totalAll = 0;
    for (const ticket of empTickets) {
      for (const sd of ticket.stageDurations) {
        totalAll += sd.durationHours;
        if (ACTIVE_STAGES.has(sd.stageName)) {
          totalActive += sd.durationHours;
        }
      }
    }

    employeeMetrics[contactId] = {
      ...base,
      name: member.name,
      contactId,
      role: member.role,
      medianExecutionHours: computePercentile(execTimes, 50),
      avgEffortScore:
        efforts.length > 0
          ? Math.round(
              (efforts.reduce((a, b) => a + b, 0) / efforts.length) * 100,
            ) / 100
          : null,
      flowEfficiency:
        totalAll > 0
          ? Math.round((totalActive / totalAll) * 10000) / 100
          : null,
      tickets: empTickets,
    };
  }

  return {
    week,
    syncedAt: now.toISOString(),
    tickets: dedupedTickets,
    agencyMetrics,
    clientMetrics,
    employeeMetrics,
  };
}
