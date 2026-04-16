---
title: "fix: Patch webhook secret NX and dedup pipeline atomicity"
type: fix
status: active
date: 2026-04-16
---

# fix: Patch webhook secret NX and dedup pipeline atomicity

## Overview

Two bugs were discovered during code review of the reliability fixes branch (`mxd-matt/reliability-fixes`). Both live in `src/lib/wrike/webhook.ts` and both can silently break the webhook pipeline with no recovery path short of manual Redis intervention.

## Problem Frame

The reliability audit introduced P10 (NX secret storage) and P12 (atomic SADD dedup) as fixes. Both fixes are incomplete:

1. **P10 — NX blocks re-registration:** `storeWebhookSecret` uses `{ nx: true }`, which correctly prevents overwrites during the original handshake. But when Wrike legitimately re-registers the webhook (after suspension recovery, manual re-creation, or secret rotation), the new secret is silently rejected. Since P9 (mandatory HMAC signature validation, introduced in the companion reliability audit) now requires signature validation on all non-handshake requests, the old secret in Redis causes every subsequent event to fail HMAC validation with 401. Wrike then suspends the webhook. No code path exists to delete or rotate the stale key.

2. **P12 — SADD outside pipeline:** `storeTransition` performs `SADD` (dedup mark) as a standalone command before the pipeline that writes the actual transition data (`ZADD`, `EXPIRE`, `SET`). If `pipe.exec()` fails after `SADD` succeeds, the transition is marked as "seen" but never stored. The 365-day TTL on the dedup set means the event is permanently lost with no retry or self-healing path.

## Requirements Trace

- R1. Webhook re-registration must successfully store a new secret, replacing any stale one
- R2. Signature validation must use the current (newest) secret, not a stale one
- R3. Transition dedup and data write must be atomic — either both succeed or neither persists
- R4. Partial pipeline failures must not permanently lose transition data

## Scope Boundaries

- Only `src/lib/wrike/webhook.ts` is modified
- No changes to the webhook route handler, Wrike API client, or other reliability fixes
- No new test files (repo has zero test infrastructure; verification is build + manual)

## Context & Research

### Relevant Code and Patterns

- `src/lib/wrike/webhook.ts:29-42` — `storeWebhookSecret()` with NX
- `src/lib/wrike/webhook.ts:101-142` — `storeTransition()` with standalone SADD
- `src/lib/storage.ts` — `getSharedRedis()` singleton, pipeline pattern (`r.pipeline()` → chain → `pipe.exec()`)
- `src/lib/storage.ts:releaseSyncGuard` — Lua eval pattern for atomic operations (reference)
- `src/app/api/webhook/wrike/route.ts:14-26` — caller of `storeWebhookSecret` on handshake
- `src/app/api/webhook/wrike/route.ts:32-48` — mandatory signature validation (P9)

### Institutional Learnings

- The comprehensive reliability audit (`docs/plans/2026-04-16-003-fix-comprehensive-reliability-audit.md`) documents P10 and P12 as intended fixes but the implementations are incomplete
- The P8 fix moved secret storage out of `after()` into synchronous code, which eliminated the original race window that motivated NX. The NX guard is now protecting against a threat that no longer exists
- Upstash `pipe.exec()` returns `(T | UpstashError)[]` — results are accessible by index, which enables moving SADD into the pipeline and checking its result post-execution

## Key Technical Decisions

- **Remove NX entirely (not add a rotation function):** The P8 fix (synchronous secret storage, replacing fire-and-forget `after()`) already eliminated the race that NX was guarding against. The handshake is now synchronous and authenticated by Wrike's `X-Hook-Secret` header. Adding a separate `rotateWebhookSecret()` function would be unnecessary complexity. Simple unconditional `SET` with TTL is correct.
- **Move SADD into pipeline (not add SREM rollback):** A try/catch with SREM rollback is fragile — if the SREM also fails, we're back to the same problem. Moving SADD into the pipeline makes both operations atomic in a single Upstash HTTP round-trip. The SADD result is checked from the `pipe.exec()` response array.

## Implementation Units

