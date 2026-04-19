// Auto-discover Wrike contact IDs and custom field IDs from the API
// Writes results to .data/config-overrides.json for runtime merging

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getWrikeClient } from "./wrike/client";
import type { WrikeContact } from "./wrike/types";
import { config } from "./config";

const DATA_DIR = process.env.VERCEL
  ? path.join(os.tmpdir(), "mxdcompass-staff-kpi-dashboard")
  : path.join(process.cwd(), ".data");
const OVERRIDES_FILE = path.join(DATA_DIR, "config-overrides.json");
const REDIS_OVERRIDES_KEY = "kpi:config-overrides";

export interface ConfigOverrides {
  contactIds: Record<string, string>; // team member name -> wrikeContactId
  effortCustomFieldId: string;
  discoveredAt: string;
}

export interface RuntimeOverrideLoadResult {
  loaded: boolean;
  source?: "redis" | "disk";
  error?: string;
}

export async function discoverWrikeConfig(): Promise<ConfigOverrides> {
  const client = getWrikeClient();

  // 1. Discover contacts
  console.log("[bootstrap] Fetching Wrike contacts...");
  const contacts = await client.get<WrikeContact>("/contacts");
  console.log(`[bootstrap] Found ${contacts.length} contacts`);

  const contactIds: Record<string, string> = {};
  for (const member of config.team) {
    // P24: Prefer full name match over first-name-only match
    const fullNameMatch = contacts.find(
      (c) =>
        `${c.firstName} ${c.lastName}`.toLowerCase() ===
        member.name.toLowerCase(),
    );
    if (fullNameMatch) {
      contactIds[member.name] = fullNameMatch.id;
      console.log(`[bootstrap] Matched ${member.name} → ${fullNameMatch.id} (full name: ${fullNameMatch.firstName} ${fullNameMatch.lastName})`);
      continue;
    }

    // Fallback to first name, but warn if ambiguous
    const firstNameMatches = contacts.filter(
      (c) => c.firstName.toLowerCase() === member.name.toLowerCase(),
    );
    if (firstNameMatches.length === 1) {
      contactIds[member.name] = firstNameMatches[0].id;
      console.log(`[bootstrap] Matched ${member.name} → ${firstNameMatches[0].id} (first name: ${firstNameMatches[0].firstName} ${firstNameMatches[0].lastName})`);
    } else if (firstNameMatches.length > 1) {
      console.warn(`[bootstrap] Ambiguous match for ${member.name}: ${firstNameMatches.length} contacts share that first name. Add full name to config for deterministic matching.`);
    } else {
      console.warn(`[bootstrap] No contact match for ${member.name}`);
    }
  }

  // 2. Discover custom fields
  console.log("[bootstrap] Fetching Wrike custom fields...");
  const customFields = await client.get<{ id: string; title: string }>(
    "/customfields",
  );
  console.log(`[bootstrap] Found ${customFields.length} custom fields`);

  let effortCustomFieldId = "";
  const effortField = customFields.find(
    (f) => f.title.toLowerCase().includes("effort"),
  );
  if (effortField) {
    effortCustomFieldId = effortField.id;
    console.log(`[bootstrap] Found effort field: ${effortField.title} → ${effortField.id}`);
  } else {
    console.warn("[bootstrap] No 'Effort' custom field found");
  }

  // 3. Write overrides
  const overrides: ConfigOverrides = {
    contactIds,
    effortCustomFieldId,
    discoveredAt: new Date().toISOString(),
  };

  // Write to Redis (production on Vercel) and filesystem (local dev)
  try {
    const { getSharedRedis } = await import("./storage");
    const redis = getSharedRedis();
    if (redis) {
      await redis.set(REDIS_OVERRIDES_KEY, JSON.stringify(overrides));
      console.log(`[bootstrap] Config overrides written to Redis (${REDIS_OVERRIDES_KEY})`);
    }
  } catch {
    console.warn("[bootstrap] Could not write to Redis");
  }

  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(OVERRIDES_FILE, JSON.stringify(overrides, null, 2), "utf-8");
    console.log(`[bootstrap] Config overrides written to ${OVERRIDES_FILE}`);
  } catch {
    console.warn("[bootstrap] Could not write to filesystem (read-only on Vercel)");
  }

  // 4. Apply to running config immediately
  applyOverrides(overrides);

  return overrides;
}

