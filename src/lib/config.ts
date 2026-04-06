export type Role = "developer" | "designer" | "account-manager";

export interface TeamMember {
  name: string;
  role: Role;
  wrikeContactId: string;
  githubUsername: string | null;
  expectedWeeklyHours: number;
}

export interface DashboardConfig {
  team: TeamMember[];
  wrikeFolderIds: string[];
  githubOrg: string;
  githubRepos: string[];
  approvalWorkflowOwner: string; // Wrike contact ID of person whose approval cycle time is tracked
  returnForReviewStatusName: string; // Name to match in Wrike workflows (e.g., "Return for Review")
  clientReviewStatusName: string; // Name of the Client Review status
  completedStatusNames: string[]; // Names that indicate completion (e.g., ["Completed", "Approved"])
}

// --- CONFIGURE YOUR TEAM HERE ---
// Wrike contact IDs: call GET /contacts with your token to find them
// GitHub usernames: null for non-engineers
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
    // Add more team members as needed
  ],

  // Wrike folder IDs to query for tasks (across all clients)
  // Find via Wrike UI or GET /folders
  wrikeFolderIds: [
    // TODO: populate folder IDs
  ],

  githubOrg: "mxdgroup",
  githubRepos: [
    "mxd-compass",
    // TODO: add other repos to track
  ],

  // Initially Matt — change this contact ID when role changes
  approvalWorkflowOwner: "", // TODO: set to Matt's Wrike contact ID

  returnForReviewStatusName: "Return for Review",
  clientReviewStatusName: "Client Review",
  completedStatusNames: ["Completed", "Approved", "Complete"],
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
