# Auth consistency analysis — why `withAuth()` is only a "half rule"

**Status: DECISION RECORD + live frontier.** The auth/authorization consolidation is complete
through the security-critical steps; the open work is cleanup (Steps 5–6). Shipped code is
authoritative for anything it records — `src/lib/auth.ts`, `src/security/*`, and the
`tests/security/*` gates are ground truth. This document keeps only the decisions, the invariants a
future change must not break, and the live frontier. It retired and replaced the standalone
`src/security/SCOPE_BINDINGS_MIGRATION.md` (now deleted).

> ### ✅ Verification 2026-07-22 (re-checked against the worktree) — security frontier CLOSED
> Every claim below was re-greped against the tree this pass:
> - **Admission unified.** All four typed front doors exist: `withAuth` (`auth.ts:124`), `withCron`
>   (`cronAuth.ts:48`), `withWebhook` (`webhookAuth.ts:37`), `withKiosk` (`kioskAuth.ts:35`). Raw
>   `getServerSession` is down to **1 production route** (`auth/dev-personas`, drift-guard
>   allowlisted); `shop/tools` is on `withAuth` and names `getServerSession` only in a comment.
>   `getOptionalSessionUser` (`auth.ts:109`) serves the sanctioned optional-session reads.
> - **Scope bindings landed.** `SCOPE_BINDINGS` + `ROW_SCOPE_KEY` + `OPT_OUT_PENDING_ROUTE` live in
>   `scopeBindings.ts`; the engine + validators in `scopes.ts`. `RSVP` is re-bound on
>   `eventId → eventIdsInScopePrograms` (`access-resolvers.ts:38,130`), `AuditLog` is bound
>   `their_own:actorId`, bare `id` is gone from `SCOPABLE_FIELDS` (`scopes.ts:158`), and every route
>   registered in `registry.ts` declares `returns:`.
> - **CI gates green + wired.** `scopeValidators.test.ts` asserts `validateBindings(...) === []` **and**
>   `validateRouteGrants(allRoutes(), SCOPE_BINDINGS) === []` over the real registry. The Step-7
>   drift-guard `routeAuthDrift.test.ts` (3 rules, incl. the §-edge-include rule) runs in the default
>   jest suite. `scopeBindingsEquivalence.test.ts` pins runtime equivalence. §-IDOR negative tests
>   exist (`authzOwnershipBoundary` / `eventRSVPAPI` / `eventAttendanceAPI` integration tests).
> - **`programs/[id]` GET is query-shaped** (the top-severity roster leak, closed). **`certifier` is a
>   first-class `Authorize` term** in `core.ts` (Option A landed).
>
> **Open (not re-verified line-by-line beyond structure):** Steps 5–6 — backfill the remaining
> authenticated routes, then collapse `withAuth` into a degenerate `handler()`. The `derive` hook that
> unblocks Step 6 is **not present** in `handler.ts`. The relation-hop write residue and the
> `OPT_OUT_PENDING_ROUTE` queue are open by design (below).

**History:** the campaign landed as PRs #568–#579 off baseline `87cc322`, plus the Step-7 drift-guard.
Model `Participant`→`Person` / field `participantId`→`personId` was renamed repo-wide by #708; this
document uses the live names. Grep the PRs for archaeology — code is the record now.

