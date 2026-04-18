"use client";

import { getAdjacentISOWeek } from "@/lib/week";

interface WeekSelectorProps {
  currentWeek: string;
  onWeekChange: (week: string) => void;
}

export function WeekSelector({ currentWeek, onWeekChange }: WeekSelectorProps) {
  function navigate(delta: number) {
    onWeekChange(getAdjacentISOWeek(currentWeek, delta));
  }

  return (
    <div className="flex items-center gap-1 rounded-lg border border-gray-200 bg-surface-raised px-1 py-0.5">
      <button
        onClick={() => navigate(-1)}
        className="rounded-md px-2 py-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-50 transition-colors"
        aria-label="Previous week"
      >
        <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
        </svg>
      </button>
      <span className="text-sm font-medium text-gray-700 tabular-nums px-2 min-w-[80px] text-center">{currentWeek}</span>
      <button
        onClick={() => navigate(1)}
        className="rounded-md px-2 py-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-50 transition-colors"
        aria-label="Next week"
      >
        <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
        </svg>
      </button>
    </div>
  );
}
