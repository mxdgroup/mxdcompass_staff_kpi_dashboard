"use client";

import type { EmployeeWeekData } from "@/lib/types";

interface AttentionItemsProps {
  employees: EmployeeWeekData[];
}

interface AttentionItem {
  type: "returned" | "stuck" | "idle";
  message: string;
  link?: string;
}

export function AttentionItems({ employees }: AttentionItemsProps) {
  const items: AttentionItem[] = [];

  for (const emp of employees) {
    // Tasks returned for review
    const returned = emp.tasks.filter((t) => t.returnedForReview);
    for (const task of returned) {
      items.push({
        type: "returned",
        message: `${task.title} returned for review (${emp.name})`,
        link: task.permalink,
      });
    }

    // Tasks stuck >5 days with no comments
    const now = Date.now();
    const fiveDays = 5 * 24 * 60 * 60 * 1000;
    const stuck = emp.tasks.filter((t) => {
      if (t.completedDate) return false;
      const lastUpdate = new Date(t.updatedDate).getTime();
      return now - lastUpdate > fiveDays && !t.hasComments;
    });
    for (const task of stuck) {
      items.push({
        type: "stuck",
        message: `${task.title} stuck >5 days, no comments (${emp.name})`,
        link: task.permalink,
      });
    }

    // Members with zero completed tasks
    if (emp.tasksCompleted === 0 && emp.tasks.length > 0) {
      items.push({
        type: "idle",
        message: `${emp.name} has 0 completed tasks this week (${emp.tasks.length} in progress)`,
      });
    }
  }

  if (items.length === 0) {
    return (
      <div className="rounded-lg bg-green-50 border border-green-200 p-4">
        <p className="text-sm text-green-700">No attention items this week</p>
      </div>
    );
  }

  const icons = { returned: "\u26A0\uFE0F", stuck: "\u23F3", idle: "\u{1F6D1}" };
  const colors = {
    returned: "bg-red-50 border-red-200",
    stuck: "bg-amber-50 border-amber-200",
    idle: "bg-orange-50 border-orange-200",
  };

  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium text-gray-500">Attention Items</h3>
      {items.map((item, i) => (
        <div key={i} className={`rounded-lg border p-3 ${colors[item.type]}`}>
          <p className="text-sm">
            {icons[item.type]}{" "}
            {item.link ? (
              <a href={item.link} target="_blank" rel="noopener noreferrer" className="underline hover:no-underline">
                {item.message}
              </a>
            ) : (
              item.message
            )}
          </p>
        </div>
      ))}
    </div>
  );
}
