---
title: "feat: Exclude archived tasks from dashboard with toggle"
type: feat
status: active
date: 2026-04-16
---

# feat: Exclude archived tasks from dashboard with toggle

## Overview

Tasks completed 45+ days ago are auto-archived in Wrike. Mirror that rule in the dashboard: by default, hide tickets meeting the archive criterion across both the Overview and Flow Details pages. Add a top-right header toggle so users can include archived tickets when they need full history.

## Problem Frame

The Wrike workspace auto-archives tasks completed more than 45 days ago to keep the project list fresh. Today the dashboard still shows them, which clutters the ticket tables, distorts active-work counts, and makes the dashboard feel out of sync with how the team actually uses Wrike. We want the dashboard's default view to match the team's working set, while preserving access to the full history for retrospective analysis.

## Requirements Trace

- R1. Tasks where `currentStage === "Completed"` AND `completedDate` is ≥ 45 UTC calendar days old are treated as "archived" (a task completed exactly 45 days ago is archived; no grace period)
- R2. Archived tasks are hidden by default
- R3. A header control (top-right) lets the user include archived tasks
- R4. Toggle state is page-local and resets on tab navigation (per user direction)
- R5. When the toggle is OFF, all dashboard surfaces — ticket tables, charts, KPI metrics, and per-employee cards — exclude archived tasks consistently
- R6. When the toggle is ON, the dashboard renders identically to today

## Scope Boundaries

- **Out of scope:** Changing what gets synced from Wrike. The sync continues to fetch and store all tasks; archival is purely a UI filter applied at render time.
- **Out of scope:** Persisting the toggle to localStorage, URL params, or across page navigation. Per user direction, the toggle is page-local React state.
- **Out of scope:** Yesterday page. It shows daily transitions, not the ticket list, and the archive concept does not apply.
- **Out of scope:** Server-side filtering, new API parameters, or any change to `FlowSnapshot` shape. Filter happens client-side after the existing `/api/dashboard` and `/api/flow` responses are received. Sync, cron, webhook, and storage paths are not modified.
- **Out of scope:** Changing the 45-day threshold to be configurable.

## Context & Research

### Relevant Code and Patterns

- `src/app/page.tsx` (Overview) — computes `filteredTickets` from `flowData.tickets` (line 203), filtering by selected client. Renders `AgencyOverview` (KPI cards), `ClientChips`, the main `TicketFlowTable`, and a list of `TeamMemberCard` components. Uses `useState` for local filter state.
- `src/app/flow/page.tsx` (Flow Details) — computes `filteredTickets` similarly (line 122). Renders `AgingWipChart`, `CumulativeFlowDiagram`, `CycleTimeScatter`, `TicketFlowTable`, and `TicketFlowDots`. Uses `useSearchParams` for client/week/view filters.
- `src/lib/types.ts` — `TicketFlowEntry` (line 144) has `completedDate: string | null` and `currentStage: string`. `FlowSnapshot` (line 185) carries `tickets`, `agencyMetrics`, `clientMetrics`, and `employeeMetrics`.
- `src/lib/flowBuilder.ts` — `computeFlowMetrics()` (line 295) builds `FlowMetrics` from a ticket list. Used only server-side at sync time. Per-employee metrics are built inline (lines 566–612) rather than via a shared helper. **`flowBuilder.ts` has top-level server-only imports** (`./wrike/fetcher`, `./wrike/client`, etc.), so importing it from a client component is unsafe. Unit 1 extracts both functions into a new `src/lib/flowMetrics.ts` with no server-only imports; `flowBuilder.ts` re-imports them.
- `src/components/TicketFlowTable.tsx` — has its own internal "All / Active / Completed" filter tabs (line 67). The new archive filter is a parent-level concern that composes with these tabs; the component does not need to know about archival.
- `src/components/TicketFlowDots.tsx` — also has internal filter logic, same pattern.
- `src/components/TeamMemberCard.tsx` — line 104 passes `flowData.tickets` (an `EmployeeFlowMetrics.tickets` array) directly into a nested `TicketFlowTable`. Also reads `flowData.flowEfficiency` and other metric fields for the collapsed summary line.
- `src/components/ClientChips.tsx`, `src/components/ClientSelector.tsx` — header filter controls; the new toggle should follow the same visual idiom (compact pill-style control).

