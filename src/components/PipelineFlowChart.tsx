"use client";

import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from "recharts";
import type { PipelineStageCount } from "@/lib/types";

interface PipelineFlowChartProps {
  stages: PipelineStageCount[];
}

const STAGE_COLORS: Record<string, string> = {
  "New": "#94a3b8",
  "In Progress": "#3b82f6",
  "Internal Review": "#8b5cf6",
  "Revisions": "#ef4444",
  "Client Review": "#f59e0b",
  "Approved": "#22c55e",
  "Completed": "#16a34a",
  "Complete": "#16a34a",
};

function getColor(name: string): string {
  return STAGE_COLORS[name] ?? "#6b7280";
}

export function PipelineFlowChart({ stages }: PipelineFlowChartProps) {
  if (stages.length === 0) {
    return <p className="text-sm text-gray-400 py-4">No pipeline data yet</p>;
  }

  const data = stages.map((s) => ({
    name: s.stageName,
    count: s.currentCount,
    entered: s.enteredThisWeek,
    left: s.leftThisWeek,
  }));

  return (
    <div className="rounded-lg bg-white p-4 shadow-sm border border-gray-100">
      <h3 className="text-sm font-medium text-gray-500 mb-3">Pipeline Flow</h3>
      <ResponsiveContainer width="100%" height={200}>
        <BarChart data={data} layout="vertical" margin={{ left: 100, right: 20 }}>
          <XAxis type="number" />
          <YAxis type="category" dataKey="name" width={90} tick={{ fontSize: 12 }} />
          <Tooltip
            formatter={(value: number, name: string) => {
              if (name === "count") return [value, "Current"];
              if (name === "entered") return [value, "Entered this week"];
              return [value, name];
            }}
          />
          <Bar dataKey="count" radius={[0, 4, 4, 0]}>
            {data.map((entry, i) => (
              <Cell key={i} fill={getColor(entry.name)} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      <div className="mt-2 flex flex-wrap gap-3 text-xs text-gray-500">
        {stages
          .filter((s) => s.enteredThisWeek > 0)
          .map((s) => (
            <span key={s.stageId}>
              {s.stageName}: +{s.enteredThisWeek} entered
            </span>
          ))}
      </div>
    </div>
  );
}
