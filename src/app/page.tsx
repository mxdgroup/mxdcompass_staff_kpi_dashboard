"use client";

import { useEffect, useState } from "react";
import type { DashboardApiResponse, WeeklySnapshot } from "@/lib/types";
import { KPICard } from "@/components/KPICard";
import { PipelineFlowChart } from "@/components/PipelineFlowChart";
import { AttentionItems } from "@/components/AttentionItems";
import { TrendChart } from "@/components/TrendChart";
import { WeekSelector } from "@/components/WeekSelector";
import { RoleGroupSection } from "@/components/RoleGroupSection";

export default function DashboardPage() {
  const [data, setData] = useState<DashboardApiResponse | null>(null);
  const [week, setWeek] = useState("current");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    fetchData(week);
  }, [week]);

  async function fetchData(w: string) {
    setLoading(true);
    setError("");
    const param = w === "current" ? "" : `?week=${w}`;
    const res = await fetch(`/api/dashboard${param}`);
    if (res.status === 401) {
      window.location.href = "/login";
      return;
    }
    if (!res.ok) {
      setError("Failed to load dashboard data");
      setLoading(false);
      return;
    }
    const json: DashboardApiResponse = await res.json();
    setData(json);
    if (json.current) setWeek(json.current.week);
    setLoading(false);
  }

  async function triggerSync() {
    setSyncing(true);
    const res = await fetch("/api/sync", { method: "POST" });
    setSyncing(false);
    if (res.ok) {
      fetchData("current");
    }
  }

  // Stale data check
  const isStale =
    data?.lastSynced &&
    Date.now() - new Date(data.lastSynced).getTime() > 24 * 60 * 60 * 1000;

  const snap = data?.current;

  // Loading skeleton
  if (loading) {
    return (
      <main className="mx-auto max-w-7xl px-4 py-8">
        <div className="animate-pulse space-y-4">
          <div className="h-8 w-48 rounded bg-gray-200" />
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="h-28 rounded-lg bg-gray-200" />
            ))}
          </div>
          <div className="h-48 rounded-lg bg-gray-200" />
        </div>
      </main>
    );
  }

  // Empty state — no sync ever run
  if (!snap) {
    return (
      <main className="mx-auto max-w-7xl px-4 py-8 text-center">
        <h1 className="text-2xl font-bold text-gray-900">KPI Dashboard</h1>
        <p className="mt-4 text-gray-500">No data yet. Run the first sync to get started.</p>
        <button
          onClick={triggerSync}
          disabled={syncing}
          className="mt-4 rounded-md bg-blue-600 px-6 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {syncing ? "Syncing..." : "Run First Sync"}
        </button>
      </main>
    );
  }

  const developers = snap.employees.filter((e) => e.role === "developer");
  const designers = snap.employees.filter((e) => e.role === "designer");
  const accountManagers = snap.employees.filter((e) => e.role === "account-manager");

  return (
    <main className="mx-auto max-w-7xl px-4 py-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-gray-900">Team Velocity</h1>
        <div className="flex items-center gap-4">
          <WeekSelector currentWeek={week} onWeekChange={setWeek} />
          <button
            onClick={triggerSync}
            disabled={syncing}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {syncing ? "Syncing..." : "Sync Now"}
          </button>
        </div>
      </div>

      {/* Stale data warning */}
      {isStale && (
        <div className="rounded-md bg-amber-50 border border-amber-200 p-3 flex items-center justify-between">
          <p className="text-sm text-amber-800">
            Data last synced {data.lastSynced ? new Date(data.lastSynced).toLocaleDateString() : "unknown"}.
          </p>
          <button onClick={triggerSync} className="text-sm font-medium text-amber-700 underline">
            Sync Now
          </button>
        </div>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}

      {/* KPI Cards */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KPICard
          label="Tasks Completed"
          value={snap.teamSummary.tasksCompleted}
          delta={snap.teamSummary.tasksCompletedDelta}
          avg4w={snap.teamSummary.tasksCompletedAvg4w}
        />
        <KPICard
          label="Pipeline Movement"
          value={snap.teamSummary.pipelineMovement}
          delta={snap.teamSummary.pipelineMovementDelta}
          subtitle="Tasks that changed status"
        />
        <KPICard
          label="Return for Review"
          value={snap.teamSummary.returnForReviewCount}
          delta={snap.teamSummary.returnForReviewDelta}
          invertDelta
          avg4w={snap.teamSummary.returnForReviewAvg4w}
        />
        <KPICard
          label="Approval Cycle Time"
          value={
            snap.approvalCycleTime.medianHours !== null
              ? `${snap.approvalCycleTime.medianHours.toFixed(1)}h`
              : "N/A"
          }
          delta={null}
          subtitle={snap.approvalCycleTime.ownerName}
        />
      </div>

      {/* Pipeline Flow */}
      <PipelineFlowChart stages={snap.pipelineFlow} />

      {/* Attention Items */}
      <AttentionItems employees={snap.employees} />

      {/* Role Groups */}
      <div className="space-y-3">
        {developers.length > 0 && (
          <RoleGroupSection role="developer" label="Developers" employees={developers} />
        )}
        {designers.length > 0 && (
          <RoleGroupSection role="designer" label="Designers" employees={designers} />
        )}
        {accountManagers.length > 0 && (
          <RoleGroupSection role="account-manager" label="Account Managers" employees={accountManagers} />
        )}
      </div>

      {/* Trend Chart */}
      <TrendChart current={snap} history={data.history} />

      {/* Member errors */}
      {snap.memberErrors.length > 0 && (
        <div className="rounded-md bg-red-50 border border-red-200 p-3">
          <p className="text-sm font-medium text-red-800 mb-1">Sync Errors</p>
          {snap.memberErrors.map((err, i) => (
            <p key={i} className="text-xs text-red-600">
              {err.name}: {err.error}
            </p>
          ))}
        </div>
      )}
    </main>
  );
}
