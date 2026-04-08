---
title: "feat: Ticket Flow dot view with assignee filter alongside existing Tickets table"
type: feat
status: completed
date: 2026-04-08
---

# feat: Ticket Flow dot view with assignee filter alongside existing Tickets table

## Overview

Add a tabbed view to the ticket dashboard: a **Tickets** tab preserves the existing `TicketFlowTable` (timestamps, durations, move details), and a new **Ticket Flow** tab shows compact colored dot badges with day counts per stage plus an assignee filter. Both tabs operate on the same `FlowSnapshot` data — no new data fetching or storage. This lets the team evaluate both views side-by-side and decide which delivers the best signal.

## Problem Frame

The existing ticket table shows *when* tickets moved between stages (timestamps + hour durations), which is valuable for understanding individual transitions. But for spotting bottlenecks at a glance — "this ticket has been In Progress for 20 days with effort 3" — the timestamp detail is noise. The team needs a second view that trades precision for scanability: colored dots showing day counts per stage. Rather than replacing the existing view (which multiple developers use), both views should coexist behind tabs so the team can compare and decide which works best.

## Requirements Trace

- R1. A tab system switches between "Tickets" (existing table) and "Ticket Flow" (new dot view)
- R2. The Tickets tab renders the current `TicketFlowTable` exactly as-is — no changes
- R3. The Ticket Flow tab shows a table with circular dot badges displaying integer day counts per stage
- R4. Dots are color-coded by duration severity (green/amber/red)
- R5. The current stage dot has a visual ring highlight
- R6. Stages the ticket hasn't reached show a dash
- R7. An assignee filter dropdown scopes the Ticket Flow view to a specific team member
- R8. Both tabs use the same `TicketFlowEntry[]` data — no new API calls or storage
- R9. Effort column appears in both views for cross-referencing duration vs. effort
- R10. Cycle time column in Ticket Flow shows days for consistency with dots

## Scope Boundaries

- Not modifying the existing `TicketFlowTable` component
- Not adding new data fields or API endpoints
- Not changing the flow page layout, charts, or client/week selectors
- Not adding assignee resolution logic — assumes `assigneeName` is populated by the data pipeline
- The tab system lives wherever the `TicketFlowTable` is currently rendered (parent page), not inside the component itself

## Context & Research

### Relevant Code and Patterns

- `src/components/TicketFlowTable.tsx` — existing table component, stays unchanged. Has sort, filter tabs (All/Active/Completed), stage duration cells with timestamps + hours, effort badges
- `src/components/ClientSelector.tsx` — dropdown pattern for the assignee filter
- `src/lib/types.ts` — `TicketFlowEntry`, `StageDuration` (with `durationHours`), `FlowSnapshot`
- `src/app/flow/page.tsx` — parent page that renders `TicketFlowTable`, manages client/week state via URL params. This is where the tab system will live
- Effort score badge in TicketFlowTable (line 197) — the circular `rounded-full` badge pattern to replicate for stage dots
- All/Active/Completed filter tabs in TicketFlowTable (lines 131-146) — pattern for the tab UI at the parent level

### Institutional Learnings

- `docs/plans/2026-04-07-001-kanban-metrics-research.md` — cycle time, stage dwell time, and bottleneck identification are the core metrics

## Key Technical Decisions

- **Two separate components, not a prop-driven mode**: Create a new `TicketFlowDots` component rather than adding a `mode` prop to `TicketFlowTable`. Rationale: the existing table is working and used by multiple developers. A separate component avoids risk of breaking it and keeps each view focused.
- **Tab system lives in the parent page**: The flow page (`src/app/flow/page.tsx`) renders a tab bar and conditionally renders either `TicketFlowTable` or `TicketFlowDots`. Rationale: the tab choice is a page-level concern, not a component-level one. Both components receive the same `tickets` prop.
- **Tab state as URL param**: Use `?view=tickets` / `?view=flow` so the tab choice is shareable and survives page refresh. Rationale: follows the existing pattern of `?client=` and `?week=` URL params on this page.
- **Dots show integer days**: Display rounded days, with "<1" for sub-day. Rationale: scanability over precision; the Tickets tab has the precise timestamps if needed.
- **Day-based color thresholds**: Green (0-2 days), amber (3-5 days), red (6+ days). Tunable constants.
- **Assignee filter in TicketFlowDots only**: The existing Tickets tab doesn't have it and shouldn't change. The new Ticket Flow view gets the assignee dropdown.

