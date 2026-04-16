import type { Role } from "./config";

// --- Weekly Snapshot (stored in Redis) ---

export interface WeeklySnapshot {
  week: string; // ISO week e.g. "2026-W14"
  weekStart: string; // Monday ISO date e.g. "2026-03-30"
  weekEnd: string; // Sunday ISO date e.g. "2026-04-05"
  syncedAt: string; // ISO datetime of last sync
  teamSummary: TeamSummary;
  employees: EmployeeWeekData[];
  pipelineFlow: PipelineStageCount[];
  approvalCycleTime: ApprovalCycleTimeData;
  memberErrors: MemberError[];
}

export interface TeamSummary {
  tasksCompleted: number;
  tasksUpdated: number;
  pipelineMovement: number;
  returnForReviewCount: number;
  totalHoursLogged: number;
  prsMerged: number;
  // Deltas vs prior week (null if no prior data)
  tasksCompletedDelta: number | null;
  pipelineMovementDelta: number | null;
  returnForReviewDelta: number | null;
  prsMergedDelta: number | null;
  // 4-week trailing averages
  tasksCompletedAvg4w: number | null;
  returnForReviewAvg4w: number | null;
  // P29: False when webhook metrics fell back to zeros due to retrieval failure
  webhookMetricsAvailable: boolean;
}

export interface EmployeeWeekData {
  name: string;
  role: Role;
  wrikeContactId: string;
  // Wrike metrics
  tasksCompleted: number;
  tasksActive: number; // all assigned tasks not in "New" status
  tasksUpdated: number;
  pipelineMovement: number;
  returnForReviewCount: number;
  hoursLogged: number;
  tasks: TaskSummary[];
  // GitHub metrics (null for non-engineers)
  github: GitHubEmployeeData | null;
}

export interface TaskSummary {
  id: string;
  title: string;
  status: string;
  customStatusId: string;
  updatedDate: string;
  completedDate: string | null;
  hasComments: boolean;
  commentCount: number;
  movedThisWeek: boolean; // had a status transition this week
  returnedForReview: boolean;
  permalink: string;
}

export interface GitHubEmployeeData {
  totalCommits: number;
  dailyCommits: DailyCommitEntry[];
  prsMerged: number;
  medianCycleTimeHours: number | null;
  prs: PRSummary[];
}

export interface DailyCommitEntry {
  date: string; // YYYY-MM-DD
  dayName: string; // Mon, Tue, etc.
  commits: CommitEntry[];
}

export interface CommitEntry {
  sha: string;
  message: string; // truncated to 100 chars
  repo: string;
  timestamp: string;
}

export interface PRSummary {
  number: number;
  title: string;
  repo: string;
  createdAt: string;
  mergedAt: string;
  cycleTimeHours: number;
}

export interface PipelineStageCount {
  stageName: string;
  stageId: string;
  currentCount: number; // tasks currently in this stage
  enteredThisWeek: number; // tasks that moved INTO this stage
  leftThisWeek: number; // tasks that moved OUT of this stage
}

export interface ApprovalCycleTimeData {
  ownerName: string;
  medianHours: number | null;
  times: number[]; // individual cycle times in hours
}

export interface MemberError {
  name: string;
  wrikeContactId: string;
  error: string;
  timestamp: string;
}

// --- API Response ---

export interface DashboardApiResponse {
  current: WeeklySnapshot | null;
  history: WeeklySnapshot[];
  lastSynced: string | null;
}

// --- Flow Dashboard (Kanban metrics) ---

export interface StageTransition {
  fromStage: string;
  toStage: string;
  fromStageId: string;
  toStageId: string;
  timestamp: string; // ISO datetime
  source: "webhook" | "comment";
}

export interface StageDuration {
  stageName: string;
  stageId: string;
  enteredAt: string;
  exitedAt: string | null; // null = still in this stage
  durationHours: number;
}

export interface TicketFlowEntry {
  taskId: string;
  title: string;
  permalink: string;
  assigneeContactId: string;
  assigneeName: string;
  clientName: string;
  effortScore: number | null;
  transitions: StageTransition[];
  stageDurations: StageDuration[];
  currentStage: string;
  currentStageAgeHours: number;
  enteredPlanDate: string | null;
  completedDate: string | null;
  totalCycleHours: number | null; // Planned → Complete
  executionHours: number | null; // Planned → In Review
}

export interface FlowMetrics {
  wip: number;
  throughput: number;
  cycleTimeP50Hours: number | null;
  cycleTimeP85Hours: number | null;
  agingItems: number; // tasks > 5 days in current stage
  flowEfficiency: number | null; // % time in active stages vs total
  bottleneckStage: { name: string; avgDwellHours: number } | null;
  stageDistribution: { stageName: string; count: number }[];
  dailyFlow: { date: string; stages: Record<string, number> }[];
}

export interface EmployeeFlowMetrics extends FlowMetrics {
  name: string;
  contactId: string;
  role: Role;
  medianExecutionHours: number | null;
  avgEffortScore: number | null;
  flowEfficiency: number | null; // % time in active stages
  tickets: TicketFlowEntry[];
}

export interface FlowSnapshot {
  week: string;
  syncedAt: string;
  tickets: TicketFlowEntry[];
  agencyMetrics: FlowMetrics;
  clientMetrics: Record<string, FlowMetrics>; // keyed by client name
  employeeMetrics: Record<string, EmployeeFlowMetrics>; // keyed by contactId
}

export interface FlowApiResponse {
  data: FlowSnapshot | null;
  week: string;
}
