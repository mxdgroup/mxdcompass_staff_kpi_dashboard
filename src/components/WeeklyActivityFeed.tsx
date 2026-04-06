"use client";

interface ActivityEvent {
  time: string;
  type: "wrike" | "github";
  action: string;
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

interface PipelineStage {
  count: number;
  tasks: Array<{ title: string; link?: string }>;
}

interface PersonActivity {
  name: string;
  role: string;
  week: string;
  days: DayActivity[];
  pipeline: {
    planned: PipelineStage;
    inProgress: PipelineStage;
    inReview: PipelineStage;
    approved: PipelineStage;
  };
  totals: {
    completed: number;
    movedToReview: number;
    created: number;
    commits: number;
    totalEvents: number;
  };
}

const ACTION_ICONS: Record<string, string> = {
  completed: "\u2705",
  moved_to_review: "\uD83D\uDD0D",
  created: "\uD83D\uDD35",
  updated: "\uD83D\uDD39",
  commit: "\uD83D\uDCBB",
};

const ACTION_LABELS: Record<string, string> = {
  completed: "Approved",
  moved_to_review: "Shipped to review",
  created: "Assigned",
  updated: "Worked on",
  commit: "Committed",
};

function ActivityBar({ days }: { days: DayActivity[] }) {
  const maxEvents = Math.max(...days.map((d) => d.events.length), 1);

  return (
    <div className="flex gap-1 items-end h-8">
      {days.map((day, i) => {
        const count = day.events.length;
        const height = count === 0 ? 2 : Math.max(8, (count / maxEvents) * 32);
        const intensity =
          count === 0
            ? "bg-gray-100"
            : count <= 2
              ? "bg-blue-200"
              : count <= 5
                ? "bg-blue-400"
                : count <= 10
                  ? "bg-blue-500"
                  : "bg-blue-700";

        return (
          <div key={i} className="flex-1 flex flex-col items-center gap-0.5">
            <div
              className={`w-full rounded-sm ${intensity}`}
              style={{ height: `${height}px` }}
              title={`${day.dayName}: ${count} events`}
            />
            <span className="text-[9px] text-gray-400">{day.dayName}</span>
          </div>
        );
      })}
    </div>
  );
}

function EventLine({ event }: { event: ActivityEvent }) {
  const icon = ACTION_ICONS[event.action] || "\u2022";
  const label = ACTION_LABELS[event.action] || event.action;
  const isGithub = event.type === "github";

  return (
    <div className="flex items-start gap-2 py-0.5">
      <span className="shrink-0 text-xs">{icon}</span>
      <div className="min-w-0 flex-1">
        {event.link ? (
          <a
            href={event.link}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-gray-800 hover:underline"
          >
            {event.title}
          </a>
        ) : (
          <span className="text-sm text-gray-800">{event.title}</span>
        )}
        {event.status && !["completed", "commit"].includes(event.action) && (
          <span className="ml-1.5 text-[10px] text-gray-400">[{event.status}]</span>
        )}
      </div>
      {isGithub && (
        <span className="shrink-0 rounded bg-gray-100 px-1 text-[9px] font-mono text-gray-500">
          git
        </span>
      )}
    </div>
  );
}

export function WeeklyActivityFeed({ members }: { members: PersonActivity[] }) {
  if (!members || members.length === 0) {
    return <p className="text-sm text-gray-400">No activity data. Run a sync first.</p>;
  }

  return (
    <div className="space-y-6">
      {members.map((person) => (
        <div key={person.name} className="rounded-lg bg-white border border-gray-100 shadow-sm overflow-hidden">
          {/* Header */}
          <div className="px-4 pt-4 pb-2">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="font-semibold text-gray-900">{person.name}</h3>
                <p className="text-xs text-gray-400 capitalize">{person.role.replace("-", " ")}</p>
              </div>
              <div className="flex gap-3 text-xs">
                <span className="font-medium text-green-700">
                  {person.totals.movedToReview} shipped to review
                </span>
                {person.totals.completed > 0 && (
                  <span className="text-gray-400">{person.totals.completed} approved</span>
                )}
                {person.totals.commits > 0 && (
                  <span className="text-gray-500">{person.totals.commits} commits</span>
                )}
              </div>
            </div>

            {/* Pipeline: Planned → In Progress → In Review → Approved */}
            <div className="mt-3 flex items-center gap-1">
              {[
                { label: "Planned", data: person.pipeline.planned, color: "bg-gray-200 text-gray-700" },
                { label: "In Progress", data: person.pipeline.inProgress, color: "bg-blue-100 text-blue-700" },
                { label: "In Review", data: person.pipeline.inReview, color: "bg-amber-100 text-amber-700" },
                { label: "Approved", data: person.pipeline.approved, color: "bg-green-100 text-green-700" },
              ].map((stage, i) => (
                <div key={i} className="flex items-center">
                  {i > 0 && <span className="mx-1 text-gray-300">{"\u2192"}</span>}
                  <div
                    className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${stage.color}`}
                    title={stage.data.tasks.map((t) => t.title).join("\n")}
                  >
                    {stage.label}: {stage.data.count}
                  </div>
                </div>
              ))}
            </div>

            {/* Activity intensity bar */}
            <div className="mt-3">
              <ActivityBar days={person.days} />
            </div>
          </div>

          {/* Day-by-day feed — all visible, no clicking */}
          <div className="px-4 pb-4 divide-y divide-gray-50">
            {person.days.map((day) => {
              if (day.events.length === 0) return null;

              // Group consecutive same-action events
              const events = day.events;
              const createdEvents = events.filter((e) => e.action === "created");
              const otherEvents = events.filter((e) => e.action !== "created");

              return (
                <div key={day.date} className="py-2">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs font-medium text-gray-500">
                      {day.dayName} {day.date.slice(5)}
                    </span>
                    <span className="text-[10px] text-gray-300">
                      {day.events.length} event{day.events.length !== 1 ? "s" : ""}
                    </span>
                  </div>

                  {/* Show completions and review moves individually */}
                  {otherEvents.map((event, j) => (
                    <EventLine key={j} event={event} />
                  ))}

                  {/* Collapse bulk task creation into one line */}
                  {createdEvents.length > 3 ? (
                    <div className="flex items-start gap-2 py-0.5">
                      <span className="shrink-0 text-xs">{ACTION_ICONS.created}</span>
                      <span className="text-sm text-gray-600">
                        Created {createdEvents.length} tasks
                        <span className="text-[10px] text-gray-400 ml-1">
                          ({createdEvents.slice(0, 2).map((e) => e.title.slice(0, 30)).join(", ")}...)
                        </span>
                      </span>
                    </div>
                  ) : (
                    createdEvents.map((event, j) => (
                      <EventLine key={`c-${j}`} event={event} />
                    ))
                  )}
                </div>
              );
            })}

            {person.totals.totalEvents === 0 && (
              <p className="py-3 text-sm text-gray-400">No activity this week</p>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
