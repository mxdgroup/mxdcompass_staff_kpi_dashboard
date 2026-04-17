---
title: Add Tickets / Ticket Flow toggle to home dashboard
type: feat
status: completed
date: 2026-04-17
---

# Add Tickets / Ticket Flow toggle to home dashboard

## Overview

The Flow Details page (`/flow`) already offers a `Tickets` vs. `Ticket Flow` view toggle in the top-right of its ticket section, switching between the detailed `TicketFlowTable` (timestamped stage cells) and the compact `TicketFlowDots` (day-count dot badges per stage). The home dashboard (`/`) renders only `TicketFlowTable`. This plan adds the same two-view toggle to the home page's Tickets section so users can swap between the table and dot visualizations without navigating away.

## Problem Frame

Users viewing the agency dashboard need both the high-information table (for triage and aging) and the compact dot visualization (for at-a-glance pipeline scan). Today, the dot view only exists on `/flow`, forcing a page navigation and loss of home-page context (client chips, team cards, attention items). Parity with the flow page is the intent.

## Requirements Trace

- R1. A `Tickets` / `Ticket Flow` segmented toggle appears in the home page's Tickets section, visually matching the flow details page toggle.
- R2. Selecting `Tickets` renders `TicketFlowTable` (current default).
- R3. Selecting `Ticket Flow` renders `TicketFlowDots`.
- R4. The existing home-page Tickets section behavior is preserved: client filtering, archived toggle, resync action (when in table view), ticket count header.
- R5. Toggle state is local to the home page — it does not persist across navigations or reloads.
- R6. Toggling views (on either `/` or `/flow`) must not cause a scroll-to-top jump. The home page uses local state so this is automatic; the `/flow` page must preserve scroll across its `router.replace` calls.

## Scope Boundaries

- No URL/query-param persistence for the home-page view (the home page does not use searchParams; flow page does — this asymmetry is intentional).
- No changes to `TicketFlowTable` or `TicketFlowDots` internals.
- On `/flow`, the only change is adding `{ scroll: false }` to the `router.replace` call so toggling view (and other param changes) no longer scrolls the page to the top. No other behavioral changes to the flow page.
- `onResyncTask` remains wired to table view only; `TicketFlowDots` does not accept it today, and this plan does not extend it.
- No new shared component extraction — the toggle block is small enough that inlining it in both pages is simpler than abstracting.

## Context & Research

### Relevant Code and Patterns

- `src/app/flow/page.tsx:28-29` — reads `view` from search params; `activeView = viewParam === "flow" ? "flow" : "tickets"`.
- `src/app/flow/page.tsx:62-76` — the `updateParams` callback that calls `router.replace(...)`; Next.js App Router scrolls to top by default on `replace`, which causes the observed jump when toggling view / week / client. Fix: pass `{ scroll: false }` as the second argument.
- `src/app/flow/page.tsx:227-263` — the container card that holds the toggle buttons, "All Tickets (count)" header, and the conditional table/dots render. This is the exact block to mirror on the home page.
- `src/app/page.tsx:368-384` — current home-page Tickets section. Heading + count live outside the card; the card contains only `TicketFlowTable`.
- `src/components/TicketFlowTable.tsx` and `src/components/TicketFlowDots.tsx` — both components manage their own `all` / `active` / `completed` filter tabs internally (lines 80 and 81 respectively), so switching views does not need to preserve that sub-state.

### Institutional Learnings

- None applicable in `docs/solutions/` (directory does not exist).

### External References

- None needed — pure internal parity change.

## Key Technical Decisions

- **Local state, not URL params:** the home page already uses local `useState` for `selectedClient`, `showArchived`, `week`, etc., and has no `useSearchParams` hook. Adding URL state just for this toggle would mean wiring `useSearchParams` + `useRouter` + the client-param scrub pattern used on `/flow`. Local state matches the page's existing idiom and the user stated no expectation of persistence. Bonus: local state means no `router.replace` call, so no scroll-to-top jump.
- **Toggle placement mirrors `/flow`:** the toggle lives inside the card header, top-right, next to a repositioned "All Tickets (count)" label — not outside the card with the section heading. This keeps the visual language identical to the flow page.
- **Keep the existing section heading ("Tickets" + count) outside the card:** the home page's overall section rhythm (see Clients, Team, etc.) uses an external h2 + right-side count. Dropping that to match the flow page exactly would visually break the home page's pattern. So the home page will have *both*: the existing section heading above the card, and the in-card header mirroring the flow toggle row. The in-card header's count can be elided (or shown as `All Tickets` without the repeated count) to avoid duplication.
- **Do not pass `onResyncTask` to dots view:** component signature does not accept it, and resync is a table-only affordance today. No scope expansion.
- **Preserve scroll on `/flow` param updates:** adding `{ scroll: false }` to the `router.replace` call in `updateParams` keeps URL-driven deep-linking intact while eliminating the jump-to-top behavior that affects the view toggle, week selector, and client selector on `/flow`. This is strictly better than the current behavior; no tradeoff.

## Open Questions

### Resolved During Planning

- Should the in-card header duplicate the ticket count shown above? — No, render `All Tickets` without the count in the card header to avoid duplication while preserving the flow-page structure.
- Should the view selection persist across sessions or navigations? — No; local state only, matching the user's brief.

### Deferred to Implementation

- None.

## Implementation Units

- [ ] **Unit 1: Add view toggle to home page Tickets section**

**Goal:** Replicate the flow page's `Tickets` / `Ticket Flow` toggle on the home dashboard, swapping between `TicketFlowTable` and `TicketFlowDots`.

**Requirements:** R1, R2, R3, R4, R5

**Dependencies:** None.

**Files:**
- Modify: `src/app/page.tsx`

