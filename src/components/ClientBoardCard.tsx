"use client";

import { useState } from "react";
import type { FlowMetrics, TicketFlowEntry } from "@/lib/types";
import { TicketFlowTable } from "@/components/TicketFlowTable";

interface ClientBoardCardProps {
  clientName: string;
  metrics: FlowMetrics | null;
  tickets: TicketFlowEntry[];
}

function formatHours(hours: number | null): string {
  if (hours === null) return "—";
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 48) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

function healthColor(metrics: FlowMetrics): string {
  const { agingItems, flowEfficiency } = metrics;
  const eff = flowEfficiency ?? 100;

  if (agingItems >= 3 || eff < 50) return "border-l-red-400";
  if (agingItems >= 1 || eff < 70) return "border-l-amber-400";
  return "border-l-green-400";
}

export function ClientBoardCard({
  clientName,
  metrics,
  tickets,
}: ClientBoardCardProps) {
  const [expanded, setExpanded] = useState(false);

  const borderColor = metrics ? healthColor(metrics) : "border-l-gray-300";

  return (
    <div
      className={`rounded-lg bg-white shadow-sm border border-gray-100 border-l-4 ${borderColor}`}
    >
      <button
        type="button"
        className="w-full text-left p-4 hover:bg-gray-50 rounded-t-lg"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center justify-between">
          <span className="font-medium text-gray-900">{clientName}</span>
          <span className="text-xs text-gray-400 ml-2">
            {expanded ? "\u25BC" : "\u25B6"}
          </span>
        </div>

        {metrics ? (
          <div className="mt-1 text-sm text-gray-600 flex flex-wrap items-center gap-x-1">
            <span>WIP {metrics.wip}</span>
            <span className="text-gray-300">|</span>
            <span>Thru {metrics.throughput}</span>
            <span className="text-gray-300">|</span>
            <span>p85 {formatHours(metrics.cycleTimeP85Hours)}</span>
            <span className="text-gray-300">|</span>
            <span>Aging {metrics.agingItems}</span>
            <span className="text-gray-300">|</span>
            <span>
              Eff{" "}
              {metrics.flowEfficiency !== null
                ? `${metrics.flowEfficiency.toFixed(0)}%`
                : "—"}
            </span>
          </div>
        ) : (
          <p className="mt-1 text-sm text-gray-400">No data this week</p>
        )}
      </button>

      {expanded && (
        <div className="border-t border-gray-100 p-4">
          <TicketFlowTable tickets={tickets} showAssignee={true} />
        </div>
      )}
    </div>
  );
}
