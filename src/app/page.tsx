"use client";

import { useEffect, useState, useCallback } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import type {
  DashboardApiResponse,
  FlowApiResponse,
  FlowSnapshot,
} from "@/lib/types";
import { config } from "@/lib/config";
import { NavTabs } from "@/components/NavTabs";
import { WeekSelector } from "@/components/WeekSelector";
import { AgencyOverview } from "@/components/AgencyOverview";
import { ClientChips } from "@/components/ClientChips";
import { TicketFlowTable } from "@/components/TicketFlowTable";
import TeamMemberCard from "@/components/TeamMemberCard";
import { AttentionItems } from "@/components/AttentionItems";

const validClientNames = new Set(config.clients.map((c) => c.name));

export default function DashboardPage() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // Read filters from URL
  const clientParam = searchParams.get("client") ?? "";
  const weekParam = searchParams.get("week") ?? "current";

  // Validate client param
  const selectedClient = validClientNames.has(clientParam) ? clientParam : "";

  // Strip invalid client param from URL
  useEffect(() => {
    if (clientParam && !validClientNames.has(clientParam)) {
      const params = new URLSearchParams(searchParams.toString());
      params.delete("client");
      const qs = params.toString();
      router.replace(qs ? `/?${qs}` : "/");
    }
  }, [clientParam, searchParams, router]);

  const [weeklyData, setWeeklyData] = useState<DashboardApiResponse | null>(null);
  const [flowData, setFlowData] = useState<FlowSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [bootstrapping, setBootstrapping] = useState(false);

  // URL update helpers
  const updateParams = useCallback(
    (updates: Record<string, string | null>) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(updates)) {
        if (value === null || value === "") {
          params.delete(key);
        } else {
          params.set(key, value);
        }
      }
      const qs = params.toString();
      router.replace(qs ? `/?${qs}` : "/");
    },
    [searchParams, router],
  );

  function handleWeekChange(w: string) {
    updateParams({ week: w === "current" ? null : w });
  }

  function handleClientSelect(name: string) {
    updateParams({ client: name || null });
  }

  // Fetch data when week changes
  useEffect(() => {
    fetchData(weekParam);
  }, [weekParam]);

  async function fetchData(w: string) {
    setLoading(true);
    setError("");
    const param = w === "current" ? "" : `?week=${w}`;

    const [weeklyRes, flowRes] = await Promise.allSettled([
      fetch(`/kpi/api/dashboard${param}`),
      fetch(`/kpi/api/flow${param}`),
    ]);

    if (weeklyRes.status === "fulfilled" && weeklyRes.value.status === 401) {
      window.location.href = "/kpi/login";
      return;
    }

    let weekly: DashboardApiResponse | null = null;
    if (weeklyRes.status === "fulfilled" && weeklyRes.value.ok) {
      weekly = await weeklyRes.value.json();
      setWeeklyData(weekly);
      // Update URL with resolved week (e.g., "current" → "2026-W14")
      if (weekly?.current && w === "current") {
        updateParams({ week: weekly.current.week });
      }
    }

    let flow: FlowSnapshot | null = null;
    if (flowRes.status === "fulfilled" && flowRes.value.ok) {
      const flowJson: FlowApiResponse = await flowRes.value.json();
      flow = flowJson.data;
      setFlowData(flow);
      if (flow && !weekly?.current && w === "current") {
        updateParams({ week: flow.week });
      }
    }

    setLoading(false);

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
  const resolvedWeek = weekParam === "current"
    ? (snap?.week ?? flowData?.week ?? "current")
    : weekParam;

  // Loading skeleton
  if (loading) {
    return (
      <main className="mx-auto max-w-6xl px-6 py-8">
        <NavTabs />
        <div className="animate-pulse space-y-6 mt-2">
          <div className="h-7 w-52 rounded-md bg-gray-100" />
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <div key={i} className="h-28 rounded-xl bg-gray-100" />
            ))}
          </div>
          <div className="h-36 rounded-xl bg-gray-100" />
        </div>
      </main>
    );
  }

  // Bootstrapping state
  if (!hasAnyData && bootstrapping) {
    return (
      <main className="mx-auto max-w-6xl px-6 py-8 text-center">
        <NavTabs />
        <div className="mt-24">
          <h1 className="text-2xl font-semibold tracking-tight text-gray-900">Setting up your dashboard</h1>
          <p className="mt-3 text-gray-500 max-w-md mx-auto">
            Discovering team members and pulling Wrike data. This takes about 30-60 seconds on first run.
          </p>
          <div className="mt-6 inline-flex items-center gap-2.5 text-sm text-gray-400">
            <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            Bootstrapping...
          </div>
          {error && <p className="mt-4 text-sm text-red-600">{error}</p>}
        </div>
      </main>
    );
  }

  // Empty state
  if (!hasAnyData) {
    return (
      <main className="mx-auto max-w-6xl px-6 py-8 text-center">
        <NavTabs />
        <div className="mt-24">
          <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-brand-50">
            <svg className="h-8 w-8 text-brand-600" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3v11.25A2.25 2.25 0 006 16.5h2.25M3.75 3h-1.5m1.5 0h16.5m0 0h1.5m-1.5 0v11.25A2.25 2.25 0 0118 16.5h-2.25m-7.5 0h7.5m-7.5 0l-1 3m8.5-3l1 3m0 0l.5 1.5m-.5-1.5h-9.5m0 0l-.5 1.5" />
            </svg>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-gray-900">No data yet</h1>
          <p className="mt-2 text-gray-500 max-w-sm mx-auto">
            Bootstrap to auto-discover your team and pull data from Wrike.
          </p>
          {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
          <button
            onClick={triggerBootstrap}
            disabled={bootstrapping}
            className="mt-6 rounded-lg bg-brand-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-brand-700 transition-colors disabled:opacity-50"
          >
            Bootstrap from Wrike
          </button>
        </div>
      </main>
    );
  }

  // --- Filtered data based on selected client ---

  // KPI metrics: use client-specific flow metrics when filtered, agency-wide otherwise
  const displayFlowMetrics = selectedClient
    ? flowData?.clientMetrics[selectedClient] ?? null
    : flowData?.agencyMetrics ?? null;

  // Weekly team summary: not available per-client, pass null when filtered
  const displayTeamSummary = selectedClient ? null : snap?.teamSummary ?? null;

  // Tickets for the selected client
  const filteredTickets = selectedClient
    ? flowData?.tickets.filter((t) => t.clientName === selectedClient) ?? []
    : [];

  // Team members: filter to those with tickets for the selected client
  const flowEmployeeList = flowData ? Object.values(flowData.employeeMetrics) : [];
  const clientAssigneeIds = selectedClient
    ? new Set(filteredTickets.map((t) => t.assigneeContactId).filter(Boolean))
    : null;

  const teamCards = config.team
    .map((member) => {
      const flowEmployee = flowEmployeeList.find((e) => e.name === member.name) ?? null;
      const weeklyEmployee = snap?.employees.find((e) => e.name === member.name) ?? null;
      const hasData = !!flowEmployee || !!weeklyEmployee;
      return {
        name: member.name,
        role: member.role,
        hasContactId: hasData,
        flowData: flowEmployee,
        weeklyData: weeklyEmployee,
        contactId: flowEmployee?.contactId ?? "",
      };
    })
    .filter((card) => {
      if (!clientAssigneeIds) return true; // no filter, show all
      return clientAssigneeIds.has(card.contactId);
    });

  return (
    <main className="mx-auto max-w-6xl px-6 py-6 space-y-10">
      <NavTabs />

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          {selectedClient ? (
            <>
              <div className="flex items-center gap-2 text-sm text-gray-400 mb-1">
                <button
                  onClick={() => handleClientSelect("")}
                  className="hover:text-gray-600 transition-colors"
                >
                  Agency Dashboard
                </button>
                <span>/</span>
              </div>
              <h1 className="text-2xl font-semibold tracking-tight text-gray-900">{selectedClient}</h1>
            </>
          ) : (
            <>
              <h1 className="text-2xl font-semibold tracking-tight text-gray-900">Agency Dashboard</h1>
              <p className="mt-0.5 text-sm text-gray-400">Team performance at a glance</p>
            </>
          )}
        </div>
        <div className="flex items-center gap-3">
          <ClientSelector selected={selectedClient} onChange={handleClientSelect} />
          <WeekSelector currentWeek={resolvedWeek} onWeekChange={handleWeekChange} />
          <button
            onClick={triggerSync}
            disabled={syncing}
            className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 transition-colors disabled:opacity-50"
          >
            {syncing ? "Syncing..." : "Sync Now"}
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg bg-red-50 border border-red-100 px-4 py-3">
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {/* Agency Overview (filtered by client when selected) */}
      <AgencyOverview
        flowMetrics={displayFlowMetrics}
        teamSummary={displayTeamSummary}
      />

      {/* Client section: chips when no client selected, ticket table when filtered */}
      {selectedClient ? (
        <section>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold tracking-tight text-gray-900">
              Tickets
            </h2>
            <span className="text-xs text-gray-400">{filteredTickets.length} tickets</span>
          </div>
          <div className="rounded-xl bg-surface-raised p-5 shadow-[var(--shadow-card)] border border-gray-100/80">
            <TicketFlowTable tickets={filteredTickets} showAssignee />
          </div>
        </section>
      ) : (
        <section>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold tracking-tight text-gray-900">
              Clients
            </h2>
            <span className="text-xs text-gray-400">{config.clients.length} clients</span>
          </div>
          <ClientChips
            clientMetrics={flowData?.clientMetrics}
            onSelect={handleClientSelect}
          />
        </section>
      )}

      {/* Team Members */}
      <section>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold tracking-tight text-gray-900">Team</h2>
          <span className="text-xs text-gray-400">{teamCards.length} members</span>
        </div>
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
          {teamCards.length === 0 && selectedClient && (
            <p className="text-sm text-gray-400 col-span-full">No team members assigned to {selectedClient} tickets this week.</p>
          )}
        </div>
      </section>

      {/* Attention Items — only show when agency-wide (not client-segmented) */}
      {!selectedClient && snap && <AttentionItems employees={snap.employees} />}

      {/* Sync Errors */}
      {snap && snap.memberErrors.length > 0 && (
        <div className="rounded-xl bg-red-50 border border-red-100 p-4">
          <p className="text-sm font-medium text-red-800 mb-2">Sync Errors</p>
          <div className="space-y-1">
            {snap.memberErrors.map((err, i) => (
              <p key={i} className="text-xs text-red-600">
                {err.name}: {err.error}
              </p>
            ))}
          </div>
        </div>
      )}
    </main>
  );
}

// Inline import to avoid a separate import line for this small component
function ClientSelector({ selected, onChange }: { selected: string; onChange: (v: string) => void }) {
  return (
    <select
      value={selected}
      onChange={(e) => onChange(e.target.value)}
      className="rounded-lg border border-gray-200 bg-surface-raised px-3 py-2 text-sm text-gray-700 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20 transition-colors"
    >
      <option value="">All Clients</option>
      {config.clients.map((c) => (
        <option key={c.wrikeFolderId} value={c.name}>
          {c.name}
        </option>
      ))}
    </select>
  );
}
