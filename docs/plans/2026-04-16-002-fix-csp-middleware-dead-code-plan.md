---
title: "fix: Wire up CSP frame-ancestors middleware"
type: fix
status: completed
date: 2026-04-16
---

# fix: Wire up CSP frame-ancestors middleware

## Overview

`src/proxy.ts` sets a `Content-Security-Policy: frame-ancestors` header to restrict iframe embedding to `https://compass.mxd.digital`, but the file is never invoked. Next.js requires middleware to live at `src/middleware.ts` (or root `middleware.ts`) and export a named `middleware` function. The current file uses a default export with an arbitrary name, and is located at the wrong path.

## Problem Frame

Commit f5fe808 ("fix: replace host-based blocking with CSP frame-ancestors") intended to restrict who can embed this dashboard in an iframe. The old host-based blocking was removed, but the replacement CSP header is never applied because the file isn't recognized as Next.js middleware. The dashboard is currently embeddable by any origin.

## Requirements Trace

- R1. All responses from the app must include `Content-Security-Policy: frame-ancestors https://compass.mxd.digital`
- R2. The middleware must not interfere with API routes (cron, webhook) that receive external requests directly (not via iframe)

## Scope Boundaries

- Not changing the CSP policy value itself — `frame-ancestors https://compass.mxd.digital` is the intended policy
- Not adding other security headers beyond what was already planned

## Context & Research

### Relevant Code and Patterns

- `src/proxy.ts` — current dead code, contains the correct header logic
- `next.config.ts` — `basePath: "/internal/kpis"` (Next.js middleware matchers are relative to basePath, so the matcher should use `/` not `/internal/kpis/`)
- Next.js 16 middleware convention: named export `middleware` from `src/middleware.ts`, optional `config` export with `matcher`

## Key Technical Decisions

- **Rename and restructure rather than create a new file:** The logic in `proxy.ts` is correct, it just needs to be in the right file with the right exports.
- **Add a route matcher:** Apply the CSP header to page routes only (`/`, `/flow`, `/yesterday`), not to API routes. API routes like `/api/webhook/wrike` and `/api/cron/sync` are called directly by external services and don't need frame-ancestors. This avoids any risk of the middleware interfering with webhook/cron functionality (R2).

## Implementation Units

- [x] **Unit 1: Convert proxy.ts to proper Next.js middleware**

**Goal:** Make the CSP frame-ancestors header actually apply to all page responses.

**Requirements:** R1, R2

**Dependencies:** None

**Files:**
- Delete: `src/proxy.ts`
- Create: `src/middleware.ts`

**Approach:**
- Rename `src/proxy.ts` to `src/middleware.ts`
- Change `export default function proxy()` to `export function middleware()`
- Add a `config` export with a `matcher` that targets page routes (`/`, `/flow`, `/yesterday`) but excludes API routes and static assets
- The `NextResponse.next()` + header set pattern is already correct

**Patterns to follow:**
- Next.js middleware convention: named `middleware` export + `config.matcher`

**Test scenarios:**
- Happy path: Page routes (`/`, `/flow`, `/yesterday`) include the `Content-Security-Policy: frame-ancestors https://compass.mxd.digital` header in responses
- Edge case: API routes (`/api/webhook/wrike`, `/api/cron/sync`, `/api/dashboard`) do NOT have the middleware applied (matcher excludes them)
- Edge case: Static assets (`/_next/static/*`) are not affected by the middleware

**Verification:**
- `src/proxy.ts` no longer exists
- `src/middleware.ts` exports a named `middleware` function and a `config` with matcher
- Hitting a page route returns the CSP header; hitting an API route does not

## System-Wide Impact

- **Interaction graph:** Middleware runs before all matched routes. The matcher scoping ensures webhook and cron API routes are unaffected.
- **Unchanged invariants:** API route behavior, webhook handshake, cron auth — all unchanged since the matcher excludes `/api/*`.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Middleware accidentally matching API routes could break webhook/cron | Route matcher explicitly targets only page routes |

## Sources & References

- Commit f5fe808: "fix: replace host-based blocking with CSP frame-ancestors"
- Next.js middleware docs: middleware must be at `src/middleware.ts` with named `middleware` export
