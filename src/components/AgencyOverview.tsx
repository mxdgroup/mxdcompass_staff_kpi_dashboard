"use client";

import type { FlowMetrics, TeamSummary } from "@/lib/types";

interface AgencyOverviewProps {
  flowMetrics: FlowMetrics | null;
  teamSummary: TeamSummary | null;
}

const STAGE_COLORS: Record<string, string> = {
  New: "#94a3b8",
  Planned: "#cbd5e1",
  "In Progress": "#60a5fa",
  "In Review": "#a78bfa",
  "Client Pending": "#fbbf24",
  Completed: "#4ade80",
};

function DeltaBadge({
  delta,
  invert = false,
}: {
  delta: number | null;
  invert?: boolean;
}) {
  if (delta === null) return <span className="text-xs text-gray-400">No prior data</span>;

  const isUp = delta > 0;
  const arrow = isUp ? "\u25B2" : delta < 0 ? "\u25BC" : "\u25CF";
  const isGood = invert ? !isUp : isUp;
  const color =
    delta === 0
      ? "text-amber-500"
      : isGood
        ? "text-green-600"
        : "text-red-600";

  return (
    <span className={`text-sm font-medium ${color}`}>
      {arrow} {Math.abs(delta)}%
    </span>
  );
}

function MetricCard({
  label,
  value,
  subtitle,
  color = "text-gray-900",
  delta,
  invertDelta,
  placeholder,
}: {
  label: string;
  value?: string | number;
  subtitle?: string;
  color?: string;
  delta?: number | null;
  invertDelta?: boolean;
  placeholder?: string;
}) {
  return (
    <div className="rounded-lg bg-white p-4 shadow-sm border border-gray-100">
      <p className="text-sm font-medium text-gray-500">{label}</p>
      {placeholder ? (
        <p className="mt-2 text-sm text-gray-400 italic">{placeholder}</p>
      ) : (
        <>
          <p className={`mt-1 text-3xl font-bold ${color}`}>{value}</p>
          {delta !== undefined && (
            <div className="mt-1">
              <DeltaBadge delta={delta} invert={invertDelta} />
            </div>
          )}
          {subtitle && (
            <p className="mt-1 text-xs text-gray-400">{subtitle}</p>
          )}
        </>
      )}
    </div>
  );
}

function StageDistributionBar({
  stages,
}: {
  stages: { stageName: string; count: number }[];
}) {
  const total = stages.reduce((sum, s) => sum + s.count, 0);
  if (total === 0) return null;

  return (
    <div className="mt-4">
      <div className="flex h-6 w-full overflow-hidden rounded-md">
        {stages
          .filter((s) => s.count > 0)
          .map((s) => {
            const pct = (s.count / total) * 100;
            const bg = STAGE_COLORS[s.stageName] ?? "#d1d5db";
            return (
              <div
                key={s.stageName}
                className="relative group"
                style={{ width: `${pct}%`, backgroundColor: bg }}
                title={`${s.stageName}: ${s.count}`}
              >
                <span className="absolute inset-0 flex items-center justify-center text-[10px] font-medium text-gray-800 opacity-0 group-hover:opacity-100 truncate px-1">
                  {s.stageName}
                </span>
              </div>
            );
          })}
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
        {stages
          .filter((s) => s.count > 0)
          .map((s) => (
            <span key={s.stageName} className="flex items-center gap-1 text-[11px] text-gray-500">
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ backgroundColor: STAGE_COLORS[s.stageName] ?? "#d1d5db" }}
              />
              {s.stageName} ({s.count})
            </span>
          ))}
      </div>
    </div>
  );
}

function formatHours(hours: number | null): string {
  if (hours === null) return "\u2014";
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  return `${Math.round(hours)}h`;
}

function flowEffColor(eff: number | null): string {
  if (eff === null) return "text-gray-900";
  if (eff >= 70) return "text-green-600";
  if (eff >= 50) return "text-amber-500";
  return "text-red-600";
}

