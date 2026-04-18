"use client";

import { useState } from "react";
import type { TicketFlowEntry, StageDuration } from "@/lib/types";

interface TicketFlowDotsProps {
  tickets: TicketFlowEntry[];
  showAssignee?: boolean;
  showClient?: boolean;
}

interface SortHeaderProps {
  label: string;
  k: SortKey;
  sortKey: SortKey;
  sortAsc: boolean;
  onToggle: (key: SortKey) => void;
  className?: string;
}

const STAGES = [
  "New",
  "Planned",
  "In Progress",
  "In Review",
  "Client Pending",
  "Completed",
];

type SortKey = "title" | "effort" | "currentStage" | "cycleTime" | "maxActiveAge" | "assignee";

const ACTIVE_SORT_STAGES = new Set(["Planned", "In Progress", "In Review", "Client Pending"]);

function maxActiveStageHours(t: TicketFlowEntry): number {
  let max = 0;
  for (const sd of t.stageDurations) {
    if (ACTIVE_SORT_STAGES.has(sd.stageName) && sd.durationHours > max) {
      max = sd.durationHours;
    }
  }
  return max;
}

// Day-based color thresholds for dot badges
const DAY_THRESHOLD_AMBER = 3;
const DAY_THRESHOLD_RED = 6;

function dayColor(days: number): string {
  if (days < DAY_THRESHOLD_AMBER) return "bg-green-100 text-green-800";
  if (days < DAY_THRESHOLD_RED) return "bg-amber-100 text-amber-800";
  return "bg-red-100 text-red-800";
}

function hoursToDays(hours: number): string {
  const days = Math.round(hours / 24);
  if (days < 1) return "<1";
  return String(days);
}

function formatTooltip(sd: StageDuration): string {
  const d = new Date(sd.enteredAt);
  const day = d.toLocaleDateString("en-US", { weekday: "short" });
  const time = d.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return `Entered: ${day} ${time} | ${sd.durationHours.toFixed(1)}h`;
}

function formatCycleDays(hours: number): string {
  const days = Math.round(hours / 24);
  return days < 1 ? "<1d" : `${days}d`;
}

function getStageDuration(
  durations: StageDuration[],
  stageName: string,
): StageDuration | undefined {
  return durations.find((d) => d.stageName === stageName);
}

function SortHeader({
  label,
  k,
  sortKey,
  sortAsc,
  onToggle,
  className,
}: SortHeaderProps) {
  return (
    <th
      className={`px-2 py-2 text-left text-xs font-medium text-gray-500 cursor-pointer hover:text-gray-700 ${className ?? ""}`}
      onClick={() => onToggle(k)}
    >
      {label} {sortKey === k ? (sortAsc ? "\u25B2" : "\u25BC") : ""}
    </th>
  );
}