**Old § map** (code comments and UNFINISHED.md still cite the pre-cut section numbers): **§4** = the
target rule (the thesis above) · **§5.1a** = the un-migrated-read / edge-include risk (drift-guard
rule 3, invariant 1) · **§7** (incl. §7.3–§7.5.1) = the scope-bindings conversion + its corrections
("Why scope bindings exist" / "Default-deny returns" / "Opt-out model") · **§9** = the execution plan
(Steps 1–4 and 7 shipped; Steps 5–6 are "The live frontier" below; "Step 3 Blocker 1" = the RSVP
`eventId` re-bind) · **§11** = edge/association sensitivity ("keep the per-route workarounds, do NOT
build a primitive").

---

## The thesis — `withAuth()` expresses only half of authorization

`withAuth()` is a "half rule" not because it is half-adopted but because it does only **admission**:
"logged-in, non-denied session?" plus an optional flat **global-role OR-list**
(`roles: ['isSysadmin', …]`, checked `roles.some(r => user[r] === true)`, `auth.ts:126,152`). It has
**no** per-field sensitivity, **no** per-row scope, **no** multi-actor/body-signature entry. So every
endpoint whose authorization depends on the **row** — *this* household/program/event, the caller's
*own* record — admits with an empty `withAuth({})` and re-implements the real check by hand in the
body. The empty call is the type signature admitting it has nothing to offer for resource-scoped
routes. (The recurring inner `if (auth.type !== 'session')` is not a second check — with `allowKiosk`
unset `withAuth` already guarantees a session; that line only narrows the `AuthResult` union for TS.)

**The one thing `withAuth` uniquely enforces — keep it:** the **denied-household lockout**
(`auth.ts:48-52`, mirrored in the JWT claims `authClaims.ts:34-38`). A denied household is treated as
unauthenticated. A route on bare `getServerSession` reads `session.user` directly and **skips this
short-circuit** — a denied household doing a write is the concrete hazard that justified routing every
route through a wrapper.

**The target rule:** `handler()` (`src/security/handler.ts`) is the policy engine — it does admission
**and** per-row scope resolution **and** per-field stripping, driven by declarations in
`src/security/registry.ts`. `withAuth` is the stopgap; `handler()` is the target. Every route should be
`export const METHOD = withX(policy, fn)` with `withX ∈ {handler/withAuth, withCron, withWebhook,
withKiosk}`, the policy declared in the registry, and **no `if (...) return 403` in the body** (the one
sanctioned exception: a commented relation-hop gate, below).

---

## Decisions (code-independent — the reasons not to undo this)

**Registry-first ordering — security before uniformity.** The sequence was: (1) stop the active PII
leaks, (2) lock them with CI validators, (3) only then chase uniformity/cleanup. The scope-resolver
conversion was pulled in **solely because the validators cannot exist without declarative data** — not
to build a framework. Library extraction (lifting the engine into a shared package for a future
monorepo) is an explicit **non-goal**, never on the critical path; defer until a second app needs it.

**Actor-typed front doors, not one mega-wrapper.** Session-less routes (cron, webhook) and the
multi-actor kiosk route are **legitimate, permanent categories**, each deserving its own named wrapper
that a new route *cannot forget*, sharing one `apiError`/catch envelope. `authenticateRequest` is the
internal primitive the wrappers call — not a public route entry point.

**Why scope bindings exist — declarative data is the only thing CI can check.** Per-row scope
resolution was an opaque `switch (modelName)` in which two failure modes were **structurally
uncatchable**: (a) a field typo (`row.householdID`) compiles, returns `undefined`, silently never
grants the scope, and ships as invisible over-restriction; (b) a model added to the schema but
forgotten in the switch silently gets only `everyones` (admin-only) — indistinguishable from
by-design. Converting the switch to a `SCOPE_BINDINGS` table interpreted by one local function
(`makeScopesHeld`) is the **minimum** that lets three validators run. That is the whole security
payoff — not the table for its own sake.

**Default-deny returns — `ROW_SCOPE_KEY` fail-closed.** A row-scoped model whose scope key is
absent/non-numeric on a fetched row returns `{}` (**no** scopes), *not* `{everyones}` — so a missing
selected column can never let an admin-tier view leak a whole row. Carried into the engine via the
`rowScopeKeys` param (`scopesHeld = makeScopesHeld(SCOPE_BINDINGS, ROW_SCOPE_KEY)`, `scopeBindings.ts:192`).
The `EmergencyContact` binding is the pilot case. The `eqCtx`/`inCtx` matchers also carry a
`typeof v === 'number'` guard so an anonymous caller (`selfId === undefined`) never spuriously matches
a row whose field is also absent.

**The two-layer seam — and the third validator.** The stripper multiplies two independently-authored
layers: `fieldVisible(tier, tokens, scopesHeld)` (`core.ts`). A field reaches the wire only if the
**route granted** a `scope:tier` token (registry `orderedView`) **and** the **caller holds** that scope
on that row (`SCOPE_BINDINGS`). Neither validator alone guards the seam between them, so a third exists:
`validateRouteGrants` proves every row-scoped scope a route grants is *resolvable* on a model it
returns. This required routes to declare `returns:`; undeclared routes are treated as `[]` and skipped,
so coverage tightens incrementally as each route declares. Together: `validateBindings` proves the
resolver is honest about *rows*; `validateRouteGrants` proves the routes are honest about *grants*.

**Opt-out model — auto-exempt the un-scopable, queue the rest, no permanent list.** A hand-maintained
permanent opt-out list is where mislabels hide. The only thing warranting permanent exemption is a
model that is *structurally un-scopable* — sensitive fields but no FK by which any non-admin could own
a row — and that is a **derivable fact**: `isScopable()` computes it from `SCOPABLE_FIELDS`
(`householdId, programId, personId, userId, actorId, createdById` — **bare `id` deliberately excluded**,
else every log/settings table would look scopable). Two rules collapse the rest: "never leaves, even to
admins" → tier the field `secret`; "admin-only by policy" is **not** opt-out — bind the scope, tier the
sensitive fields `internal`, and never grant `their_*:internal` on a route (`AuditLog` and
`BackgroundCheckAttestation` are the test cases). What remains is one hand-maintained **work queue**,
`OPT_OUT_PENDING_ROUTE`, that each future self-facing route drains by moving its model into a real
binding in the same PR.

**Certifier — Option A (a first-class `Authorize` term).** The shop-certifier gate is a `toolStatus`
(`MAY_CERTIFY_OTHERS`), not a global role. It is admitted as a first-class `certifier` `Authorize` term
in `core.ts`, backed by a `resolveAccess` predicate reading `toolStatuses` — keeping "all authorization
is declared." (Rejected: Option B, split the route and keep the certifier branch inline.) *Open view
question, not admission:* `shop/org-members` grants a certifier `everyones` to return every member's
`email`; confirm a certifier needs every member's email vs. `name` + a contactable handle. This is the
one migrated route where the fix should *reduce* what leaks, not merely declare the status quo.

**Edge/association sensitivity — keep the per-route workarounds, do NOT build a primitive.** Field
stripping protects *sensitive-tier fields*; it does nothing when the leak is the **existence of an
association** whose identifiers are `public`-tier. A `ProgramParticipant`/`RSVP`/`Visit` row simply
existing reveals "person X is enrolled in / attending Y," and those FKs are `public`, so the stripper
leaves them (`fieldVisible('public', …)` ignores scopes; `stripValue` even preserves array length =
roster size). Only **admission-gating** or **query-shaping** protects these. A row-drop-by-scope
primitive was rejected: it presupposes scopes that don't exist (each route's boundary is bespoke), it
can't say "rows private, count public" (`programs/[id]` keeps `_count` public), it helps no writes, and
N is tiny and already closed — textbook over-engineering. The cheap preventive substitute shipped as
drift-guard **rule 3** (below).

