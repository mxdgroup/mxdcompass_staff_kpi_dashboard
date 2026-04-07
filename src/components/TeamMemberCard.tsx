"use client";

import { useState } from "react";
import type { EmployeeFlowMetrics, EmployeeWeekData } from "@/lib/types";
import type { Role } from "@/lib/config";
import { TicketFlowTable } from "@/components/TicketFlowTable";

interface TeamMemberCardProps {
  name: string;
  role: Role;
  hasContactId: boolean;
  flowData: EmployeeFlowMetrics | null;
  weeklyData: EmployeeWeekData | null;
}

const ROLE_BADGE: Record<Role, { bg: string; text: string }> = {
  developer: { bg: "bg-blue-100", text: "text-blue-700" },
  designer: { bg: "bg-violet-100", text: "text-violet-700" },
  "account-manager": { bg: "bg-green-100", text: "text-green-700" },
};

function fmt(value: number | null | undefined, suffix = ""): string {
  if (value == null) return "\u2014";
  return `${Math.round(value * 10) / 10}${suffix}`;
}

export default function TeamMemberCard({
  name,
  role,
  hasContactId,
  flowData,
  weeklyData,
}: TeamMemberCardProps) {
  const [expanded, setExpanded] = useState(false);

  const badge = ROLE_BADGE[role];
  const github = weeklyData?.github ?? null;

  if (!hasContactId) {
    return (
      <div className="rounded-lg bg-white shadow-sm border border-gray-100 p-4">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm">{name}</span>
          <span
            className={`text-xs px-2 py-0.5 rounded-full ${badge.bg} ${badge.text}`}
          >
            {role}
          </span>
        </div>
        <p className="mt-2 text-xs text-amber-600">
          Bootstrap required to load metrics
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg bg-white shadow-sm border border-gray-100">
      {/* Header — clickable */}
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="w-full text-left px-4 py-3 flex items-center gap-2"
      >
        <span className="text-xs text-gray-400 mr-1">
          {expanded ? "▼" : "▶"}
        </span>
        <span className="font-medium text-sm truncate">{name}</span>
        <span
          className={`text-xs px-2 py-0.5 rounded-full shrink-0 ${badge.bg} ${badge.text}`}
        >
          {role}
        </span>

        {/* Inline key metrics */}
        <span className="ml-auto flex items-center gap-3 text-sm text-gray-600">
          {weeklyData?.tasksCompleted != null && (
            <span title="Tasks completed">
              <span className="font-semibold">{weeklyData.tasksCompleted}</span>{" "}
              tasks
            </span>
          )}
          {flowData?.cycleTimeP85Hours != null && (
            <span title="P85 cycle time">
              {fmt(flowData.cycleTimeP85Hours, "h")} cycle
            </span>
          )}
          {flowData?.flowEfficiency != null && (
            <span title="Flow efficiency">
              {fmt(flowData.flowEfficiency * 100, "%")} eff
            </span>
          )}
          {role === "developer" && github != null && (
            <span title="Total commits this week">
              <span className="font-semibold">{github.totalCommits}</span>{" "}
              commits
            </span>
          )}
        </span>
      </button>

      {/* Expanded detail */}
      {expanded && (
        <div className="px-4 pb-4 space-y-3 border-t border-gray-50 pt-3">
          {/* Flow tickets table */}
          {flowData?.tickets && flowData.tickets.length > 0 && (
            <TicketFlowTable tickets={flowData.tickets} showClient />
          )}

          {/* GitHub stats for developers */}
          {role === "developer" && github && (
            <div className="flex gap-4 text-sm text-gray-600">
              <span>
                <span className="font-semibold">{github.totalCommits}</span>{" "}
                commits
              </span>
              <span>
                <span className="font-semibold">{github.prsMerged}</span> PRs
                merged
              </span>
              {github.medianCycleTimeHours != null && (
                <span>
                  {fmt(github.medianCycleTimeHours, "h")} median PR cycle
                </span>
              )}
            </div>
          )}

          {/* Hours logged */}
          {weeklyData?.hoursLogged != null && weeklyData.hoursLogged > 0 && (
            <p className="text-sm text-gray-600">
              <span className="font-semibold">{weeklyData.hoursLogged}</span>{" "}
              hours logged
            </p>
          )}

          {/* Fallback when nothing to show */}
          {!flowData?.tickets?.length &&
            !(role === "developer" && github) &&
            !weeklyData?.hoursLogged && (
              <p className="text-xs text-gray-400">
                No detailed data available this period.
              </p>
            )}
        </div>
      )}
    </div>
  );
}
