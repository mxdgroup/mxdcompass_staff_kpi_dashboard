// Parse Wrike system comments to extract status change transitions

import type { WrikeComment, WrikeCustomStatus } from "./types";
import type { StageTransition } from "../types";

// Wrike comments may contain HTML — strip tags before matching
function stripHtml(text: string): string {
  return text.replace(/<[^>]*>/g, "").trim();
}

// Matches: "changed status to In Progress"
// Also:    "changed status from New to In Progress"
const STATUS_CHANGE_RE =
  /changed status(?:\s+from\s+(.+?))?\s+to\s+(.+)/i;

/**
 * Build a lookup from lowercase status name → WrikeCustomStatus.
 */
function buildStatusLookup(
  allStatuses: WrikeCustomStatus[],
): Map<string, WrikeCustomStatus> {
  const map = new Map<string, WrikeCustomStatus>();
  for (const s of allStatuses) {
    map.set(s.name.toLowerCase(), s);
  }
  return map;
}

/**
 * Parse status change events from a task's comments.
 * Returns transitions sorted chronologically (oldest first).
 */
export function parseStatusChangesFromComments(
  comments: WrikeComment[],
  allStatuses: WrikeCustomStatus[],
): StageTransition[] {
  const lookup = buildStatusLookup(allStatuses);
  const transitions: StageTransition[] = [];

  // Sort comments by creation date ascending
  const sorted = [...comments].sort(
    (a, b) =>
      new Date(a.createdDate).getTime() - new Date(b.createdDate).getTime(),
  );

  for (const comment of sorted) {
    const plain = stripHtml(comment.text);
    const match = plain.match(STATUS_CHANGE_RE);
    if (!match) continue;

    const fromName = match[1]?.trim() ?? "";
    const toName = match[2]?.trim() ?? "";

    const toStatus = lookup.get(toName.toLowerCase());
    if (!toStatus) continue; // can't resolve status name — skip

    const fromStatus = fromName
      ? lookup.get(fromName.toLowerCase())
      : undefined;

    transitions.push({
      fromStage: fromStatus?.name ?? (fromName || "Unknown"),
      fromStageId: fromStatus?.id ?? "",
      toStage: toStatus.name,
      toStageId: toStatus.id,
      timestamp: comment.createdDate,
      source: "comment",
    });
  }

  return transitions;
}
