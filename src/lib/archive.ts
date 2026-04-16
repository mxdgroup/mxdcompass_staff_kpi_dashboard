// Archive rule: a ticket is "archived" once it has been completed for ≥ 45 UTC
// calendar days. Tasks with completedDate === null (the migration cohort) are
// always treated as not archived. Pure module — safe for client and server.

import type { TicketFlowEntry } from "./types";

export const ARCHIVE_THRESHOLD_DAYS = 45;

const MS_PER_DAY = 86_400_000;

function utcDayCount(date: Date): number {
  return Math.floor(date.getTime() / MS_PER_DAY);
}

export function isArchived(ticket: TicketFlowEntry, now: Date = new Date()): boolean {
  if (ticket.currentStage !== "Completed") return false;
  if (ticket.completedDate === null) return false;

  const completedDay = utcDayCount(new Date(ticket.completedDate));
  const todayDay = utcDayCount(now);
  return todayDay - completedDay >= ARCHIVE_THRESHOLD_DAYS;
}
