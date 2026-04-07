"use client";

import { config } from "@/lib/config";

interface ClientSelectorProps {
  selected: string;
  onChange: (clientName: string) => void;
}

export function ClientSelector({ selected, onChange }: ClientSelectorProps) {
  return (
    <select
      value={selected}
      onChange={(e) => onChange(e.target.value)}
      className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
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
