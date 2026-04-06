"use client";

import { useEffect, useState } from "react";
import { WeeklyActivityFeed } from "@/components/WeeklyActivityFeed";
import { WeekSelector } from "@/components/WeekSelector";

export default function ActivityPage() {
  const [data, setData] = useState<any>(null);
  const [week, setWeek] = useState("current");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    fetchActivity(week);
  }, [week]);

  async function fetchActivity(w: string) {
    setLoading(true);
    setError("");
    try {
      const param = w === "current" ? "" : `?week=${w}`;
      const res = await fetch(`/api/activity${param}`);
      if (res.status === 401) {
        window.location.href = "/login";
        return;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "Unknown error");
        setError(`API error ${res.status}: ${text.slice(0, 200)}`);
      } else {
        const json = await res.json();
        setData(json);
        if (json.week) setWeek(json.week);
      }
    } catch (err) {
      setError(`Fetch failed: ${err instanceof Error ? err.message : "unknown"}`);
    }
    setLoading(false);
  }

  return (
    <main className="mx-auto max-w-4xl px-4 py-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Weekly Activity</h1>
          <p className="text-sm text-gray-500">What everyone shipped this week</p>
        </div>
        <div className="flex items-center gap-4">
          <WeekSelector currentWeek={week} onWeekChange={setWeek} />
          <a href="/" className="text-sm text-blue-600 hover:underline">Dashboard</a>
        </div>
      </div>

      {loading ? (
        <div className="animate-pulse space-y-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-40 rounded-lg bg-gray-200" />
          ))}
        </div>
      ) : error ? (
        <div className="rounded-md bg-red-50 border border-red-200 p-4">
          <p className="text-sm text-red-700">{error}</p>
          <button onClick={() => fetchActivity(week)} className="mt-2 text-sm text-red-600 underline">Retry</button>
        </div>
      ) : data?.members ? (
        <WeeklyActivityFeed members={data.members} />
      ) : (
        <p className="text-gray-400">No activity data available.</p>
      )}
    </main>
  );
}