### Institutional Learnings

- Project memory feedback: "Plans must guard against regressions." Multiple past fixes have broken adjacent functionality. Before changing shared logic (`computeFlowMetrics`, `filteredTickets`), trace all callers and list unchanged invariants explicitly.
- Existing filter pattern is consistent: page-level filtering of the ticket array before passing into table/chart components. Follow the same pattern; do not push archive logic into leaf components.
- `TicketFlowTable` and `TicketFlowDots` both filter independently; any per-ticket filter applied at the page level automatically reaches both, which is the right interception point.
- **90-day completed cutoff (hard design rule).** The sync only stores completed tasks whose `completedDate` is within the last 90 days. Tasks completed >90 days ago are not synced, not stored, not displayed. The archive filter therefore operates within an already-bounded 90-day window — its job is to shrink that window further to 45 days for the default view. One important consequence: the 90-day filter is applied as `completedDate < today - 90d`, which does not match tasks with `completedDate === null` (the migration cohort) — those are stored regardless of age.
- **Wrike data migration.** The team migrated from a previous PM system in February 2026 with full cutover the first week of March 2026. Many tasks have `currentStage === "Completed"` but `completedDate === null` because the original completion timestamp did not survive migration. As of 2026-04-16 these are 6+ weeks old; treating them as "always show" silently keeps the legacy backlog visible after the toggle ships. See Open Questions for the design decision needed here.

### External References

None gathered — the work is entirely local UI/state with established patterns.

## Key Technical Decisions

- **Archive criterion:** A ticket is archived when `currentStage === "Completed"` AND `completedDate !== null` AND the date portion of `completedDate` is 45 or more UTC calendar days before today. Tasks with `completedDate === null` are treated as **not archived** (always shown). This is the user-chosen rule; see "Known limitation: migration cohort" below.
- **Comparison granularity:** UTC calendar days (date portion only). Extract `completedDate.slice(0, 10)` and compare against `new Date().toISOString().slice(0, 10)` reduced to a day count via `Math.floor(ms / 86400000)`. UTC matches the server's day-bucket convention at `flowBuilder.ts:408` so the client and server agree about what "today" means.
- **Compute on the client via `useMemo`.** When the toggle is OFF, the page recomputes metrics from `flowData.tickets.filter(t => !isArchived(t))` by calling the same `computeFlowMetrics` (and `computeEmployeeFlowMetrics`) functions that the server already uses at sync time. When the toggle is ON, the page reads the existing server-computed metrics directly. Because both code paths call the *same function*, numerical parity is structural — there is no second implementation to drift. This requires extracting `computeFlowMetrics` (and the per-employee inline loop at `flowBuilder.ts:566-612`) into a client-safe module, but adds nothing to the sync pipeline, the snapshot shape, the storage layer, or the webhook patch path.
- **Filter location:** Page level. Filter the ticket array (by `isArchived(t)`) and recompute metrics from the filtered set before passing into any downstream component or chart. Leaf components remain unaware of the archive concept.
- **State scope:** Page-local `useState`. The toggle resets when navigating between Overview and Flow tabs, per user direction. Default state is `false` (archived tasks hidden). (See risk table — review flagged this as friction-prone; lift to layout if it proves so in use.)
- **Toggle UI:** A toggle control in the right side of each page's header, sitting alongside the existing client selector / week selector / sync button. Label: **"Show archived"**. Tooltip clarifies "Completed 45+ days ago — migrated tasks without a completion date are always shown." HTML primitive, ARIA, and visual states resolved during Unit 2 — see Risks.
- **TeamMemberCard integration:** Pass the `showArchived` flag down as a prop. Inside the card, filter `flowData.tickets` by `isArchived` and re-derive the per-employee summary metrics via `computeEmployeeFlowMetrics(visibleTickets, ...)` (memoized). When all of a member's tickets are archived, render the card with zero counts and a small inline note (e.g., "All N tickets are archived — toggle to view") so the team list stays complete. Distinguish "all archived" from "no tickets at all" — the note only applies to the former.

