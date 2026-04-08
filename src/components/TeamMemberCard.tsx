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

const ROLE_BADGE: Record<Role, { bg: string; text: string; label: string }> = {
  developer: { bg: "bg-brand-50", text: "text-brand-700", label: "Dev" },
  designer: { bg: "bg-violet-50", text: "text-violet-700", label: "Design" },
  "account-manager": { bg: "bg-emerald-50", text: "text-emerald-700", label: "AM" },
  "brand-design": { bg: "bg-violet-50", text: "text-violet-700", label: "Brand" },
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
      <div className="rounded-xl bg-surface-raised shadow-[var(--shadow-card)] border border-gray-100/80 p-5">
        <div className="flex items-center gap-2.5">
          <span className="font-medium text-sm text-gray-900">{name}</span>
          <span className={`text-[11px] font-medium px-2 py-0.5 rounded-md ${badge.bg} ${badge.text}`}>
            {badge.label}
          </span>
        </div>
        <p className="mt-3 text-xs text-amber-600">
          Bootstrap required to load metrics
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl bg-surface-raised shadow-[var(--shadow-card)] border border-gray-100/80 card-interactive overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="w-full text-left px-5 py-4 flex items-center gap-2.5"
      >
        <svg
          className={`h-3.5 w-3.5 text-gray-300 transition-transform duration-200 shrink-0 ${expanded ? "rotate-90" : ""}`}
          fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
        </svg>
        <span className="font-medium text-sm text-gray-900 truncate">{name}</span>
        <span className={`text-[11px] font-medium px-2 py-0.5 rounded-md shrink-0 ${badge.bg} ${badge.text}`}>
          {badge.label}
        </span>

        <span className="ml-auto flex items-center gap-3 text-sm text-gray-500">
          {weeklyData?.tasksActive != null && weeklyData.tasksActive > 0 && (
            <span title="Assigned tasks (excl. New)">
              <span className="font-semibold text-gray-700 tabular-nums">{weeklyData.tasksActive}</span>{" "}
              <span className="text-xs">tasks</span>
              {weeklyData.tasksCompleted > 0 && (
                <span className="text-xs text-gray-400 ml-1">({weeklyData.tasksCompleted} done)</span>
              )}
            </span>
          )}
          {flowData?.cycleTimeP85Hours != null && (
            <span title="P85 cycle time" className="text-xs">
              <span className="tabular-nums">{fmt(flowData.cycleTimeP85Hours, "h")}</span> cycle
            </span>
          )}
          {flowData?.flowEfficiency != null && (
            <span title="Flow efficiency" className="text-xs">
              <span className="tabular-nums">{fmt(flowData.flowEfficiency * 100, "%")}</span> eff
            </span>
          )}
          {role === "developer" && github != null && (
            <span title="Total commits this week" className="text-xs">
              <span className="font-semibold text-gray-700 tabular-nums">{github.totalCommits}</span>{" "}
              commits
            </span>
          )}
        </span>
      </button>

      {expanded && (
        <div className="px-5 pb-5 space-y-3 border-t border-gray-50 pt-4">
          {flowData?.tickets && flowData.tickets.length > 0 && (
            <TicketFlowTable tickets={flowData.tickets} showClient />
          )}

          {role === "developer" && github && (
            <div className="flex gap-4 text-sm text-gray-500">
              <span>
                <span className="font-semibold text-gray-700 tabular-nums">{github.totalCommits}</span>{" "}
                commits
              </span>
              <span>
                <span className="font-semibold text-gray-700 tabular-nums">{github.prsMerged}</span> PRs
                merged
              </span>
              {github.medianCycleTimeHours != null && (
                <span>
                  <span className="tabular-nums">{fmt(github.medianCycleTimeHours, "h")}</span> median PR cycle
                </span>
              )}
            </div>
          )}

          {weeklyData?.hoursLogged != null && weeklyData.hoursLogged > 0 && (
            <p className="text-sm text-gray-500">
              <span className="font-semibold text-gray-700 tabular-nums">{weeklyData.hoursLogged}</span>{" "}
              hours logged
            </p>
          )}

          {!flowData?.tickets?.length &&
            !(role === "developer" && github) &&
            !weeklyData?.hoursLogged && (
              <p className="text-xs text-gray-300">
                No detailed data available this period.
              </p>
            )}
        </div>
      )}
    </div>
  );
}
