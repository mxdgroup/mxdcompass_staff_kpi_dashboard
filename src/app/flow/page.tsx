"use client";

import { useEffect, useState } from "react";
import type { FlowApiResponse, FlowSnapshot } from "@/lib/types";
import { NavTabs } from "@/components/NavTabs";
import { WeekSelector } from "@/components/WeekSelector";
import { AgingWipChart } from "@/components/AgingWipChart";
import { CumulativeFlowDiagram } from "@/components/CumulativeFlowDiagram";
import { CycleTimeScatter } from "@/components/CycleTimeScatter";
import { TicketFlowTable } from "@/components/TicketFlowTable";
import { ClientSelector } from "@/components/ClientSelector";

export default function FlowDetailsPage() {
  const [data, setData] = useState<FlowSnapshot | null>(null);
  const [week, setWeek] = useState("current");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [selectedClient, setSelectedClient] = useState("");

  useEffect(() => {
    fetchData(week);
  }, [week]);

  async function fetchData(w: string) {
    setLoading(true);
    setError("");
    const param = w === "current" ? "" : `?week=${w}`;
    const res = await fetch(`/kpi/api/flow${param}`);
    if (res.status === 401) {
      window.location.href = "/kpi/login";
      return;
    }
    if (!res.ok) {
      setError("Failed to load flow data");
      setLoading(false);
      return;
    }
    const json: FlowApiResponse = await res.json();
    setData(json.data);
    if (json.data) setWeek(json.data.week);
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

  if (loading) {
    return (
      <main className="mx-auto max-w-7xl px-4 py-8">
        <NavTabs />
        <div className="animate-pulse space-y-4">
          <div className="h-8 w-48 rounded bg-gray-200" />
          <div className="h-64 rounded-lg bg-gray-200" />
          <div className="h-64 rounded-lg bg-gray-200" />
        </div>
      </main>
    );
  }

  if (!data) {
    return (
      <main className="mx-auto max-w-7xl px-4 py-8 text-center">
        <NavTabs />
        <h1 className="text-2xl font-bold text-gray-900">Flow Details</h1>
        <p className="mt-4 text-gray-500">
          No flow data yet. Run a sync from the Overview page.
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-7xl px-4 py-6 space-y-6">
      <NavTabs />

      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <h1 className="text-xl font-bold text-gray-900">Flow Details</h1>
          <ClientSelector
            selected={selectedClient}
            onChange={setSelectedClient}
          />
        </div>
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

      {/* Charts */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <AgingWipChart tickets={filteredTickets} />
        {displayMetrics && (
          <CumulativeFlowDiagram metrics={displayMetrics} />
        )}
      </div>

      <CycleTimeScatter tickets={filteredTickets} />

      {/* Full ticket table */}
      <div className="rounded-lg bg-white p-4 shadow-sm border border-gray-100">
        <h2 className="text-sm font-medium text-gray-500 mb-3">
          All Tickets ({filteredTickets.length})
        </h2>
        <TicketFlowTable
          tickets={filteredTickets}
          showAssignee
          showClient={!selectedClient}
        />
      </div>
    </main>
  );
}
