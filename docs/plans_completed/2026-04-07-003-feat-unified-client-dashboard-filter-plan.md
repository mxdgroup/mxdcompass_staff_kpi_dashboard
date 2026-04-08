---
title: "feat: Unify client and agency dashboards with client filter"
type: feat
status: completed
date: 2026-04-07
deepened: 2026-04-07
---

# feat: Unify client and agency dashboards with client filter

## Overview

Replace the separate "Client Boards" card grid on the Overview page with a client filter that applies to the entire dashboard. When a client is selected, every section — KPI cards, pipeline distribution, team members, attention items — filters to that client's data. When no client is selected, the dashboard shows agency-wide metrics as it does today. This makes client views a first-class experience that automatically improves whenever the agency dashboard improves.

## Problem Frame

The current Overview page shows clients as collapsed cards in a "Client Boards" section, each with a minimal summary (WIP, throughput, p85, aging) and an expandable ticket table. This creates two problems:

1. **Client views are second-class** — they show a fraction of what the agency dashboard shows (no pipeline distribution bar, no team breakdown, no attention items, no charts)
2. **Dual maintenance** — any new feature added to the agency dashboard must be separately added to `ClientBoardCard` to benefit client views

The `/flow` page already solves this with a `ClientSelector` dropdown that filters the entire page. The Overview page should follow the same pattern.

## Requirements Trace

- R1. Selecting a client on the Overview page filters all sections to that client's data
- R2. With no client selected, the dashboard looks and behaves exactly as it does today (agency-wide)
- R3. The client filter should be preserved when navigating between Overview and Flow Details tabs
- R4. The "Client Boards" section is replaced by client selector UI — no separate card grid
- R5. Team section filters to show only members who have tickets for the selected client
- R6. Attention items filter to the selected client's tasks
- R7. The page header/title updates to reflect the selected client
- R8. Week selection should also be preserved when navigating between tabs

## Scope Boundaries

- **In scope:** Overview page client filtering, shared filter state between Overview and Flow pages via URL params, removal of `ClientBoardCard` section, moving `week` state to URL params for cross-page consistency
- **Not in scope:** Server-side client filtering (API changes), new data models, new API endpoints, changes to data sync/aggregation logic
- **Not in scope:** Per-client WeeklySnapshot data (the weekly aggregator is employee-centric, not client-centric — throughput deltas and 4-week averages are agency-wide only)

## Context & Research

### Relevant Code and Patterns