/**
 * Apply discovered overrides to the in-memory config.
 * Called at bootstrap time and also at module load if overrides file exists.
 */
export function applyOverrides(overrides: ConfigOverrides): void {
  for (const member of config.team) {
    if (overrides.contactIds[member.name]) {
      member.wrikeContactId = overrides.contactIds[member.name];
    }
  }
  if (overrides.effortCustomFieldId) {
    (config as { effortCustomFieldId: string }).effortCustomFieldId =
      overrides.effortCustomFieldId;
  }
}

/**
 * Load overrides from disk if they exist.
 * Called once at config module initialization.
 */
export function loadOverridesFromDisk(): void {
  try {
    if (fs.existsSync(OVERRIDES_FILE)) {
      const raw = fs.readFileSync(OVERRIDES_FILE, "utf-8");
      const overrides: ConfigOverrides = JSON.parse(raw);
      applyOverrides(overrides);
    }
  } catch {
    // Silently ignore — overrides are optional
  }
}

function loadOverridesFromDiskResult(): RuntimeOverrideLoadResult {
  try {
    if (!fs.existsSync(OVERRIDES_FILE)) {
      return { loaded: false, error: "No overrides found on disk" };
    }
    const raw = fs.readFileSync(OVERRIDES_FILE, "utf-8");
    const overrides: ConfigOverrides = JSON.parse(raw);
    applyOverrides(overrides);
    return { loaded: true, source: "disk" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[bootstrap] Failed to load overrides from disk:", message);
    return { loaded: false, error: message };
  }
}

/**
 * Load overrides from Redis (async, for serverless on Vercel).
 * Call at the start of API routes to rehydrate contact IDs after cold start.
 * P22: Returns load status instead of silently swallowing errors.
 */
export async function loadOverridesFromRedis(): Promise<{ loaded: boolean; error?: string }> {
  try {
    const { getSharedRedis } = await import("./storage");
    const redis = getSharedRedis();
    if (!redis) return { loaded: false, error: "Redis unavailable" };
    const raw = await redis.get<string>(REDIS_OVERRIDES_KEY);
    if (raw) {
      const overrides: ConfigOverrides = typeof raw === "string" ? JSON.parse(raw) : raw as unknown as ConfigOverrides;
      applyOverrides(overrides);

      // P23: Validate contact IDs after loading
      const unmapped = getUnmappedMembers();
      if (unmapped.length > 0) {
        const names = unmapped.map((m) => m.name).join(", ");
        console.warn(`[bootstrap] Unmapped team members after override load: ${names}`);
      }

      return { loaded: true };
    }
    return { loaded: false, error: "No overrides found in Redis" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[bootstrap] Failed to load overrides from Redis:", message);
    return { loaded: false, error: message };
  }
}

/**
 * Load overrides for the current runtime.
 * Prefers Redis when available, but falls back to the local overrides file for
 * local/dev environments and Redis outages.
 */
export async function loadRuntimeOverrides(): Promise<RuntimeOverrideLoadResult> {
  const redisResult = await loadOverridesFromRedis();
  if (redisResult.loaded) {
    return { loaded: true, source: "redis" };
  }

  const diskResult = loadOverridesFromDiskResult();
  if (diskResult.loaded) {
    if (redisResult.error) {
      console.warn(
        `[bootstrap] Falling back to disk overrides after Redis load failure: ${redisResult.error}`,
      );
    }
    return diskResult;
  }

  const errors = [redisResult.error, diskResult.error].filter(Boolean);
  return {
    loaded: false,
    error:
      errors.length > 0
        ? errors.join("; ")
        : "No config overrides available from Redis or disk",
  };
}

/**
 * P23: Returns team members with empty wrikeContactId.
 */
export function getUnmappedMembers(): import("./config").TeamMember[] {
  return config.team.filter((m) => !m.wrikeContactId);
}
