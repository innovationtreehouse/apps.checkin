# CheckMeIn architecture-improvement ideas (backlog)

A running backlog of re-architecture opportunities. **This is an idea list, not a
design record** — before acting on any entry, grep the named symbol/file to
confirm it's still open. Many originals have since shipped (see below) — don't
re-propose them.

> Note: the `Participant` model was renamed to **`Person`** (#708). Domain words
> like `ProgramParticipant` are unchanged; a bare "participant type" below means
> the `Person` type.

## Shipped since this list was written — do NOT re-propose

Verified against the tree; each is greppable:

- **#1 Centralized auth middleware** → `withAuth(...)` in `src/lib/auth.ts` wraps
  route handlers with typed, role-checked users.
- **#13 Kiosk auth as first-class middleware** → `authenticateRequest()` returns
  the `AuthResult` union (`kiosk | session | unauthenticated`) in `src/lib/auth.ts`.
- **#2 Shared TypeScript types** → `src/types/` (`participant.ts`, `attendance.ts`,
  `api.ts`, `auth.ts`, …) replaces the per-file inline `Participant`/`SessionUser`
  re-declarations.
- **#10 API response consistency** → `apiSuccess`/`apiError`/`apiJson` in
  `src/lib/api-response.ts`.
- **#16 Env/config management** → `src/lib/config.ts` (typed `config.*`,
  server-only `CHECKIN_ENV`; see `docs/ops/dev-instance.md`).
- **#11 Debug artifacts removed** → the `fs.writeFileSync` and the `/api/scan`
  `console.log` spew are gone.
- **#7 `/api/scan` refactor** → `src/lib/scan-service.ts` (`processCheckin`,
  `processCheckout`, `finalizeFacilityClose`); the route is a thin orchestrator.
- **#5 Consolidated age/`isMinor`** → `calculateAge` / `isYouth` in
  `src/lib/time.ts`; the three duplicated DOB checks are gone.
- **#6 Shared "relevant programs" query** → `getRelevantProgramIds()` in
  `src/lib/attendanceTransitions.ts`, used by both callers.
- **#12 Email templates** → `src/lib/email-templates/` (`base.ts` + per-type).
- **#8 `fetchAttendance` dedup** → **moot**: `kioskdisplay/page.tsx` was refactored
  away (now `src/app/attendance/current/page.tsx`); the triplicated fetch is gone.

## Still open (terse)

- **#3 Extract reusable UI components (partially done).** `AlertBanner`
  (`src/components/admin/AlertBanner.tsx`) has since shipped; glass card, modal
  overlay, role badge, person card, form field, safety warning are still inlined
  per page — none of `Modal/RoleBadge/PersonCard/FormField` exist.
- **#4 CSS tokens / modules over inline styles.** Most styling is still inline
  `style={{…}}` with magic `rgba()` values; no design-token layer. Blocks
  `:hover`/`:focus`, media queries, and re-creates style objects per render.
- **#9 Decompose monolithic pages.** Still large: `attendance/current` (~580),
  `my-household` (~610), `program-ops/programs/[id]`. Break into sub-components.
- **#14 Query optimization.** `getFullAttendance` re-iterates the active-visit
  list; add indexes on hot paths (e.g. `Visit.departed`). (The 3-query program
  lookup is already fixed — see #6.)
- **#15 Error boundary + loading/shell components.** No React error boundary
  anywhere; every page hand-rolls its "Loading…" and a `PageShell` auth-redirect
  wrapper would remove real boilerplate.
- **#17 Service layer + Zod validation.** Move business logic into
  `src/services/*.service.ts`; parse payloads with Zod (currently zero Zod usage)
  so malformed data never reaches a service. Broader than #7's scan-only extract.
- **#18 Response caching.** Read-heavy low-churn routes (Tools, historical Events,
  active Programs) via `unstable_cache` / cache headers. Not applied.
- **#19 Telemetry retention.** `ErrorLog`/`AuditLog`/`SystemMetric` grow unbounded
  — prune >90d with a cron, or offload high-volume telemetry off the relational DB.
- **#20 Edge RBAC in middleware.** `src/middleware.ts` exists but does env/staging
  gating, not per-section role rejection at the Edge before the Node runtime/DB
  spin up.
- **#21 RSC vs client boundaries.** Push `"use client"` down to interactive leaves
  so heavy views stay Server Components (smaller bundles, no fetch waterfalls).
- **#22 Vertical-slice structure.** Group by feature domain
  (`src/features/{Attendance,Households,Programs}/`) instead of by technical concern.

**Rough priority of what's left:** #3/#15 are low-effort DX wins; #17 (services +
Zod) and #20 (edge RBAC) carry the most correctness/security leverage; #4/#9 are
large readability refactors; #14/#18/#19/#21/#22 are perf/structure, do when they
earn it.
