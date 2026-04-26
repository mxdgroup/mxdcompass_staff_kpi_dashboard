"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { label: "Dashboard", href: "/ppc" },
  { label: "Campaigns", href: "/ppc/campaigns" },
  { label: "Search Terms", href: "/ppc/search-terms" },
];

export function PPCNav() {
  const pathname = usePathname();

  return (
    <nav className="flex gap-1 mb-8">
      <Link
        href="/"
        className="px-3 py-2 text-sm text-gray-400 hover:text-gray-600 transition-colors mr-2"
      >
        ← KPIs
      </Link>
      {TABS.map((tab) => {
        const active = pathname === tab.href;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
              active
                ? "bg-gray-900 text-white"
                : "text-gray-500 hover:text-gray-700 hover:bg-gray-100"
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
