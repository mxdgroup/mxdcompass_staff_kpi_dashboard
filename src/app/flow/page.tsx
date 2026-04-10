"use client";

import { useEffect, useState, useCallback } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import type { FlowApiResponse, FlowSnapshot } from "@/lib/types";
import { config } from "@/lib/config";
import { NavTabs } from "@/components/NavTabs";
import { WeekSelector } from "@/components/WeekSelector";
import { AgingWipChart } from "@/components/AgingWipChart";
import { CumulativeFlowDiagram } from "@/components/CumulativeFlowDiagram";
import { CycleTimeScatter } from "@/components/CycleTimeScatter";
import { TicketFlowTable } from "@/components/TicketFlowTable";
import { TicketFlowDots } from "@/components/TicketFlowDots";
import { ClientSelector } from "@/components/ClientSelector";

const validClientNames = new Set(config.clients.map((c) => c.name));

export default function FlowDetailsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const clientParam = searchParams.get("client") ?? "";
  const weekParam = searchParams.get("week") ?? "current";
  const viewParam = searchParams.get("view");
  const activeView = viewParam === "flow" ? "flow" : "tickets";
  const selectedClient = validClientNames.has(clientParam) ? clientParam : "";

  // Strip invalid client param
  useEffect(() => {
    if (clientParam && !validClientNames.has(clientParam)) {
      const params = new URLSearchParams(searchParams.toString());
      params.delete("client");
      const qs = params.toString();
      router.replace(qs ? `/flow?${qs}` : "/flow");
    }
  }, [clientParam, searchParams, router]);

  const [data, setData] = useState<FlowSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [syncing, setSyncing] = useState(false);

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
      router.replace(qs ? `/flow?${qs}` : "/flow");
    },
    [searchParams, router],
  );

  function handleWeekChange(w: string) {
    updateParams({ week: w === "current" ? null : w });
  }

  function handleClientChange(name: string) {
    updateParams({ client: name || null });
  }

  useEffect(() => {
    fetchData(weekParam);
  }, [weekParam]);

  async function fetchData(w: string) {
    setLoading(true);
    setError("");
    const param = w === "current" ? "" : `?week=${w}`;
    const res = await fetch(`/kpi/api/flow${param}`);
    if (!res.ok) {
      setError("Failed to load flow data");
      setLoading(false);
      return;
    }
    const json: FlowApiResponse = await res.json();
    setData(json.data);
    if (json.data && w === "current") {
      updateParams({ week: json.data.week });
    }
    setLoading(false);
  }

  async function triggerSync() {
    setSyncing(true);
    const res = await fetch("/kpi/api/sync", { method: "POST" });
    setSyncing(false);
    if (res.ok) fetchData("current");
  }

  const filteredTickets = selectedClient
    ? data?.tickets.filter((t) => t.clientName === selectedClient) ?? []
    : data?.tickets ?? [];

  const displayMetrics = selectedClient
    ? data?.clientMetrics[selectedClient] ?? data?.agencyMetrics
    : data?.agencyMetrics;

  const resolvedWeek = weekParam === "current"
    ? (data?.week ?? "current")
    : weekParam;

  if (loading) {
    return (
      <main className="mx-auto max-w-6xl px-6 py-8">
        <NavTabs />
        <div className="animate-pulse space-y-6 mt-2">
          <div className="h-7 w-52 rounded-md bg-gray-100" />
          <div className="h-64 rounded-xl bg-gray-100" />
          <div className="h-64 rounded-xl bg-gray-100" />
        </div>
      </main>
    );
  }

  if (!data) {
    return (
      <main className="mx-auto max-w-6xl px-6 py-8 text-center">
        <NavTabs />
        <div className="mt-24">
          <h1 className="text-2xl font-semibold tracking-tight text-gray-900">Flow Details</h1>
          <p className="mt-2 text-gray-500">
            No flow data yet. Run a sync from the Overview page.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-6xl px-6 py-6 space-y-8">
      <NavTabs />

      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-gray-900">Flow Details</h1>
            <p className="mt-0.5 text-sm text-gray-400">Pipeline analysis and ticket flow</p>
          </div>
          <ClientSelector
            selected={selectedClient}
            onChange={handleClientChange}
          />
        </div>
        <div className="flex items-center gap-3">
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

      {/* Charts */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <AgingWipChart tickets={filteredTickets} />
        {displayMetrics && (
          <CumulativeFlowDiagram metrics={displayMetrics} />
        )}
      </div>

      <CycleTimeScatter tickets={filteredTickets} />

      {/* View tabs + ticket table */}
      <div className="rounded-xl bg-surface-raised p-5 shadow-[var(--shadow-card)] border border-gray-100/80">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-[13px] font-medium text-gray-400 tracking-wide">
            All Tickets ({filteredTickets.length})
          </h2>
          <div className="flex gap-1">
            {([["tickets", "Tickets"], ["flow", "Ticket Flow"]] as const).map(([key, label]) => (
              <button
                key={key}
                onClick={() => updateParams({ view: key === "tickets" ? null : key })}
                className={`px-2.5 py-1 text-xs rounded-md font-medium ${
                  activeView === key
                    ? "bg-gray-900 text-white"
                    : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        {activeView === "tickets" ? (
          <TicketFlowTable
            tickets={filteredTickets}
            showAssignee
            showClient={!selectedClient}
          />
        ) : (
          <TicketFlowDots
            tickets={filteredTickets}
            showAssignee
            showClient={!selectedClient}
          />
        )}
      </div>
    </main>
  );
}
