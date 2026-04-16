// Cron-based catch-up: backfill missing dates for tasks in trigger statuses.
// Covers gaps from dropped webhook events, suspensions, or historical tasks.

import { getWrikeClient } from "./client";
import { resolveWorkflowStatuses } from "./fetcher";
import { config } from "../config";
import type { WrikeTask } from "./types";

export interface CatchupResult {
  scanned: number;
  startDatesSet: number;
  dueDatesSet: number;
  errors: number;
}

export async function catchUpMissingDates(): Promise<CatchupResult> {
  const statuses = await resolveWorkflowStatuses();
  const client = getWrikeClient();
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  // Build trigger sets (same logic as dateWriter.ts)
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

  // Exclude "New" from start triggers
  const startTriggerIds = new Set([
    ...statuses.plannedIds.filter(
      (id) => !statuses.allStatuses.some(
        (s) => s.id === id && s.name.toLowerCase() === "new",
      ),
    ),
    ...allInProgressIds,
  ]);

  const dueTriggerIds = new Set([
    ...statuses.completedIds,
    ...allInReviewIds,
    ...allClientPendingIds,
  ]);

  const result: CatchupResult = { scanned: 0, startDatesSet: 0, dueDatesSet: 0, errors: 0 };

  // Fetch tasks from all configured client folders
  for (const folderId of config.wrikeFolderIds) {
    let tasks: WrikeTask[];
    try {
      tasks = await client.get<WrikeTask>(`/folders/${folderId}/tasks`, {
        fields: '["parentIds"]',
        descendants: true,
      });
    } catch (err) {
      console.error(`[dateCatchup] Failed to fetch tasks for folder ${folderId}:`, err);
      result.errors++;
      continue;
    }

    for (const task of tasks) {
      result.scanned++;
      const statusId = task.customStatusId;
      if (!statusId) continue;

      const hasStart = !!task.dates?.start;
      const hasDue = !!task.dates?.due;
      const isStartTrigger = startTriggerIds.has(statusId);
      const isDueTrigger = dueTriggerIds.has(statusId);

      try {
        if (isStartTrigger && !hasStart) {
          const dates: Record<string, string> = { start: today };
          if (!hasDue) dates.due = today;
          await client.put(`/tasks/${task.id}`, { dates: JSON.stringify(dates) });
          result.startDatesSet++;
          console.log(`[dateCatchup] Set start date ${today} on task ${task.id} (${task.title})`);
        } else if (isDueTrigger && !hasDue) {
          if (hasStart) {
            const existingStart = task.dates.start!.slice(0, 10);
            await client.put(`/tasks/${task.id}`, {
              dates: JSON.stringify({ start: existingStart, due: today }),
            });
          } else {
            await client.put(`/tasks/${task.id}`, {
              dates: JSON.stringify({ start: today, due: today }),
            });
          }
          result.dueDatesSet++;
          console.log(`[dateCatchup] Set due date ${today} on task ${task.id} (${task.title})`);
        }
      } catch (err) {
        console.error(`[dateCatchup] Failed to set dates on task ${task.id}:`, err);
        result.errors++;
      }
    }
  }

  console.log(
    `[dateCatchup] Done: scanned=${result.scanned}, startDatesSet=${result.startDatesSet}, dueDatesSet=${result.dueDatesSet}, errors=${result.errors}`,
  );
  return result;
}
