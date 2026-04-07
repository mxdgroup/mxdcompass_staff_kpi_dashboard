"use client";

import { useEffect, useState } from "react";
import { NavTabs } from "@/components/NavTabs";
import type { YesterdayApiResponse, YesterdayMember, YesterdayTransition } from "@/app/api/yesterday/route";

const ROLE_BADGE: Record<string, { bg: string; text: string }> = {
  developer: { bg: "bg-blue-100", text: "text-blue-700" },
  designer: { bg: "bg-violet-100", text: "text-violet-700" },
  "account-manager": { bg: "bg-green-100", text: "text-green-700" },
  "brand-design": { bg: "bg-pink-100", text: "text-pink-700" },
};

function formatTime(timestamp: string): string {
  const d = new Date(timestamp);
  return d.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });
}

function TransitionRow({ t }: { t: YesterdayTransition }) {
  return (
    <div className="flex items-start gap-3 py-2 border-b border-gray-50 last:border-0">
      <span className="text-xs text-gray-400 mt-0.5 w-12 shrink-0">
        {formatTime(t.timestamp)}
      </span>
      <div className="flex-1 min-w-0">
        <a
          href={t.permalink}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm text-blue-600 hover:text-blue-800 hover:underline truncate block"
        >
          {t.isCompletion && (
            <span className="text-green-600 mr-1" title="Completed">
              &#10003;
            </span>
          )}
          {t.taskTitle}
        </a>
        <div className="text-xs text-gray-500 mt-0.5">
          <span className="inline-block px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">
            {t.fromStage}
          </span>
          <span className="mx-1">&rarr;</span>
          <span
            className={`inline-block px-1.5 py-0.5 rounded ${
              t.isCompletion
                ? "bg-green-100 text-green-700"
                : "bg-gray-100 text-gray-600"
            }`}
          >
            {t.toStage}
          </span>
        </div>
      </div>
    </div>
  );
}

function MemberSection({ member }: { member: YesterdayMember }) {
  const badge = ROLE_BADGE[member.role] ?? {
    bg: "bg-gray-100",
    text: "text-gray-600",
  };

  return (
    <div className="rounded-lg bg-white shadow-sm border border-gray-100">
      <div className="px-4 py-3 flex items-center gap-2 border-b border-gray-50">
        <span className="font-medium text-sm">{member.name}</span>
        <span
          className={`text-xs px-2 py-0.5 rounded-full ${badge.bg} ${badge.text}`}
        >
          {member.role}
        </span>
        <span className="ml-auto text-sm text-gray-500">
          {member.totalMoves > 0 ? (
            <>
              <span className="font-semibold text-gray-700">
                {member.totalMoves}
              </span>{" "}
              {member.totalMoves === 1 ? "move" : "moves"}
              {member.totalCompletions > 0 && (
                <>
                  {", "}
                  <span className="font-semibold text-green-700">
                    {member.totalCompletions}
                  </span>{" "}
                  completed
                </>
              )}
            </>
          ) : (
            <span className="text-gray-400">No activity</span>
          )}
        </span>
      </div>

      {member.transitions.length > 0 ? (
        <div className="px-4 py-2">
          {member.transitions.map((t, i) => (
            <TransitionRow key={`${t.taskId}-${t.timestamp}-${i}`} t={t} />
          ))}
        </div>
      ) : (
        <div className="px-4 py-4 text-sm text-gray-400">
          No task movements recorded yesterday.
        </div>
      )}
    </div>
  );
}

export default function YesterdayPage() {
  const [data, setData] = useState<YesterdayApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    fetchData();
  }, []);

  async function fetchData() {
    setLoading(true);
    setError("");
    const res = await fetch("/kpi/api/yesterday");
    if (res.status === 401) {
      window.location.href = "/kpi/login";
      return;
    }
    if (!res.ok) {
      setError("Failed to load yesterday's data");
      setLoading(false);
      return;
    }
    const json: YesterdayApiResponse = await res.json();
    setData(json);
    setLoading(false);
  }

  if (loading) {
    return (
      <main className="mx-auto max-w-7xl px-4 py-8">
        <NavTabs />
        <div className="animate-pulse space-y-4">
          <div className="h-8 w-64 rounded bg-gray-200" />
          <div className="h-32 rounded-lg bg-gray-200" />
          <div className="h-32 rounded-lg bg-gray-200" />
        </div>
      </main>
    );
  }

  if (!data) {
    return (
      <main className="mx-auto max-w-7xl px-4 py-8 text-center">
        <NavTabs />
        <h1 className="text-2xl font-bold text-gray-900">Yesterday</h1>
        <p className="mt-4 text-gray-500">No activity recorded yesterday.</p>
      </main>
    );
  }

  const hasAnyActivity = data.members.some((m) => m.totalMoves > 0);

  return (
    <main className="mx-auto max-w-7xl px-4 py-6 space-y-6">
      <NavTabs />

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Yesterday</h1>
          <p className="text-sm text-gray-500">{data.dateLabel}</p>
        </div>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {!hasAnyActivity ? (
        <div className="rounded-lg bg-white shadow-sm border border-gray-100 p-8 text-center">
          <p className="text-gray-500">No activity recorded yesterday.</p>
          <p className="text-xs text-gray-400 mt-2">
            Webhook transition data may not yet be available. Activity will
            appear here once tasks are moved between stages in Wrike.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {data.members.map((member) => (
            <MemberSection key={member.contactId} member={member} />
          ))}
        </div>
      )}
    </main>
  );
}