---

## Invariants a future change must not break

These are constraints, not walkthroughs. A change that violates one is a regression even if it
compiles.

1. **The drift-guard contract** (`tests/security/routeAuthDrift.test.ts`, default suite): every
   `src/app/api/**/route.ts` obeys three rules, each with a comment-justified allowlist as the *only*
   exit:
   - **Rule 1** — no raw `getServerSession`/`authOptions` in a route (use a wrapper or the allowlist).
   - **Rule 2** — any `prisma`-touching route enters through `withAuth`/`handler`/`withCron`/`withWebhook`/
     `withKiosk` (or a sanctioned public read via `getOptionalSessionUser`/`authenticateRequest`).
   - **Rule 3 (edge-include)** — a GET/HEAD that `include`s/`select`s an edge-sensitive model
     (`EDGE_MODELS = {ProgramParticipant, ProgramVolunteer, RSVP, Visit}`) must be admission-gated,
     query-shaped, or admin-role-gated, else CI fails. Allowlist entries are checked for liveness (no
     dead exemptions).
   *This is preventive security, not hygiene: the `getServerSession` class already re-grew 2→6 once.*
2. **`ROW_SCOPE_KEY` fail-closed** (above): a row-scoped model missing its scope key returns no scopes,
   never `everyones`.
3. **The seam holds both ways:** `validateBindings` and `validateRouteGrants` must stay `=== []` over
   the real registry. A grant that can't resolve is now a **build error**, not silent over-restriction.
