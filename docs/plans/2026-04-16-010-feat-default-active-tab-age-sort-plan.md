---
title: "feat: Default to Active tab and sort by current-stage age"
type: feat
status: active
date: 2026-04-16
---

# feat: Default to Active tab and sort by current-stage age

## Overview

Change the Tickets section defaults so that (1) the "Active" tab is selected on page load instead of "All", and (2) tickets sort by longest time in their current stage (descending) instead of by total cycle time. This surfaces the most stale/blocked tickets first, which is the primary use case when reviewing the dashboard.

## Problem Frame

The current defaults show all 314 tickets sorted by total cycle time. Users almost always switch to "Active" immediately and care most about which tickets have been sitting in their current stage the longest — the ones needing attention. Making these the defaults eliminates two clicks on every page load.

## Requirements Trace

- R1. Default filter tab must be "Active" (not "All") on initial render
- R2. Default sort must order tickets by `currentStageAgeHours` descending (longest in current stage first)
- R3. Both `TicketFlowTable` and `TicketFlowDots` components must apply the same defaults
- R4. Users must still be able to switch to "All" / "Completed" tabs and change sort columns

## Scope Boundaries

- No changes to the API or backend data
- No new sort column header added — reuse the existing "Cycle" header or rename it to reflect the new default. The `cycleTime` sort key can remain available if users click the header to toggle
- No changes to sort direction toggle behavior

## Context & Research

### Relevant Code and Patterns

- `src/components/TicketFlowTable.tsx` — `useState<SortKey>("cycleTime")` at line 65, `useState("all")` at line 67, sort switch at lines 97–118
- `src/components/TicketFlowDots.tsx` — identical pattern at lines 67–69, sort switch at lines 101–120
- `TicketFlowEntry.currentStageAgeHours` already computed by `src/lib/flowBuilder.ts:196` — no new data needed

## Key Technical Decisions

- **Add `"currentStageAge"` as a new `SortKey` value** rather than repurposing `"cycleTime"`: Both sort dimensions are useful. `cycleTime` sorts by total Planned→Complete duration; `currentStageAge` sorts by time in current stage. Keep both available via header clicks.
- **Rename "Cycle" column header to "Age"**: The default sort is now current-stage age, so the primary column header should reflect that. `cycleTime` sort remains accessible if we add a small secondary header or keep the Cycle column — but the simplest approach is to rename the header label to "Age" and map it to the new `currentStageAge` key, while keeping `cycleTime` as an internal sort option without a dedicated header (it was never the most useful default).

**Decision update:** Actually, looking at the screenshot more carefully, "Cycle" is a separate rightmost column showing total cycle time. The cleanest approach: keep the "Cycle" column header mapped to `cycleTime`, and simply change the **default sort key** to `currentStageAge` without adding a new visible column. The sort is just the initial ordering — users can click "Cycle" to re-sort by cycle time if they want.

## Open Questions

### Resolved During Planning

- **Should we add a visible "Age" column header?** No — the request is about default ordering, not adding UI. The `currentStageAge` sort key is used as the default but doesn't need its own clickable column header. Users who want cycle-time sort can click the existing "Cycle" header.

### Deferred to Implementation

- None

## Implementation Units

- [ ] **Unit 1: Add currentStageAge sort key and change defaults in TicketFlowTable**

  **Goal:** Default to "Active" tab and sort by current-stage age descending

  **Requirements:** R1, R2, R3

  **Dependencies:** None

  **Files:**
  - Modify: `src/components/TicketFlowTable.tsx`

  **Approach:**
  - Add `"currentStageAge"` to the `SortKey` union type
  - Add sort case: `case "currentStageAge": cmp = a.currentStageAgeHours - b.currentStageAgeHours; break;`
  - Change default `sortKey` state from `"cycleTime"` to `"currentStageAge"`
  - Change default `filter` state from `"all"` to `"active"`
  - Default `sortAsc` remains `false` (descending = longest first)

  **Patterns to follow:**
  - Existing sort cases in the same switch statement (lines 99–115)
  - Existing filter state initialization pattern

  **Test scenarios:**
  - Happy path: Component renders with "Active" tab highlighted and completed tickets hidden on initial load
  - Happy path: Tickets appear in descending `currentStageAgeHours` order on initial render
  - Happy path: Clicking "All" tab shows all tickets including completed
  - Happy path: Clicking "Cycle" header re-sorts by total cycle time

  **Verification:**
  - On page load, only active tickets visible, sorted longest-in-current-stage first

- [ ] **Unit 2: Mirror changes in TicketFlowDots**

  **Goal:** Apply identical default changes to the dots variant component

  **Requirements:** R1, R2, R3

  **Dependencies:** Unit 1 (same pattern, apply after confirming approach)

  **Files:**
  - Modify: `src/components/TicketFlowDots.tsx`

  **Approach:**
  - Same four changes as Unit 1: add `"currentStageAge"` to `SortKey`, add sort case, change default `sortKey`, change default `filter`

  **Patterns to follow:**
  - Unit 1 changes (identical component structure)

  **Test scenarios:**
  - Happy path: TicketFlowDots renders with "Active" tab selected and age-descending sort by default

  **Verification:**
  - Dots view matches table view defaults

## System-Wide Impact

- **Interaction graph:** Only client-side state defaults change. No API, webhook, or backend impact.
- **API surface parity:** Both ticket view components (Table and Dots) get the same change.
- **Unchanged invariants:** All existing sort/filter behaviors remain available via user interaction. No data shape changes.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Active tab count not shown (currently only "All" shows count) | Minor UX gap — could add count to Active tab label, but out of scope for this change |
| `currentStageAgeHours` is 0 for tickets with no transition data | These sort to the bottom with descending order, which is correct behavior |
