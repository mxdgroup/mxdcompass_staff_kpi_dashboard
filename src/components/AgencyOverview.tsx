"use client";

import type { FlowMetrics, TeamSummary } from "@/lib/types";

interface AgencyOverviewProps {
  flowMetrics: FlowMetrics | null;
  teamSummary: TeamSummary | null;
}

const STAGE_COLORS: Record<string, string> = {
  New: "oklch(0.70 0.04 250)",
  Planned: "oklch(0.78 0.03 250)",
  "In Progress": "oklch(0.60 0.15 250)",
  "In Review": "oklch(0.60 0.12 300)",
  "Client Pending": "oklch(0.75 0.14 80)",
  Completed: "oklch(0.65 0.15 155)",
};

function DeltaBadge({
  delta,
  invert = false,
}: {
  delta: number | null;
  invert?: boolean;
}) {
  if (delta === null) return <span className="text-xs text-gray-300">No prior data</span>;

  const isUp = delta > 0;
  const isGood = invert ? !isUp : isUp;
  const color =
    delta === 0
      ? "text-amber-500 bg-amber-50"
      : isGood
        ? "text-green-700 bg-green-50"
        : "text-red-700 bg-red-50";

  return (
    <span className={`inline-flex items-center gap-0.5 text-xs font-medium px-1.5 py-0.5 rounded-md ${color}`}>
      {isUp ? "\u2191" : delta < 0 ? "\u2193" : "\u2022"} {Math.abs(delta)}%
    </span>
  );
}