export function TicketFlowDots({
  tickets,
  showAssignee = false,
  showClient = false,
}: TicketFlowDotsProps) {
  const [sortKey, setSortKey] = useState<SortKey>("maxActiveAge");
  const [sortAsc, setSortAsc] = useState(false);
  const [filter, setFilter] = useState<"all" | "active" | "completed">("active");
  const [assigneeFilter, setAssigneeFilter] = useState("");

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortAsc(!sortAsc);
    } else {
      setSortKey(key);
      setSortAsc(key === "title" || key === "assignee");
    }
  }

  // Derive unique assignees
  const assignees = Array.from(
    new Set(tickets.map((t) => t.assigneeName)),
  ).sort();

  // Apply filters
  const filtered = tickets.filter((t) => {
    if (filter === "active" && t.currentStage === "Completed") return false;
    if (filter === "completed" && t.currentStage !== "Completed") return false;
    if (assigneeFilter && t.assigneeName !== assigneeFilter) return false;
    return true;
  });

  const stagesWithData = new Set<string>();
  for (const t of filtered) {
    for (const sd of t.stageDurations) {
      stagesWithData.add(sd.stageName);
    }
  }

  const sorted = [...filtered].sort((a, b) => {
    let cmp = 0;
    switch (sortKey) {
      case "title":
        cmp = a.title.localeCompare(b.title);
        break;
      case "effort":
        cmp = (a.effortScore ?? 0) - (b.effortScore ?? 0);
        break;
      case "currentStage":
        cmp =
          STAGES.indexOf(a.currentStage) - STAGES.indexOf(b.currentStage);
        break;
      case "cycleTime":
        cmp = (a.totalCycleHours ?? 999) - (b.totalCycleHours ?? 999);
        break;
      case "maxActiveAge":
        cmp = maxActiveStageHours(a) - maxActiveStageHours(b);
        break;
      case "assignee":
        cmp = a.assigneeName.localeCompare(b.assigneeName);
        break;
    }
    return sortAsc ? cmp : -cmp;
  });

  if (tickets.length === 0) {
    return (
      <p className="text-sm text-gray-400 py-4">No tickets for this period</p>
    );
  }

  return (
    <div>
      {/* Filter bar */}
      <div className="flex items-center gap-3 mb-3">
        <div className="flex gap-1">
          {(["all", "active", "completed"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-2.5 py-1 text-xs rounded-md font-medium ${
                filter === f
                  ? "bg-gray-900 text-white"
                  : "bg-gray-100 text-gray-600 hover:bg-gray-200"
              }`}
            >
              {f.charAt(0).toUpperCase() + f.slice(1)}
              {f === "all" && ` (${tickets.length})`}
            </button>
          ))}
        </div>
        <select
          value={assigneeFilter}
          onChange={(e) => setAssigneeFilter(e.target.value)}
          className="text-xs rounded-md border border-gray-200 bg-white px-2 py-1 text-gray-600"
        >
          <option value="">All Assignees</option>
          {assignees.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </div>

      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200">
              <SortHeader
                label="Task"
                k="title"
                sortKey={sortKey}
                sortAsc={sortAsc}
                onToggle={toggleSort}
                className="min-w-[180px]"
              />
              {showAssignee && (
                <SortHeader
                  label="Assignee"
                  k="assignee"
                  sortKey={sortKey}
                  sortAsc={sortAsc}
                  onToggle={toggleSort}
                />
              )}
              {showClient && (
                <th className="px-2 py-2 text-left text-xs font-medium text-gray-500">
                  Client
                </th>
              )}
              <SortHeader
                label="Effort"
                k="effort"
                sortKey={sortKey}
                sortAsc={sortAsc}
                onToggle={toggleSort}
              />
              {STAGES.map((stage) => {
                const hasData = stagesWithData.has(stage);
                return (
                  <th
                    key={stage}
                    className={`px-2 py-2 text-center text-xs font-medium whitespace-nowrap ${
                      hasData
                        ? "text-gray-500 min-w-[56px]"
                        : "text-gray-300 min-w-[36px]"
                    }`}
                  >
                    {stage}
                  </th>
                );
              })}
              <SortHeader
                label="Cycle"
                k="cycleTime"
                sortKey={sortKey}
                sortAsc={sortAsc}
                onToggle={toggleSort}
              />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {sorted.map((ticket) => (
              <tr key={ticket.taskId} className="hover:bg-gray-50">
                <td className="px-2 py-2">
                  <a
                    href={ticket.permalink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-gray-800 hover:underline font-medium truncate block max-w-[220px]"
                    title={ticket.title}
                  >
                    {ticket.title}
                  </a>
                </td>
                {showAssignee && (
                  <td className="px-2 py-2 text-gray-600">
                    {ticket.assigneeName}
                  </td>
                )}
                {showClient && (
                  <td className="px-2 py-2 text-gray-600 text-xs">
                    {ticket.clientName}
                  </td>
                )}
                <td className="px-2 py-2 text-center">
                  {ticket.effortScore !== null ? (
                    <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-blue-100 text-blue-700 text-xs font-medium">
                      {ticket.effortScore}
                    </span>
                  ) : (
                    <span className="text-gray-300">—</span>
                  )}
                </td>
                {STAGES.map((stage) => {
                  const sd = getStageDuration(ticket.stageDurations, stage);
                  const isCurrent = ticket.currentStage === stage;

                  if (!sd) {
                    return (
                      <td
                        key={stage}
                        className="px-2 py-2 text-center text-gray-200"
                      >
                        —
                      </td>
                    );
                  }

                  return (
                    <td key={stage} className="px-2 py-2 text-center">
                      <span
                        className={`inline-flex items-center justify-center w-8 h-8 rounded-full text-xs font-semibold ${dayColor(sd.durationHours / 24)} ${
                          isCurrent ? "ring-2 ring-blue-400" : ""
                        }`}
                        title={formatTooltip(sd)}
                      >
                        {hoursToDays(sd.durationHours)}
                      </span>
                    </td>
                  );
                })}
                <td className="px-2 py-2 text-center">
                  {ticket.totalCycleHours !== null ? (
                    <span className="text-xs font-semibold text-gray-700">
                      {formatCycleDays(ticket.totalCycleHours)}
                    </span>
                  ) : ticket.executionHours !== null ? (
                    <span className="text-xs text-gray-500">
                      {formatCycleDays(ticket.executionHours)}{" "}
                      <span className="text-gray-400">(active)</span>
                    </span>
                  ) : (
                    <span className="text-gray-300">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
