"use client";

import { useEffect, useState } from "react";
import type { SearchTermSummary } from "@/lib/ppc-types";
import { PPCNav } from "@/components/ppc/PPCNav";

const API = "/internal/kpis/api/ppc";

const MOVE_COLORS: Record<string, string> = {
  negative: "bg-red-50 text-red-700",
  "keep+broaden": "bg-emerald-50 text-emerald-700",
  monitor: "bg-gray-50 text-gray-600",
};

export default function SearchTermsPage() {
  const [terms, setTerms] = useState<SearchTermSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [moveFilter, setMoveFilter] = useState("");

  useEffect(() => {
    fetchTerms();
  }, [moveFilter]);

  async function fetchTerms() {
    setLoading(true);
    const params = new URLSearchParams({ limit: "100" });
    if (moveFilter) params.set("move", moveFilter);
    try {
      const res = await fetch(`${API}/search-terms?${params}`);
      if (res.ok) setTerms(await res.json());
      else setError(`Failed to load (${res.status})`);
    } catch (e) {
      setError(`${e}`);
    } finally {
      setLoading(false);
    }
  }

  async function setDecision(termId: number, decision: string) {
    const res = await fetch(`${API}/search-terms/${termId}/decision`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision }),
    });
    if (res.ok) {
      setTerms((prev) =>
        prev.map((t) =>
          t.id === termId ? { ...t, analyst_decision: decision } : t
        )
      );
    }
  }

  async function exportCSV() {
    const res = await fetch(`${API}/search-terms/export`);
    if (res.ok) {
      const data = await res.json();
      if (data.csv) {
        const blob = new Blob([data.csv], { type: "text/csv" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `negatives-${new Date().toISOString().slice(0, 10)}.csv`;
        a.click();
        URL.revokeObjectURL(url);
      }
    }
  }

  if (loading) {
    return (
      <main className="mx-auto max-w-6xl px-6 py-6">
        <PPCNav />
        <div className="animate-pulse space-y-3">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="h-12 bg-gray-100 rounded-lg" />
          ))}
        </div>
      </main>
    );
  }

  const pending = terms.filter(
    (t) => t.move === "negative" && !t.analyst_decision
  ).length;

  return (
    <main className="mx-auto max-w-6xl px-6 py-6 space-y-6">
      <PPCNav />

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Search Terms</h1>
          <p className="text-sm text-gray-500 mt-1">
            {terms.length} terms · {pending} pending review
          </p>
        </div>
        <div className="flex gap-2">
          <select
            value={moveFilter}
            onChange={(e) => setMoveFilter(e.target.value)}
            className="rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
          >
            <option value="">All moves</option>
            <option value="negative">Negative</option>
            <option value="keep+broaden">Keep + Broaden</option>
            <option value="monitor">Monitor</option>
          </select>
          <button
            onClick={exportCSV}
            className="rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
          >
            Export CSV
          </button>
        </div>
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
              <th className="text-left px-4 py-2.5 font-medium">Search Term</th>
              <th className="text-left px-4 py-2.5 font-medium">Move</th>
              <th className="text-left px-4 py-2.5 font-medium">Intent</th>
              <th className="text-right px-4 py-2.5 font-medium">Cost</th>
              <th className="text-right px-4 py-2.5 font-medium">Clicks</th>
              <th className="text-right px-4 py-2.5 font-medium">Conv</th>
              <th className="text-right px-4 py-2.5 font-medium">CPA</th>
              <th className="text-left px-4 py-2.5 font-medium">Decision</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {terms.map((t) => (
              <tr key={t.id} className="hover:bg-gray-50">
                <td className="px-4 py-2.5 max-w-xs truncate font-medium">
                  {t.search_term}
                </td>
                <td className="px-4 py-2.5">
                  {t.move && (
                    <span
                      className={`text-xs font-medium px-2 py-0.5 rounded-md ${
                        MOVE_COLORS[t.move] ?? "bg-gray-50 text-gray-600"
                      }`}
                    >
                      {t.move}
                    </span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-xs text-gray-500">
                  {t.intent_class ?? "—"}
                </td>
                <td className="px-4 py-2.5 text-right font-mono">
                  £{parseFloat(t.cost).toFixed(2)}
                </td>
                <td className="px-4 py-2.5 text-right">{t.clicks}</td>
                <td className="px-4 py-2.5 text-right">
                  {parseFloat(t.conversions).toFixed(0)}
                </td>
                <td className="px-4 py-2.5 text-right font-mono">
                  {t.cpa ? `£${parseFloat(t.cpa).toFixed(2)}` : "—"}
                </td>
                <td className="px-4 py-2.5">
                  {t.analyst_decision ? (
                    <span
                      className={`text-xs font-medium px-2 py-0.5 rounded-md ${
                        t.analyst_decision === "approved"
                          ? "bg-emerald-50 text-emerald-700"
                          : t.analyst_decision === "rejected"
                            ? "bg-red-50 text-red-700"
                            : "bg-gray-50 text-gray-600"
                      }`}
                    >
                      {t.analyst_decision}
                    </span>
                  ) : t.move === "negative" ? (
                    <div className="flex gap-1">
                      <button
                        onClick={() => setDecision(t.id, "approved")}
                        className="text-xs px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
                      >
                        ✓
                      </button>
                      <button
                        onClick={() => setDecision(t.id, "rejected")}
                        className="text-xs px-2 py-0.5 rounded bg-red-50 text-red-700 hover:bg-red-100"
                      >
                        ✗
                      </button>
                      <button
                        onClick={() => setDecision(t.id, "deferred")}
                        className="text-xs px-2 py-0.5 rounded bg-gray-50 text-gray-600 hover:bg-gray-100"
                      >
                        …
                      </button>
                    </div>
                  ) : (
                    <span className="text-gray-400">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