function MetricCard({
  label,
  value,
  subtitle,
  accentClass = "",
  delta,
  invertDelta,
  placeholder,
}: {
  label: string;
  value?: string | number;
  subtitle?: string;
  accentClass?: string;
  delta?: number | null;
  invertDelta?: boolean;
  placeholder?: string;
}) {
  return (
    <div className="rounded-xl bg-surface-raised p-5 shadow-[var(--shadow-card)] border border-gray-100/80">
      <p className="text-[13px] font-medium text-gray-400 tracking-wide">{label}</p>
      {placeholder ? (
        <p className="mt-3 text-sm text-gray-300 italic">{placeholder}</p>
      ) : (
        <>
          <p className={`mt-2 text-3xl font-semibold tabular-nums tracking-tight ${accentClass || "text-gray-900"}`}>{value}</p>
          {delta !== undefined && (
            <div className="mt-2">
              <DeltaBadge delta={delta} invert={invertDelta} />
            </div>
          )}
          {subtitle && (
            <p className="mt-1.5 text-xs text-gray-400">{subtitle}</p>
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
    <div className="mt-6 rounded-xl bg-surface-raised p-5 shadow-[var(--shadow-card)] border border-gray-100/80">
      <p className="text-[13px] font-medium text-gray-400 tracking-wide mb-3">Pipeline Distribution</p>
      <div className="flex h-3 w-full overflow-hidden rounded-full gap-0.5">
        {stages
          .filter((s) => s.count > 0)
          .map((s) => {
            const pct = (s.count / total) * 100;
            const bg = STAGE_COLORS[s.stageName] ?? "#d1d5db";
            return (
              <div
                key={s.stageName}
                className="rounded-full transition-all duration-300"
                style={{ width: `${pct}%`, backgroundColor: bg }}
                title={`${s.stageName}: ${s.count}`}
              />
            );
          })}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
        {stages
          .filter((s) => s.count > 0)
          .map((s) => (
            <span key={s.stageName} className="flex items-center gap-1.5 text-xs text-gray-500">
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ backgroundColor: STAGE_COLORS[s.stageName] ?? "#d1d5db" }}
              />
              {s.stageName} <span className="text-gray-400">({s.count})</span>
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
  if (eff >= 50) return "text-amber-600";
  return "text-red-600";
}

export function AgencyOverview({ flowMetrics, teamSummary }: AgencyOverviewProps) {
  const hasFlow = flowMetrics !== null;
  const hasWeekly = teamSummary !== null;

  if (!hasFlow && !hasWeekly) {
    return (
      <section>
        <h2 className="mb-4 text-lg font-semibold tracking-tight text-gray-900">Agency Overview</h2>
        <div className="rounded-xl bg-surface-raised p-10 shadow-[var(--shadow-card)] border border-gray-100/80 text-center">
          <p className="text-gray-400">No data yet. Click Sync Now to pull metrics.</p>
        </div>
      </section>
    );
  }

  if (hasFlow && hasWeekly) {
    return (
      <section>
        <h2 className="mb-4 text-lg font-semibold tracking-tight text-gray-900">Agency Overview</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <MetricCard
            label="WIP"
            value={flowMetrics.wip}
            accentClass="text-brand-600"
            subtitle="Active tasks in pipeline"
          />
          <MetricCard
            label="Throughput"
            value={teamSummary.tasksCompleted}
            accentClass="text-green-600"
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
            accentClass="text-violet-600"
            subtitle={`Median: ${formatHours(flowMetrics.cycleTimeP50Hours)}`}
          />
          <MetricCard
            label="Aging Items"
            value={flowMetrics.agingItems}
            accentClass={flowMetrics.agingItems > 0 ? "text-red-600" : "text-gray-900"}
            subtitle="Tasks > 5 days in stage"
          />
          <MetricCard
            label="Returns"
            value={teamSummary.returnForReviewCount}
            accentClass={teamSummary.returnForReviewCount > 0 ? "text-red-600" : "text-gray-900"}
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
            accentClass={flowEffColor(flowMetrics.flowEfficiency)}
            subtitle="Active vs total time"
          />
        </div>

        <StageDistributionBar stages={flowMetrics.stageDistribution} />

        {flowMetrics.bottleneckStage && (
          <p className="mt-3 text-xs text-gray-400">
            Bottleneck: <span className="font-medium text-gray-600">{flowMetrics.bottleneckStage.name}</span> (avg{" "}
            {Math.round(flowMetrics.bottleneckStage.avgDwellHours)}h dwell)
          </p>
        )}
      </section>
    );
  }

  if (hasWeekly) {
    return (
      <section>
        <h2 className="mb-4 text-lg font-semibold tracking-tight text-gray-900">Agency Overview</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <MetricCard
            label="Tasks Completed"
            value={teamSummary.tasksCompleted}
            accentClass="text-green-600"
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
            accentClass={teamSummary.returnForReviewCount > 0 ? "text-red-600" : "text-gray-900"}
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

  return (
    <section>
      <h2 className="mb-4 text-lg font-semibold tracking-tight text-gray-900">Agency Overview</h2>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <MetricCard
          label="WIP"
          value={flowMetrics!.wip}
          accentClass="text-brand-600"
          subtitle="Active tasks in pipeline"
        />
        <MetricCard
          label="Throughput"
          value={flowMetrics!.throughput}
          accentClass="text-green-600"
          subtitle="Completed this week"
        />
        <MetricCard
          label="Cycle Time (p85)"
          value={formatHours(flowMetrics!.cycleTimeP85Hours)}
          accentClass="text-violet-600"
          subtitle={`Median: ${formatHours(flowMetrics!.cycleTimeP50Hours)}`}
        />
        <MetricCard
          label="Aging Items"
          value={flowMetrics!.agingItems}
          accentClass={flowMetrics!.agingItems > 0 ? "text-red-600" : "text-gray-900"}
          subtitle="Tasks > 5 days in stage"
        />
        <MetricCard
          label="Flow Efficiency"
          value={
            flowMetrics!.flowEfficiency !== null
              ? `${Math.round(flowMetrics!.flowEfficiency)}%`
              : "\u2014"
          }
          accentClass={flowEffColor(flowMetrics!.flowEfficiency)}
          subtitle="Active vs total time"
        />
        <MetricCard label="Returns" placeholder="No weekly data" />
      </div>

      <StageDistributionBar stages={flowMetrics!.stageDistribution} />

      {flowMetrics!.bottleneckStage && (
        <p className="mt-3 text-xs text-gray-400">
          Bottleneck: <span className="font-medium text-gray-600">{flowMetrics!.bottleneckStage.name}</span> (avg{" "}
          {Math.round(flowMetrics!.bottleneckStage.avgDwellHours)}h dwell)
        </p>
      )}
    </section>
  );
}
