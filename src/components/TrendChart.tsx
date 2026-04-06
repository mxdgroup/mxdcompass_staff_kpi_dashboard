"use client";

import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from "recharts";
import type { WeeklySnapshot } from "@/lib/types";

interface TrendChartProps {
  current: WeeklySnapshot | null;
  history: WeeklySnapshot[];
}

export function TrendChart({ current, history }: TrendChartProps) {
  const allSnapshots = [...history.reverse(), ...(current ? [current] : [])];
  if (allSnapshots.length < 2) {
    return <p className="text-sm text-gray-400 py-4">Need at least 2 weeks of data for trend chart</p>;
  }

  const data = allSnapshots.map((s) => ({
    week: s.week.replace(/^\d{4}-/, ""),
    "Tasks Completed": s.teamSummary.tasksCompleted,
    "Pipeline Movement": s.teamSummary.pipelineMovement,
    "Returns": s.teamSummary.returnForReviewCount,
  }));

  return (
    <div className="rounded-lg bg-white p-4 shadow-sm border border-gray-100">
      <h3 className="text-sm font-medium text-gray-500 mb-3">4-Week Trends</h3>
      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={data}>
          <XAxis dataKey="week" tick={{ fontSize: 12 }} />
          <YAxis tick={{ fontSize: 12 }} />
          <Tooltip />
          <Legend />
          <Line type="monotone" dataKey="Tasks Completed" stroke="#3b82f6" strokeWidth={2} dot />
          <Line type="monotone" dataKey="Pipeline Movement" stroke="#8b5cf6" strokeWidth={2} dot />
          <Line type="monotone" dataKey="Returns" stroke="#ef4444" strokeWidth={2} dot />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
