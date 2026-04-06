"use client";

import type { TaskSummary } from "@/lib/types";

interface EmployeePipelineProps {
  tasks: TaskSummary[];
}

const STAGE_ORDER = [
  "New",
  "In Progress",
  "Internal Review",
  "Revisions",
  "Client Review",
  "Approved",
  "Completed",
  "Complete",
];

const STAGE_COLORS: Record<string, string> = {
  "New": "bg-slate-200",
  "In Progress": "bg-blue-200",
  "Internal Review": "bg-violet-200",
  "Revisions": "bg-red-200",
  "Client Review": "bg-amber-200",
  "Approved": "bg-green-200",
  "Completed": "bg-green-300",
  "Complete": "bg-green-300",
};

export function EmployeePipeline({ tasks }: EmployeePipelineProps) {
  // Group tasks by status name
  const byStatus = new Map<string, TaskSummary[]>();
  for (const t of tasks) {
    const existing = byStatus.get(t.status) ?? [];
    existing.push(t);
    byStatus.set(t.status, existing);
  }

  const stages = STAGE_ORDER.filter((s) => byStatus.has(s));
  // Add any status not in the standard order
  for (const s of byStatus.keys()) {
    if (!stages.includes(s)) stages.push(s);
  }

  if (stages.length === 0) {
    return <p className="text-xs text-gray-400">No tasks this week</p>;
  }

  return (
    <div className="flex gap-1 items-end">
      {stages.map((stage) => {
        const stageTasks = byStatus.get(stage) ?? [];
        const movedCount = stageTasks.filter((t) => t.movedThisWeek).length;

        return (
          <div key={stage} className="flex-1 min-w-0">
            <p className="text-[10px] text-gray-400 truncate mb-0.5">{stage}</p>
            <div
              className={`rounded px-1.5 py-1 text-center text-xs font-medium ${
                STAGE_COLORS[stage] ?? "bg-gray-200"
              }`}
            >
              {stageTasks.length}
              {movedCount > 0 && (
                <span className="ml-0.5 text-[10px] text-green-700">\u25B2{movedCount}</span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
