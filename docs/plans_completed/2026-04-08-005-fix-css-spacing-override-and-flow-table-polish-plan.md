---
title: "fix: CSS spacing override collision and flow table polish"
type: fix
status: completed
date: 2026-04-08
---

# fix: CSS spacing override collision and flow table polish

## Overview

The custom `--spacing-*` CSS variables in `globals.css` collide with Tailwind v4's reserved namespace, breaking `max-w-sm` (collapses to 8px instead of 384px) and `max-w-md`. This broke the login page layout and potentially other uses of these utility classes. Additionally, the flow detail table has minor polish issues visible in QA screenshots.

## Problem Frame

Tailwind v4 uses `--spacing-*` as an internal namespace for its spacing scale. The `@theme` block in `globals.css` defined `--spacing-sm: 8px`, `--spacing-md: 16px`, etc., which overrode Tailwind's values. This caused `max-w-sm` to resolve to `max-width: 8px` instead of `max-width: 24rem`, collapsing any container using that class. The login page (`w-full max-w-sm`) was the most visible casualty.

Separately, the flow details table has minor readability issues: compressed stage duration cells, truncated column headers, and empty columns taking up space.

## Requirements Trace

- R1. Remove the Tailwind v4 namespace collision so `max-w-*` utilities work correctly
- R2. Login page renders at proper width (384px container)
- R3. Flow table column headers don't truncate ("Cycle", "Client Pending")
- R4. Stage duration cells in TicketFlowTable are readable at normal zoom
- R5. Empty effort/stage columns don't waste horizontal space when all values are dashes

## Scope Boundaries

- Not redesigning the flow table layout
- Not changing data pipeline behavior (empty stage durations are a data issue, not a UI issue)
- Not modifying the new TicketFlowDots component (it was just built and works correctly)

## Key Technical Decisions

- **Remove dead spacing variables entirely**: The `--spacing-xs` through `--spacing-2xl` variables are defined but never referenced in any component. Deleting them is the cleanest fix. (Already done during this session — Unit 1 is to verify and commit.)
- **Use `whitespace-nowrap` on column headers**: Prevents "Client Pending" and "Cycle" from wrapping at narrow widths.
- **Minimum column widths on stage cells**: The existing `min-w-[90px]` on stage headers may be too small for timestamp+duration content. Increase slightly.

## Implementation Units

- [x] **Unit 1: Remove `--spacing-*` overrides from globals.css**

  **Goal:** Eliminate the Tailwind v4 namespace collision.

  **Requirements:** R1, R2

  **Dependencies:** None

  **Files:**
  - Modify: `src/app/globals.css`

  **Approach:**
  - Delete the `/* Spacing scale (4px base) */` block (6 variables: xs, sm, md, lg, xl, 2xl)
  - These variables are never referenced outside their definition

  **Test expectation:** none — CSS variable removal, verified by visual inspection of login page

  **Verification:**
  - Login page renders at ~384px width, centered
  - `max-w-sm` in compiled CSS resolves to Tailwind's default (not `var(--spacing-sm)`)

  **Status:** Already completed during this session.

- [x] **Unit 2: Fix flow table column header truncation**

  **Goal:** Prevent "Client Pending" and "Cycle" column headers from truncating or wrapping.

  **Requirements:** R3

  **Dependencies:** None

  **Files:**
  - Modify: `src/components/TicketFlowTable.tsx`
  - Modify: `src/components/TicketFlowDots.tsx`

  **Approach:**
  - Add `whitespace-nowrap` to all stage column `<th>` elements
  - Ensure the "Cycle" sort header has a minimum width

  **Patterns to follow:**
  - Existing `min-w-[180px]` on the Task column header
  - Existing `min-w-[90px]` on stage column headers

  **Test expectation:** none — CSS styling only

  **Verification:**
  - "Client Pending" header displays fully without wrapping
  - "Cycle" header displays fully
  - Table remains horizontally scrollable when viewport is narrow

- [x] **Unit 3: Improve stage duration cell readability in TicketFlowTable**

  **Goal:** Make the timestamp + duration cells in the existing Tickets table more readable.

  **Requirements:** R4

  **Dependencies:** None

  **Files:**
  - Modify: `src/components/TicketFlowTable.tsx`

  **Approach:**
  - Increase `min-w` on stage columns from `90px` to `100px`
  - Ensure the timestamp text (`formatTimestamp`) and duration text (`formatDuration`) have enough contrast and size to read at normal zoom

  **Patterns to follow:**
  - Existing `durationColor()` function for background colors
  - Existing `text-[10px]` for timestamp, `text-xs` for duration

  **Test expectation:** none — CSS sizing adjustment

  **Verification:**
  - Stage cells with data show timestamp and duration without clipping
  - Table still fits within the card container with horizontal scroll

- [x] **Unit 4: Collapse empty columns gracefully**

  **Goal:** When all tickets in the current view have no data for a stage column (all dashes), reduce that column's visual weight.

  **Requirements:** R5

  **Dependencies:** Unit 2

  **Files:**
  - Modify: `src/components/TicketFlowTable.tsx`
  - Modify: `src/components/TicketFlowDots.tsx`

  **Approach:**
  - For each stage column, check if any visible ticket has a `StageDuration` for that stage
  - If the column is entirely empty (all dashes), apply a reduced `min-w` and muted header style
  - Keep the column visible (don't hide it) so the pipeline stages are always shown in order

  **Patterns to follow:**
  - The existing `getStageDuration()` function to check for data presence
  - The `filtered` array already computes visible tickets

  **Test scenarios:**
  - Happy path: Column with data -> renders at full width with normal header style
  - Happy path: Column with all dashes -> renders at reduced width with muted header
  - Edge case: Switching between All/Active/Completed tabs changes which columns have data -> column widths update
  - Edge case: Single ticket with data in a column -> column renders at full width

  **Verification:**
  - Empty stage columns take less horizontal space
  - Columns with data remain fully readable
  - Switching filter tabs recalculates column states

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Removing spacing vars breaks something we missed | Grep confirmed zero references outside globals.css |
| Column width changes cause horizontal overflow | Table already has `overflow-x-auto` wrapper |
| Empty column collapse logic adds complexity | Keep it simple — CSS class toggle based on a boolean, not dynamic width calculation |

## Sources & References

- CSS collision discovered during QA session on 2026-04-08
- Existing table: `src/components/TicketFlowTable.tsx`
- New dot view: `src/components/TicketFlowDots.tsx`
- Login page: `src/app/login/page.tsx`
- Global styles: `src/app/globals.css`
