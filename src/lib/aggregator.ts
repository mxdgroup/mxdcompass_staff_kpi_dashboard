import { config, getMemberByContactId } from "./config";
import type {
  WeeklySnapshot,
  TeamSummary,
  EmployeeWeekData,
  TaskSummary,
  GitHubEmployeeData,
  DailyCommitEntry,
  PRSummary,
  PipelineStageCount,
  ApprovalCycleTimeData,
  MemberError,
} from "./types";
import { getWeekRange, getWeekDays } from "./week";
import { getSnapshot } from "./storage";
import { fetchWeeklyMemberData, resolveWorkflowStatuses } from "./wrike/fetcher";
import { getPipelineMovement, getReturnForReviewCount, getApprovalCycleTime } from "./wrike/transitions";
import { fetchWeeklyGitHubData } from "./github/fetcher";
import type { DailyCommits, GitHubWeekData } from "./github/types";

export async function buildWeeklySnapshot(week: string): Promise<WeeklySnapshot> {
  const range = getWeekRange(week);
  const dateRange = { start: range.start, end: range.end };
  const statuses = await resolveWorkflowStatuses();
  const memberErrors: MemberError[] = [];
  const employees: EmployeeWeekData[] = [];

  // Fetch webhook-derived metrics
  const startTs = Math.floor(range.startTimestamp / 1000);
  const endTs = Math.floor(range.endTimestamp / 1000);

  const [pipelineData, returnData, approvalData] = await Promise.all([
    getPipelineMovement(dateRange).catch(() => ({ total: 0, byMember: {} as Record<string, number> })),
    getReturnForReviewCount(
      dateRange,
      statuses.returnForReviewId ?? ""
    ).catch(() => ({ total: 0, byMember: {} as Record<string, number>, tasks: [] as string[] })),
    getApprovalCycleTime(
      dateRange,
      config.approvalWorkflowOwner,
      statuses.clientReviewId ?? "",
      statuses.completedIds
    ).catch(() => ({ medianHours: null, times: [] as number[] })),
  ]);

  // Process each team member
  for (const member of config.team) {
    try {
      // Wrike data
      const wrikeData = await fetchWeeklyMemberData(
        config.wrikeFolderIds,
        member.wrikeContactId,
        dateRange
      );

      // Build task summaries
      const tasks: TaskSummary[] = wrikeData.tasks.map((t) => {
        const taskComments = wrikeData.comments.get(t.id) ?? [];
        const isReturned = returnData.tasks.includes(t.id);
        const moved = (pipelineData.byMember[member.wrikeContactId] ?? 0) > 0;

        return {
          id: t.id,
          title: t.title,
          status: t.status,
          customStatusId: t.customStatusId ?? "",
          updatedDate: t.updatedDate,
          completedDate: t.completedDate ?? null,
          hasComments: taskComments.length > 0,
          commentCount: taskComments.length,
          movedThisWeek: moved,
          returnedForReview: isReturned,
          permalink: t.permalink ?? "",
        };
      });

      const tasksCompleted = tasks.filter((t) => t.completedDate !== null).length;
      const tasksActive = tasks.filter((t) => t.status.toLowerCase() !== "new").length;

      // GitHub data (null for non-engineers)
      let github: GitHubEmployeeData | null = null;
      if (member.githubUsername) {
        try {
          const ghData = await fetchWeeklyGitHubData(
            member.githubUsername,
            config.githubRepos,
            config.githubOrg,
            range.start,
            range.end
          );
          github = mapGitHubData(ghData, week);
        } catch {
          memberErrors.push({
            name: member.name,
            wrikeContactId: member.wrikeContactId,
            error: "GitHub fetch failed",
            timestamp: new Date().toISOString(),
          });
        }
      }

      employees.push({
        name: member.name,
        role: member.role,
        wrikeContactId: member.wrikeContactId,
        tasksCompleted,
        tasksActive,
        tasksUpdated: tasks.length,
        pipelineMovement: pipelineData.byMember[member.wrikeContactId] ?? 0,
        returnForReviewCount: returnData.byMember[member.wrikeContactId] ?? 0,
        hoursLogged: wrikeData.totalHours,
        tasks,
        github,
      });
    } catch (err) {
      memberErrors.push({
        name: member.name,
        wrikeContactId: member.wrikeContactId,
        error: err instanceof Error ? err.message : "Unknown error",
        timestamp: new Date().toISOString(),
      });
    }
  }

  // Build team summary
  const teamSummary = await buildTeamSummary(employees, pipelineData.total, returnData.total, week);

  // Build pipeline flow (simplified — counts per stage)
  const pipelineFlow = buildPipelineFlow(statuses.allStatuses, employees);

  // Approval cycle time
  const approvalOwner = getMemberByContactId(config.approvalWorkflowOwner);
  const approvalCycleTime: ApprovalCycleTimeData = {
    ownerName: approvalOwner?.name ?? "Unknown",
    medianHours: approvalData.medianHours,
    times: approvalData.times,
  };

  return {
    week,
    weekStart: range.start,
    weekEnd: range.end,
    syncedAt: new Date().toISOString(),
    teamSummary,
    employees,
    pipelineFlow,
    approvalCycleTime,
    memberErrors,
  };
}

