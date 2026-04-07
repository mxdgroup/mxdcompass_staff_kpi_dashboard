"use client";

import type { FlowMetrics } from "@/lib/types";
import { config } from "@/lib/config";

interface ClientChipsProps {
  clientMetrics: Record<string, FlowMetrics> | undefined;
  selected: string;
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

export function ClientChips({ clientMetrics, selected, onSelect }: ClientChipsProps) {
  return (
    <div className="flex flex-wrap gap-2">
      {config.clients.map((client) => {
        const metrics = clientMetrics?.[client.name];
        const isActive = selected === client.name;
        return (
          <button
            key={client.name}
            onClick={() => onSelect(isActive ? "" : client.name)}
            className={`inline-flex items-center gap-2 rounded-lg border px-3.5 py-2 text-sm font-medium shadow-[var(--shadow-card)] hover:shadow-[var(--shadow-card-hover)] transition-all card-interactive ${
              isActive
                ? "border-brand-500 bg-brand-50 text-brand-700 ring-2 ring-brand-500/20"
                : "border-gray-200 bg-surface-raised text-gray-700 hover:border-gray-300"
            }`}
          >
            <span className={`h-2 w-2 rounded-full shrink-0 ${healthColor(metrics)}`} />
            <span>{client.name}</span>
            {metrics && (
              <span className={`text-xs tabular-nums ${isActive ? "text-brand-500" : "text-gray-400"}`}>
                WIP {metrics.wip}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
