// Auto-set Wrike task dates when status changes
//
// Planned / In Progress        → set start date (if not already set)
// In Review / Client Pending / Completed → set due date (+ start if missing)

import { getWrikeClient } from "./client";
import { resolveWorkflowStatuses } from "./fetcher";
import { config } from "../config";
import type { WrikeWebhookEvent } from "./webhook";
import type { WrikeTask } from "./types";

/**
 * Given a TaskStatusChanged webhook event, write start/due dates
 * back to the Wrike task if the new status warrants it.
 *
 * Designed to run inside `after()` so it never blocks the webhook response.
 */
export async function applyDateForStatusChange(
  event: WrikeWebhookEvent,
): Promise<void> {
  const statuses = await resolveWorkflowStatuses();
  const newStatusId = event.customStatusId;

  // Collect ALL matching IDs across workflows (not just the first match)
  // because resolveWorkflowStatuses().inProgressId only returns the first
  // match, which may be from the wrong workflow.
  const lowerInProgress = config.inProgressStatusName.toLowerCase();
  const lowerInReview = config.inReviewStatusName.toLowerCase();
  const lowerClientPending = config.clientPendingStatusName.toLowerCase();

  const allInProgressIds = statuses.allStatuses
    .filter((s) => s.name.toLowerCase() === lowerInProgress)
    .map((s) => s.id);

  const allInReviewIds = statuses.allStatuses
    .filter((s) => s.name.toLowerCase() === lowerInReview)
    .map((s) => s.id);

  const allClientPendingIds = statuses.allStatuses
    .filter((s) => s.name.toLowerCase() === lowerClientPending)
    .map((s) => s.id);

  // Exclude "New" from start triggers — plannedIds includes New for the flow
  // dashboard, but only Planned/In Progress should set a start date.
  const startTriggerIds = statuses.plannedIds.filter(
    (id) => !statuses.allStatuses.some(
      (s) => s.id === id && s.name.toLowerCase() === "new",
    ),
  );

  const isStartTrigger =
    startTriggerIds.includes(newStatusId) ||
    allInProgressIds.includes(newStatusId);

  const isDueTrigger =
    statuses.completedIds.includes(newStatusId) ||
    allInReviewIds.includes(newStatusId) ||
    allClientPendingIds.includes(newStatusId);

  if (!isStartTrigger && !isDueTrigger) return;

  const eventDate = event.lastUpdatedDate.slice(0, 10); // YYYY-MM-DD
  const client = getWrikeClient();

  // Fetch the task to check existing dates
  const tasks = await client.get<WrikeTask>(`/tasks/${event.taskId}`);
  const task = tasks[0];
  if (!task) {
    console.warn(`[webhook] Task ${event.taskId} not found, skipping date write`);
    return;
  }

  const hasStart = !!task.dates?.start;
  const hasDue = !!task.dates?.due;

  if (isStartTrigger) {
    if (hasStart) {
      console.log(`[webhook] Task ${event.taskId} already has start date ${task.dates.start}, skipping`);
      return;
    }
    // Wrike requires both start+due when transitioning from Backlog type
    const dates: Record<string, string> = { start: eventDate };
    if (!hasDue) {
      dates.due = eventDate;
    }
    await client.put(`/tasks/${event.taskId}`, {
      dates: JSON.stringify(dates),
    });
    console.log(`[webhook] Set start date ${eventDate} on task ${event.taskId}`);
    return;
  }

  // isDueTrigger — set due date if not already set (idempotent)
  if (hasDue) {
    console.log(`[webhook] Task ${event.taskId} already has due date ${task.dates.due}, skipping`);
    return;
  }

  // Wrike requires both start+due for type=Planned; sending only due
  // converts the task to Milestone and drops the start date.
  if (hasStart) {
    const existingStart = task.dates.start!.slice(0, 10); // preserve YYYY-MM-DD
    await client.put(`/tasks/${event.taskId}`, {
      dates: JSON.stringify({ start: existingStart, due: eventDate }),
    });
    console.log(`[webhook] Set due date ${eventDate} on task ${event.taskId}`);
  } else {
    // Backfill: task skipped Planned/In Progress, set both
    await client.put(`/tasks/${event.taskId}`, {
      dates: JSON.stringify({ start: eventDate, due: eventDate }),
    });
    console.log(`[webhook] Set start+due date ${eventDate} on task ${event.taskId} (backfill)`);
  }
}