4. **No ad-hoc authz in bodies** — with **one** sanctioned exception: a `403` that exists *because the
   param-keyed `authorize` grammar cannot yet express a relation hop* (the route's `[id]` names a child
   entity whose ownership lives on a parent relation). It must be commented and is a candidate to lift
   into `authorize` later. Distinguish it from un-migrated drift.
5. **What the gates do NOT catch — do not mistake green for safe.** The validators catch
   *over*-restriction and *inconsistency*, never *over-permissiveness*: a route handing `everyones:pii`
   to `authenticated` passes every check. Appropriateness of a grant is caught by **CODEOWNERS review
   of `registry.ts` + negative tests**, not a gate. The runtime anti-IDOR (per-row stripping) covers
   only **reads of sensitive-tier fields** — not public-tier association reads (rule 3's job) and not
   **any write** (a write is gated only by `authorize`, and only if `authorize` is row-aware).

---

## The live frontier

**Baseline:** admission is uniform; scope bindings + all three validators are green and gated; the
drift-guard is landed. Authorization is still hand-rolled inline in the un-migrated `withAuth` routes,
and only the registered `handler()` routes strip fields. Remaining work is cleanup and one open
security residue (the relation-hop writes).

### Step 5 — backfill the remaining authenticated routes *(open; none is a broad cross-person leak)*

Every migrated route gets `authorize` + `returns` so the seam validator covers it. Ordered by residual
value:
- **5a — admin/staff PII reads → `handler()` + `everyones` view (backstop against a future over-include).**
  **RAW-ROW routes only.** *Hard constraint:* `handler()` emits only *classified model fields* +
  relations and **silently drops computed/derived response fields**. Reads returning a **computed
  envelope** the frontend depends on (e.g. `participants/search`'s `isMember`, `safety/emergency-contacts`'s
  `isPresent`/back-compat names, `admin/broken-households`'s fallback name) **must not** be force-migrated
  — they stay on `withAuth` until the Step-6 `derive` hook. Verify each returns model rows before
  batching.
- **5b — own-data reads → `handler()` + `self`/`their_own`** (`profile/*`, `membership/*`,
  `notifications`, `programs/mine`, …). Self-scoped, low risk; convert for consistency.
- **5c — role-gated writes → uniformity** (drift-guard payoff, not PII). Declare `authorize`, drop the
  inline 403s, add `returns`. Lowest priority — they leak nothing on the wire.
- **5d — system/config reads → uniformity.**

### Step 6 — collapse `withAuth` into a degenerate `handler()` *(BLOCKED on the `derive` hook)*

**Blocker (verified: no `derive` in `handler.ts`):** a permissive `orderedView` is **not** "stripper a
no-op" — the stripper emits only classified model fields regardless of view tokens, so any `handler()`
path drops computed/derived fields. Many `withAuth` routes return computed envelopes. Therefore
`withAuth` cannot be collapsed until `handler()` can host computed fields via a **fail-closed `derive`
hook**: `handler(endpoint, fn, { derive: (strippedBag, ctx) => extraFields })`, running **after**
`stripBag` on already-visible data — a computed field whose inputs were stripped can't be built, so it
can't leak. **Decide this hook before committing to Step 6.** After it: make `withAuth` register a
permissive policy and call `handler()`; delete `auth.ts`'s `roles`/admission logic; `authenticateRequest`
survives as the internal primitive.

### Open security residue — relation-hop IDOR writes *(the one genuinely-open item)*

Mutations whose `[id]` names a **child** entity and whose ownership lives on a **parent relation** the
param-keyed `authorize` grammar can't express, so the gate stays inline and forgettable. These stay
inline even after full migration — verified still inline this pass:

| endpoint | `[id]` → owner hop | current gate | backstop |
|---|---|---|---|
| `events/[id]` PATCH | event → program lead | inline `leadMentorId === user.id` | — |
| `events/[id]/rsvp` PATCH | event → program participant | inline 403 | `eventRSVPAPI` IDOR tests |
| `household/emergency-contacts/[contactId]` PATCH/DELETE | contact → household lead | inline + query scoped to `householdId` | `authzOwnershipBoundary` tests |
| `trusted-adults/[id]/renew` POST | trustedAdult → household/subject | service-layer check | `fd192fc` IDOR test |
| `trusted-adults/[id]/withdraw` POST | trustedAdult → household/subject | service-layer check | `fd192fc` IDOR test |

The lever is **negative tests (the `fd192fc` pattern)**, not the validator gate — the primary backstop.

> **Do NOT fold `events/[id]*` into `eventIdsInScopePrograms` (verified — the obvious refactor is
> wrong).** Reusing the RSVP capability's lead∪core-vol set as an events `authorize` term (a) *widens*
> access — `attendance` POST and the PATCH edit/cancel branch gate on `leadMentor` **only**, so it is a
> silent privilege escalation; (b) `rsvp` PATCH gates on *enrollment* (`ProgramParticipant`), which that
> set doesn't compute; (c) `events/[id]` PATCH is multi-conditional in one route. `eventIdsInScopePrograms`
> stays RSVP-only; the `events/[id]` routes keep their inline gates as the accepted relation-hop
> exception.

### The pending-route queue *(open work list)*

`OPT_OUT_PENDING_ROUTE` (`scopeBindings.ts`) — sensitive, scopable models whose scoped route is not
built yet. Each future self-facing route moves its model OUT of the set and INTO a real binding in the
same PR. **Done when the set is empty.** Live members (each documented in-file with its reader and the
future route that would earn it a binding): `OrgMembershipProcess`, `BackgroundCheckAttestation`,
`Corporation`, `VolunteerDesignation`, `PaymentException`, `PersonRole`, `BulkSendItem`.

### Residual risk ranking

The active PII leaks are closed. What remains:
1. **Un-migrated `withAuth` reads have no field-stripping backstop** — a future over-`include` on one of
   them is the most likely place a real leak originates. Mitigated (not eliminated) by drift-guard rule 3
   for edge models; fully closed only as Step 5 backfills. **Highest residual.**
2. **Relation-hop IDOR writes** (table above) — open by design, backstopped by negative tests.
3. **`OPT_OUT_PENDING_ROUTE` not yet empty** — each entry is admin-only today; the risk is a future
   self-facing route shipping without moving the model into a binding. The queue + coverage validator is
   the guard.

---

## Definition of done

- ✅ Admission unified: four typed front doors; `authenticateRequest` internal-only; `getServerSession`
  down to 1 allowlisted route.
- ✅ Migrated PII reads strip fields; no enumerable-ID roster leak (`programs/[id]` query-shaped).
- ✅ Three CI validators green + gating; the drift-guard landed; `SCOPE_BINDINGS_MIGRATION.md` deleted.
- ⬜ Step 5 backfill; Step 6 `derive` hook + `withAuth`→`handler()` collapse (zero `if (...) return 403`
  in bodies); `OPT_OUT_PENDING_ROUTE` drained; relation-hop IDOR writes covered. Library extraction
  remains an explicit non-goal.
