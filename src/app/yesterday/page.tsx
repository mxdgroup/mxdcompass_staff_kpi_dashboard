"use client";

import { useEffect, useState } from "react";
import { NavTabs } from "@/components/NavTabs";
import type { Role } from "@/lib/config";
import type {
  YesterdayApiResponse,
  YesterdayMember,
  YesterdayTransition,
} from "@/app/api/yesterday/route";

const ROLE_BADGE: Record<Role, { bg: string; text: string; label: string }> = {
  developer: { bg: "bg-brand-50", text: "text-brand-700", label: "Dev" },
  designer: { bg: "bg-violet-50", text: "text-violet-700", label: "Design" },
  "account-manager": {
    bg: "bg-emerald-50",
    text: "text-emerald-700",
    label: "AM",
  },
};

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  });
}

function formatDateHeading(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00Z");
  return d.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

function TransitionRow({ t }: { t: YesterdayTransition }) {
  return (
    <div className="flex items-center gap-3 py-2 border-b border-gray-50 last:border-0">
      <span className="text-xs text-gray-400 tabular-nums w-12 shrink-0">
        {formatTime(t.timestamp)}
      </span>
      <a
        href={t.permalink}
        target="_blank"
        rel="noopener noreferrer"
        className="text-sm text-gray-800 hover:underline font-medium truncate max-w-[220px]"
        title={t.taskTitle}
      >
        {t.taskTitle}
      </a>
      <div className="flex items-center gap-1.5 text-xs shrink-0">
        <span className="px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">
          {t.fromStage}
        </span>
        <span className="text-gray-300">→</span>
        <span
          className={`px-1.5 py-0.5 rounded ${
            t.isCompletion
              ? "bg-green-100 text-green-700"
              : "bg-gray-100 text-gray-600"
          }`}
        >
          {t.toStage}
        </span>
      </div>
      {t.isCompletion && (
        <span className="text-green-600 text-xs" title="Completed">
          ✓
        </span>
      )}
    </div>
  );
}

function MemberCard({ member }: { member: YesterdayMember }) {
  const badge = ROLE_BADGE[member.role];
  const hasActivity = member.transitions.length > 0;

  return (
    <div className="rounded-xl bg-surface-raised p-5 shadow-[var(--shadow-card)] border border-gray-100/80">
      <div className="flex items-center gap-3 mb-3">
        <h3 className="text-sm font-semibold text-gray-900">{member.name}</h3>
        <span
          className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${badge.bg} ${badge.text}`}
        >
          {badge.label}
        </span>
        <div className="ml-auto flex items-center gap-3 text-xs text-gray-400">
          <span>{member.totalMoves} moves</span>
          {member.totalCompletions > 0 && (
            <span className="text-green-600">
              {member.totalCompletions} completed
            </span>
          )}
        </div>
      </div>
      {hasActivity ? (
        <div className="space-y-0">
          {member.transitions.map((t, i) => (
            <TransitionRow key={`${t.taskId}-${t.timestamp}-${i}`} t={t} />
          ))}
        </div>
      ) : (
        <p className="text-sm text-gray-300 py-2">
          No task movements recorded yesterday
        </p>
      )}
    </div>
  );
}

export default function YesterdayPage() {
  const [data, setData] = useState<YesterdayApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    async function fetchData() {
      setLoading(true);
      setError("");
      const res = await fetch("/internal/kpis/api/yesterday");
      if (!res.ok) {
        setError("Failed to load yesterday's activity");
        setLoading(false);
        return;
      }
      const json: YesterdayApiResponse = await res.json();
      setData(json);
      setLoading(false);
    }
    fetchData();
  }, []);

  if (loading) {
    return (
      <main className="mx-auto max-w-6xl px-6 py-6 space-y-8">
        <NavTabs />
        <div className="animate-pulse space-y-6">
          <div className="h-7 w-64 rounded-md bg-gray-100" />
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="h-40 rounded-xl bg-gray-100"
              />
            ))}
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-6xl px-6 py-6 space-y-8">
      <NavTabs />

      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-gray-900">
          Yesterday
        </h1>
        <p className="mt-0.5 text-sm text-gray-400">
          {data ? formatDateHeading(data.date) : "Daily activity feed"}
        </p>
      </div>

      {error && (
        <div className="rounded-lg bg-red-50 border border-red-100 px-4 py-3">
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {data && data.members.length === 0 && (
        <div className="text-center py-16">
          <p className="text-gray-400">No team members configured</p>
        </div>
      )}

      {data && data.members.length > 0 && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {data.members.map((member) => (
            <MemberCard key={member.contactId} member={member} />
          ))}
        </div>
      )}
    </main>
  );
}
