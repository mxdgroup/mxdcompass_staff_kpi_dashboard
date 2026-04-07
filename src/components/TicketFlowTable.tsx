"use client";

import { useState } from "react";
import type { TicketFlowEntry, StageDuration } from "@/lib/types";

interface TicketFlowTableProps {
  tickets: TicketFlowEntry[];
  showAssignee?: boolean;
  showClient?: boolean;
}

const STAGES = [
  "New",
  "Planned",
  "In Progress",
  "In Review",
  "Client Pending",
  "Completed",
];

type SortKey =
  | "title"
  | "effort"
  | "currentStage"
  | "cycleTime"
  | "assignee";

function durationColor(hours: number): string {
  if (hours < 4) return "bg-green-50 text-green-700";
  if (hours < 24) return "bg-amber-50 text-amber-700";
  return "bg-red-50 text-red-700";
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  const day = d.toLocaleDateString("en-US", { weekday: "short" });
  const time = d.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return `${day} ${time}`;
}

function formatDuration(hours: number): string {
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 48) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

function getStageDuration(
  durations: StageDuration[],
  stageName: string,
): StageDuration | undefined {
  return durations.find((d) => d.stageName === stageName);
}

export function TicketFlowTable({
  tickets,
  showAssignee = false,
  showClient = false,
}: TicketFlowTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>("cycleTime");
  const [sortAsc, setSortAsc] = useState(false);
  const [filter, setFilter] = useState<"all" | "active" | "completed">("all");

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortAsc(!sortAsc);
    } else {
      setSortKey(key);
      setSortAsc(key === "title" || key === "assignee");
    }
  }

  const filtered = tickets.filter((t) => {
    if (filter === "active") return t.currentStage !== "Completed";
    if (filter === "completed") return t.currentStage === "Completed";
    return true;
  });

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

  const SortHeader = ({
    label,
    k,
    className,
  }: {
    label: string;
    k: SortKey;
    className?: string;
  }) => (
    <th
      className={`px-2 py-2 text-left text-xs font-medium text-gray-500 cursor-pointer hover:text-gray-700 ${className ?? ""}`}
      onClick={() => toggleSort(k)}
    >
      {label} {sortKey === k ? (sortAsc ? "\u25B2" : "\u25BC") : ""}
    </th>
  );

  return (
    <div>
      {/* Filter tabs */}
      <div className="flex gap-1 mb-3">
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

      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200">
              <SortHeader label="Task" k="title" className="min-w-[180px]" />
              {showAssignee && <SortHeader label="Assignee" k="assignee" />}
              {showClient && (
                <th className="px-2 py-2 text-left text-xs font-medium text-gray-500">
                  Client
                </th>
              )}
              <SortHeader label="Effort" k="effort" />
              {STAGES.map((stage) => (
                <th
                  key={stage}
                  className="px-2 py-2 text-center text-xs font-medium text-gray-500 min-w-[90px]"
                >
                  {stage}
                </th>
              ))}
              <SortHeader label="Cycle" k="cycleTime" />
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
                      <div
                        className={`rounded px-1.5 py-1 ${
                          isCurrent
                            ? "ring-2 ring-blue-400 " + durationColor(sd.durationHours)
                            : durationColor(sd.durationHours)
                        }`}
                      >
                        <div className="text-[10px] text-gray-500">
                          {formatTimestamp(sd.enteredAt)}
                        </div>
                        <div className="text-xs font-semibold">
                          {formatDuration(sd.durationHours)}
                        </div>
                      </div>
                    </td>
                  );
                })}
                <td className="px-2 py-2 text-center">
                  {ticket.totalCycleHours !== null ? (
                    <span className="text-xs font-semibold text-gray-700">
                      {formatDuration(ticket.totalCycleHours)}
                    </span>
                  ) : ticket.executionHours !== null ? (
                    <span className="text-xs text-gray-500">
                      {formatDuration(ticket.executionHours)} (active)
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
