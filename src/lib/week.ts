/**
 * ISO 8601 week utilities.
 * Weeks start Monday 00:00 UTC, end Sunday 23:59:59 UTC.
 */

export interface WeekRange {
  week: string; // "2026-W14"
  start: string; // "2026-03-30" (Monday)
  end: string; // "2026-04-05" (Sunday)
  startTimestamp: number;
  endTimestamp: number;
}

/** Get ISO week string for a date (e.g. "2026-W14") */
export function getISOWeek(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7; // Sunday = 7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum); // Thursday of the week
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

/** Get the Monday-Sunday range for an ISO week string */
export function getWeekRange(weekStr: string): WeekRange {
  const [yearStr, weekPart] = weekStr.split("-W");
  const year = parseInt(yearStr, 10);
  const week = parseInt(weekPart, 10);

  // Jan 4 is always in week 1
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4DayOfWeek = jan4.getUTCDay() || 7;
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - jan4DayOfWeek + 1 + (week - 1) * 7);

  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  sunday.setUTCHours(23, 59, 59, 999);

  const fmt = (d: Date) =>
    `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;

  return {
    week: weekStr,
    start: fmt(monday),
    end: fmt(sunday),
    startTimestamp: monday.getTime(),
    endTimestamp: sunday.getTime(),
  };
}

/** Get the current ISO week */
export function getCurrentWeek(): string {
  return getISOWeek(new Date());
}

/** Get the most recently completed ISO week (last week if today is Mon-Sat, two weeks ago if Sun before cron runs) */
export function getLastCompletedWeek(): string {
  const now = new Date();
  // Go back to last Monday
  const dayOfWeek = now.getUTCDay() || 7;
  const lastMonday = new Date(now);
  lastMonday.setUTCDate(now.getUTCDate() - dayOfWeek - 6); // Monday of the previous week
  return getISOWeek(lastMonday);
}

/** Get N prior week strings (not including the given week) */
export function getPriorWeeks(weekStr: string, count: number): string[] {
  const range = getWeekRange(weekStr);
  const monday = new Date(range.startTimestamp);
  const weeks: string[] = [];
  for (let i = 1; i <= count; i++) {
    const prev = new Date(monday);
    prev.setUTCDate(monday.getUTCDate() - 7 * i);
    weeks.push(getISOWeek(prev));
  }
  return weeks;
}

/** Get the 7 days (Mon-Sun) of a week as YYYY-MM-DD strings */
export function getWeekDays(weekStr: string): string[] {
  const range = getWeekRange(weekStr);
  const monday = new Date(range.startTimestamp);
  const days: string[] = [];
  const fmt = (d: Date) =>
    `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  for (let i = 0; i < 7; i++) {
    const day = new Date(monday);
    day.setUTCDate(monday.getUTCDate() + i);
    days.push(fmt(day));
  }
  return days;
}
