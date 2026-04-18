// Pure metric computation extracted from flowBuilder.ts so the same functions
// can run on both the server (during sync) and the client (when filtering
// archived tickets via the "Show archived" toggle). No server-only imports
// allowed in this file — verified by import path: only ./types and ./math.

import type {
  TicketFlowEntry,
  FlowMetrics,
} from "./types";
import { computePercentile } from "./math";
import { isDateWithinRange } from "./week";

const STAGE_ORDER = [
  "New",
  "Planned",
  "In Progress",
  "In Review",
  "Client Pending",
  "Completed",
];

const ACTIVE_STAGES = new Set(["In Progress"]);
const AGING_THRESHOLD_HOURS = 5 * 24;

export function normalizeStage(name: string): string {
  const lower = name.toLowerCase();
  if (lower === "new" || lower === "planned") return name;
  if (lower === "client review" || lower === "client pending")
    return "Client Pending";
  if (lower === "internal review" || lower === "in review") return "In Review";
  if (lower === "completed" || lower === "approved" || lower === "complete")
    return "Completed";
  return name;
}

export function computeFlowMetrics(
  tickets: TicketFlowEntry[],
  weekStart: string,
  weekEnd: string,
): FlowMetrics {
  const completedSet = new Set(["Completed"]);
  const completed = tickets.filter(
    (t) =>
      completedSet.has(t.currentStage) &&
      isDateWithinRange(t.completedDate, weekStart, weekEnd),
  );
  const active = tickets.filter((t) => !completedSet.has(t.currentStage));

  const cycleTimes = completed
    .map((t) => t.totalCycleHours)
    .filter((h): h is number => h !== null);

  const stageCounts = new Map<string, number>();
  for (const t of tickets) {
    const stage = t.currentStage;
    stageCounts.set(stage, (stageCounts.get(stage) ?? 0) + 1);
  }
  const stageDistribution = STAGE_ORDER.filter((s) => stageCounts.has(s)).map(
    (s) => ({ stageName: s, count: stageCounts.get(s)! }),
  );
  for (const [s, count] of stageCounts) {
    if (!STAGE_ORDER.includes(s)) {
      stageDistribution.push({ stageName: s, count });
    }
  }

  const dailyFlow = buildDailyFlow(tickets, weekStart, weekEnd);

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
    totalAll > 0 ? Math.round((totalActive / totalAll) * 10000) / 100 : null;

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

function buildDailyFlow(
  tickets: TicketFlowEntry[],
  weekStart: string,
  weekEnd: string,
): { date: string; stages: Record<string, number> }[] {
  const start = new Date(weekStart);
  const end = new Date(weekEnd);
  const days: { date: string; stages: Record<string, number> }[] = [];

  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const dayEnd = new Date(d);
    dayEnd.setHours(23, 59, 59, 999);
    const dayEndMs = dayEnd.getTime();
    const dateStr = d.toISOString().slice(0, 10);

    const stages: Record<string, number> = {};
    for (const stage of STAGE_ORDER) {
      stages[stage] = 0;
    }

    for (const ticket of tickets) {
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

interface EmployeeMetricPortion extends FlowMetrics {
  medianExecutionHours: number | null;
  avgEffortScore: number | null;
}

export function computeEmployeeFlowMetrics(
  tickets: TicketFlowEntry[],
  weekStart: string,
  weekEnd: string,
): EmployeeMetricPortion {
  const base = computeFlowMetrics(tickets, weekStart, weekEnd);

  const execTimes = tickets
    .map((t) => t.executionHours)
    .filter((h): h is number => h !== null);

  const efforts = tickets
    .map((t) => t.effortScore)
    .filter((e): e is number => e !== null);

  return {
    ...base,
    medianExecutionHours: computePercentile(execTimes, 50),
    avgEffortScore:
      efforts.length > 0
        ? Math.round(
            (efforts.reduce((a, b) => a + b, 0) / efforts.length) * 100,
          ) / 100
        : null,
  };
}
