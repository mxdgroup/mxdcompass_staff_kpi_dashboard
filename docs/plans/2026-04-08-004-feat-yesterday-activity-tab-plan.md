---
title: "feat: Rebuild Yesterday activity tab with design system"
type: feat
status: active
date: 2026-04-08
---

# feat: Rebuild Yesterday activity tab with design system

## Overview

Rebuild the "Yesterday" tab that was removed in commit `5946662` during the design system overhaul. The tab shows a per-person daily activity feed — ticket movements between workflow stages, completions, and timestamps — so the team can get a quick standup-style overview of everything that happened the previous day. The rebuild aligns with the current design system (OKLCH brand tokens, `surface-raised` cards, Inter font, `rounded-xl` card pattern, role badges).

## Problem Frame

The team lost visibility into daily activity when the Yesterday tab was removed alongside the unified client dashboard filter overhaul. The underlying transition infrastructure (`getTransitionsInRange`) still works — only the page, API route, and nav tab entry were deleted.

## Requirements Trace

- R1. A "Yesterday" tab appears in the top nav alongside Overview and Flow Details
- R2. The page shows all team members, grouped by person, with their ticket movements from the previous day (midnight-to-midnight UTC)
- R3. Each movement shows: task title (linked to Wrike), from-stage → to-stage, timestamp, and a completion indicator
- R4. Members with no activity are included (for standup visibility) but sorted below active members
- R5. Summary stats per member: total moves and total completions
- R6. The page uses the current design system — `surface-raised` cards, brand color tokens, role badges matching `TeamMemberCard`, proper loading/error/empty states
- R7. Auth-gated (401 → redirect to login), matching existing page pattern

## Scope Boundaries