- [ ] **Unit 1: Remove NX from webhook secret storage**

  **Goal:** Allow `storeWebhookSecret` to overwrite stale secrets during legitimate re-registration

  **Requirements:** R1, R2

  **Dependencies:** None

  **Files:**
  - Modify: `src/lib/wrike/webhook.ts`

  **Approach:**
  - Replace `{ ex: TTL_SECONDS, nx: true }` with `{ ex: TTL_SECONDS }` on line 36
  - Update the P10 comment to explain why NX was removed (P8 eliminated the race it guarded)
  - Remove the conditional result check and the "ignoring overwrite attempt" warning — every handshake now unconditionally stores the secret
  - Keep the success log line

  **Patterns to follow:**
  - Other Redis `set()` calls in `storage.ts` use simple `{ ex: TTL }` without NX

  **Test scenarios:**
  - Happy path: First handshake stores secret successfully and logs confirmation
  - Happy path: Re-registration handshake overwrites existing secret with new value
  - Edge case: Redis unavailable — error is logged, function returns without throwing

  **Verification:**
  - `npm run build` succeeds with no type errors
  - Reading the code confirms `set()` no longer uses `nx`

- [ ] **Unit 2: Move SADD into pipeline for atomic dedup**

  **Goal:** Make the dedup mark and transition data write atomic so partial failures cannot permanently lose events

  **Requirements:** R3, R4

  **Dependencies:** None (can be done in parallel with Unit 1)

  **Files:**
  - Modify: `src/lib/wrike/webhook.ts`

  **Approach:**
  - Remove the standalone `await r.sadd(dedupSetKey, dedupKey)` call (line 126)
  - Remove the early return on `added === 0` (line 127)
  - Add `pipe.sadd(dedupSetKey, dedupKey)` as the first command in the pipeline
  - Add `nx: true` to the `pipe.zadd()` call as a correctness guard for the concurrent-pipeline race: if two pipelines for the same dedupKey execute simultaneously, both SADD commands may return 1 (Redis processes them before either `exec` returns). ZADD NX ensures only one transition member is written. This is required for correctness, not optional defense-in-depth
  - Execute `pipe.exec()` and check the SADD result (index 0): if `0`, it was a duplicate — log and return
  - Keep the TTL conditional logic (`r.ttl()` before the pipeline) as-is to avoid scope creep
  - Update the P12 comment to reflect the new approach

  **Patterns to follow:**
  - `storage.ts:saveSnapshot` — pipeline pattern with `pipe.set()` → `pipe.expire()` → `pipe.exec()`
  - Upstash pipeline returns `(T | UpstashError)[]` — access results by command index

  **Test scenarios:**
  - Happy path: New transition — SADD returns 1, ZADD writes data, TTL set if needed, log confirms storage
  - Happy path: Duplicate transition — SADD returns 0 in pipeline results, function returns silently without writing
  - Error path: `pipe.exec()` throws — neither SADD nor ZADD persist (atomic failure), no dedup key is orphaned
  - Edge case: Concurrent duplicate events — two pipelines execute simultaneously for the same dedupKey; both SADD commands may return 1, but ZADD NX ensures only one member is written to the sorted set

  **Verification:**
  - `npm run build` succeeds with no type errors
  - Reading the code confirms SADD is inside the pipeline, not standalone
  - The `pipe.exec()` result array is checked for the SADD return value before logging

## System-Wide Impact

- **Interaction graph:** The webhook route handler (`src/app/api/webhook/wrike/route.ts`) calls both functions but requires no changes — the function signatures and return types are unchanged
- **Error propagation:** No change to error propagation — both functions already swallow errors internally and log them
- **State lifecycle risks:** Unit 1 eliminates a stale-secret state that previously required manual Redis key deletion. Unit 2 eliminates an orphaned-dedup-key state that previously caused permanent data loss
- **API surface parity:** No external API changes
- **Unchanged invariants:** `validateSignature()`, `getWebhookSecret()`, `redisKeyForWeek()`, and the `TransitionEntry` type are not modified

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Removing NX allows any request with `X-Hook-Secret` to overwrite the stored secret | The webhook route only calls `storeWebhookSecret` when `X-Hook-Secret` is present — this header is only sent by Wrike during handshakes. The route is not publicly documented. Risk is negligible. |
| Upstash pipeline result array indexing could be off | The pipeline is built in a deterministic order; result indices are stable. The SADD is always the first command (index 0). |

## Sources & References

- Related plan: `docs/plans/2026-04-16-003-fix-comprehensive-reliability-audit.md` (P10, P12)
- Related plan: `docs/plans/2026-04-16-001-fix-wrike-webhook-suspension-plan.md` (P8, P9, P10)
