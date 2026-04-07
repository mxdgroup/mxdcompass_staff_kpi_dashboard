"use client";

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
  ReferenceLine,
} from "recharts";
import type { TicketFlowEntry } from "@/lib/types";

interface AgingWipChartProps {
  tickets: TicketFlowEntry[];
}

function ageColor(hours: number): string {
  const days = hours / 24;
  if (days < 3) return "#86efac"; // green-300
  if (days < 5) return "#fcd34d"; // amber-300
  return "#fca5a5"; // red-300
}

export function AgingWipChart({ tickets }: AgingWipChartProps) {
  // Only show non-completed active items
  const active = tickets
    .filter((t) => t.currentStage !== "Completed")
    .sort((a, b) => b.currentStageAgeHours - a.currentStageAgeHours);

  if (active.length === 0) {
    return (
      <div className="rounded-lg bg-white p-4 shadow-sm border border-gray-100">
        <h3 className="text-sm font-medium text-gray-500 mb-3">
          Aging Work Items
        </h3>
        <p className="text-sm text-gray-400 py-4">
          No active work items
        </p>
      </div>
    );
  }

  const data = active.map((t) => ({
    name:
      t.title.length > 30 ? t.title.slice(0, 30) + "..." : t.title,
    days: Math.round((t.currentStageAgeHours / 24) * 10) / 10,
    hours: t.currentStageAgeHours,
    stage: t.currentStage,
    assignee: t.assigneeName,
    fullTitle: t.title,
  }));

  return (
    <div className="rounded-lg bg-white p-4 shadow-sm border border-gray-100">
      <h3 className="text-sm font-medium text-gray-500 mb-1">
        Aging Work Items
      </h3>
      <p className="text-xs text-gray-400 mb-3">
        Days in current stage — items needing attention
      </p>
      <ResponsiveContainer width="100%" height={Math.max(200, active.length * 36)}>
        <BarChart data={data} layout="vertical" margin={{ left: 10, right: 20 }}>
          <XAxis type="number" tick={{ fontSize: 11 }} unit="d" />
          <YAxis
            type="category"
            dataKey="name"
            width={180}
            tick={{ fontSize: 11 }}
          />
          <Tooltip
            content={({ payload }) => {
              if (!payload || payload.length === 0) return null;
              const d = payload[0]?.payload;
              if (!d) return null;
              return (
                <div className="bg-white rounded-lg shadow-lg border border-gray-200 p-2 text-xs">
                  <p className="font-medium text-gray-800">{d.fullTitle}</p>
                  <p className="text-gray-500">{d.assignee} — {d.stage}</p>
                  <p className="text-gray-600 font-medium">{d.days}d in stage</p>
                </div>
              );
            }}
          />
          <ReferenceLine x={3} stroke="#f59e0b" strokeDasharray="3 3" label={{ value: "3d", fontSize: 10 }} />
          <ReferenceLine x={5} stroke="#ef4444" strokeDasharray="3 3" label={{ value: "5d", fontSize: 10 }} />
          <Bar dataKey="days" radius={[0, 4, 4, 0]}>
            {data.map((entry, idx) => (
              <Cell key={idx} fill={ageColor(entry.hours)} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
