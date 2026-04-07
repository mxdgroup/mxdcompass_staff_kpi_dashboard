"use client";

import {
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";
import type { TicketFlowEntry } from "@/lib/types";
import { computePercentile } from "@/lib/math";

interface CycleTimeScatterProps {
  tickets: TicketFlowEntry[];
}

export function CycleTimeScatter({ tickets }: CycleTimeScatterProps) {
  // Only show completed tickets with cycle time data
  const completed = tickets.filter(
    (t) =>
      t.currentStage === "Completed" &&
      t.totalCycleHours !== null &&
      t.completedDate,
  );

  if (completed.length === 0) {
    return (
      <div className="rounded-lg bg-white p-4 shadow-sm border border-gray-100">
        <h3 className="text-sm font-medium text-gray-500 mb-3">
          Cycle Time Distribution
        </h3>
        <p className="text-sm text-gray-400 py-4">
          No completed tasks with cycle data
        </p>
      </div>
    );
  }

  const cycleTimes = completed.map((t) => t.totalCycleHours!);
  const p50 = computePercentile(cycleTimes, 50);
  const p85 = computePercentile(cycleTimes, 85);

  const data = completed.map((t) => {
    const d = new Date(t.completedDate!);
    return {
      x: d.getTime(),
      y: t.totalCycleHours!,
      title: t.title,
      assignee: t.assigneeName,
      effort: t.effortScore,
    };
  });

  return (
    <div className="rounded-lg bg-white p-4 shadow-sm border border-gray-100">
      <h3 className="text-sm font-medium text-gray-500 mb-1">
        Cycle Time Distribution
      </h3>
      <p className="text-xs text-gray-400 mb-3">
        Each dot is a completed task — lower is faster
      </p>
      <ResponsiveContainer width="100%" height={240}>
        <ScatterChart margin={{ bottom: 10 }}>
          <XAxis
            type="number"
            dataKey="x"
            domain={["auto", "auto"]}
            tickFormatter={(ts: number) =>
              new Date(ts).toLocaleDateString("en-US", {
                weekday: "short",
              })
            }
            tick={{ fontSize: 11 }}
            name="Completed"
          />
          <YAxis
            type="number"
            dataKey="y"
            tick={{ fontSize: 11 }}
            name="Hours"
            unit="h"
          />
          <Tooltip
            formatter={(value: number, name: string) => {
              if (name === "Hours") return [`${value.toFixed(1)}h`, "Cycle Time"];
              return [value, name];
            }}
            labelFormatter={() => ""}
            content={({ payload }) => {
              if (!payload || payload.length === 0) return null;
              const d = payload[0]?.payload;
              if (!d) return null;
              return (
                <div className="bg-white rounded-lg shadow-lg border border-gray-200 p-2 text-xs">
                  <p className="font-medium text-gray-800 truncate max-w-[200px]">
                    {d.title}
                  </p>
                  <p className="text-gray-500">{d.assignee}</p>
                  <p className="text-gray-600 font-medium">
                    {d.y.toFixed(1)}h cycle
                    {d.effort !== null && ` | Effort: ${d.effort}`}
                  </p>
                </div>
              );
            }}
          />
          {p50 !== null && (
            <ReferenceLine
              y={p50}
              stroke="#3b82f6"
              strokeDasharray="4 4"
              label={{ value: `p50: ${p50}h`, fontSize: 10, fill: "#3b82f6" }}
            />
          )}
          {p85 !== null && (
            <ReferenceLine
              y={p85}
              stroke="#ef4444"
              strokeDasharray="4 4"
              label={{ value: `p85: ${p85}h`, fontSize: 10, fill: "#ef4444" }}
            />
          )}
          <Scatter data={data} fill="#8b5cf6" fillOpacity={0.7} />
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  );
}