### Known limitation: migration cohort

The team migrated from a previous PM system Feb–early March 2026. Many completed tasks have `completedDate === null` from that migration. Per the chosen rule above, those tasks remain visible regardless of toggle state. This is an explicit user decision: the rule should not silently hide tasks whose age cannot be confirmed, even at the cost of some legacy clutter remaining. Document this clearly in the PR description so reviewers understand the toggle will appear to "do nothing" for that cohort.

If, after shipping, the migration cohort proves disruptive, follow-up options are: (a) extend the `completedDate` fallback chain at `flowBuilder.ts:285` to use `task.updatedDate` as a third tier, (b) backfill `completedDate` for migrated tasks via a one-shot script, or (c) revisit the rule. Out of scope for this plan.

## Open Questions

### Resolved During Planning

- **Filter affects metrics, not just tables?** Yes — recomputed client-side from the filtered ticket set via `useMemo`, calling the same `computeFlowMetrics` function the server uses. (User decision.)
- **TeamMemberCard's nested table respects the toggle?** Yes — thread the flag down; render zero-count cards with an inline note when all tickets are archived (distinguish from "no tickets at all"). (User decision.)
- **State persistence across tab navigation?** No — page-local state, resets on switch. (User decision; flagged as friction-prone in review — see risks.)
- **Null `completedDate` handling?** Treat as not archived (always shown). Accept the migration-cohort limitation; see Key Technical Decisions → "Known limitation: migration cohort." (User decision.)
- **Toggle label?** "Show archived" — adopt Wrike's vocabulary. (User decision.)
- **Boundary condition?** `>= 45 UTC calendar days`, comparing date portions only.
- **Yesterday page?** Out of scope; no ticket list, no archive concept.
- **Implementation shape — server pre-compute vs. client recompute?** Client recompute via `useMemo`. (User decision after document-review surfaced architectural concerns with the server pre-compute path: time-based flag drift, webhook-patch aggregate cost, snapshot bloat, storage migration, and tautological parity check. Client recompute eliminates all five.)

### Deferred to Implementation

- Whether to verify 45 days against Wrike's actual workspace auto-archive setting before shipping. Recommended verification *before* Unit 1 begins — adjust `ARCHIVE_THRESHOLD_DAYS` constant if Wrike uses a different value. Owner: implementer.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```
Server (unchanged): /api/flow returns the existing FlowSnapshot —
                    tickets, agencyMetrics, clientMetrics, employeeMetrics.

Page render (client, Overview or Flow Details):

  flowData (from /api/flow)
       │
       ▼
  showArchived (useState, default false)
       │
       ▼
  ┌──────────────────────────────────────┐
  │ visibleTickets = useMemo(            │  if showArchived → flowData.tickets
  │   showArchived                       │  else → tickets.filter(t => !isArchived(t))
  │     ? flowData.tickets               │
  │     : flowData.tickets.filter(...))  │
  └──────────────────────────────────────┘
       │
       ├──► filteredTickets (apply client filter)
       │         │
       │         ├──► TicketFlowTable / TicketFlowDots
       │         ├──► AgingWipChart / CycleTimeScatter
       │         └──► ticket count label
       │
       ├──► displayMetrics = useMemo(
       │       showArchived
       │         ? flowData.agencyMetrics  (or clientMetrics[c])
       │         : computeFlowMetrics(filteredTickets, weekStart, weekEnd))
       │         │
       │         └──► AgencyOverview / CumulativeFlowDiagram (toggle ON only;
       │                                                     see CFD note in risks)
       │
       └──► per-team-member (TeamMemberCard, Overview only):
             empVisibleTickets = useMemo(empTickets.filter(...))
             empSummary = useMemo(
               showArchived
                 ? employee  (server-computed full set)
                 : computeEmployeeFlowMetrics(empVisibleTickets, ...))
                 │
                 └──► collapsed summary + expanded TicketFlowTable
