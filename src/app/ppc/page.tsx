"use client";

import { useEffect, useState } from "react";
import type {
  DashboardSummary,
  AdDiagnosisSummary,
  BidBudgetSummary,
  CronJob,
} from "@/lib/ppc-types";
import { PPCNav } from "@/components/ppc/PPCNav";

const API = "/internal/kpis/api/ppc";

const STATE_COLORS: Record<string, { bg: string; text: string }> = {
  Scale: { bg: "bg-emerald-50", text: "text-emerald-700" },
  Protect: { bg: "bg-blue-50", text: "text-blue-700" },
  Repair: { bg: "bg-amber-50", text: "text-amber-700" },
  Deprioritise: { bg: "bg-red-50", text: "text-red-700" },
  Monitor: { bg: "bg-gray-50", text: "text-gray-600" },
};

const FLAG_COLORS: Record<string, { bg: string; text: string; label: string }> = {
  clean: { bg: "bg-emerald-50", text: "text-emerald-700", label: "Clean" },
  "proceed-with-caveats": { bg: "bg-amber-50", text: "text-amber-700", label: "Caveats" },
  "measurement-affected": { bg: "bg-red-50", text: "text-red-700", label: "Affected" },
};

export default function PPCDashboard() {
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [ads, setAds] = useState<AdDiagnosisSummary[]>([]);
  const [decisions, setDecisions] = useState<BidBudgetSummary[]>([]);
  const [cronJobs, setCronJobs] = useState<CronJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    fetchAll();
  }, []);

  async function fetchAll() {
    setLoading(true);
    setError("");
    try {
      const [sumRes, adsRes, decRes, cronRes] = await Promise.allSettled([
        fetch(`${API}/summary`),
        fetch(`${API}/ads?limit=10`),
        fetch(`${API}/decisions`),
        fetch(`${API}/cron/status`),
      ]);

      if (sumRes.status === "fulfilled" && sumRes.value.ok)
        setSummary(await sumRes.value.json());
      if (adsRes.status === "fulfilled" && adsRes.value.ok)
        setAds(await adsRes.value.json());
      if (decRes.status === "fulfilled" && decRes.value.ok)
        setDecisions(await decRes.value.json());
      if (cronRes.status === "fulfilled" && cronRes.value.ok) {
        const data = await cronRes.value.json();
        setCronJobs(data.jobs ?? []);
      }
    } catch (e) {
      setError(`Failed to load: ${e}`);
    } finally {
      setLoading(false);
    }
  }

  async function triggerCron(mode: string) {
    setSyncing(true);
    try {
      const res = await fetch(`${API}/cron/${mode}`, { method: "POST" });
      if (res.ok) {
        const data = await res.json();
        setCronJobs((prev) => [data, ...prev].slice(0, 5));
      }
    } finally {
      setSyncing(false);
    }
  }

  if (loading) {
    return (
      <main className="mx-auto max-w-6xl px-6 py-6">
        <PPCNav />
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-200 rounded w-64" />
          <div className="grid grid-cols-3 gap-4">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-32 bg-gray-100 rounded-xl" />
            ))}
          </div>
        </div>
      </main>
    );
  }

  const flag = summary ? FLAG_COLORS[summary.measurement_flag] ?? FLAG_COLORS.clean : FLAG_COLORS.clean;

  return (
    <main className="mx-auto max-w-6xl px-6 py-6 space-y-8">
      <PPCNav />

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">PPC Analyser</h1>
          <p className="text-sm text-gray-500 mt-1">
            {summary?.total_campaigns ?? 0} campaigns across{" "}
            {summary?.accounts.length ?? 0} accounts
            {summary?.data_freshness && (
              <> · Data from {summary.data_freshness}</>
            )}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => triggerCron("weekly")}
            disabled={syncing}
            className="rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors disabled:opacity-50"
          >
            {syncing ? "Running..." : "Sync Weekly"}
          </button>
          <button
            onClick={() => triggerCron("monthly")}
            disabled={syncing}
            className="rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 transition-colors disabled:opacity-50"
          >
            {syncing ? "Running..." : "Run Monthly"}
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Integrity Banner */}
      {summary && summary.measurement_flag !== "clean" && (
        <div className={`rounded-lg ${flag.bg} border p-4`}>
          <div className={`font-medium ${flag.text}`}>
            Measurement {flag.label}
          </div>
          <ul className="mt-1 text-sm text-gray-600 space-y-0.5">
            {summary.measurement_reasons.map((r, i) => (
              <li key={i}>· {r}</li>
            ))}
          </ul>
        </div>
      )}

      {/* KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {/* States */}
        {Object.entries(summary?.campaigns_by_state ?? {}).map(([state, count]) => {
          const c = STATE_COLORS[state] ?? STATE_COLORS.Monitor;
          return (
            <div
              key={state}
              className="rounded-xl bg-surface-raised p-5 shadow-[var(--shadow-card)] border border-gray-100/80"
            >
              <div className="text-sm text-gray-500">{state}</div>
              <div className="text-3xl font-semibold mt-1">{count}</div>
              <span
                className={`inline-block mt-2 text-xs font-medium px-2 py-0.5 rounded-md ${c.bg} ${c.text}`}
              >
                {state}
              </span>
            </div>
          );
        })}

        {/* Measurement */}
        <div className="rounded-xl bg-surface-raised p-5 shadow-[var(--shadow-card)] border border-gray-100/80">
          <div className="text-sm text-gray-500">Measurement</div>
          <span
            className={`inline-block mt-2 text-sm font-medium px-2 py-0.5 rounded-md ${flag.bg} ${flag.text}`}
          >
            {flag.label}
          </span>
        </div>

        {/* Pending */}
        <div className="rounded-xl bg-surface-raised p-5 shadow-[var(--shadow-card)] border border-gray-100/80">
          <div className="text-sm text-gray-500">Pending Decisions</div>
          <div className="text-3xl font-semibold mt-1">
            {summary?.pending_decisions ?? 0}
          </div>
        </div>
      </div>

      {/* Ad Diagnoses */}
      {ads.length > 0 && (
        <section>
          <h2 className="text-lg font-semibold text-gray-900 mb-3">
            Ad Diagnoses
          </h2>
          <div className="rounded-xl bg-surface-raised shadow-[var(--shadow-card)] border border-gray-100/80 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-500">
                <tr>
                  <th className="text-left px-4 py-2 font-medium">Ad ID</th>
                  <th className="text-left px-4 py-2 font-medium">Diagnosis</th>
                  <th className="text-right px-4 py-2 font-medium">Impressions</th>
                  <th className="text-right px-4 py-2 font-medium">CTR</th>
                  <th className="text-left px-4 py-2 font-medium">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {ads.map((ad) => (
                  <tr key={ad.id} className="hover:bg-gray-50">
                    <td className="px-4 py-2.5 font-mono text-xs">
                      {ad.ad_id}
                    </td>
                    <td className="px-4 py-2.5">
                      <DiagnosisBadge diagnosis={ad.diagnosis} />
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      {ad.impressions.toLocaleString()}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      {ad.ctr ? `${(parseFloat(ad.ctr) * 100).toFixed(1)}%` : "—"}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-gray-500 max-w-xs truncate">
                      {ad.recommended_action ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Bid/Budget Decisions */}
      {decisions.length > 0 && (
        <section>
          <h2 className="text-lg font-semibold text-gray-900 mb-3">
            Bid/Budget Proposals
          </h2>
          <div className="rounded-xl bg-surface-raised shadow-[var(--shadow-card)] border border-gray-100/80 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-500">
                <tr>
                  <th className="text-left px-4 py-2 font-medium">Campaign</th>
                  <th className="text-left px-4 py-2 font-medium">Strategy</th>
                  <th className="text-right px-4 py-2 font-medium">Change %</th>
                  <th className="text-left px-4 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {decisions.map((d) => (
                  <tr key={d.id} className="hover:bg-gray-50">
                    <td className="px-4 py-2.5 font-mono text-xs">
                      {d.campaign_id}
                    </td>
                    <td className="px-4 py-2.5">
                      {d.current_strategy} → {d.recommended_strategy}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      {d.change_pct
                        ? `${(parseFloat(d.change_pct) * 100).toFixed(0)}%`
                        : "—"}
                    </td>
                    <td className="px-4 py-2.5">
                      {d.analyst_decision ?? "Pending"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Cron Jobs */}
      {cronJobs.length > 0 && (
        <section>
          <h2 className="text-lg font-semibold text-gray-900 mb-3">
            Recent Sync Jobs
          </h2>
          <div className="space-y-2">
            {cronJobs.map((job) => (
              <div
                key={job.job_id}
                className="flex items-center gap-3 rounded-lg bg-surface-raised p-3 border border-gray-100/80 text-sm"
              >
                <span
                  className={`w-2 h-2 rounded-full ${
                    job.status === "complete"
                      ? "bg-emerald-400"
                      : job.status === "running"
                        ? "bg-amber-400 animate-pulse"
                        : job.status === "failed"
                          ? "bg-red-400"
                          : "bg-gray-300"
                  }`}
                />
                <span className="font-medium">{job.mode}</span>
                <span className="text-gray-400">{job.job_id}</span>
                <span className="text-gray-500">
                  {job.completed_steps.join(", ") || "queued"}
                </span>
                <span className="ml-auto text-gray-400 text-xs">
                  {job.started_at?.slice(0, 19)}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}

function DiagnosisBadge({ diagnosis }: { diagnosis: string | null }) {
  if (!diagnosis) return <span className="text-gray-400">—</span>;
  const colors: Record<string, string> = {
    weak_hook: "bg-amber-50 text-amber-700",
    mismatch: "bg-purple-50 text-purple-700",
    fatigue: "bg-red-50 text-red-700",
    over_pinned: "bg-orange-50 text-orange-700",
    auction_pressure: "bg-blue-50 text-blue-700",
    healthy: "bg-emerald-50 text-emerald-700",
  };
  return (
    <span
      className={`text-xs font-medium px-2 py-0.5 rounded-md ${
        colors[diagnosis] ?? "bg-gray-50 text-gray-600"
      }`}
    >
      {diagnosis.replace("_", " ")}
    </span>
  );
}
