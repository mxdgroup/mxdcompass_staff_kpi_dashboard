"use client";

import type { FlowMetrics } from "@/lib/types";
import { config } from "@/lib/config";

interface ClientChipsProps {
  clientMetrics: Record<string, FlowMetrics> | undefined;
  onSelect: (clientName: string) => void;
}

function healthColor(metrics: FlowMetrics | undefined): string {
  if (!metrics) return "bg-gray-300";
  const { agingItems, flowEfficiency } = metrics;
  const eff = flowEfficiency ?? 100;
  if (agingItems >= 3 || eff < 50) return "bg-red-500";
  if (agingItems >= 1 || eff < 70) return "bg-amber-400";
  return "bg-green-500";
}

export function ClientChips({ clientMetrics, onSelect }: ClientChipsProps) {
  return (
    <div className="flex flex-wrap gap-2">
      {config.clients.map((client) => {
        const metrics = clientMetrics?.[client.name];
        return (
          <button
            key={client.name}
            onClick={() => onSelect(client.name)}
            className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-surface-raised px-3.5 py-2 text-sm font-medium text-gray-700 shadow-[var(--shadow-card)] hover:shadow-[var(--shadow-card-hover)] hover:border-gray-300 transition-all card-interactive"
          >
            <span className={`h-2 w-2 rounded-full shrink-0 ${healthColor(metrics)}`} />
            <span>{client.name}</span>
            {metrics && (
              <span className="text-xs text-gray-400 tabular-nums">
                WIP {metrics.wip}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
