"use client";

interface KPICardProps {
  label: string;
  value: string | number;
  delta: number | null; // percentage change vs last week
  invertDelta?: boolean; // true = up is bad (e.g., Return for Review)
  subtitle?: string;
  avg4w?: number | null;
}

export function KPICard({ label, value, delta, invertDelta = false, subtitle, avg4w }: KPICardProps) {
  const deltaColor =
    delta === null
      ? "text-gray-400"
      : invertDelta
        ? delta > 5
          ? "text-red-600"
          : delta < -5
            ? "text-green-600"
            : "text-amber-500"
        : delta > 5
          ? "text-green-600"
          : delta < -5
            ? "text-red-600"
            : "text-amber-500";

  const deltaArrow = delta === null ? "" : delta > 0 ? "\u25B2" : delta < 0 ? "\u25BC" : "\u25CF";

  return (
    <div className="rounded-lg bg-white p-4 shadow-sm border border-gray-100">
      <p className="text-sm font-medium text-gray-500">{label}</p>
      <p className="mt-1 text-3xl font-bold text-gray-900">{value}</p>
      <div className="mt-1 flex items-center gap-2">
        {delta !== null && (
          <span className={`text-sm font-medium ${deltaColor}`}>
            {deltaArrow} {Math.abs(delta)}%
          </span>
        )}
        {delta === null && <span className="text-sm text-gray-400">No prior data</span>}
      </div>
      {subtitle && <p className="mt-1 text-xs text-gray-400">{subtitle}</p>}
      {avg4w !== null && avg4w !== undefined && (
        <p className="mt-1 text-xs text-gray-400">4-week avg: {avg4w}</p>
      )}
    </div>
  );
}
