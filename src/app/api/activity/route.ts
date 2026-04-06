import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { getWrikeClient } from "@/lib/wrike/client";
import type { WrikeTask } from "@/lib/wrike/types";
import { config } from "@/lib/config";
import { getWeekRange, getWeekDays, getCurrentWeek, getLastCompletedWeek, getISOWeek } from "@/lib/week";

const STATUS_MAP: Record<string, string> = {
  IEAGV532JMGNL7LG: "New",
  IEAGV532JMGNL7L2: "In progress",
  IEAGV532JMGNL7ME: "In review",
  IEAGV532JMGNL7LQ: "Planned",
  IEAGV532JMGNL7LH: "Completed",
  IEAGV532JMAAAAAA: "New",
  IEAGV532JMGNL7K4: "In Progress",
  IEAGV532JMAAAAAB: "Completed",
  IEAGV532JMAAAAAC: "On Hold",
  IEAGV532JMAAAAAD: "Cancelled",
};

interface ActivityEvent {
  time: string;
  type: "wrike" | "github";
  action: string; // "completed" | "moved_to_review" | "created" | "updated" | "commit"
  title: string;
  status?: string;
  link?: string;
}

interface DayActivity {
  date: string;
  dayName: string;
  events: ActivityEvent[];
  wrikeCount: number;
  githubCount: number;
}

interface PersonActivity {
  name: string;
  role: string;
  week: string;
  days: DayActivity[];
  pipeline: {
    planned: { count: number; tasks: Array<{ title: string; link?: string }> };
    inProgress: { count: number; tasks: Array<{ title: string; link?: string }> };
    inReview: { count: number; tasks: Array<{ title: string; link?: string }> };
    approved: { count: number; tasks: Array<{ title: string; link?: string }> };
  };
  totals: {
    completed: number;
    movedToReview: number;
    created: number;
    commits: number;
    totalEvents: number;
  };
}

export const maxDuration = 120;

export async function GET(request: Request) {
  const authed = await isAuthenticated();
  if (!authed) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  // Default to last week on Monday mornings (the review meeting use case)
  const weekParam = searchParams.get("week") || getLastCompletedWeek();
  const contactId = searchParams.get("contactId");

  const range = getWeekRange(weekParam);
  const days = getWeekDays(weekParam);
  const dayNames = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

  const client = getWrikeClient();
  const members = contactId
    ? config.team.filter((m) => m.wrikeContactId === contactId)
    : config.team;

  const results: PersonActivity[] = [];

  for (const member of members) {
    if (!member.wrikeContactId) continue;

    // Fetch Wrike tasks
    let tasks: WrikeTask[] = [];
    try {
      tasks = await client.get<WrikeTask>("/tasks", {
        responsibles: JSON.stringify([member.wrikeContactId]),
        updatedDate: JSON.stringify({
          start: `${range.start}T00:00:00Z`,
          end: `${range.end}T23:59:59Z`,
        }),
        fields: JSON.stringify(["responsibleIds"]),
      });
    } catch {
      // Skip on error
    }

    // Build day-by-day events from Wrike
    const dayMap = new Map<string, ActivityEvent[]>();
    for (const day of days) {
      dayMap.set(day, []);
    }

    let totalCompleted = 0;
    let totalReview = 0;
    let totalCreated = 0;

    for (const task of tasks) {
      const updated = task.updatedDate || "";
      const day = updated.slice(0, 10);
      const statusId = task.customStatusId || "";
      const statusName = STATUS_MAP[statusId] || "Active";
      const completed = task.completedDate;

      let action = "updated";
      if (completed) {
        action = "completed";
        totalCompleted++;
      } else if (statusName === "In review") {
        action = "moved_to_review";
        totalReview++;
      } else if (statusName === "New" || statusName === "Planned") {
        // Check if created this week
        const created = task.createdDate || "";
        const createdDay = created.slice(0, 10);
        if (createdDay >= range.start && createdDay <= range.end) {
          action = "created";
          totalCreated++;
        }
      }

      const events = dayMap.get(day) || [];
      events.push({
        time: updated,
        type: "wrike",
        action,
        title: task.title,
        status: statusName,
        link: task.permalink,
      });
      dayMap.set(day, events);
    }

    // Fetch GitHub commits if developer
    let totalCommits = 0;
    if (member.githubUsername) {
      for (const repo of config.githubRepos) {
        for (const day of days) {
          try {
            const commits = await fetchDayCommits(
              member.githubUsername,
              config.githubOrg,
              repo,
              day
            );
            totalCommits += commits.length;
            const events = dayMap.get(day) || [];
            for (const c of commits) {
              events.push({
                time: c.date,
                type: "github",
                action: "commit",
                title: c.message,
                link: c.url,
              });
            }
            dayMap.set(day, events);
          } catch {
            // Skip
          }
        }
      }
    }

    // Build pipeline summary — where are this person's tasks right now?
    const pipeline = {
      planned: { count: 0, tasks: [] as Array<{ title: string; link?: string }> },
      inProgress: { count: 0, tasks: [] as Array<{ title: string; link?: string }> },
      inReview: { count: 0, tasks: [] as Array<{ title: string; link?: string }> },
      approved: { count: 0, tasks: [] as Array<{ title: string; link?: string }> },
    };

    for (const task of tasks) {
      const statusId = task.customStatusId || "";
      const statusName = STATUS_MAP[statusId] || "Active";
      const entry = { title: task.title, link: task.permalink };

      if (statusName === "Planned" || statusName === "New") {
        pipeline.planned.count++;
        pipeline.planned.tasks.push(entry);
      } else if (statusName === "In progress" || statusName === "In Progress") {
        pipeline.inProgress.count++;
        pipeline.inProgress.tasks.push(entry);
      } else if (statusName === "In review") {
        pipeline.inReview.count++;
        pipeline.inReview.tasks.push(entry);
      } else if (statusName === "Completed") {
        pipeline.approved.count++;
        pipeline.approved.tasks.push(entry);
      }
    }

    // Build the response
    const activityDays: DayActivity[] = days.map((day, i) => {
      const events = (dayMap.get(day) || []).sort(
        (a, b) => new Date(a.time).getTime() - new Date(b.time).getTime()
      );
      return {
        date: day,
        dayName: dayNames[i],
        events,
        wrikeCount: events.filter((e) => e.type === "wrike").length,
        githubCount: events.filter((e) => e.type === "github").length,
      };
    });

    results.push({
      name: member.name,
      role: member.role,
      week: weekParam,
      days: activityDays,
      pipeline,
      totals: {
        completed: totalCompleted,
        movedToReview: totalReview,
        created: totalCreated,
        commits: totalCommits,
        totalEvents: activityDays.reduce(
          (sum, d) => sum + d.events.length,
          0
        ),
      },
    });
  }

  return NextResponse.json({ week: weekParam, members: results });
}

async function fetchDayCommits(
  username: string,
  org: string,
  repo: string,
  day: string
): Promise<Array<{ message: string; date: string; url: string }>> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return [];

  const res = await fetch(
    `https://api.github.com/repos/${org}/${repo}/commits?author=${username}&since=${day}T00:00:00Z&until=${day}T23:59:59Z&per_page=100`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
      },
    }
  );

  if (!res.ok) return [];
  const data = await res.json();
  return data.map((c: any) => ({
    message: (c.commit?.message || "").split("\n")[0].slice(0, 80),
    date: c.commit?.author?.date || day,
    url: c.html_url || "",
  }));
}