**Approach:**
- Add `const [ticketView, setTicketView] = useState<"tickets" | "flow">("tickets");` alongside the existing state hooks near the top of `DashboardPage`.
- Import `TicketFlowDots` from `@/components/TicketFlowDots` next to the existing `TicketFlowTable` import.
- Restructure the Tickets section (`src/app/page.tsx:368-384`) so that inside the existing card `<div className="rounded-xl bg-surface-raised ...">` a header row is added above the table/dots render. That header row mirrors `src/app/flow/page.tsx:229-248`: a muted "All Tickets" label on the left and a two-button segmented control on the right with the same class names (`bg-gray-900 text-white` for active, `bg-gray-100 text-gray-600 hover:bg-gray-200` for inactive; `px-2.5 py-1 text-xs rounded-md font-medium`).
- Conditionally render `TicketFlowTable` (with `onResyncTask={resyncTask}`) when `ticketView === "tickets"`, else `TicketFlowDots` (no `onResyncTask` prop).
- Leave the outer `<section>` heading (`Tickets` + `{filteredTickets.length} tickets`) unchanged so the home page's section rhythm stays consistent with Clients / Team / Attention sections.
- Because the toggle uses local state, clicking it does not trigger navigation — React swaps the inner render in place and scroll position is naturally preserved.

**Patterns to follow:**
- `src/app/flow/page.tsx:227-263` — copy the in-card header + toggle markup verbatim, adapting state hooks from `activeView` / `updateParams` to `ticketView` / `setTicketView`.
- Toggle button class conventions are shared with `TicketFlowTable`'s internal filter tabs (`src/components/TicketFlowTable.tsx:163-176`) — reuse the same Tailwind classes for visual consistency.

**Test scenarios:**
- Happy path: Load `/`; default view shows the table (current behavior preserved); "Tickets" button shows the active state.
- Happy path: Click "Ticket Flow"; table unmounts, dots render with the same filtered ticket set; "Ticket Flow" button shows active state.
- Happy path: Click "Tickets"; dots unmount, table re-renders with the same filtered ticket set.
- Edge case: Select a specific client from the client chip or selector, then toggle views — both views receive the client-filtered tickets.
- Edge case: Toggle the archived switch, then toggle views — both views reflect the archived setting.
- Integration: In table view, the per-row resync button is still visible and functional; in dots view, no resync control renders (by design).
- Edge case: Zero-ticket state (e.g., a client with no tickets this week) — both views render their "No tickets for this period" empty state identically.
- Edge case: Scroll down to the Tickets section, then click the toggle — page does not jump to top; the Tickets card remains in the viewport.

**Verification:**
- Home page renders the toggle exactly like `/flow` visually.
- Default view is `Tickets`.
- Switching views changes only the inner render; client/archive filters, counts, and section layout remain stable.
- Scroll position is preserved when toggling.
- No TypeScript errors; no regressions on `/flow`.

- [ ] **Unit 2: Preserve scroll position on `/flow` param updates**

**Goal:** Eliminate the scroll-to-top jump that happens every time a user changes view, week, or client on `/flow`.

**Requirements:** R6

**Dependencies:** None (independent of Unit 1).

**Files:**
- Modify: `src/app/flow/page.tsx`

**Approach:**
- In the `updateParams` callback (`src/app/flow/page.tsx:62-76`), change the `router.replace(...)` call to pass `{ scroll: false }` as the second argument: `router.replace(qs ? \`/flow?${qs}\` : "/flow", { scroll: false })`.
- This is the one and only change to `/flow` in this plan. It applies to view toggle, week selector, and client selector since all three funnel through `updateParams`.
- The `router.replace` in the invalid-client-scrub `useEffect` (`src/app/flow/page.tsx:33-40`) also runs at mount; it is harmless to add `{ scroll: false }` there too for consistency, but strictly not required since it runs before the user has scrolled.

**Patterns to follow:**
- Next.js App Router `router.replace(href, { scroll: false })` option — documented behavior for preserving scroll across same-route param updates.

**Test scenarios:**
- Happy path: Scroll down on `/flow`, click `Ticket Flow` toggle — URL updates to `?view=flow`, content swaps, scroll position is preserved.
- Happy path: Scroll down on `/flow`, change week via `WeekSelector` — URL updates, content refetches, scroll position is preserved.
- Happy path: Scroll down on `/flow`, change client via `ClientSelector` — URL updates, scroll position is preserved.
- Edge case: Navigating *to* `/flow` from another route (e.g., the home page `NavTabs` link) should still land at the top — unaffected by this change, which only alters same-route `replace` behavior.
- Edge case: Deep-linking into `/flow?view=flow&week=2026-W15` still works exactly as before; URL-driven state is unchanged.

**Verification:**
- No `router.replace(...)` call in `src/app/flow/page.tsx` scrolls the window on toggle/week/client changes.
- Cross-route navigation to `/flow` still scrolls to top as expected.
- No regressions in URL state behavior.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Duplicate toggle markup drifts from `/flow` over time | Accept local duplication for now; if a third call site appears, extract a `TicketViewToggle` component then. |
| Users expect the view to persist across reloads (it won't) | Matches the explicit decision above; easy to add URL/localStorage persistence later if feedback surfaces it. |

## Sources & References

- Related code:
  - `src/app/flow/page.tsx` (the toggle pattern being lifted)
  - `src/app/page.tsx` (home page Tickets section)
  - `src/components/TicketFlowTable.tsx`
  - `src/components/TicketFlowDots.tsx`
- Attachments: `.context/attachments/Screenshot 2026-04-17 at 09.03.47.png` (home page current state), `.context/attachments/Screenshot 2026-04-17 at 09.04.32.png` (flow page target toggle).
