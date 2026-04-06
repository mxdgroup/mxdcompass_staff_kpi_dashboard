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
  approvalWorkflowOwner: string;
  returnForReviewStatusName: string;
  clientReviewStatusName: string;
  completedStatusNames: string[];
}

export const config: DashboardConfig = {
  team: [
    {
      name: "Matthew",
      role: "developer",
      wrikeContactId: "KUAWRNQD",
      githubUsername: "matthewsliedrecht",
      expectedWeeklyHours: 40,
    },
    {
      name: "Ivan",
      role: "developer",
      wrikeContactId: "KUAXD6OG",
      githubUsername: null, // TODO: set GitHub username when known
      expectedWeeklyHours: 40,
    },
    {
      name: "Andrea",
      role: "account-manager",
      wrikeContactId: "KUAXD23C",
      githubUsername: null,
      expectedWeeklyHours: 40,
    },
    {
      name: "Christian",
      role: "developer",
      wrikeContactId: "KUAW7PGR",
      githubUsername: null, // TODO: set GitHub username when known
      expectedWeeklyHours: 40,
    },
  ],

  // Active client folders in Wrike
  wrikeFolderIds: [
    "MQAAAAEAs-EQ",  // Client Work
    "MQAAAAEAs_35",  // Clinic 27
    "MQAAAAEAs_3-",  // Suzanne Code
    "MQAAAAEERizq",  // LifeCycle Offers
    "MQAAAAEAs-ES",  // Hacker Kitchens
  ],

  githubOrg: "mxdgroup",
  githubRepos: [
    "mxd-compass",
    "mxdcompass_staff_kpi_dashboard",
  ],

  // Matthew handles client approvals
  approvalWorkflowOwner: "KUAWRNQD",

  // Wrike workflow status names to match
  // Current workflow: New → In Progress → Completed (simple)
  // Adjust these if you add custom statuses like "Return for Review" or "Client Review"
  returnForReviewStatusName: "Return for Review",
  clientReviewStatusName: "Client Review",
  completedStatusNames: ["Completed"],
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
