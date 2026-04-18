import type {
  GitHubCommit,
  GitHubPR,
  GitHubWeekData,
  DailyCommits,
} from "./types";
import { get, searchIssues } from "./client";

// ---- GitHub REST response shapes (partial) ----

interface CommitResponse {
  sha: string;
  commit: {
    message: string;
    author: {
      date: string;
    };
  };
}

interface SearchItem {
  number: number;
  title: string;
  created_at: string;
  repository_url: string;
  pull_request?: {
    merged_at: string | null;
  };
}

// ---- Helpers ----

/** Return the median of a numeric array, or null if empty. */
export function median(numbers: number[]): number | null {
  if (numbers.length === 0) return null;
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

/**
 * Generate an array of 7 date strings (YYYY-MM-DD) starting from weekStart (Monday).
 */
function weekDays(weekStart: string): string[] {
  const days: string[] = [];
  const start = new Date(weekStart + "T00:00:00Z");
  for (let i = 0; i < 7; i++) {
    const d = new Date(start.getTime() + i * 86_400_000);
    days.push(d.toISOString().slice(0, 10));
  }
  return days;
}

/**
 * Extract the repo name from a GitHub repository_url.
 * e.g. "https://api.github.com/repos/mxdgroup/mxd-compass" -> "mxd-compass"
 */
function repoNameFromUrl(url: string): string {
  const parts = url.split("/");
  return parts[parts.length - 1];
}

// ---- Main fetcher ----

/**
 * Fetch all GitHub KPI data for a single user across the given repos and org
 * for one week (weekStart to weekEnd inclusive, both YYYY-MM-DD).
 */
export async function fetchWeeklyGitHubData(
  username: string,
  repos: string[],
  org: string,
  weekStart: string,
  weekEnd: string,
): Promise<GitHubWeekData> {
  const days = weekDays(weekStart);

  // --- (a) Daily commits ---
  // Build a flat list of fetch promises: one per (day, repo) pair.
  const commitPromises: Promise<{ dayIndex: number; commits: GitHubCommit[] }>[] =
    [];

  for (let dayIndex = 0; dayIndex < 7; dayIndex++) {
    const dayDate = days[dayIndex];
    for (const repo of repos) {
      commitPromises.push(
        get<CommitResponse[]>(`/repos/${org}/${repo}/commits`, {
          author: username,
          since: `${dayDate}T00:00:00Z`,
          until: `${dayDate}T23:59:59Z`,
        })
          .then((data) => ({
            dayIndex,
            commits: data.map((c) => ({
              sha: c.sha,
              message: c.commit.message.slice(0, 100),
              date: c.commit.author.date,
              repo,
            })),
          }))
          .catch(() => ({
            dayIndex,
            commits: [] as GitHubCommit[],
          })),
      );
    }
  }

  const commitResults = await Promise.all(commitPromises);

  // Assemble the dailyCommits array (7 entries, Mon=0 to Sun=6).
  const dailyCommits: DailyCommits[] = days.map((date) => ({
    date,
    commits: [],
  }));

  for (const result of commitResults) {
    dailyCommits[result.dayIndex].commits.push(...result.commits);
  }

  const totalCommits = dailyCommits.reduce(
    (sum, d) => sum + d.commits.length,
    0,
  );

  // --- (b) PRs merged ---
  let prs: GitHubPR[] = [];

  if (repos.length > 0) {
    try {
      const prMap = new Map<string, GitHubPR>();
      for (const repo of repos) {
        const searchResult = await searchIssues(
          `type:pr+author:${username}+repo:${org}/${repo}+merged:${weekStart}..${weekEnd}`,
        ).catch(() => ({ items: [] as Record<string, unknown>[] }));

        for (const si of searchResult.items as unknown as SearchItem[]) {
          if (!si.pull_request?.merged_at) continue;
          const createdAt = new Date(si.created_at).getTime();
          const mergedAt = new Date(si.pull_request.merged_at).getTime();
          const pr: GitHubPR = {
            number: si.number,
            title: si.title,
            repo: repoNameFromUrl(si.repository_url),
            createdAt: si.created_at,
            mergedAt: si.pull_request.merged_at,
            cycleTimeHours: Math.round(((mergedAt - createdAt) / (1000 * 60 * 60)) * 100) / 100,
          };
          prMap.set(`${pr.repo}#${pr.number}`, pr);
        }
      }
      prs = Array.from(prMap.values());
    } catch {
      // Search failed — return empty PR data rather than crashing.
      prs = [];
    }
  }

  // --- (c) Compute median cycle time ---
  const cycleTimes = prs.map((pr) => pr.cycleTimeHours);
  const medianCycleTimeHours = median(cycleTimes);

  return {
    dailyCommits,
    totalCommits,
    prs,
    prsMergedCount: prs.length,
    medianCycleTimeHours,
  };
}