## Open Questions

### Resolved During Planning

- **Replace or coexist?** Coexist — both views behind tabs so the team can compare.
- **Same data?** Yes — both views consume the same `TicketFlowEntry[]` from `FlowSnapshot`.
- **Where do tabs live?** Parent page, not inside either component.

### Deferred to Implementation

- **Exact day thresholds for color coding**: 2/5 day breakpoints are a starting point; tune after seeing real data.
- **Whether to persist tab choice in localStorage**: Start with URL param only; add localStorage if needed.
- **Tooltip detail on dots**: Likely useful (entry timestamp + exact hours on hover), but defer exact content to implementation.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```
flow/page.tsx
├── Client selector, Week selector, Sync button (unchanged)
├── Charts section (unchanged)
├── Tab bar: [ Tickets | Ticket Flow ]
│   ├── Tickets tab → <TicketFlowTable tickets={...} />  (existing, unchanged)
│   └── Ticket Flow tab → <TicketFlowDots tickets={...} />  (new component)
│       ├── Assignee filter dropdown
│       ├── All / Active / Completed tabs (replicated)
│       └── Table with dot badges per stage

Ticket Flow row:
| Task Title | Assignee | Effort | New | Planned | In Progress | In Review | Pending | Completed | Cycle |
|            | J. Doe   |  [3]   | [1] |   [3]   |    [20]     |           |         |           | 24d   |
                          blue    green   green       RED          dash       dash       dash
                          dot     dot     dot         dot
                                                   (ring=current)
```

## Implementation Units

- [ ] **Unit 1: Add tab system to flow page**

  **Goal:** Add a Tickets / Ticket Flow tab bar to the flow page that switches between the existing table and the new view (placeholder initially).

  **Requirements:** R1, R2, R8

  **Dependencies:** None

  **Files:**
  - Modify: `src/app/flow/page.tsx`

  **Approach:**
  - Add a `view` URL search param (`tickets` | `flow`, default `tickets`)
  - Render a tab bar above the table area, styled consistently with the existing filter tabs pattern
  - When `view=tickets`, render the existing `<TicketFlowTable>` exactly as today
  - When `view=flow`, render a placeholder (replaced in Unit 2)
  - Integrate with the existing `useSearchParams` / URL param pattern already used for `client` and `week`

  **Patterns to follow:**
  - Existing URL param handling in `src/app/flow/page.tsx` for client/week
  - Filter tab styling from `TicketFlowTable` (lines 131-146)

  **Test scenarios:**
  - Happy path: Page loads with no `view` param -> shows Tickets tab (existing table)
  - Happy path: Click "Ticket Flow" tab -> URL updates to `?view=flow`, view switches
  - Happy path: Click "Tickets" tab -> URL updates to `?view=tickets`, existing table shows
  - Integration: Tab persists alongside `client` and `week` params -> `?client=Clinic+27&week=2026-W14&view=flow` works
  - Edge case: Invalid `view` param value -> defaults to Tickets

  **Verification:**
  - Tab bar appears above the table
  - Clicking tabs switches views and updates URL
  - Existing Tickets view is completely unchanged

