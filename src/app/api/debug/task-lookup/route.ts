// Diagnostic endpoint: look up a Wrike task by permalink ID to determine why
// it's missing from the dashboard. Reports folder membership, status, and
// whether the task falls within configured folders.
// Protected by CRON_SECRET Bearer auth.

import { NextResponse } from "next/server";
import { getWrikeClient } from "@/lib/wrike/client";
import { resolveWorkflowStatuses } from "@/lib/wrike/fetcher";
import { config } from "@/lib/config";
import type { WrikeTask, WrikeComment } from "@/lib/wrike/types";

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const permalinkId = url.searchParams.get("permalink");
  if (!permalinkId) {
    return NextResponse.json(
      { error: "Missing ?permalink=<numeric_id> parameter" },
      { status: 400 },
    );
  }

  const client = getWrikeClient();
  const statuses = await resolveWorkflowStatuses();
  const configuredFolderIds = new Set(config.clients.map((c) => c.wrikeFolderId));
  const configuredFolderNames = Object.fromEntries(
    config.clients.map((c) => [c.wrikeFolderId, c.name]),
  );

  // Strategy: search each configured folder for the task by scanning all tasks.
  // Also try the Wrike /tasks endpoint with permalink filter.
  const permalinkUrl = `https://www.wrike.com/open.htm?id=${permalinkId}`;

  // Approach 1: Fetch all tasks from all configured folders and match by permalink
  let foundTask: WrikeTask | null = null;
  let foundInFolder: string | null = null;
  let foundInClient: string | null = null;

  for (const clientConfig of config.clients) {
    try {
      const tasks = await client.get<WrikeTask>(
        `/folders/${clientConfig.wrikeFolderId}/tasks`,
        {
          fields: JSON.stringify(["customFields", "responsibleIds", "briefDescription"]),
          descendants: true,
        },
      );

      const match = tasks.find((t) => t.permalink === permalinkUrl);
      if (match) {
        foundTask = match;
        foundInFolder = clientConfig.wrikeFolderId;
        foundInClient = clientConfig.name;
        break;
      }
    } catch (err) {
      console.error(`[task-lookup] Error scanning folder ${clientConfig.name}:`, err);
    }
  }

  // If not found in configured folders, try fetching all tasks without folder filter
  // (requires account-level access)
  if (!foundTask) {
    try {
      // Wrike API: search by permalink across the account
      const allTasks = await client.get<WrikeTask>("/tasks", {
        permalink: permalinkUrl,
        fields: JSON.stringify(["customFields", "responsibleIds", "briefDescription"]),
      });
      if (allTasks.length > 0) {
        foundTask = allTasks[0];
      }
    } catch (err) {
      console.error("[task-lookup] Account-wide search failed:", err);
    }
  }

  if (!foundTask) {
    return NextResponse.json({
      permalinkId,
      permalinkUrl,
      found: false,
      diagnosis: "Task not found in any configured folder or via account-wide search. The permalink ID may be incorrect, or the task may be in a space/folder this API token cannot access.",
    });
  }

  // Determine status info
  const statusObj = foundTask.customStatusId
    ? statuses.allStatuses.find((s) => s.id === foundTask!.customStatusId)
    : null;

  // Check folder membership
  const parentFolderMatches = (foundTask.parentIds ?? []).filter((pid) =>
    configuredFolderIds.has(pid),
  );
  const isInConfiguredFolder = foundInFolder !== null || parentFolderMatches.length > 0;

  // Fetch comments to check for status change history
  let comments: WrikeComment[] = [];
  let statusChangeComments = 0;
  try {
    comments = await client.get<WrikeComment>(`/tasks/${foundTask.id}/comments`);
    const statusChangeRe = /changed status/i;
    statusChangeComments = comments.filter((c) => statusChangeRe.test(c.text.replace(/<[^>]*>/g, ""))).length;
  } catch {
    // Comments fetch failed — continue without
  }

  // Build diagnosis
  const issues: string[] = [];

  if (!isInConfiguredFolder) {
    issues.push(
      `Task is NOT in any configured folder. Parent folder IDs: [${(foundTask.parentIds ?? []).join(", ")}]. ` +
      `Configured folders: ${config.clients.map((c) => `${c.name} (${c.wrikeFolderId})`).join(", ")}. ` +
      `Fix: add the task's folder to config.clients[] in src/lib/config.ts.`,
    );
  }

  if (statusObj?.group === "Completed" && !foundTask.completedDate) {
    issues.push("Task status group is 'Completed' but has no completedDate — may be in a broken state.");
  }

  if (statusObj?.group === "Completed") {
    issues.push(
      `Task is in '${statusObj.name}' (Completed group). It will only appear on the dashboard if updated within the selected week's date range.`,
    );
  }

  if (!statusObj && foundTask.customStatusId) {
    issues.push(
      `Task has customStatusId '${foundTask.customStatusId}' which is NOT in the known status list. ` +
      `This status may need to be added to knownCustomStatuses[] in fetcher.ts.`,
    );
  }

  if (statusChangeComments === 0) {
    issues.push("Task has ZERO status change comments — comment parser will produce no transitions. Only webhook data or synthetic fallback will be available.");
  }

  const diagnosis = issues.length > 0
    ? issues.join(" | ")
    : "Task appears healthy — it's in a configured folder, has a recognized status, and has status change comments.";

  return NextResponse.json({
    permalinkId,
    permalinkUrl,
    found: true,
    taskId: foundTask.id,
    title: foundTask.title,
    status: {
      customStatusId: foundTask.customStatusId,
      statusName: statusObj?.name ?? "Unknown",
      statusGroup: statusObj?.group ?? "Unknown",
    },
    dates: {
      created: foundTask.createdDate,
      updated: foundTask.updatedDate,
      completed: foundTask.completedDate ?? null,
      start: foundTask.dates?.start ?? null,
      due: foundTask.dates?.due ?? null,
    },
    folders: {
      parentIds: foundTask.parentIds ?? [],
      isInConfiguredFolder,
      foundInFolder,
      foundInClient,
      configuredFolders: config.clients.map((c) => ({
        name: c.name,
        folderId: c.wrikeFolderId,
      })),
    },
    comments: {
      total: comments.length,
      statusChangeComments,
    },
    assignees: foundTask.responsibleIds ?? [],
    diagnosis,
  });
}