- **Existing client filter pattern:** `src/app/flow/page.tsx:52-58` — filters `data.tickets` by `clientName` and swaps `displayMetrics` between `agencyMetrics` and `clientMetrics[selectedClient]`
- **ClientSelector component:** `src/components/ClientSelector.tsx` — dropdown already exists, used on Flow page
- **AgencyOverview component:** `src/components/AgencyOverview.tsx` — accepts `flowMetrics` and `teamSummary` props; can already render client-level `FlowMetrics` if passed
- **FlowSnapshot data structure:** `src/lib/types.ts:182-189` — already contains `clientMetrics: Record<string, FlowMetrics>` keyed by client name
- **Client config:** `src/lib/config.ts:38-43` — four clients defined with name and wrikeFolderId
- **NavTabs:** `src/components/NavTabs.tsx` — uses Next.js `Link` with hardcoded href paths, `usePathname()` for active state
- **WeekSelector:** Controlled component pattern — parent owns `useState("current")`, WeekSelector fires `onWeekChange` callback. Both pages duplicate this independently.
- **No existing `useSearchParams` usage** anywhere in the codebase. Only `useRouter` usage is in `src/app/login/page.tsx` for `router.push("/")` after login. Only `usePathname` usage is in NavTabs.
- **Layout:** `src/app/layout.tsx` is a minimal server component — renders `<html>` and `<body>` with Inter font, no Suspense boundaries, no context providers. NavTabs is rendered inside each page component, not in layout.
- **basePath:** `next.config.ts` sets `basePath: "/kpi"`. `usePathname()` returns paths without basePath (e.g., `/`, `/flow`). `useSearchParams()` is unaffected by basePath. Router navigation uses paths without basePath prefix (confirmed by login page's `router.push("/")`).

### Key Data Availability by Filter Scope

| Section | Agency-wide | Per-client | Notes |
|---------|------------|------------|-------|
| KPI cards (FlowMetrics) | `flowData.agencyMetrics` | `flowData.clientMetrics[name]` | Full parity |
| Pipeline Distribution | `agencyMetrics.stageDistribution` | `clientMetrics[name].stageDistribution` | Full parity |
| Throughput (weekly) | `teamSummary.tasksCompleted` | Not available | WeeklySnapshot is not client-segmented |
| Returns (weekly) | `teamSummary.returnForReviewCount` | Not available | Same limitation |
| Team members | All members | Filter by tickets | `flowData.employeeMetrics` has per-employee ticket lists with `clientName` |
| Attention items | `snap.employees` | Not directly filterable | Would need ticket-level filtering |
| Ticket table | `flowData.tickets` | `tickets.filter(t => t.clientName === name)` | Full parity |

### Institutional Learnings

- The kanban metrics research (`docs/plans/2026-04-07-001-kanban-metrics-research.md`) establishes the layout hierarchy: leading indicators (WIP, aging) first, then trends, then lagging output. This should be preserved in client-filtered view.
- Redis snapshots may lack newer fields — UI must handle `undefined` gracefully for backwards compatibility.

## Key Technical Decisions

- **Both `client` and `week` in URL search params:** Both filter dimensions live in the URL (`?client=Clinic+27&week=2026-W14`). This prevents a split-state bug where navigating between tabs preserves the client filter but resets the week to "current". Both pages read from URL params; both use `router.replace()` to update them. The API already accepts `?week=` so the resolved week from the API response (e.g., "current" → "2026-W14") updates the URL via `replace()` without creating a history entry.

- **`router.replace()` for filter changes, not `push()`:** Filter changes on the same page should not pollute browser history. If a user clicks between 5 clients, the back button should take them to the previous *page*, not cycle through 5 filter states. Use `replace()` for all same-page filter/week changes. Use `push()` only if we add cross-page drill-down navigation in the future.

- **Validate client param against `config.clients`:** If `?client=` contains a name not in `config.clients`, strip the param by redirecting to the clean URL. This prevents a silently broken UI where the `<select>` shows blank, metrics fall back to agency-wide, and the ticket table shows 0 results while the URL claims a specific client is selected. Validation should happen once at the top of each page.

- **NavTabs forwards all search params generically:** Instead of having NavTabs know about `?client=`, it reads `useSearchParams()`, converts to string, and appends to all Link hrefs. This makes NavTabs param-agnostic — it preserves `client`, `week`, and any future params without code changes. Active tab detection still works because `usePathname()` returns only the path portion.

- **Single Suspense boundary in layout.tsx:** Wrap `{children}` in `layout.tsx` with `<Suspense>`. Since NavTabs is rendered inside each page (not in layout), this single boundary covers both pages and all components using `useSearchParams`. No per-page Suspense wrappers needed.

- **Keep AgencyOverview component generic:** It already accepts `FlowMetrics` — just pass `clientMetrics[name]` when filtered. For WeeklySnapshot metrics (throughput, returns), pass `null` as `teamSummary` when a client is selected. The component already handles the `teamSummary === null` case (flow-only cards).

- **Replace Client Boards with inline client chips:** Instead of the card grid, show clickable client chips/pills below the header when no client is selected. Each chip shows the client name, health dot, and WIP count. Clicking a chip sets the URL param. This replaces the `ClientBoardCard` grid with a more compact, scannable UI.

## Open Questions

### Resolved During Planning

- **Q: Should the Flow page's existing `ClientSelector` state be replaced with URL params?**
  Yes — both pages should use the same `?client=` URL param. This gives free state preservation when switching tabs and makes links shareable.

- **Q: What happens to WeeklySnapshot metrics when a client is filtered?**
  Show flow-only metrics (WIP, cycle time, aging, flow efficiency, pipeline distribution). Pass `null` as `teamSummary`. The `AgencyOverview` component already handles the flow-only case (lines 266-316).

- **Q: Should we add a "back to agency" breadcrumb?**
  Yes — when a client is selected, the header shows a clear way to deselect (e.g., "Agency Dashboard > Clinic 27" breadcrumb, or a clear/X button on the selector).

- **Q: Should `week` also be in the URL?**
  Yes — without this, navigating between tabs resets the week to "current" because each page initializes `useState("current")`. The resolved week from the API (`"2026-W14"`) should replace "current" in the URL via `router.replace()`.

- **Q: `push()` vs `replace()` for filter changes?**
  `replace()` for all same-page filter changes. This prevents browser history pollution where the back button cycles through filter states instead of navigating to the previous page.

- **Q: How should NavTabs preserve params?**
  Forward all search params generically (read `useSearchParams().toString()` and append to hrefs). This avoids NavTabs knowing about specific param names and is future-proof.

- **Q: Where should the Suspense boundary go?**
  In `layout.tsx` wrapping `{children}`. Both pages are `"use client"` and NavTabs lives inside each page, so a single boundary in layout covers everything.

- **Q: What if the URL contains an invalid client name?**
  Validate against `config.clients` at page load. If invalid, strip the param by navigating to the clean URL via `replace()`. This prevents a broken UI state.

### Deferred to Implementation

- Exact visual treatment of the "Agency-wide only" placeholder for weekly metrics when client-filtered — may need to see it in context to decide.
- Whether client chips should show health indicators (green/amber/red dots from `ClientBoardCard`) — nice to have but depends on layout space.
- Exact Suspense fallback content in layout.tsx — could be `null` or a minimal loading skeleton.

## Implementation Units

- [ ] **Unit 1: Add Suspense boundary and URL param infrastructure**

  **Goal:** Add the Suspense boundary to layout.tsx and introduce URL search param reading on the Overview page. Move `week` from `useState` to URL param on the Overview page.

  **Requirements:** R1, R3, R8

  **Dependencies:** None

  **Files:**
  - Modify: `src/app/layout.tsx`
  - Modify: `src/app/page.tsx`
  - Modify: `src/components/ClientSelector.tsx`

  **Approach:**
  - Add `<Suspense>` wrapping `{children}` in `layout.tsx`
  - In `page.tsx`, read `client` and `week` from `useSearchParams()`
  - Validate `client` param against `config.clients` — if invalid, strip via `router.replace()`
  - Replace `useState("current")` for `week` with URL param. When API response resolves the week (e.g., "current" → "2026-W14"), update URL via `replace()`
  - Update `ClientSelector` to accept an `onSelect` callback that the parent uses to call `router.replace()` with updated params
  - Update `WeekSelector` similarly — its `onWeekChange` callback should update the URL param

  **Patterns to follow:**
  - Flow page's existing `selectedClient` / `setSelectedClient` controlled component pattern, adapted for URL params
  - Login page's `router.push("/")` for router usage convention (paths without basePath)

  **Test scenarios:**
  - Loading `/?client=Clinic+27&week=2026-W14` pre-selects both filters
  - Loading `/` with no params shows agency-wide with current week (existing behavior)
  - Loading `/?client=FakeClient` strips the param and shows agency-wide
  - Selecting a client updates URL without full page reload
  - Changing week updates URL; API fetches with new week param
  - API resolving "current" to "2026-W14" updates URL via replace (no history entry)

  **Verification:**
  - URL reflects both `client` and `week` params; page state matches URL on reload

- [ ] **Unit 2: Filter AgencyOverview and pipeline to selected client**

  **Goal:** When a client is selected, pass that client's `FlowMetrics` to `AgencyOverview` instead of agency-wide metrics.

  **Requirements:** R1, R2

  **Dependencies:** Unit 1

  **Files:**
  - Modify: `src/app/page.tsx`

  **Approach:**
  - Compute `displayMetrics` and `displayTeamSummary` based on `selectedClient` (same pattern as `flow/page.tsx:56-58`)
  - When a client is selected: pass `clientMetrics[selectedClient]` as `flowMetrics` and `null` as `teamSummary` (weekly data is not client-segmented)
  - `AgencyOverview` already handles the `teamSummary === null` case — it shows flow-only cards
  - When no client selected: pass agency-wide data as today
  - No changes needed to `AgencyOverview` component itself

  **Patterns to follow:**
  - `src/app/flow/page.tsx:56-58` — the `displayMetrics` pattern

  **Test scenarios:**
  - Client selected → KPI cards show that client's WIP, cycle time, aging, flow efficiency
  - Client selected → pipeline distribution bar shows that client's stage counts
  - Client selected → weekly-only cards (throughput, returns) show flow-only fallback
  - No client selected → behaves exactly as current agency dashboard

  **Verification:**
  - Selecting "Clinic 27" shows Clinic 27's metrics; deselecting restores agency-wide

- [ ] **Unit 3: Replace Client Boards section with client chips and filtered ticket table**

  **Goal:** Remove the "Client Boards" card grid and show a ticket table when a client is selected, or client chips for quick selection when no client is active.

  **Requirements:** R1, R4

  **Dependencies:** Unit 1, Unit 2

  **Files:**
  - Modify: `src/app/page.tsx`
  - Create: `src/components/ClientChips.tsx`

  **Approach:**
  - When no client selected: render a row of clickable client chips (name + health dot + WIP count) that call `router.replace()` with the client param. This replaces the `ClientBoardCard` grid with a more compact, scannable UI.
  - When a client is selected: render a `TicketFlowTable` with that client's filtered tickets (same component already used inside `ClientBoardCard` and on the Flow page)
  - The `ClientChips` component receives `clientMetrics` as a prop to show summary info on each chip

  **Patterns to follow:**
  - `ClientBoardCard`'s `healthIndicator()` function for chip color dots
  - `TicketFlowTable` usage in `ClientBoardCard` and `/flow` page

  **Test scenarios:**
  - No client selected → client chips visible with health indicators and WIP counts
  - Click a chip → URL updates, dashboard filters to that client, ticket table appears
  - Client selected → full ticket flow table with assignee column visible
  - Click a different chip → filter switches to that client

  **Verification:**
  - Client Boards card grid no longer renders; chips and filtered table replace it

- [ ] **Unit 4: Filter team section and attention items by selected client**

  **Goal:** When a client is selected, only show team members working on that client's tickets, and filter attention items accordingly.

  **Requirements:** R5, R6

  **Dependencies:** Unit 1

  **Files:**
  - Modify: `src/app/page.tsx`

  **Approach:**
  - Build a set of assignee contact IDs from `flowData.tickets.filter(t => t.clientName === selectedClient)`
  - Filter `teamCards` to only include members whose contact ID appears in that set
  - Hide `AttentionItems` section when client-filtered — it uses `EmployeeWeekData` which is not client-segmented and would show misleading data
  - Show `AttentionItems` when agency-wide (no client selected)

  **Test scenarios:**
  - Client selected → only team members with tickets for that client appear in Team section
  - Client with one assignee → only that member shown
  - No client selected → all team members shown (current behavior)
  - Attention items hidden when client filtered, shown when agency-wide

  **Verification:**
  - Team section member count updates to reflect filtered set

- [ ] **Unit 5: Update header and NavTabs to carry all URL params**

  **Goal:** Show which client is selected in the page header and preserve all URL params when navigating between tabs.

  **Requirements:** R3, R7, R8

  **Dependencies:** Unit 1

  **Files:**
  - Modify: `src/app/page.tsx`
  - Modify: `src/components/NavTabs.tsx`

  **Approach:**
  - **Page header:** When a client is selected, change title from "Agency Dashboard" to the client name with a "Back to Agency" breadcrumb/button that clears the `client` param via `replace()`
  - **NavTabs:** Read `useSearchParams()`, convert to string via `.toString()`, and append `?${params}` to each tab href when params are non-empty. This is param-agnostic — forwards `client`, `week`, and any future params. Active tab detection (`usePathname() === tab.href`) still works because `usePathname()` returns only the path portion.

  **Patterns to follow:**
  - Current `NavTabs` `Link` pattern with dynamic href construction
  - `usePathname()` already used in NavTabs for active detection

  **Test scenarios:**
  - Select client on Overview → navigate to Flow Details → same client and week pre-selected
  - Select client on Flow → navigate to Overview → same client and week filtered
  - Clear client on either page → navigating preserves the cleared state and current week
  - NavTabs preserves unknown future params without code changes

  **Verification:**
  - Round-trip between tabs preserves both client and week selection

- [ ] **Unit 6: Migrate Flow page to URL params and clean up**

  **Goal:** Replace the Flow page's local `selectedClient` and `week` state with URL params for full parity. Remove unused `ClientBoardCard` component.

  **Requirements:** R3, R8

  **Dependencies:** Unit 1, Unit 5

  **Files:**
  - Modify: `src/app/flow/page.tsx`
  - Delete: `src/components/ClientBoardCard.tsx`

  **Approach:**
  - Replace `useState("")` for `selectedClient` with `useSearchParams().get("client")`
  - Replace `useState("current")` for `week` with `useSearchParams().get("week")`
  - Same validation pattern as Overview page — invalid client gets stripped
  - Same `replace()` pattern for filter/week changes
  - Delete `ClientBoardCard.tsx` and remove its import from `page.tsx`

  **Patterns to follow:**
  - Overview page's URL param pattern from Unit 1

  **Test scenarios:**
  - Loading `/flow?client=Clinic+27&week=2026-W14` pre-selects both
  - Flow page filter changes update URL via `replace()`
  - `ClientBoardCard` no longer referenced anywhere in codebase
  - Build succeeds

  **Verification:**
  - `grep -r "ClientBoardCard" src/` returns no results
  - Flow page reads from URL params, not local state

## System-Wide Impact

- **Interaction graph:** `NavTabs` now reads `useSearchParams()` — covered by Suspense boundary in `layout.tsx`. Both pages share URL state rather than independent local state. `WeekSelector` callbacks change from setting local state to updating URL params.
- **Error propagation:** No new error paths. If `clientMetrics[name]` is missing, falls back to `null` (existing pattern in `AgencyOverview`). Invalid client params are stripped at page load.
- **State lifecycle risks:** URL params are the single source of truth for both `client` and `week` — no split-state sync issues between pages. API response resolving "current" to a specific week updates URL via `replace()` without creating history entries. Browser back/forward works correctly because `useSearchParams()` reacts to popstate events.
- **Browser history:** All same-page filter changes use `replace()` to avoid history pollution. Back button takes user to previous page, not previous filter state.
- **API surface parity:** No API changes. `?week=` param already accepted by APIs. Client filtering remains client-side using existing `FlowSnapshot.clientMetrics` and `FlowSnapshot.tickets`.
- **Integration coverage:** Critical paths: (1) select client → all sections filter correctly → navigate to Flow → both client and week preserved → navigate back → still active. (2) Invalid `?client=FakeClient` → param stripped, agency-wide shown. (3) Week change → URL updates → API fetches → resolved week replaces "current" in URL.

## Risks & Dependencies

- **WeeklySnapshot not client-segmented:** Throughput deltas and 4-week averages are agency-wide. When client-filtered, these metrics show as unavailable. This is acceptable — the flow metrics provide the important per-client KPIs. Adding per-client weekly metrics would require aggregator changes (future scope).
- **AttentionItems uses EmployeeWeekData:** This data is not client-filtered, so showing it in client view would be misleading. Hiding it when filtered is the safe choice.
- **Suspense boundary in layout.tsx:** First Suspense boundary in the app. The fallback content needs to be minimal to avoid flash of loading state on normal navigation. `null` or a very brief skeleton is preferred.
- **Week state migration scope creep:** Moving `week` from `useState` to URL params is technically a separate concern, but it is necessary to prevent cross-page navigation bugs. The alternative (leaving week in local state) would cause the week to reset to "current" every time the user switches tabs.
- **`useSearchParams()` triggers client-side rendering:** In Next.js App Router, pages using `useSearchParams()` opt out of static generation. Both pages are already `"use client"` with client-side data fetching, so this has no practical impact.

## Sources & References

- Existing pattern: `src/app/flow/page.tsx:52-58` (client filtering)
- Existing component: `src/components/ClientSelector.tsx`
- Data model: `src/lib/types.ts:182-189` (`FlowSnapshot` with `clientMetrics`)
- Design research: `docs/plans/2026-04-07-001-kanban-metrics-research.md`
- Router convention: `src/app/login/page.tsx` (`router.push("/")` without basePath)
- Layout structure: `src/app/layout.tsx` (minimal server component, no existing Suspense)
