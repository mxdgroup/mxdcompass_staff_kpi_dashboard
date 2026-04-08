---
title: "refactor: Plan lifecycle management for multi-developer coordination"
type: refactor
status: completed
date: 2026-04-08
---

# refactor: Plan lifecycle management for multi-developer coordination

## Overview

Establish a convention where active plans live in `docs/plans/` and completed plans are moved to `docs/plans_completed/`. This gives multiple developers a clear signal of what work is in-flight vs done without reading file contents.

## Problem Frame

Multiple developers work on this project. Without a visible separation between active and completed plans, developers must open each plan file and inspect its status to know whether work is available or already done. This creates friction and risks duplicate effort.

## Requirements Trace

- R1. Active plans must reside in `docs/plans/`
- R2. Completed plans must reside in `docs/plans_completed/`
- R3. File location is the single source of truth for plan status — no frontmatter update required on move
- R4. The convention must be obvious to any developer looking at the directory structure

## Scope Boundaries

- No automation or CI enforcement — this is a manual developer convention
- No changes to plan file format or naming
- No changes to how plans are created (they still go in `docs/plans/`)

## Key Technical Decisions

- **File move is the status signal**: Moving a file from `docs/plans/` to `docs/plans_completed/` is the only action needed to mark work as done. Rationale: simplest possible convention, no tooling dependency, visible in `ls` or any file browser.
- **No frontmatter changes on completion**: The `status` field in YAML frontmatter may still say `completed` (as some existing plans already do), but it is not required. The directory location is authoritative.

## Implementation Units

- [ ] **Unit 1: Create `docs/plans_completed/` directory**

  **Goal:** Establish the completed plans directory so it exists for future moves.

  **Requirements:** R2, R4

  **Dependencies:** None

  **Files:**
  - Create: `docs/plans_completed/.gitkeep`

  **Approach:**
  - Add a `.gitkeep` so the empty directory is tracked in git

  **Test expectation:** none — directory scaffolding only

  **Verification:**
  - `docs/plans_completed/` exists and is tracked in git

- [ ] **Unit 2: Move the completed plan**

  **Goal:** Move the already-completed unified dashboard filter plan to `docs/plans_completed/`.

  **Requirements:** R1, R2

  **Dependencies:** Unit 1

  **Files:**
  - Move: `docs/plans/2026-04-07-003-feat-unified-client-dashboard-filter-plan.md` → `docs/plans_completed/2026-04-07-003-feat-unified-client-dashboard-filter-plan.md`

  **Approach:**
  - `git mv` the file to preserve history
  - The kanban metrics research doc (`2026-04-07-001-kanban-metrics-research.md`) stays in `docs/plans/` as it is a reference document, not a completed feature plan

  **Test expectation:** none — file move only

  **Verification:**
  - `docs/plans/` contains only active/reference plans
  - `docs/plans_completed/` contains the unified dashboard filter plan
  - `git log --follow` on the moved file still shows its history

## System-Wide Impact

- **Convention adoption:** All developers should follow this pattern going forward — create plans in `docs/plans/`, move to `docs/plans_completed/` when done
- **Existing plans:** Only the one confirmed-completed plan moves now. The kanban research doc remains as active reference material.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Developers forget the convention | Directory names are self-documenting; mention in PR description |
| Git history lost on move | Use `git mv`; `git log --follow` preserves history |
