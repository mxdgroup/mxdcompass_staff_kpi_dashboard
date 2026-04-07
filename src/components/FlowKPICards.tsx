"use client";

import type { FlowMetrics } from "@/lib/types";

interface FlowKPICardsProps {
  metrics: FlowMetrics;
}

export function FlowKPICards({ metrics }: FlowKPICardsProps) {
  const cards = [
    {
      label: "WIP",
      value: metrics.wip,
      subtitle: "Active tasks in pipeline",
      color: "text-blue-600",
    },
    {
      label: "Throughput",
      value: metrics.throughput,
      subtitle: "Completed this week",
      color: "text-green-600",
    },
    {
      label: "Cycle Time (p85)",
      value:
        metrics.cycleTimeP85Hours !== null
          ? `${metrics.cycleTimeP85Hours}h`
          : "—",
      subtitle:
        metrics.cycleTimeP50Hours !== null
          ? `Median: ${metrics.cycleTimeP50Hours}h`
          : "No completed tasks",
      color: "text-violet-600",
    },
    {
      label: "Aging Items",
      value: metrics.agingItems,
      subtitle: "Tasks > 5 days in stage",
      color: metrics.agingItems > 0 ? "text-red-600" : "text-gray-600",
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {cards.map((card) => (
        <div
          key={card.label}
          className="rounded-lg bg-white p-4 shadow-sm border border-gray-100"
        >
          <p className="text-sm font-medium text-gray-500">{card.label}</p>
          <p className={`mt-1 text-3xl font-bold ${card.color}`}>
            {card.value}
          </p>
          <p className="mt-1 text-xs text-gray-400">{card.subtitle}</p>
        </div>
      ))}
    </div>
  );
}
