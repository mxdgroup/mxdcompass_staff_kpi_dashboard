"use client";

import { useState } from "react";
import type { EmployeeWeekData } from "@/lib/types";
import type { Role } from "@/lib/config";
import { EmployeePipeline } from "./EmployeePipeline";
import { DailyCommitGrid } from "./DailyCommitGrid";

interface RoleGroupSectionProps {
  role: Role;
  label: string;
  employees: EmployeeWeekData[];
  approvalOwnerId?: string;
}

export function RoleGroupSection({ label, employees }: RoleGroupSectionProps) {
  const [open, setOpen] = useState(false);
  const [expandedCards, setExpandedCards] = useState<Set<string>>(new Set());

  const totalCompleted = employees.reduce((s, e) => s + e.tasksCompleted, 0);
  const totalMoved = employees.reduce((s, e) => s + e.pipelineMovement, 0);
  const totalReturns = employees.reduce((s, e) => s + e.returnForReviewCount, 0);

  function toggleCard(id: string) {
    setExpandedCards((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="rounded-lg bg-white shadow-sm border border-gray-100">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between p-4 text-left hover:bg-gray-50"
      >
        <div>
          <span className="font-medium text-gray-900">
            {open ? "\u25BC" : "\u25B6"} {label} ({employees.length})
          </span>
          <span className="ml-4 text-sm text-gray-500">
            {totalCompleted} done, {totalMoved} moved
            {totalReturns > 0 && (
              <span className="text-red-600 ml-1">{totalReturns} returned</span>
            )}
          </span>
        </div>
      </button>

      {open && (
        <div className="border-t border-gray-100 divide-y divide-gray-50">
          {employees.map((emp) => {
            const isExpanded = expandedCards.has(emp.wrikeContactId);

            return (
              <div key={emp.wrikeContactId} className="p-4">
                <button
                  onClick={() => toggleCard(emp.wrikeContactId)}
                  className="flex w-full items-center justify-between text-left"
                >
                  <div className="flex items-center gap-3">
                    <span className="font-medium text-gray-800">{emp.name}</span>
                    <span className="text-sm text-gray-500">
                      {emp.tasksCompleted} done, {emp.pipelineMovement} moved
                    </span>
                    {emp.returnForReviewCount > 0 && (
                      <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">
                        {emp.returnForReviewCount} returned
                      </span>
                    )}
                  </div>
                  <span className="text-gray-400">{isExpanded ? "\u25BC" : "\u25B6"}</span>
                </button>

                {isExpanded && (
                  <div className="mt-3 space-y-4 pl-2">
                    {/* Mini pipeline */}
                    <EmployeePipeline tasks={emp.tasks} />

                    {/* Daily commit grid for developers */}
                    {emp.github && (
                      <div className="space-y-3">
                        <DailyCommitGrid dailyCommits={emp.github.dailyCommits} />
                        <div className="flex gap-4 text-xs text-gray-500">
                          <span>{emp.github.prsMerged} PRs merged</span>
                          {emp.github.medianCycleTimeHours !== null && (
                            <span>Median cycle: {emp.github.medianCycleTimeHours.toFixed(1)}h</span>
                          )}
                          <span>{emp.github.totalCommits} commits total</span>
                        </div>
                      </div>
                    )}

                    {/* Task list */}
                    <div>
                      <h4 className="text-xs font-medium text-gray-500 mb-1">Tasks</h4>
                      <ul className="space-y-1">
                        {emp.tasks.map((task) => (
                          <li key={task.id} className="flex items-center gap-2 text-sm">
                            {task.returnedForReview && (
                              <span className="shrink-0 rounded bg-red-100 px-1 text-[10px] font-medium text-red-700">
                                RETURNED
                              </span>
                            )}
                            {task.movedThisWeek && !task.returnedForReview && (
                              <span className="shrink-0 text-green-500 text-[10px]">\u25B2</span>
                            )}
                            {!task.movedThisWeek && task.hasComments && (
                              <span className="shrink-0 text-blue-500 text-[10px]">{"\uD83D\uDCAC"}</span>
                            )}
                            <a
                              href={task.permalink}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="truncate text-gray-700 hover:underline"
                            >
                              {task.title}
                            </a>
                            <span className="shrink-0 text-xs text-gray-400">{task.status}</span>
                          </li>
                        ))}
                      </ul>
                    </div>

                    {/* Hours logged */}
                    {emp.hoursLogged > 0 && (
                      <p className="text-xs text-gray-400">{emp.hoursLogged.toFixed(1)}h logged</p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
