"use client";

import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import type { FlowMetrics } from "@/lib/types";

interface CumulativeFlowDiagramProps {
  metrics: FlowMetrics;
}

const STAGE_COLORS: Record<string, string> = {
  New: "#94a3b8",
  Planned: "#cbd5e1",
  "In Progress": "#60a5fa",
  "In Review": "#a78bfa",
  "Client Pending": "#fbbf24",
  Completed: "#4ade80",
};

const STAGE_ORDER = [
  "Completed",
  "Client Pending",
  "In Review",
  "In Progress",
  "Planned",
  "New",
];

export function CumulativeFlowDiagram({
  metrics,
}: CumulativeFlowDiagramProps) {
  const { dailyFlow } = metrics;

  if (dailyFlow.length === 0) {
    return (
      <div className="rounded-lg bg-white p-4 shadow-sm border border-gray-100">
        <h3 className="text-sm font-medium text-gray-500 mb-3">
          Cumulative Flow
        </h3>
        <p className="text-sm text-gray-400 py-4">No flow data yet</p>
      </div>
    );
  }

  // Format data for Recharts — stacked areas
  const data = dailyFlow.map((d) => {
    const dayLabel = new Date(d.date).toLocaleDateString("en-US", {
      weekday: "short",
    });
    return {
      day: dayLabel,
      ...d.stages,
    };
  });

  // Only show stages that have data
  const activeStages = STAGE_ORDER.filter((stage) =>
    dailyFlow.some((d) => (d.stages[stage] ?? 0) > 0),
  );

  return (
    <div className="rounded-lg bg-white p-4 shadow-sm border border-gray-100">
      <h3 className="text-sm font-medium text-gray-500 mb-1">
        Cumulative Flow Diagram
      </h3>
      <p className="text-xs text-gray-400 mb-3">
        Widening bands indicate bottlenecks
      </p>
      <ResponsiveContainer width="100%" height={260}>
        <AreaChart data={data}>
          <XAxis dataKey="day" tick={{ fontSize: 12 }} />
          <YAxis tick={{ fontSize: 12 }} />
          <Tooltip />
          <Legend />
          {activeStages.map((stage) => (
            <Area
              key={stage}
              type="monotone"
              dataKey={stage}
              stackId="1"
              fill={STAGE_COLORS[stage] ?? "#e5e7eb"}
              stroke={STAGE_COLORS[stage] ?? "#e5e7eb"}
              fillOpacity={0.8}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
