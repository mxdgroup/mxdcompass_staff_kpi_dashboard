"use client";

interface WeekSelectorProps {
  currentWeek: string;
  onWeekChange: (week: string) => void;
}

export function WeekSelector({ currentWeek, onWeekChange }: WeekSelectorProps) {
  const [yearStr, weekPart] = currentWeek.split("-W");
  const year = parseInt(yearStr, 10);
  const weekNum = parseInt(weekPart, 10);

  function navigate(delta: number) {
    let newWeek = weekNum + delta;
    let newYear = year;
    if (newWeek < 1) {
      newYear--;
      newWeek = 52;
    } else if (newWeek > 52) {
      newYear++;
      newWeek = 1;
    }
    onWeekChange(`${newYear}-W${String(newWeek).padStart(2, "0")}`);
  }

  return (
    <div className="flex items-center gap-3">
      <button
        onClick={() => navigate(-1)}
        className="rounded px-2 py-1 text-sm text-gray-600 hover:bg-gray-100"
      >
        {"← Prev"}
      </button>
      <span className="text-sm font-medium text-gray-700">{currentWeek}</span>
      <button
        onClick={() => navigate(1)}
        className="rounded px-2 py-1 text-sm text-gray-600 hover:bg-gray-100"
      >
        {"Next →"}
      </button>
    </div>
  );
}