export function AgencyOverview({ flowMetrics, teamSummary }: AgencyOverviewProps) {
  const hasFlow = flowMetrics !== null;
  const hasWeekly = teamSummary !== null;

  // No data at all
  if (!hasFlow && !hasWeekly) {
    return (
      <section>
        <h2 className="mb-3 text-lg font-semibold text-gray-800">Agency Overview</h2>
        <div className="rounded-lg bg-white p-8 shadow-sm border border-gray-100 text-center text-gray-400">
          No data yet &mdash; click Sync Now
        </div>
      </section>
    );
  }

  // Both sources available
  if (hasFlow && hasWeekly) {
    return (
      <section>
        <h2 className="mb-3 text-lg font-semibold text-gray-800">Agency Overview</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <MetricCard
            label="WIP"
            value={flowMetrics.wip}
            color="text-blue-600"
            subtitle="Active tasks in pipeline"
          />
          <MetricCard
            label="Throughput"
            value={teamSummary.tasksCompleted}
            color="text-green-600"
            delta={teamSummary.tasksCompletedDelta}
            subtitle={
              teamSummary.tasksCompletedAvg4w !== null
                ? `4-week avg: ${teamSummary.tasksCompletedAvg4w}`
                : undefined
            }
          />
          <MetricCard
            label="Cycle Time (p85)"
            value={formatHours(flowMetrics.cycleTimeP85Hours)}
            color="text-violet-600"
            subtitle={`Median: ${formatHours(flowMetrics.cycleTimeP50Hours)}`}
          />
          <MetricCard
            label="Aging Items"
            value={flowMetrics.agingItems}
            color={flowMetrics.agingItems > 0 ? "text-red-600" : "text-gray-900"}
            subtitle="Tasks > 5 days in stage"
          />
          <MetricCard
            label="Returns"
            value={teamSummary.returnForReviewCount}
            color={teamSummary.returnForReviewCount > 0 ? "text-red-600" : "text-gray-900"}
            delta={teamSummary.returnForReviewDelta}
            invertDelta
            subtitle={
              teamSummary.returnForReviewAvg4w !== null
                ? `4-week avg: ${teamSummary.returnForReviewAvg4w}`
                : undefined
            }
          />
          <MetricCard
            label="Flow Efficiency"
            value={
              flowMetrics.flowEfficiency !== null
                ? `${Math.round(flowMetrics.flowEfficiency)}%`
                : "\u2014"
            }
            color={flowEffColor(flowMetrics.flowEfficiency)}
            subtitle="Active vs total time"
          />
        </div>

        <StageDistributionBar stages={flowMetrics.stageDistribution} />

        {flowMetrics.bottleneckStage && (
          <p className="mt-2 text-xs text-gray-500">
            Bottleneck: {flowMetrics.bottleneckStage.name} (avg{" "}
            {Math.round(flowMetrics.bottleneckStage.avgDwellHours)}h dwell)
          </p>
        )}
      </section>
    );
  }

  // Only weekly available
  if (hasWeekly) {
    return (
      <section>
        <h2 className="mb-3 text-lg font-semibold text-gray-800">Agency Overview</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <MetricCard
            label="Tasks Completed"
            value={teamSummary.tasksCompleted}
            color="text-green-600"
            delta={teamSummary.tasksCompletedDelta}
            subtitle={
              teamSummary.tasksCompletedAvg4w !== null
                ? `4-week avg: ${teamSummary.tasksCompletedAvg4w}`
                : undefined
            }
          />
          <MetricCard
            label="Pipeline Movement"
            value={teamSummary.pipelineMovement}
            delta={teamSummary.pipelineMovementDelta}
          />
          <MetricCard
            label="Returns"
            value={teamSummary.returnForReviewCount}
            color={teamSummary.returnForReviewCount > 0 ? "text-red-600" : "text-gray-900"}
            delta={teamSummary.returnForReviewDelta}
            invertDelta
            subtitle={
              teamSummary.returnForReviewAvg4w !== null
                ? `4-week avg: ${teamSummary.returnForReviewAvg4w}`
                : undefined
            }
          />
          <MetricCard label="WIP" placeholder="Sync for flow metrics" />
          <MetricCard label="Cycle Time" placeholder="Sync for flow metrics" />
          <MetricCard label="Flow Efficiency" placeholder="Sync for flow metrics" />
        </div>
      </section>
    );
  }

  // Only flow available
  return (
    <section>
      <h2 className="mb-3 text-lg font-semibold text-gray-800">Agency Overview</h2>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <MetricCard
          label="WIP"
          value={flowMetrics!.wip}
          color="text-blue-600"
          subtitle="Active tasks in pipeline"
        />
        <MetricCard
          label="Throughput"
          value={flowMetrics!.throughput}
          color="text-green-600"
          subtitle="Completed this week"
        />
        <MetricCard
          label="Cycle Time (p85)"
          value={formatHours(flowMetrics!.cycleTimeP85Hours)}
          color="text-violet-600"
          subtitle={`Median: ${formatHours(flowMetrics!.cycleTimeP50Hours)}`}
        />
        <MetricCard
          label="Aging Items"
          value={flowMetrics!.agingItems}
          color={flowMetrics!.agingItems > 0 ? "text-red-600" : "text-gray-900"}
          subtitle="Tasks > 5 days in stage"
        />
        <MetricCard
          label="Flow Efficiency"
          value={
            flowMetrics!.flowEfficiency !== null
              ? `${Math.round(flowMetrics!.flowEfficiency)}%`
              : "\u2014"
          }
          color={flowEffColor(flowMetrics!.flowEfficiency)}
          subtitle="Active vs total time"
        />
        <MetricCard label="Returns" placeholder="No weekly data" />
      </div>

      <StageDistributionBar stages={flowMetrics!.stageDistribution} />

      {flowMetrics!.bottleneckStage && (
        <p className="mt-2 text-xs text-gray-500">
          Bottleneck: {flowMetrics!.bottleneckStage.name} (avg{" "}
          {Math.round(flowMetrics!.bottleneckStage.avgDwellHours)}h dwell)
        </p>
      )}
    </section>
  );
}
