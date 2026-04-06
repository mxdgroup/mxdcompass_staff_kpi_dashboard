export interface GitHubCommit {
  sha: string;
  message: string;
  date: string;
  repo: string;
}

export interface DailyCommits {
  date: string; // YYYY-MM-DD
  commits: GitHubCommit[];
}

export interface GitHubPR {
  number: number;
  title: string;
  repo: string;
  createdAt: string;
  mergedAt: string;
  cycleTimeHours: number;
}

export interface GitHubWeekData {
  dailyCommits: DailyCommits[]; // length 7, Mon(0) - Sun(6)
  totalCommits: number;
  prs: GitHubPR[];
  prsMergedCount: number;
  medianCycleTimeHours: number | null;
}