- No GitHub commit data on this page (transitions/movements only — GitHub activity is tracked on Overview)
- No client filtering on the Yesterday page (it's a team-wide standup view)
- No comments or time entries — only `TaskStatusChanged` webhook transitions
- No new storage layer or caching — the API computes on-the-fly from Redis sorted sets

## Context & Research

### Relevant Code and Patterns

- `src/components/NavTabs.tsx` — static `TABS` array, add `{ label: "Yesterday", href: "/yesterday" }`
- `src/app/page.tsx` — reference for page structure: `"use client"`, `useState`/`useEffect`, `NavTabs`, loading skeletons, error banner, auth redirect
- `src/app/api/dashboard/route.ts` — reference for API route pattern: `loadOverridesFromRedis()` → `isAuthenticated()` → fetch data → `NextResponse.json()`
- `src/lib/wrike/transitions.ts` — `getTransitionsInRange(startTs, endTs)` already supports arbitrary date ranges
- `src/lib/wrike/fetcher.ts` — `resolveWorkflowStatuses()` for status ID → name mapping
- `src/lib/flowStorage.ts` — `getFlowLatestWeek()` + `getFlowSnapshot()` for task title enrichment
- `src/lib/config.ts` — `config.team`, `getMemberByContactId()`, `Role` type
- `src/components/TeamMemberCard.tsx` — `ROLE_BADGE` pattern (`bg-brand-50 text-brand-700` for dev, `bg-violet-50 text-violet-700` for design, `bg-emerald-50 text-emerald-700` for AM)
- Design tokens in `src/app/globals.css` — OKLCH brand colors, surface tokens, shadow-card

### Prior Implementation

The deleted feature (commit `ff0327a`) serves as the functional reference. Key differences for the rebuild:
- Old version used `bg-blue-100`/`bg-white` styling → new version uses design system tokens
- Old version used `max-w-7xl px-4` → new version uses `max-w-6xl px-6` (current standard)
- Old version used `rounded-lg` cards → new version uses `rounded-xl bg-surface-raised shadow-[var(--shadow-card)] border border-gray-100/80`

## Key Technical Decisions

- **Compute on-the-fly, no new storage**: Yesterday's transitions are a small Redis sorted-set range query (one day). No need for a daily snapshot or caching layer — matches the deleted version's approach.
- **Types co-located with API route**: Define `YesterdayApiResponse`, `YesterdayMember`, `YesterdayTransition` interfaces in the API route file and import them from the page component (matches the deleted version's pattern; the rest of the app uses `src/lib/types.ts` for shared snapshot types but these are API-specific).
- **Reuse existing role badge pattern**: Mirror `ROLE_BADGE` from `TeamMemberCard` for visual consistency rather than defining a separate mapping.
- **Page component in `src/app/yesterday/page.tsx`**: Follows App Router convention. Separate component files only if the page grows beyond ~200 lines — start with everything in one file.

## Open Questions

### Resolved During Planning

- **Should this page support client filtering?** No — it's a team-wide standup view. Filtering by client would fragment the per-person activity view.
- **Should GitHub commits be included?** Not in v1 — the original didn't include them and the primary value is Wrike workflow visibility.

### Deferred to Implementation

- **Exact role badge import strategy**: Whether to import `ROLE_BADGE` from `TeamMemberCard` or duplicate a small mapping depends on whether `TeamMemberCard` exports it. Resolve during implementation.
- **Timezone display**: The original used UTC timestamps. Whether to add local timezone display can be decided during implementation.

## Implementation Units

- [ ] **Unit 1: Yesterday API route**

**Goal:** Create the backend endpoint that computes yesterday's per-member activity from Redis transitions.

**Requirements:** R2, R3, R4, R5, R7

**Dependencies:** None — uses existing infrastructure

**Files:**
- Create: `src/app/api/yesterday/route.ts`
- Test: `src/app/api/yesterday/__tests__/route.test.ts`

**Approach:**
- Follow the deleted implementation's logic: compute yesterday midnight-to-midnight UTC, query `getTransitionsInRange`, resolve status names via `resolveWorkflowStatuses`, enrich task titles from latest flow snapshot, group by `eventAuthorId`
- Include all team members (even those with no activity) using `config.team`
- Sort: active members first, then alphabetical
- Auth guard with `isAuthenticated()` returning 401

**Patterns to follow:**
- `src/app/api/dashboard/route.ts` for route structure
- `src/lib/wrike/transitions.ts` for transition querying
- `src/lib/flowStorage.ts` for task title enrichment

**Test scenarios:**
- Happy path: 3 team members, 2 with transitions, 1 without → response includes all 3, sorted correctly, active first
- Happy path: transition with a completed status ID → `isCompletion: true` on that transition
- Edge case: no transitions for any team member → all members present with `totalMoves: 0`, empty transitions arrays
- Edge case: transition by an unknown contact ID (not in `config.team`) → still included with contactId as name fallback
- Error path: `resolveWorkflowStatuses` throws → status IDs used as fallback names, response still returns
- Error path: flow snapshot unavailable → task titles fall back to `Task {id}`
- Error path: unauthenticated request → 401 response

**Verification:**
- `GET /kpi/api/yesterday` returns `YesterdayApiResponse` JSON with correct date, all team members, and properly resolved transitions

---

- [ ] **Unit 2: Yesterday page component**

**Goal:** Create the client-side page that renders the daily activity feed per team member.

**Requirements:** R2, R3, R4, R5, R6, R7

**Dependencies:** Unit 1 (API route)

**Files:**
- Create: `src/app/yesterday/page.tsx`

**Approach:**
- `"use client"` page with `useState`/`useEffect` fetching `/kpi/api/yesterday`
- Three states: loading (skeleton cards), error (red banner), and data display
- Each member rendered as a `surface-raised` card with role badge, move/completion counts, and transition list
- Stage transition pills: `fromStage` → `toStage` with completion stages highlighted in green
- Task titles linked to Wrike permalink
- Empty activity message for members with no transitions
- Main wrapper: `<main className="mx-auto max-w-6xl px-6 py-6 space-y-10">`

**Patterns to follow:**
- `src/app/page.tsx` for page structure (NavTabs, loading, error, auth redirect)
- `src/components/AgencyOverview.tsx` for card styling (`rounded-xl bg-surface-raised p-5 shadow-[var(--shadow-card)] border border-gray-100/80`)
- `src/components/TeamMemberCard.tsx` for role badge colors
- Section header pattern: `text-lg font-semibold tracking-tight text-gray-900`

**Test scenarios:**
- Happy path: page renders NavTabs, date heading, and member cards with transition rows
- Happy path: completion transitions show green checkmark and green stage pill
- Edge case: no activity for anyone → centered empty state message
- Edge case: member with no activity → card shows "No task movements recorded yesterday" with muted styling
- Error path: API returns error → red error banner displayed
- Error path: 401 response → redirect to `/kpi/login`

**Verification:**
- Navigating to `/kpi/yesterday` shows the Yesterday page with proper design system styling, member cards, and transition details

---

- [ ] **Unit 3: Add Yesterday tab to navigation**

**Goal:** Add the Yesterday entry to the NavTabs component so it appears in the top navigation.

**Requirements:** R1

**Dependencies:** Unit 2 (page exists to navigate to)

**Files:**
- Modify: `src/components/NavTabs.tsx`

**Approach:**
- Add `{ label: "Yesterday", href: "/yesterday" }` to the `TABS` array
- No other changes needed — active state detection via `usePathname()` handles it automatically

**Patterns to follow:**
- Existing `TABS` array structure in `NavTabs.tsx`

**Test scenarios:**
- Happy path: NavTabs renders 3 tabs — Overview, Flow Details, Yesterday
- Happy path: navigating to `/yesterday` highlights the Yesterday tab as active

**Verification:**
- All three tabs visible in navigation; Yesterday tab navigable and highlights correctly when active

## System-Wide Impact

- **Interaction graph:** The API route reads from Redis sorted sets (webhook-stored transitions) and the flow snapshot (sync-stored). No writes. NavTabs is rendered on every page — adding a tab affects all pages visually.
- **Error propagation:** API failures (Redis, Wrike status resolution, flow snapshot) are caught and degraded gracefully — the route returns partial data rather than 500s, matching the deleted implementation's resilience pattern.
- **State lifecycle risks:** None — the route is stateless and computes on-the-fly. No caching, no writes.
- **Unchanged invariants:** Overview and Flow Details pages, their API routes, the sync pipeline, and webhook processing are completely unaffected. The transition storage format in Redis is read-only from this feature's perspective.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Wrike contact IDs not populated in config (TODOs in `config.ts`) | Already mitigated by `loadOverridesFromRedis()` which loads contact IDs from Redis overrides. The deleted feature worked with this same mechanism. |
| No transitions in Redis for yesterday (webhook downtime) | Show empty state with explanation text — same as deleted version |
| Flow snapshot stale or missing (no recent sync) | Task titles degrade to `Task {id}` — acceptable and matches prior behavior |

## Sources & References

- Prior implementation: commit `ff0327a` (created) and `5946662` (deleted)
- Related infrastructure: `src/lib/wrike/transitions.ts`, `src/lib/wrike/fetcher.ts`, `src/lib/flowStorage.ts`
