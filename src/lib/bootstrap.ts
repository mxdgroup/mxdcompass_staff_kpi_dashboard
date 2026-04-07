// Auto-discover Wrike contact IDs and custom field IDs from the API
// Stores results in Redis (production) or .data/ (local dev)

import * as fs from "node:fs";
import * as path from "node:path";
import { getWrikeClient } from "./wrike/client";
import type { WrikeContact } from "./wrike/types";
import { config } from "./config";

const DATA_DIR = path.join(process.cwd(), ".data");
const OVERRIDES_FILE = path.join(DATA_DIR, "config-overrides.json");
const REDIS_OVERRIDES_KEY = "kpi:config-overrides";

export interface ConfigOverrides {
  contactIds: Record<string, string>; // team member name -> wrikeContactId
  effortCustomFieldId: string;
  discoveredAt: string;
}

export async function discoverWrikeConfig(): Promise<ConfigOverrides> {
  const client = getWrikeClient();

  // 1. Discover contacts
  console.log("[bootstrap] Fetching Wrike contacts...");
  const contacts = await client.get<WrikeContact>("/contacts");
  console.log(`[bootstrap] Found ${contacts.length} contacts`);

  const contactIds: Record<string, string> = {};
  for (const member of config.team) {
    const match = contacts.find(
      (c) =>
        c.firstName.toLowerCase() === member.name.toLowerCase() ||
        `${c.firstName} ${c.lastName}`.toLowerCase() ===
          member.name.toLowerCase(),
    );
    if (match) {
      contactIds[member.name] = match.id;
      console.log(`[bootstrap] Matched ${member.name} → ${match.id} (${match.firstName} ${match.lastName})`);
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

  // 3. Write overrides (Redis if available, filesystem for local dev)
  const overrides: ConfigOverrides = {
    contactIds,
    effortCustomFieldId,
    discoveredAt: new Date().toISOString(),
  };

  try {
    const { Redis } = await import("@upstash/redis");
    if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
      const redis = Redis.fromEnv();
      await redis.set(REDIS_OVERRIDES_KEY, JSON.stringify(overrides));
      console.log(`[bootstrap] Config overrides written to Redis (${REDIS_OVERRIDES_KEY})`);
    } else {
      throw new Error("No Redis");
    }
  } catch {
    // Fallback to filesystem (local dev only)
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      fs.writeFileSync(OVERRIDES_FILE, JSON.stringify(overrides, null, 2), "utf-8");
      console.log(`[bootstrap] Config overrides written to ${OVERRIDES_FILE}`);
    } catch (fsErr) {
      console.warn(`[bootstrap] Could not write to filesystem: ${fsErr}`);
    }
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
 * Load overrides from Redis or disk.
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

/**
 * Load overrides from Redis (async version for serverless).
 * Call this at the start of API routes on Vercel.
 */
export async function loadOverridesFromRedis(): Promise<void> {
  try {
    if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) return;
    const { Redis } = await import("@upstash/redis");
    const redis = Redis.fromEnv();
    const raw = await redis.get<string>(REDIS_OVERRIDES_KEY);
    if (raw) {
      const overrides: ConfigOverrides = typeof raw === "string" ? JSON.parse(raw) : raw as unknown as ConfigOverrides;
      applyOverrides(overrides);
    }
  } catch {
    // Silently ignore
  }
}
