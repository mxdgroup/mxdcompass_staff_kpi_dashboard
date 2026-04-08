---
title: "feat: Show tickets table at agency and organisation level"
type: feat
status: completed
date: 2026-04-08
---

# feat: Show tickets table at agency and organisation level

## Overview

The tickets table currently only renders on the Overview page when a specific client is selected. This plan makes the table always visible — at the agency level (no client selected) it shows all tickets across every client, and when a client is selected it filters to that client's tickets. The table should also show the client column when viewing agency-wide so tickets are distinguishable.

## Problem Frame

Users need to see all active tickets across the organisation from the Overview page without clicking into a specific client. The current UX requires selecting a client first, which prevents a quick cross-client view of work in progress. The Flow Details page already shows all tickets agency-wide — this brings the same visibility to the Overview page.

## Requirements Trace

- R1. Tickets table is always visible on the Overview page, regardless of client selection
- R2. When no client is selected, the table shows ALL tickets with a client column visible
- R3. When a client is selected, the table filters to that client's tickets (existing behaviour preserved)
- R4. Client filter dropdown does not control ticket table visibility — only content filtering

## Scope Boundaries

- No changes to the Flow Details page (`src/app/flow/page.tsx`) — it already shows all tickets
- No changes to the API, data fetching, or `FlowSnapshot` shape — all ticket data is already fetched
- No changes to `TicketFlowTable` component — it already supports `showClient` prop

## Context & Research

### Relevant Code and Patterns

- `src/app/page.tsx:178-180` — `filteredTickets` returns `[]` when no client is selected; this is the root cause
- `src/app/page.tsx:285` — `{selectedClient && (...)}` conditional hides the entire tickets section
- `src/app/flow/page.tsx:97-99` — Flow page already does this correctly: returns all tickets when no client selected
- `src/components/TicketFlowTable.tsx` — Already accepts `showClient?: boolean` prop

## Key Technical Decisions

- **Follow the Flow page pattern**: The flow page at line 97-99 already returns all tickets when no client is selected and toggles `showClient` based on selection. Mirror this exact pattern on the Overview page.
- **Show client column in agency view**: When viewing all tickets, the client column is essential to distinguish which client each ticket belongs to. Pass `showClient={!selectedClient}` just like the Flow page does.

## Implementation Units

- [x] **Unit 1: Show tickets table at agency level on Overview page**

**Goal:** Make the tickets table always visible and show all tickets when no client is selected

**Requirements:** R1, R2, R3, R4

**Dependencies:** None

**Files:**
- Modify: `src/app/page.tsx`

**Approach:**
Two changes in `src/app/page.tsx`:
1. Change `filteredTickets` (line 178-180) from returning `[]` to returning all tickets when no client is selected — match the pattern from `src/app/flow/page.tsx:97-99`
2. Remove the `{selectedClient && (...)}` guard around the tickets section (line 285) so the table always renders
3. Add `showClient={!selectedClient}` to the `TicketFlowTable` to show the client column in agency view

**Patterns to follow:**
- `src/app/flow/page.tsx:97-99` — exact pattern for ticket filtering without client
- `src/app/flow/page.tsx:185-189` — exact pattern for `showClient` toggle

**Test scenarios:**
- Happy path: Load Overview with no client selected → tickets table visible with all tickets and client column shown
- Happy path: Select a client → tickets table filters to that client's tickets, client column hidden
- Happy path: Deselect client (back to "All Clients") → tickets table shows all tickets again with client column
- Edge case: No flow data loaded → tickets section shows 0 tickets gracefully (empty `[]` from `?? []` fallback)

**Verification:**
- Tickets table is visible on page load without selecting a client
- Ticket count in the header matches total tickets across all clients
- Client column appears in agency view and disappears in client view
- Selecting/deselecting clients correctly filters the table content

## System-Wide Impact

- **Interaction graph:** No callbacks, middleware, or API changes — purely UI rendering logic
- **Unchanged invariants:** Flow Details page, API responses, `TicketFlowTable` component, and data fetching all remain untouched

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Large ticket count could make page long | Acceptable — the Flow page already shows all tickets without issues. Table has built-in Active/Completed filter tabs |

## Sources & References

- Related code: `src/app/flow/page.tsx` (reference implementation)
- Related code: `src/components/TicketFlowTable.tsx` (existing component with `showClient` support)
