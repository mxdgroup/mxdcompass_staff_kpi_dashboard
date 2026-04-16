// Shared sync logic used by:
// - /api/sync/trigger (frontend button)
// - /api/sync (cron/external with Bearer auth)
// - Webhook after() for auto-sync on task status changes

import { loadOverridesFromRedis, getUnmappedMembers } from "./bootstrap";
import { config } from "./config";
import { acquireSyncGuard, releaseSyncGuard, saveSnapshot } from "./storage";
import { buildWeeklySnapshot } from "./aggregator";
import { buildFlowSnapshot, patchFlowSnapshotForTask } from "./flowBuilder";
import { saveFlowSnapshot, getFlowSnapshot, getFlowLatestWeek } from "./flowStorage";
import { getCurrentWeek } from "./week";
import { getWrikeClient } from "./wrike/client";

export interface SyncResult {
  ok: boolean;
  week: string;
  duration: string;
  membersProcessed: number;
  memberErrors: number;
  flowTickets: number;
  flowFolderErrors?: string[];
  saveErrors?: string[];
  error?: string;
  skipped?: boolean;
}

/**
 * Run a full sync: build weekly + flow snapshots and save them.
 * Uses sync guard to prevent concurrent runs. If guard can't be acquired,
 * returns { skipped: true } instead of failing.
 */
export async function runSync(): Promise<SyncResult> {
  // Load config overrides (contact IDs etc.)
  const overrideResult = await loadOverridesFromRedis();
  if (!overrideResult.loaded) {
    return {
      ok: false,
      week: "",
      duration: "0s",
      membersProcessed: 0,
      memberErrors: 0,
      flowTickets: 0,
      error: `Config override load failed: ${overrideResult.error}`,
    };
  }

  // Reject if all members are unmapped
  const unmapped = getUnmappedMembers();
  if (unmapped.length === config.team.length) {
    return {
      ok: false,
      week: "",
      duration: "0s",
      membersProcessed: 0,
      memberErrors: 0,
      flowTickets: 0,
      error: "All team members unmapped — run bootstrap first",
    };
  }

  // Quick Wrike connectivity check — catch expired tokens before wasting time
  try {
    const client = getWrikeClient();
    const contacts = await client.get<{ id: string }>("/contacts", { me: true });
    if (contacts.length === 0) {
      return {
        ok: false,
        week: "",
        duration: "0s",
        membersProcessed: 0,
        memberErrors: 0,
        flowTickets: 0,
        error: "Wrike API returned empty response for /contacts?me=true. Token may be invalid.",
      };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isAuth = msg.includes("401") || msg.includes("403");
    return {
      ok: false,
      week: "",
      duration: "0s",
      membersProcessed: 0,
      memberErrors: 0,
      flowTickets: 0,
      error: isAuth
        ? `Wrike API authentication failed (${msg}). The WRIKE_PERMANENT_ACCESS_TOKEN is likely expired — generate a new one in Wrike > Apps & Integrations > API.`
        : `Wrike API connectivity check failed: ${msg}`,
    };
  }

  const startTime = Date.now();

  const guard = await acquireSyncGuard();
  if (!guard.acquired) {
    return {
      ok: true,
      week: "",
      duration: "0s",
      membersProcessed: 0,
      memberErrors: 0,
      flowTickets: 0,
      skipped: true,
    };
  }

  try {
    const week = getCurrentWeek();
    const snapshot = await buildWeeklySnapshot(week);
    const weeklyResult = await saveSnapshot(snapshot);

    const flowSnapshot = await buildFlowSnapshot(week);
    const flowResult = await saveFlowSnapshot(flowSnapshot);

    const duration = Math.round((Date.now() - startTime) / 1000);

    const saveErrors: string[] = [];
    if (!weeklyResult.saved) saveErrors.push(`Weekly: ${weeklyResult.reason}`);
    if (!flowResult.saved) saveErrors.push(`Flow: ${flowResult.reason}`);

    return {
      ok: saveErrors.length === 0,
      week,
      duration: `${duration}s`,
      membersProcessed: snapshot.employees.length,
      memberErrors: snapshot.memberErrors.length,
      flowTickets: flowSnapshot.tickets.length,
      flowFolderErrors: flowSnapshot.folderErrors,
      saveErrors: saveErrors.length > 0 ? saveErrors : undefined,
    };
  } finally {
    await releaseSyncGuard(guard.owner);
  }
}

/**
 * Sync a single task: fetch it from Wrike, rebuild its flow entry,
 * and patch the existing flow snapshot. ~2 Wrike API calls instead of ~20+.
 * Does NOT use the sync guard — it's lightweight and non-destructive.
 */
export async function syncTask(taskId: string): Promise<{ ok: boolean; error?: string }> {
  const overrideResult = await loadOverridesFromRedis();
  if (!overrideResult.loaded) {
    return { ok: false, error: `Config load failed: ${overrideResult.error}` };
  }

  const week = await getFlowLatestWeek() ?? getCurrentWeek();
  const existing = await getFlowSnapshot(week);
  if (!existing) {
    // No snapshot to patch — need a full sync first
    console.warn(`[syncTask] No existing flow snapshot for ${week}, falling back to full sync`);
    const result = await runSync();
    return { ok: result.ok, error: result.error };
  }

  try {
    const patched = await patchFlowSnapshotForTask(taskId, existing);
    const result = await saveFlowSnapshot(patched);
    if (!result.saved) {
      return { ok: false, error: result.reason };
    }
    console.log(`[syncTask] Patched task ${taskId} in flow snapshot ${week}`);
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[syncTask] Failed for task ${taskId}:`, message);
    return { ok: false, error: message };
  }
}
