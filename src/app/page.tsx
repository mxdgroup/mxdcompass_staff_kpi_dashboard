"use client";

import { useEffect, useState } from "react";
import type {
  DashboardApiResponse,
  FlowApiResponse,
  FlowSnapshot,
} from "@/lib/types";
import { config } from "@/lib/config";
import { NavTabs } from "@/components/NavTabs";
import { WeekSelector } from "@/components/WeekSelector";
import { AgencyOverview } from "@/components/AgencyOverview";
import { ClientBoardCard } from "@/components/ClientBoardCard";
import TeamMemberCard from "@/components/TeamMemberCard";
import { AttentionItems } from "@/components/AttentionItems";

export default function DashboardPage() {
  const [weeklyData, setWeeklyData] = useState<DashboardApiResponse | null>(
    null,
  );
  const [flowData, setFlowData] = useState<FlowSnapshot | null>(null);
  const [week, setWeek] = useState("current");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [bootstrapping, setBootstrapping] = useState(false);

  useEffect(() => {
    fetchData(week);
  }, [week]);

  async function fetchData(w: string) {
    setLoading(true);
    setError("");
    const param = w === "current" ? "" : `?week=${w}`;

    // Fetch both endpoints in parallel — either can fail independently
    const [weeklyRes, flowRes] = await Promise.allSettled([
      fetch(`/kpi/api/dashboard${param}`),
      fetch(`/kpi/api/flow${param}`),
    ]);

    // Handle auth
    if (
      weeklyRes.status === "fulfilled" && weeklyRes.value.status === 401
    ) {
      window.location.href = "/kpi/login";
      return;
    }

    // Parse weekly data
    let weekly: DashboardApiResponse | null = null;
    if (weeklyRes.status === "fulfilled" && weeklyRes.value.ok) {
      weekly = await weeklyRes.value.json();
      setWeeklyData(weekly);
      if (weekly?.current) setWeek(weekly.current.week);
    }

    // Parse flow data
    let flow: FlowSnapshot | null = null;
    if (flowRes.status === "fulfilled" && flowRes.value.ok) {
      const flowJson: FlowApiResponse = await flowRes.value.json();
      flow = flowJson.data;
      setFlowData(flow);
      if (flow && !weekly?.current) setWeek(flow.week);
    }

    setLoading(false);

    // Auto-bootstrap if no data at all
    if (!weekly?.current && !flow) {
      triggerBootstrap();
    }
  }

  async function triggerSync() {
    setSyncing(true);
    const res = await fetch("/kpi/api/sync", { method: "POST" });
    setSyncing(false);
    if (res.ok) fetchData("current");
  }

  async function triggerBootstrap() {
    setBootstrapping(true);
    setError("");
    try {
      const res = await fetch("/kpi/api/bootstrap", { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? "Bootstrap failed");
      } else {
        fetchData("current");
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setBootstrapping(false);
    }
  }

  const snap = weeklyData?.current ?? null;
  const hasAnyData = !!snap || !!flowData;

  // Loading skeleton
  if (loading) {
    return (
      <main className="mx-auto max-w-7xl px-4 py-8">
        <NavTabs />
        <div className="animate-pulse space-y-4">
          <div className="h-8 w-48 rounded bg-gray-200" />
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <div key={i} className="h-24 rounded-lg bg-gray-200" />
            ))}
          </div>
          <div className="h-32 rounded-lg bg-gray-200" />
        </div>
      </main>
    );
  }

  // Bootstrapping state
  if (!hasAnyData && bootstrapping) {
    return (
      <main className="mx-auto max-w-7xl px-4 py-8 text-center">
        <NavTabs />
        <h1 className="text-2xl font-bold text-gray-900">Agency Dashboard</h1>
        <p className="mt-4 text-gray-500">
          Bootstrapping... discovering team members and pulling Wrike data.
        </p>
        <div className="mt-4 inline-flex items-center gap-2 text-sm text-gray-400">
          <svg
            className="animate-spin h-4 w-4"
            viewBox="0 0 24 24"
            fill="none"
          >
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
            />
          </svg>
          This takes ~30-60 seconds on first run
        </div>
        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      </main>
    );
  }

  // Empty state — no data and not bootstrapping
  if (!hasAnyData) {
    return (
      <main className="mx-auto max-w-7xl px-4 py-8 text-center">
        <NavTabs />
        <h1 className="text-2xl font-bold text-gray-900">Agency Dashboard</h1>
        <p className="mt-4 text-gray-500">
          No data yet. Bootstrap to auto-discover your team and pull Wrike data.
        </p>
        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
        <div className="mt-4 flex gap-3 justify-center">
          <button
            onClick={triggerBootstrap}
            disabled={bootstrapping}
            className="rounded-md bg-green-600 px-6 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
          >
            Bootstrap from Wrike
          </button>
        </div>
      </main>
    );
  }

  // Build client cards data
  const clientCards = config.clients.map((client) => ({
    name: client.name,
    metrics: flowData?.clientMetrics[client.name] ?? null,
    tickets: flowData?.tickets.filter((t) => t.clientName === client.name) ?? [],
  }));

  // Build team member cards data
  // Note: config.team contactIds are empty on the client (overrides only load server-side).
  // Instead, match by name from the server-returned data which already used the overrides.
  const flowEmployeeList = flowData ? Object.values(flowData.employeeMetrics) : [];
  const teamCards = config.team.map((member) => {
    const flowEmployee =
      flowEmployeeList.find((e) => e.name === member.name) ?? null;
    const weeklyEmployee =
      snap?.employees.find((e) => e.name === member.name) ?? null;
    // If we got any data back for this person, bootstrap has run
    const hasData = !!flowEmployee || !!weeklyEmployee;
    return {
      name: member.name,
      role: member.role,
      hasContactId: hasData,
      flowData: flowEmployee,
      weeklyData: weeklyEmployee,
    };
  });

  return (
    <main className="mx-auto max-w-7xl px-4 py-6 space-y-8">
      <NavTabs />

      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-gray-900">Agency Dashboard</h1>
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

      {error && <p className="text-sm text-red-600">{error}</p>}

      {/* Agency Overview */}
      <AgencyOverview
        flowMetrics={flowData?.agencyMetrics ?? null}
        teamSummary={snap?.teamSummary ?? null}
      />

      {/* Client Boards */}
      <section>
        <h2 className="text-lg font-semibold text-gray-800 mb-3">
          Client Boards
        </h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {clientCards.map((card) => (
            <ClientBoardCard
              key={card.name}
              clientName={card.name}
              metrics={card.metrics}
              tickets={card.tickets}
            />
          ))}
        </div>
      </section>

      {/* Team Members */}
      <section>
        <h2 className="text-lg font-semibold text-gray-800 mb-3">Team</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {teamCards.map((card) => (
            <TeamMemberCard
              key={card.name}
              name={card.name}
              role={card.role}
              hasContactId={card.hasContactId}
              flowData={card.flowData}
              weeklyData={card.weeklyData}
            />
          ))}
        </div>
      </section>

      {/* Attention Items */}
      {snap && <AttentionItems employees={snap.employees} />}

      {/* Sync Errors */}
      {snap && snap.memberErrors.length > 0 && (
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