async function buildTeamSummary(
  employees: EmployeeWeekData[],
  totalPipelineMovement: number,
  totalReturns: number,
  week: string
): Promise<TeamSummary> {
  const tasksCompleted = employees.reduce((sum, e) => sum + e.tasksCompleted, 0);
  const tasksUpdated = employees.reduce((sum, e) => sum + e.tasksUpdated, 0);
  const totalHoursLogged = employees.reduce((sum, e) => sum + e.hoursLogged, 0);
  const prsMerged = employees.reduce((sum, e) => sum + (e.github?.prsMerged ?? 0), 0);

  // Get prior week for delta calculation
  const priorWeekStr = getPriorWeekStr(week);
  const priorSnap = priorWeekStr ? await getSnapshot(priorWeekStr) : null;

  const delta = (current: number, prior: number | undefined) =>
    prior !== undefined && prior > 0
      ? Math.round(((current - prior) / prior) * 100)
      : null;

  // 4-week trailing averages
  const avg4w = await compute4WeekAverage(week);

  return {
    tasksCompleted,
    tasksUpdated,
    pipelineMovement: totalPipelineMovement,
    returnForReviewCount: totalReturns,
    totalHoursLogged,
    prsMerged,
    tasksCompletedDelta: delta(tasksCompleted, priorSnap?.teamSummary.tasksCompleted),
    pipelineMovementDelta: delta(totalPipelineMovement, priorSnap?.teamSummary.pipelineMovement),
    returnForReviewDelta: delta(totalReturns, priorSnap?.teamSummary.returnForReviewCount),
    prsMergedDelta: delta(prsMerged, priorSnap?.teamSummary.prsMerged),
    tasksCompletedAvg4w: avg4w.tasksCompleted,
    returnForReviewAvg4w: avg4w.returnForReview,
  };
}

function getPriorWeekStr(week: string): string | null {
  const [yearStr, weekPart] = week.split("-W");
  const weekNum = parseInt(weekPart, 10);
  if (weekNum <= 1) {
    return `${parseInt(yearStr, 10) - 1}-W52`;
  }
  return `${yearStr}-W${String(weekNum - 1).padStart(2, "0")}`;
}

async function compute4WeekAverage(
  currentWeek: string
): Promise<{ tasksCompleted: number | null; returnForReview: number | null }> {
  const weeks: string[] = [];
  let w = currentWeek;
  for (let i = 0; i < 4; i++) {
    const prior = getPriorWeekStr(w);
    if (!prior) break;
    weeks.push(prior);
    w = prior;
  }

  const snapshots = await Promise.all(weeks.map((w) => getSnapshot(w)));
  const valid = snapshots.filter((s) => s !== null);

  if (valid.length === 0) return { tasksCompleted: null, returnForReview: null };

  return {
    tasksCompleted: Math.round(valid.reduce((s, snap) => s + snap.teamSummary.tasksCompleted, 0) / valid.length),
    returnForReview: Math.round(valid.reduce((s, snap) => s + snap.teamSummary.returnForReviewCount, 0) / valid.length * 10) / 10,
  };
}

function mapGitHubData(ghData: GitHubWeekData, week: string): GitHubEmployeeData {
  const dayNames = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const days = getWeekDays(week);

  const dailyCommits: DailyCommitEntry[] = ghData.dailyCommits.map((dc, i) => ({
    date: days[i] ?? dc.date,
    dayName: dayNames[i] ?? "",
    commits: dc.commits.map((c) => ({
      sha: c.sha,
      message: c.message,
      repo: c.repo,
      timestamp: c.date,
    })),
  }));

  const prs: PRSummary[] = ghData.prs.map((pr) => ({
    number: pr.number,
    title: pr.title,
    repo: pr.repo,
    createdAt: pr.createdAt,
    mergedAt: pr.mergedAt,
    cycleTimeHours: pr.cycleTimeHours,
  }));

  return {
    totalCommits: ghData.totalCommits,
    dailyCommits,
    prsMerged: ghData.prsMergedCount,
    medianCycleTimeHours: ghData.medianCycleTimeHours,
    prs,
  };
}

function buildPipelineFlow(
  allStatuses: Array<{ id: string; name: string; group?: string }>,
  employees: EmployeeWeekData[]
): PipelineStageCount[] {
  const allTasks = employees.flatMap((e) => e.tasks);
  const stageMap = new Map<string, PipelineStageCount>();

  for (const status of allStatuses) {
    stageMap.set(status.id, {
      stageName: status.name,
      stageId: status.id,
      currentCount: 0,
      enteredThisWeek: 0,
      leftThisWeek: 0,
    });
  }

  for (const task of allTasks) {
    const stage = stageMap.get(task.customStatusId);
    if (stage) {
      stage.currentCount++;
      if (task.movedThisWeek) {
        stage.enteredThisWeek++;
      }
    }
  }

  return Array.from(stageMap.values()).filter((s) => s.currentCount > 0 || s.enteredThisWeek > 0);
}
