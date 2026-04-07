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

const TYPE_STYLES: Record<AttentionItem["type"], { bg: string; dot: string; label: string }> = {
  returned: { bg: "bg-red-50 border-red-100", dot: "bg-red-500", label: "Returned" },
  stuck: { bg: "bg-amber-50 border-amber-100", dot: "bg-amber-400", label: "Stuck" },
  idle: { bg: "bg-orange-50 border-orange-100", dot: "bg-orange-400", label: "Idle" },
};

export function AttentionItems({ employees }: AttentionItemsProps) {
  const items: AttentionItem[] = [];

  for (const emp of employees) {
    const returned = emp.tasks.filter((t) => t.returnedForReview);
    for (const task of returned) {
      items.push({
        type: "returned",
        message: `${task.title} returned for review (${emp.name})`,
        link: task.permalink,
      });
    }

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

    if (emp.tasksCompleted === 0 && emp.tasks.length > 0) {
      items.push({
        type: "idle",
        message: `${emp.name} has 0 completed tasks this week (${emp.tasks.length} in progress)`,
      });
    }
  }

  if (items.length === 0) {
    return (
      <div className="rounded-xl bg-green-50 border border-green-100 px-5 py-4 flex items-center gap-3">
        <span className="h-2 w-2 rounded-full bg-green-500 shrink-0" />
        <p className="text-sm text-green-700">No attention items this week</p>
      </div>
    );
  }

  return (
    <section>
      <h2 className="text-lg font-semibold tracking-tight text-gray-900 mb-4">
        Attention Items
        <span className="ml-2 text-sm font-normal text-gray-400">({items.length})</span>
      </h2>
      <div className="space-y-2">
        {items.map((item, i) => {
          const style = TYPE_STYLES[item.type];
          return (
            <div key={i} className={`rounded-xl border px-4 py-3 flex items-start gap-3 ${style.bg}`}>
              <span className={`mt-1.5 h-2 w-2 rounded-full shrink-0 ${style.dot}`} />
              <div className="min-w-0">
                <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">{style.label}</span>
                <p className="text-sm text-gray-700 mt-0.5">
                  {item.link ? (
                    <a href={item.link} target="_blank" rel="noopener noreferrer" className="hover:underline">
                      {item.message}
                    </a>
                  ) : (
                    item.message
                  )}
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
