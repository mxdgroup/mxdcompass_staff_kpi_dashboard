"use client";

import { useState } from "react";
import type { DailyCommitEntry } from "@/lib/types";

interface DailyCommitGridProps {
  dailyCommits: DailyCommitEntry[];
}

export function DailyCommitGrid({ dailyCommits }: DailyCommitGridProps) {
  const [expanded, setExpanded] = useState<number | null>(null);

  return (
    <div>
      <h4 className="text-xs font-medium text-gray-500 mb-2">Daily Commits</h4>
      <div className="grid grid-cols-7 gap-1">
        {dailyCommits.map((day, i) => {
          const count = day.commits.length;
          const isExpanded = expanded === i;

          return (
            <div key={i} className="text-center">
              <p className="text-[10px] font-medium text-gray-400">{day.dayName}</p>
              <button
                onClick={() => setExpanded(isExpanded ? null : i)}
                className={`w-full rounded py-1.5 text-sm font-medium transition-colors ${
                  count === 0
                    ? "bg-gray-50 text-gray-300 cursor-default"
                    : count <= 2
                      ? "bg-blue-50 text-blue-700 hover:bg-blue-100"
                      : count <= 5
                        ? "bg-blue-100 text-blue-800 hover:bg-blue-200"
                        : "bg-blue-200 text-blue-900 hover:bg-blue-300"
                }`}
                disabled={count === 0}
              >
                {count || ""}
              </button>
            </div>
          );
        })}
      </div>

      {expanded !== null && dailyCommits[expanded] && dailyCommits[expanded].commits.length > 0 && (
        <div className="mt-2 rounded-md bg-gray-50 p-2 text-xs">
          <p className="font-medium text-gray-600 mb-1">{dailyCommits[expanded].date}</p>
          <ul className="space-y-1">
            {dailyCommits[expanded].commits.map((c, j) => (
              <li key={j} className="flex gap-2">
                <span className="shrink-0 rounded bg-gray-200 px-1 font-mono text-[10px]">
                  {c.repo}
                </span>
                <span className="text-gray-700 truncate">{c.message}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
