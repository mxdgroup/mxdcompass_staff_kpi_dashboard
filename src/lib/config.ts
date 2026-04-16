export type Role = "developer" | "designer" | "account-manager";

// Completed tasks older than this are dropped at fetch time — they're not
// synced, stored, or shown. Active (non-completed) tasks are NEVER filtered
// by age, no matter how long they've been open.
export const COMPLETED_TASK_CUTOFF_DAYS = 90;

export interface TeamMember {
  name: string;
  role: Role;
  wrikeContactId: string;
  githubUsername: string | null;
  expectedWeeklyHours: number;
}

export interface ClientConfig {
  name: string;
  wrikeFolderId: string;
}

export interface DashboardConfig {
  team: TeamMember[];
  clients: ClientConfig[];
  wrikeFolderIds: string[]; // Derived from clients — populated below
  githubOrg: string;
  githubRepos: string[];
  approvalWorkflowOwner: string;
  returnForReviewStatusName: string;
  clientReviewStatusName: string;
  completedStatusNames: string[];
  // Flow dashboard stage names
  plannedStatusNames: string[];
  inProgressStatusName: string;
  inReviewStatusName: string;
  clientPendingStatusName: string;
  // Effort tracking
  effortCustomFieldId: string;
}

// --- CONFIGURE YOUR TEAM HERE ---
// Wrike contact IDs: call GET /contacts with your token to find them
// GitHub usernames: null for non-engineers
const clients: ClientConfig[] = [
  { name: "Clinic 27", wrikeFolderId: "MQAAAAEAs_35" },
  { name: "Hacker Kitchens", wrikeFolderId: "MQAAAAEAs-ES" },
  { name: "Suzanne Code", wrikeFolderId: "MQAAAAEAs_3-" },
  { name: "MxD (Internal)", wrikeFolderId: "MQAAAAEFAONl" },
];

export const config: DashboardConfig = {
  team: [
    {
      name: "Matthew",
      role: "developer",
      wrikeContactId: "", // TODO: populate from GET /contacts
      githubUsername: "matthewsliedrecht",
      expectedWeeklyHours: 40,
    },
    {
      name: "Ivan",
      role: "developer",
      wrikeContactId: "", // TODO: populate from GET /contacts
      githubUsername: "", // TODO: set GitHub username
      expectedWeeklyHours: 40,
    },
    {
      name: "Andrea",
      role: "account-manager",
      wrikeContactId: "", // TODO: populate from GET /contacts
      githubUsername: null,
      expectedWeeklyHours: 40,
    },
  ],

  clients,
  wrikeFolderIds: clients.map((c) => c.wrikeFolderId),

  githubOrg: "mxdgroup",
  githubRepos: [
    "mxd-compass",
  ],

  approvalWorkflowOwner: "", // TODO: set to Matt's Wrike contact ID

  returnForReviewStatusName: "Return for Review",
  clientReviewStatusName: "Client Review",
  completedStatusNames: ["Completed", "Approved", "Complete"],

  // Flow dashboard — status names matching the Client Work workflow
  // Known IDs: New=IEAGV532JMGNL7LG, Planned=IEAGV532JMGNL7LQ,
  // In Progress=IEAGV532JMGNL7L2, In Review=IEAGV532JMGNL7ME,
  // Client Pending=IEAGV532JMGYGIPO
  plannedStatusNames: ["New", "Planned"],
  inProgressStatusName: "In Progress",
  inReviewStatusName: "In Review",
  clientPendingStatusName: "Client Pending",

  effortCustomFieldId: "", // TODO: populate from GET /customfields
};

// Derived helpers
export function getDevelopers(): TeamMember[] {
  return config.team.filter((m) => m.role === "developer");
}

export function getGithubMembers(): TeamMember[] {
  return config.team.filter((m) => m.githubUsername !== null);
}

export function getMemberByContactId(contactId: string): TeamMember | undefined {
  return config.team.find((m) => m.wrikeContactId === contactId);
}

export function getClientByFolderId(folderId: string): ClientConfig | undefined {
  return config.clients.find((c) => c.wrikeFolderId === folderId);
}

/** P23: Returns team members with empty wrikeContactId. */
export function getUnmappedMembers(): TeamMember[] {
  return config.team.filter((m) => !m.wrikeContactId);
}

// Load persisted config overrides (contact IDs, custom field IDs) from disk
// Only runs server-side (node:fs not available in browser)
if (typeof window === "undefined") {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("node:fs");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require("node:path");
    const overridesPath = path.join(process.cwd(), ".data", "config-overrides.json");
    if (fs.existsSync(overridesPath)) {
      const raw = fs.readFileSync(overridesPath, "utf-8");
      const overrides = JSON.parse(raw);
      if (overrides.contactIds) {
        for (const member of config.team) {
          if (overrides.contactIds[member.name]) {
            member.wrikeContactId = overrides.contactIds[member.name];
          }
        }
      }
      if (overrides.effortCustomFieldId) {
        (config as { effortCustomFieldId: string }).effortCustomFieldId =
          overrides.effortCustomFieldId;
      }
    }
  } catch {
    // Silently ignore — overrides are optional
  }
}
