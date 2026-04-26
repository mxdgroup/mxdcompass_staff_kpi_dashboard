"use client";

import { useEffect, useState } from "react";
import type { CampaignSummary } from "@/lib/ppc-types";
import { PPCNav } from "@/components/ppc/PPCNav";

const API = "/internal/kpis/api/ppc";
const ROLES = ["Brand", "Non-brand Commercial"];

const STATE_COLORS: Record<string, string> = {
  Scale: "bg-emerald-50 text-emerald-700",
  Protect: "bg-blue-50 text-blue-700",
  Repair: "bg-amber-50 text-amber-700",
  Deprioritise: "bg-red-50 text-red-700",
  Monitor: "bg-gray-50 text-gray-600",
};

export default function CampaignsPage() {
  const [campaigns, setCampaigns] = useState<CampaignSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    fetchCampaigns();
  }, []);

  async function fetchCampaigns() {
    setLoading(true);
    try {
      const res = await fetch(`${API}/campaigns`);
      if (res.ok) setCampaigns(await res.json());
      else setError(`Failed to load campaigns (${res.status})`);
    } catch (e) {
      setError(`${e}`);
    } finally {
      setLoading(false);
    }
  }

  async function setRole(campaignId: string, role: string) {
    const res = await fetch(`${API}/campaigns/${campaignId}/role`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role }),
    });
    if (res.ok) {
      setCampaigns((prev) =>
        prev.map((c) =>
          c.campaign_id === campaignId ? { ...c, role } : c
        )
      );
    }
  }

  if (loading) {
    return (
      <main className="mx-auto max-w-6xl px-6 py-6">
        <PPCNav />
        <div className="animate-pulse space-y-3">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="h-14 bg-gray-100 rounded-lg" />
          ))}
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-6xl px-6 py-6 space-y-6">
      <PPCNav />

      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-gray-900">Campaigns</h1>
        <span className="text-sm text-gray-500">
          {campaigns.length} campaigns
        </span>
      </div>

      {error && (
        <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="rounded-xl bg-surface-raised shadow-[var(--shadow-card)] border border-gray-100/80 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-500 sticky top-0">
            <tr>
              <th className="text-left px-4 py-2.5 font-medium">Campaign</th>
              <th className="text-left px-4 py-2.5 font-medium">Role</th>
              <th className="text-left px-4 py-2.5 font-medium">State</th>
              <th className="text-right px-4 py-2.5 font-medium">Spend (28d)</th>
              <th className="text-right px-4 py-2.5 font-medium">Conv</th>
              <th className="text-right px-4 py-2.5 font-medium">CPA</th>
              <th className="text-right px-4 py-2.5 font-medium">Target CPA</th>
              <th className="text-left px-4 py-2.5 font-medium">Constraint</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {campaigns.map((c) => {
              const state = c.state_override || c.state || "Unknown";
              const stateClass = STATE_COLORS[state] ?? STATE_COLORS.Monitor;
              return (
                <tr key={c.campaign_id} className="hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <div className="font-medium text-gray-900 truncate max-w-xs">
                      {c.campaign_name}
                    </div>
                    <div className="text-xs text-gray-400">{c.campaign_id}</div>
                  </td>
                  <td className="px-4 py-3">
                    <select
                      value={c.role ?? ""}
                      onChange={(e) => {
                        if (e.target.value) setRole(c.campaign_id, e.target.value);
                      }}
                      className="rounded-md border border-gray-200 px-2 py-1 text-xs focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500/20"
                    >
                      <option value="">Unassigned</option>
                      {ROLES.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`text-xs font-medium px-2 py-0.5 rounded-md ${stateClass}`}
                    >
                      {state}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right font-mono">
                    £{parseFloat(c.spend_28d).toLocaleString("en-GB", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                  </td>
                  <td className="px-4 py-3 text-right font-mono">
                    {parseFloat(c.conversions_28d).toFixed(0)}
                  </td>
                  <td className="px-4 py-3 text-right font-mono">
                    {c.cpa_28d ? `£${parseFloat(c.cpa_28d).toFixed(2)}` : "—"}
                  </td>
                  <td className="px-4 py-3 text-right font-mono">
                    {c.target_cpa
                      ? `£${parseFloat(c.target_cpa).toFixed(2)}`
                      : "—"}
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-500">
                    {c.demand_constraint ?? "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </main>
  );
}
