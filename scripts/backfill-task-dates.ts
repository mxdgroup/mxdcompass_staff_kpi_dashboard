/**
 * Backfill Wrike task start/end dates from task history.
 *
 * Uses the /tasks_history API to find when a task was moved to
 * "Planned" and "In Review" statuses, then updates start/end dates.
 *
 * Usage:
 *   npx tsx scripts/backfill-task-dates.ts              # dry-run (default)
 *   npx tsx scripts/backfill-task-dates.ts --write       # actually update
 *   npx tsx scripts/backfill-task-dates.ts --dump        # dump all history entries
 */

import { config as dotenvConfig } from "dotenv";
import { resolve } from "path";

// Load .env.local first, then .env as fallback
dotenvConfig({ path: resolve(import.meta.dirname, "../.env.local") });
dotenvConfig({ path: resolve(import.meta.dirname, "../.env") });

import { WrikeClient } from "../src/lib/wrike/client";
import type { WrikeTask } from "../src/lib/wrike/types";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PERMALINK_URL = "https://www.wrike.com/open.htm?id=4388245750";

// Status names to match (case-insensitive)
const PLANNED_KEYWORDS = ["planned"];
const IN_REVIEW_KEYWORDS = ["in review"];

const args = process.argv.slice(2);
const WRITE_MODE = args.includes("--write");
const DUMP_MODE = args.includes("--dump");

// ---------------------------------------------------------------------------
// Types for tasks_history response
// ---------------------------------------------------------------------------

interface WrikeHistoryEntry {
  id: string;
  taskId: string;
  userId: string;
  updatedDate: string;
  field: string;
  oldValue?: string;
  newValue?: string;
  [key: string]: unknown; // allow extra fields we haven't mapped
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isoToDate(iso: string): string {
  return iso.slice(0, 10); // "2026-04-01T10:30:00Z" → "2026-04-01"
}

function matchesKeywords(value: string, keywords: string[]): boolean {
  const lower = value.toLowerCase();
  return keywords.some((kw) => lower.includes(kw));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const client = new WrikeClient();

  // Step 1: Resolve permalink → API task ID
  console.log(`Resolving permalink: ${PERMALINK_URL}`);
  const tasks = await client.get<WrikeTask>("/tasks", {
    permalink: PERMALINK_URL,
  });

  if (tasks.length === 0) {
    console.error("Could not resolve task from permalink. Check the URL.");
    process.exit(1);
  }

  const task = tasks[0];
  console.log(`Resolved to task: "${task.title}" (${task.id})`);
  console.log(`Current dates: start=${task.dates.start ?? "none"}, due=${task.dates.due ?? "none"}`);

  // Step 2: Fetch task history
  console.log("\nFetching task history...");
  const history = await client.get<WrikeHistoryEntry>(
    `/tasks/${task.id}/tasks_history`,
  );
  console.log(`Found ${history.length} history entries`);

  // Sort by updatedDate ascending
  history.sort(
    (a, b) =>
      new Date(a.updatedDate).getTime() - new Date(b.updatedDate).getTime(),
  );

  // Dump mode: show all history entries and exit
  if (DUMP_MODE) {
    console.log("\n--- Raw history entries ---\n");
    for (const h of history) {
      console.log(JSON.stringify(h, null, 2));
    }
    return;
  }

  // Step 3: Find status transitions
  // Look for entries where field is "CustomStatus" or "Status" and newValue matches
  let plannedDate: string | undefined;
  let inReviewDate: string | undefined;

  for (const entry of history) {
    const field = entry.field?.toLowerCase();
    if (field !== "customstatus" && field !== "status") continue;

    const newVal = String(entry.newValue ?? "");

    if (!plannedDate && matchesKeywords(newVal, PLANNED_KEYWORDS)) {
      plannedDate = isoToDate(entry.updatedDate);
      console.log(
        `Found "Planned" transition: ${plannedDate} — ${entry.oldValue ?? "(none)"} → ${newVal}`,
      );
    }

    if (!inReviewDate && matchesKeywords(newVal, IN_REVIEW_KEYWORDS)) {
      inReviewDate = isoToDate(entry.updatedDate);
      console.log(
        `Found "In Review" transition: ${inReviewDate} — ${entry.oldValue ?? "(none)"} → ${newVal}`,
      );
    }
  }

  if (!plannedDate && !inReviewDate) {
    console.log(
      "\nNo status transitions found. Try running with --dump to inspect history entries.",
    );
    return;
  }

  // Step 4: Build dates payload
  const start = plannedDate ?? task.dates.start;
  const due = inReviewDate ?? task.dates.due;

  if (!start || !due) {
    console.log(`\nIncomplete dates — start: ${start ?? "missing"}, due: ${due ?? "missing"}`);
    console.log("Cannot update without both start and due dates. Skipping.");
    return;
  }

  console.log(`\nDates to set: start=${start}, due=${due}`);

  if (!WRITE_MODE) {
    console.log("\n[DRY RUN] No changes made. Run with --write to update Wrike.");
    return;
  }

  // Step 5: Update task dates
  console.log("\nUpdating task dates...");
  const dates = JSON.stringify({ type: "Planned", start, due });
  await client.put(`/tasks/${task.id}`, { dates });
  console.log("Task dates updated successfully.");
}

main().catch((err) => {
  console.error("Error:", err.message ?? err);
  process.exit(1);
});