- [ ] **Unit 2: Create TicketFlowDots component**

  **Goal:** Build the new dot-badge table component that shows day counts per stage with color coding.

  **Requirements:** R3, R4, R5, R6, R9, R10

  **Dependencies:** Unit 1 (needs the tab system to render it, but can be built in parallel)

  **Files:**
  - Create: `src/components/TicketFlowDots.tsx`
  - Modify: `src/app/flow/page.tsx` (import and render in the flow tab)

  **Approach:**
  - Accept same `TicketFlowTableProps` interface (`tickets`, `showAssignee`, `showClient`)
  - Replicate the table structure: Task, Assignee, Effort, six stage columns, Cycle
  - Stage cells: circular dot badge with integer day count (durationHours / 24, rounded). Sub-day shows "<1"
  - Color function: green (0-2d), amber (3-5d), red (6+d) — defined as named constants for easy tuning
  - Current stage dot gets `ring-2 ring-blue-400`
  - Missing stages show dash
  - Cycle column: show "Xd" for completed, "Xd (active)" for in-progress, dash for no data
  - Include All/Active/Completed filter tabs (replicate from TicketFlowTable)
  - Include sort by title, effort, currentStage, cycleTime, assignee (replicate sort logic)
  - Add `title` attribute on dots for hover tooltip: "Entered: Mon 14:30 | 52.3h"

  **Patterns to follow:**
  - Effort badge in TicketFlowTable line 197: `inline-flex items-center justify-center rounded-full` pattern
  - Sort/filter logic from TicketFlowTable
  - `durationColor()` pattern but with day thresholds

  **Test scenarios:**
  - Happy path: Ticket with 52 hours in "In Progress" -> dot shows "2" with green background
  - Happy path: Ticket with 150 hours (6.25 days) in "New" -> dot shows "6" with red background
  - Edge case: Ticket with 0.5 hours -> dot shows "<1" with green background
  - Edge case: No `StageDuration` for a stage -> cell shows dash
  - Happy path: Current stage dot has blue ring, others don't
  - Edge case: Exactly 24 hours -> shows "1" with green background
  - Happy path: Completed ticket cycle 576h -> Cycle column shows "24d"
  - Happy path: Active ticket execution 48h -> Cycle column shows "2d (active)"
  - Edge case: Hovering a dot shows tooltip with entry timestamp and precise hours
  - Happy path: All/Active/Completed tabs filter correctly
  - Happy path: Sort by effort, cycle time, title all work

  **Verification:**
  - Table renders with circular dots showing day counts
  - Colors reflect severity thresholds
  - Current stage visually distinct
  - Sort and filter work as expected
  - Cycle column shows days

- [ ] **Unit 3: Add assignee filter to TicketFlowDots**

  **Goal:** Add a dropdown in the Ticket Flow view that filters by assignee.

  **Requirements:** R7

  **Dependencies:** Unit 2

  **Files:**
  - Modify: `src/components/TicketFlowDots.tsx`

  **Approach:**
  - Add `assigneeFilter` state (string, default empty = all)
  - Derive unique assignee names from `tickets` prop, sorted alphabetically
  - Render a `<select>` dropdown in the filter bar next to the All/Active/Completed tabs
  - Apply filter: if assignee selected, include only tickets where `assigneeName` matches
  - Assignee filter combines with status filter (both apply)

  **Patterns to follow:**
  - `src/components/ClientSelector.tsx` — select element with onChange
  - Filter bar layout in TicketFlowTable

  **Test scenarios:**
  - Happy path: Select "Jane Doe" -> only Jane's tickets shown
  - Happy path: Select "All Assignees" -> all tickets shown
  - Edge case: All "Unknown" assignees -> dropdown shows "All Assignees" and "Unknown"
  - Integration: Assignee + Active tab -> only active tickets from that assignee
  - Edge case: Only one unique assignee -> dropdown still renders with that name and "All"

  **Verification:**
  - Dropdown appears in filter bar
  - Filtering works correctly in combination with status tabs

## System-Wide Impact

- **Interaction graph:** The flow page (`src/app/flow/page.tsx`) gains a tab bar and conditionally renders one of two components. The existing `TicketFlowTable` is NOT modified. A new `TicketFlowDots` component is created.
- **Error propagation:** No new failure modes — both views consume the same already-fetched data.
- **State lifecycle risks:** Tab state stored as URL param; no persistence concerns. Assignee filter is ephemeral component state within `TicketFlowDots`.
- **API surface parity:** If `TicketFlowTable` is rendered elsewhere (e.g., overview page), those usages are unaffected. The tab system only lives on the flow page.
- **Unchanged invariants:** `FlowSnapshot` data model, `/api/flow` endpoint, existing `TicketFlowTable` component, client selector, week selector, charts — all unchanged.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Data pipeline not populating `stageDurations` — dots show dashes | Graceful degradation. The Tickets tab remains as fallback. Both views handle empty data. |
| `assigneeName` showing "Unknown" — filter has limited value | Filter still functions. "Unknown" appears as a filterable option. Value improves as pipeline populates names. |
| Duplicated sort/filter logic between the two components | Acceptable for now. If both views stick around long-term, extract shared logic into a hook. |
| Day thresholds (2/5) may not match team expectations | Defined as named constants, easy to tune after seeing real data. |

## Sources & References

- Related research: `docs/plans/2026-04-07-001-kanban-metrics-research.md`
- Existing table: `src/components/TicketFlowTable.tsx`
- Parent page: `src/app/flow/page.tsx`
- Filter pattern: `src/components/ClientSelector.tsx`
- Type definitions: `src/lib/types.ts`
