"use client";

interface ArchivedToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
}

export function ArchivedToggle({ checked, onChange }: ArchivedToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      title="Completed 45+ days ago — migrated tasks without a completion date are always shown."
      className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium shadow-[var(--shadow-card)] hover:shadow-[var(--shadow-card-hover)] transition-all ${
        checked
          ? "border-brand-500 bg-brand-50 text-brand-700 ring-2 ring-brand-500/20"
          : "border-gray-200 bg-surface-raised text-gray-700 hover:border-gray-300"
      }`}
    >
      <span
        className={`h-2 w-2 rounded-full shrink-0 ${checked ? "bg-brand-500" : "bg-gray-300"}`}
      />
      <span>Show archived</span>
    </button>
  );
}