```

Rule: `isArchived(t) === t.currentStage === "Completed" && t.completedDate !== null && daysSince(t.completedDate) >= 45`.

`computeFlowMetrics` and `computeEmployeeFlowMetrics` are extracted into a client-safe module (see Unit 1) and called from both the server (unchanged behavior) and the client (new). Same function, same numbers — parity is structural, not enforced.

## Implementation Units

- [x] **Unit 1: Extract metric helpers + add `archive.ts` rule module**

**Goal:** Make `computeFlowMetrics` and the per-employee metric computation callable from the client. Add a single `isArchived` rule module used by both pages.

**Requirements:** R1

**Dependencies:** None.

**Files:**
- Create: `src/lib/flowMetrics.ts` — client-safe extraction of `computeFlowMetrics` (and `computeEmployeeFlowMetrics`, currently inlined at `flowBuilder.ts:566-612`)
- Create: `src/lib/archive.ts` — single source of truth for the archive rule
- Modify: `src/lib/flowBuilder.ts` — re-export or import the extracted helpers; do not duplicate logic

**Approach:**
- In `src/lib/archive.ts`:
  - Export `ARCHIVE_THRESHOLD_DAYS = 45`.
  - Export `isArchived(ticket: TicketFlowEntry, now?: Date): boolean` — true only when `currentStage === "Completed"` AND `completedDate !== null` AND the UTC date portion of `completedDate` is ≥ `ARCHIVE_THRESHOLD_DAYS` calendar days before `now ?? new Date()`. Inject `now` for deterministic tests.
- In `src/lib/flowMetrics.ts`:
  - Move `computeFlowMetrics` (currently `flowBuilder.ts:295`) and the helper constants it depends on (`STAGE_ORDER`, `ACTIVE_STAGES`, `AGING_THRESHOLD_HOURS`, `normalizeStage`, `buildDailyFlow`) into this module.
  - Extract the per-employee inline loop at `flowBuilder.ts:566-612` into `computeEmployeeFlowMetrics(tickets, weekStart, weekEnd, employee)` (signature TBD by implementer; must produce the same `EmployeeFlowMetrics` shape minus the `tickets` array, which the caller composes).
  - **Hard constraint:** this file must have zero server-only imports — no `./wrike/*`, no `node:*`, no Redis, no `fs`. Verify by attempting to import it from a `"use client"` module.
- In `src/lib/flowBuilder.ts`:
  - Replace the moved functions with re-exports/imports from `flowMetrics.ts`. The server's behavior must be byte-identical after extraction — this is a pure refactor of code location, not logic.

**Patterns to follow:**
- Existing pure-function style in `src/lib/`.
- `UPPER_SNAKE_CASE` constants per repo convention.
- Existing `computeFlowMetrics` signature; do not modify it.

**Test scenarios:**
- `isArchived`:
  - Completed, `completedDate` exactly 45 UTC days ago → archived.
  - Completed, `completedDate` 44 UTC days ago → not archived.
  - Completed, `completedDate` 100 days ago → archived.
  - Completed, `completedDate === null` → **not** archived (migration cohort guard).
  - Active stage with old `completedDate` → not archived.
  - Times-of-day differ but date portion is 45 days → archived (date-only comparison).
- Refactor parity: a sync against the current data produces a `FlowSnapshot` byte-identical to `main` (same agency metrics, same client metrics, same per-employee metrics, same tickets). Compare via JSON serialization.
- Client-import smoke check: a `"use client"` test page can `import { computeFlowMetrics, computeEmployeeFlowMetrics } from "@/lib/flowMetrics"` and run them in the browser without errors.

**Verification:**
- Existing sync produces unchanged snapshots (byte-identical FlowSnapshot for the current week).
- TypeScript compiles cleanly across server and client.
- No server-only imports leak into `flowMetrics.ts` (grep the file for `wrike`, `node:`, `redis`, `fs`).

---

- [x] **Unit 2: Toggle + client-side recompute on Overview and Flow Details**

**Goal:** Add the `ArchivedToggle` and wire it into both `src/app/page.tsx` (Overview) and `src/app/flow/page.tsx` (Flow Details). Both pages share the same pattern: filter `flowData.tickets` by `isArchived`, then `useMemo` over `computeFlowMetrics` to derive `displayMetrics`.

**Requirements:** R3, R4, R5, R6

**Dependencies:** Unit 1.

**Files:**
- Create: `src/components/ArchivedToggle.tsx` — small reusable presentational component
- Modify: `src/app/page.tsx`
- Modify: `src/app/flow/page.tsx`

**Approach (shared):**
- `const [showArchived, setShowArchived] = useState(false)` near existing local filter state.
- ```ts
  const visibleTickets = useMemo(
    () => showArchived ? flowData.tickets : flowData.tickets.filter(t => !isArchived(t)),
    [flowData.tickets, showArchived]
  );
  ```
- Update existing `filteredTickets` derivations to chain off `visibleTickets`.
- Render `<ArchivedToggle checked={showArchived} onChange={setShowArchived} />` in the header's right-hand control cluster.

**Overview-specific (`src/app/page.tsx`):**
- ```ts
  const displayFlowMetrics = useMemo(() => {
    if (showArchived) {
      return selectedClient ? flowData.clientMetrics[selectedClient] ?? flowData.agencyMetrics
                            : flowData.agencyMetrics;
    }
    return computeFlowMetrics(filteredTickets, weekStart, weekEnd);
  }, [showArchived, selectedClient, filteredTickets, flowData, weekStart, weekEnd]);
  ```
- Pass `displayFlowMetrics` to `AgencyOverview`.

**Flow Details-specific (`src/app/flow/page.tsx`):**
- Same pattern. The recomputed `displayMetrics.dailyFlow` flows into `CumulativeFlowDiagram`. **CFD note:** because the recent metric set is computed over a strictly smaller ticket set, the CFD will visibly differ when toggling — a ticket completed 50 days ago appears in the full CFD but not the recent CFD. Bounded impact (90-day cutoff already caps history). Acceptable for v1; flag in PR description.
- Toggle is page-local `useState` (not a URL param) — matches Overview, intentional per user direction. Switching between "Tickets" and "Ticket Flow" view preserves toggle within the page session.

**`ArchivedToggle` component:**
- Resolve before implementing the wiring: HTML primitive (button vs. checkbox vs. switch), `aria-pressed` or `role="switch"` semantics, active/inactive class names. The pattern in `src/components/ClientChips.tsx` is the closest visual reference. Default to a `button` with `aria-pressed={checked}` unless the implementer has reason to prefer otherwise.
- Label: **"Show archived"**. Tooltip text: *"Completed 45+ days ago — migrated tasks without a completion date are always shown."*
- Style: matches existing header controls — `rounded-lg border border-gray-200 bg-surface-raised px-3 py-2 text-sm` (or pill variant matching `ClientChips`, implementer's choice).
- Optional UX: when toggle is OFF and `flowData.tickets.some(isArchived)`, show a small hint near the ticket count ("{n} archived hidden"). Defer if it complicates layout.

**Patterns to follow:**
- Existing page-level filtering pattern: filter the ticket array, recompute metrics, pass into leaf components. Leaf components stay archive-unaware.
- Existing `useState` + `useMemo` patterns on both pages.

**Test scenarios:**
- Default load (both pages): archived tickets absent from tables/charts; KPI/flow cards reflect recomputed recent-only metrics; ticket count matches visible set.
- Toggle ON (both pages): archived tickets reappear; metrics revert to server-computed full set; numbers match `main`.
- Overview + client selected + toggle OFF: archived hidden for that client; client metric card recomputed from filtered tickets.
- Week with zero archived tickets: toggling has no visible effect; ON and OFF produce identical metric numbers (parity sanity check, structurally guaranteed by calling the same function).
- Flow Details: switching view modes ("Tickets" / "Ticket Flow") preserves toggle within session; changing week preserves toggle.
- Navigation Overview → Flow → Overview: toggle resets to OFF on each page (intentional per user direction).
- `CycleTimeScatter` (Flow Details) hides 60-days-completed tickets when toggle OFF, shows them when ON.

**Verification:**
- Toggling ON/OFF on both pages visibly changes the ticket table, ticket count, KPI/flow cards, and (Flow Details) charts.
- No console errors or React key warnings.
- TypeScript compiles cleanly.
- Toggle ON produces numbers identical to `main` on a few key cards (regression sanity check).

---

- [x] **Unit 3: TeamMemberCard archive integration + manual QA**

**Goal:** When the Overview toggle is OFF, each `TeamMemberCard` hides archived tickets in its expanded table AND recomputes its summary metrics from the filtered set. When all of a member's tickets are archived, render the card with zero counts and an inline note rather than dropping it from the list. Manual QA closes out the feature.

**Requirements:** R5, plus end-to-end verification of all requirements.

**Dependencies:** Units 1, 2.

**Files:**
- Modify: `src/components/TeamMemberCard.tsx`
- Modify: `src/app/page.tsx` (pass `showArchived` into each card; adjust `clientAssigneeIds` derivation)

**Approach:**
- Add `showArchived: boolean` prop to `TeamMemberCard` (no default — explicit at the one call site).
- Inside the card:
  - ```ts
    const visibleTickets = useMemo(
      () => showArchived ? flowData.tickets : flowData.tickets.filter(t => !isArchived(t)),
      [flowData.tickets, showArchived]
    );
    const summary = useMemo(
      () => showArchived ? flowData : computeEmployeeFlowMetrics(visibleTickets, weekStart, weekEnd, employee),
      [showArchived, flowData, visibleTickets, weekStart, weekEnd, employee]
    );
    ```
  - Pass `visibleTickets` into the nested `TicketFlowTable`. Use `summary` for the collapsed summary fields (`flowEfficiency`, `medianExecutionHours`, `avgEffortScore`, `cycleTimeP50/P85`, `agingItems`).
- **Zero-count rendering:** distinguish two cases — (a) member has tickets, all archived → card renders with zero metrics + inline note "All N tickets are archived — toggle to view"; (b) member has no tickets at all → existing empty-state behavior, no archive note. Card must not throw on empty input; verify no `NaN`/`undefined` in formatted numbers.
- **Card-list inclusion (`src/app/page.tsx:208`):** the current `clientAssigneeIds` derives from `filteredTickets` (post-archive). When toggle is OFF + a client is selected + a member has only archived tickets for that client, that member would disappear from the list. To honor the zero-count decision: derive `clientAssigneeIds` from the *full* `flowData.tickets` (pre-archive) when computing card visibility, but continue using `filteredTickets` everywhere else. This keeps the team roster stable across toggle states while still honoring the client filter.

**Patterns to follow:**
- Existing `TeamMemberCardProps` type extension.
- Existing card layout — archive note appears as a small muted line beneath the summary, not as a separate banner.

**Test scenarios:**
- Toggle OFF + member has mixed tickets: expanded table shows only non-archived; summary recomputed from filtered set.
- Toggle ON: expanded table shows full history; summary matches server-computed `flowData` (no recompute).
- Toggle OFF + member has only archived tickets: card renders with zero counts + inline note; no `NaN`/`undefined` in displayed numbers.
- Toggle OFF + client selected + member has only archived tickets for that client: card still appears (zero + note).
- Toggle ON + same scenario: card appears with full data.
- Member with zero tickets total: existing empty-state behavior, no archive note.

**Manual QA checklist:**
- Run dev server; load Overview and Flow Details for the current week.
- Toggle ON across both pages → dashboard numerically matches `main` for a few key cards.
- Toggle OFF across both pages → archived tickets absent everywhere they should be.
- Compose toggle OFF with client filter → archived hidden; metrics reflect filtered client set.
- Compose toggle OFF with `TicketFlowTable`'s "Completed" tab → only recently completed tickets show.
- Yesterday page renders unchanged (no toggle present).
- Header right-cluster on a ~900px viewport: cluster does not wrap awkwardly. If it does, shorten the toggle label or move below the header.
- **Threshold check:** confirm 45 days matches Wrike's actual workspace auto-archive setting. If different, adjust `ARCHIVE_THRESHOLD_DAYS` in `src/lib/archive.ts` and reload.
- **Migration cohort spot-check:** pick a member known to have many `completedDate === null` migrated tasks; confirm those tasks remain visible regardless of toggle state, matching the documented "Known limitation."

**Verification:**
- Per-member tables and summaries update in lockstep with the page-level toggle.
- No `NaN`/`undefined` in any rendered numbers when ticket sets become empty.
- Team roster does not flicker when toggling.
- No console errors in the browser.
- TypeScript compiles cleanly; lints pass.

## System-Wide Impact

- **Interaction graph:** Two pages (Overview, Flow Details) and one card component (`TeamMemberCard`) consume the new toggle. Downstream chart/table components receive a filtered ticket array and a recomputed metric object — no internal changes.
- **Sync, cron, webhook, storage layer:** Untouched. No new fields written to `FlowSnapshot`, no schema changes, no migration of persisted data, no change to webhook patch behavior.
- **`flowBuilder.ts` refactor:** `computeFlowMetrics` and the per-employee inline loop move into `src/lib/flowMetrics.ts`. `flowBuilder.ts` re-imports them. Server output must be byte-identical to `main` after the move (Unit 1 parity check).
- **API surface parity:** No new endpoints, no response-shape changes. `/api/dashboard` and `/api/flow` responses are unchanged.
- **Error propagation:** Filter and recompute happen client-side after data fetch. The new path is `flowData.tickets → useMemo(filter) → useMemo(computeFlowMetrics)`. `computeFlowMetrics` already handles `tickets.length === 0` (sync exercises that case today). No new error paths on the client.
- **State lifecycle:** Toggle is page-local `useState`, lost on navigation. Intentional per user direction; documented so future maintainers do not "fix" it by adding URL persistence.
- **Client compute cost:** `computeFlowMetrics` runs once per render when toggle is OFF, over a strictly smaller ticket set than the server processed at sync time. `useMemo` keys on `[showArchived, flowData.tickets, weekStart, weekEnd, selectedClient]` so it only re-runs on actual change. Negligible at current dashboard scale (low thousands of tickets within the 90-day window).
- **Unchanged invariants:**
  - `TicketFlowEntry`, `FlowSnapshot`, `EmployeeFlowMetrics` field shapes
  - `computeFlowMetrics` signature and behavior (only its file location changes)
  - Sync, cron, and webhook flows
  - Internal `TicketFlowTable` Active/Completed filter tabs
  - Client filter, week selector, view toggle (`?view=`), Sync Now button
  - Yesterday page

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| `flowMetrics.ts` extraction subtly changes server output (constants, helpers, or transitive imports drift) | Unit 1 verifies byte-identical `FlowSnapshot` against `main` for the current week. Pure code-location refactor — no logic edits during the move. |
| `flowMetrics.ts` accidentally pulls in a server-only transitive import (e.g., a helper imports `./wrike/*`) | Hard constraint in Unit 1: grep the file and dependency tree for `wrike`, `node:`, `redis`, `fs`. Smoke-test by importing from a `"use client"` module. |
| Client `useMemo` recompute is slow on members with many tickets | Acceptable at current scale (low thousands of tickets bounded by the 90-day cutoff). Memo keys are stable; recompute only fires when toggle, week, or client changes. Revisit only if profiling shows a problem. |
| `TicketFlowTable`'s internal Active/Completed tabs become confusing when composed with the archive toggle | Confirm during Unit 3 manual QA. If users find the composition confusing, a future iteration can rename the tabs or add helper text. |
| Toggle resetting on every tab navigation surprises users | Per user direction this is intentional. Document review flagged it as friction-prone for an internal team that bounces between Overview and Flow; if rejected after a week of use, lift state into the shared layout (small change). |
| Migration cohort (`completedDate === null`) makes the toggle appear to "do nothing" for hundreds of legacy completed tasks | Documented as "Known limitation: migration cohort" in Key Technical Decisions. PR description must call this out explicitly so reviewers and users understand the behavior is deliberate. Follow-up options listed in that section. |
| `dailyFlow` / `CumulativeFlowDiagram` shows visibly different shape when toggling | Bounded impact: 90-day cutoff already caps history. Acceptable for v1; flag in PR description. If users complain, future iteration can pin `dailyFlow` to the full metric set regardless of toggle. |
| `ArchivedToggle` visual model is under-specified ("pill-style" is ambiguous) | Resolve in Unit 2 — pick HTML primitive (default: `button` with `aria-pressed`) and active/inactive class names matching `ClientChips`. |
| Header right-cluster grows to four controls; no responsive strategy specified | Verify in Unit 3 manual QA on a ~900px viewport. If the cluster wraps awkwardly, shorten the toggle label or move below the header. |
| 45-day threshold may not match Wrike's actual auto-archive setting | Verify *before* Unit 1 (open question marked deferred to implementation, owner: implementer). Adjust `ARCHIVE_THRESHOLD_DAYS` constant if needed — single-line change, no re-sync required since the rule is client-side. |

## Documentation / Operational Notes

- **No deployment migration required.** The feature is pure UI: filter + client recompute over already-fetched data. No re-sync, no snapshot regeneration, no env vars, no new API surface.
- PR description should call out: (1) intentional page-local toggle behavior (resets on navigation), (2) the 45-day rule, (3) the migration cohort known limitation (toggle appears to do nothing for tasks with `completedDate === null`), (4) the `flowBuilder.ts` → `flowMetrics.ts` extraction (pure code move, server output byte-identical to `main`).

## Sources & References

- Related code:
  - `src/app/page.tsx` (Overview page filtering + toggle wiring)
  - `src/app/flow/page.tsx` (Flow Details filtering + toggle wiring)
  - `src/components/TeamMemberCard.tsx` (per-member nested table, zero-count rendering)
  - `src/components/TicketFlowTable.tsx` (internal Active/Completed tabs — unchanged, composes with archive filter)
  - `src/components/TicketFlowDots.tsx` (alt view, same data)
  - `src/components/ClientChips.tsx` (visual reference for `ArchivedToggle`)
  - `src/lib/flowBuilder.ts` (`computeFlowMetrics` at line 295 → moves to `flowMetrics.ts`; per-employee inline path 566–612 → extracted to `computeEmployeeFlowMetrics`; `completedDate` fallback at line 285 — relevant for migration-cohort follow-up)
  - `src/lib/types.ts` (`TicketFlowEntry` line 144, `FlowSnapshot` line 185 — read-only, no changes)
- Related plans:
  - `docs/plans_completed/2026-04-07-003-feat-unified-client-dashboard-filter-plan.md` — established the URL-param filter pattern (deliberately not used here, per user direction)
  - `docs/plans_completed/2026-04-08-003-feat-agency-wide-tickets-table-plan.md` — established the page-level filtering interception point reused here
