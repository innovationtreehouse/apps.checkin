# Archive households: structural exclusion for permanently departed families

Issues: [#1228](https://github.com/innovationtreehouse/checkin/issues/1228),
[#1232](https://github.com/innovationtreehouse/checkin/issues/1232)

## Problem

A household that has left the organisation permanently still appears in every
roster, dropdown, search result, and count the app produces. There is no way to
mark one as gone, because the `Household` model has no `archivedAt` column.

The obvious fix — add the column, filter it on every read — is the same pattern
`LIVE_PERSON` already proved does not work at scale. `LIVE_PERSON` is
`{ mergedIntoId: null }` applied by convention to Person queries; it produced 13
silent defects across a single widened sweep, including an authorization check a
merged-away identity could satisfy.

Household queries are a comparable surface: **14 direct read calls** across 12
production files, **72 relation-`where` traversals** (`household: { ... }` inside
another model's query), **24 relation includes** (`household: true`), **3 raw SQL
`SELECT ... FOR UPDATE`** sites, and **3 direct writes**. An opt-out
`{ archivedAt: null }` filter on each relevant site is the same bug class —
forgettable, no compiler error on omission, leaks silently — and would mint a
second convention alongside `LIVE_PERSON`, doubling the surface a drift guard has
to cover.

`TOMBSTONE_REMOVAL.md`'s out-of-scope section calls this out explicitly: "a
second exclusion dimension … would mint a second forgettable convention and a
second drift guard."

## Why the earlier draft's answer was insufficient

A prior version of this design recommended a **Prisma client extension** that
auto-injects `{ archivedAt: null }` into every `household.*` read. That approach
does not solve the `LIVE_PERSON` problem — it relocates it.

The arithmetic is the disqualifier. Of the ~116 production query sites that can
surface a Household, only **14 are direct `prisma.household.*` reads**. A Prisma
query extension intercepts exactly those 14. The other ~99 — 72 relation-`where`
traversals, 24 relation includes, 3 raw SQL, 3 writes — are invisible to it,
because **Prisma extensions cannot see a relation traversal**. A
`person.findMany({ where: { household: { … } }, include: { household: true } })`
resolves the Household inside the Person query's SQL; the extension's
`household.findMany` interceptor never runs.

That is not a rounding error. It is the majority of the surface, and it is the
*same shape* where `LIVE_PERSON` actually failed: the shipped defects
concentrated in relation-named references (`householdMembers`, `leadMentor`)
that the original drift guard could not see. An extension that closes the 14
easy sites and leaves the 99 hard ones to convention has fixed the part that was
never really broken and left the part that bites. Safe-by-default on 12% of the
surface is not safe by default.

The deeper reason is structural, and it decides the whole design:

> **The archived row is a *join target*. Exclusion enforced anywhere above the
> database cannot cover a join, because the join happens in the database, in SQL
> the application layer never rewrites.**

Any mechanism that lives in application code — a per-query filter convention
(Option A) or a client extension (the earlier recommendation) — can only reach
the queries the application issues *against Household directly*. The moment
another model joins to Household, the exclusion has to be re-stated by hand, and
we are back to `LIVE_PERSON`. The only way to make an archived household
unreadable from a query that did not ask for it — including the 96 relation and
raw-SQL sites — is to enforce the exclusion **in the database**.

## Objective

**Make it impossible to read an archived household from a query that did not ask
for one — direct read, relation join, or raw SQL alike — rather than everyone's
job to remember not to.**

Concretely: add `Household.archivedAt`, and enforce `archivedAt IS NULL` as a
Postgres **row-level security (RLS) policy** on the `Household` table, so the
exclusion is applied by the database on every access path. Queries that
legitimately need archived rows opt in explicitly, per transaction.

## Executive summary

| | |
|---|---|
| **The fix** | A Postgres RLS policy on `Household` filters `archivedAt IS NULL` by default. It applies to every access path the database sees: direct reads, relation joins from other models, and raw SQL. Queries that need archived rows opt in with a transaction-scoped `SET LOCAL`. |
| **Why not a client extension** | A Prisma extension reaches only the 14 direct `household.*` reads. The other ~99 sites are relation traversals and raw SQL the extension is architecturally blind to — the exact shape `LIVE_PERSON` failed on. See [Why the earlier draft's answer was insufficient](#why-the-earlier-drafts-answer-was-insufficient). |
| **Why not per-query filters** | `LIVE_PERSON` proved the convention does not hold: 13 defects from one sweep, and the drift guard that existed missed all three bugs that shipped. |
| **What board members see** | A new "Archive" action on a household, available to the Board only and refused while the household has a current Treehouse membership or a current program enrollment. Archived households and their members disappear from every active surface, search and pickers included. Historical reports and audit trails still show them. |
| **What developers stop doing** | Nothing — they never start. No filter to remember on any of the 116 sites, no drift guard to maintain. New code that joins to Household inherits the exclusion for free. |
| **The cost** | RLS must bind every role that reads the table. The app's DML role owns no tables, so RLS binds it already; `FORCE` binds a non-superuser owner. The roles that migrate and run integration tests are superusers, which RLS never binds, so the archive's RLS tests connect as a dedicated non-superuser test role. Opt-in reads must run inside a transaction, and the test DB must carry the policy or the tests pass vacuously. See [Costs and how they are handled](#costs-and-how-they-are-handled). |
| **Done when** | Archived households are invisible on every active surface including relation traversals (#1232), enforced structurally by the database, not by convention. |

## What "archived" means

**An archived household is one that has permanently left the organisation.**

It is not:

- **REVOKED membership.** Revocation is a membership-level state
  (`OrgMembership.status = REVOKED`). A revoked household keeps app access and
  loses facility privileges. Archival is the step beyond: the family is gone,
  the row is retained for audit, and nobody should encounter it in an active
  context.
- **A tombstone.** `LIVE_PERSON` marks a Person that was merged away — a
  data-hygiene artifact. Archival is a domain event: a real family departed.
- **DENIED membership.** Denial locks sign-in; archival does not. A denied
  household may later be archived, but the two are independent.

**When it happens:** a board member archives a household after the family has
left. Only the Board may archive or unarchive; a sysadmin who is not on the Board
may not, and neither may a household lead. This is a deliberate human act, not
an automatic consequence of any other state transition.

**When it is refused:** a household with a current Treehouse membership, or with
a member in a current program enrollment, cannot be archived (HA-7). Either one
blocks it. The archive action checks this and refuses with a reason, the same
shape as the existing refusal to deny a household that contains a board member.
A departing family has its membership and enrollments ended first, and is
archived after that.

**Reversibility:** yes. Unarchiving restores the household to whatever state it
held before. The `archivedAt` timestamp is nulled. This follows the principle
that decisions are reversible — an archive of the wrong household can be undone.

## Mechanism evaluation

The requirement spans three access shapes — direct reads, relation traversals
from other models, and raw SQL. The one axis that separates a real fix from
`LIVE_PERSON` redux is whether the mechanism covers **relation traversals**,
because that is both the largest slice (~96 of 116 sites) and where
`LIVE_PERSON` actually broke.

| Option | Direct reads | Relation traversals | Raw SQL | Verdict |
|---|---|---|---|---|
| A — per-query filter convention | convention | convention | convention | rejected — this *is* `LIVE_PERSON` |
| Client extension (earlier draft) | structural | **not covered** | not covered | rejected — blind to the surface that matters |
| B — Postgres view | rename churn | **not covered** | n/a | rejected — Prisma relations still target the base table |
| D — drift guard only | convention | convention | convention | rejected — `LIVE_PERSON` has this; it missed 3 bugs |
| E — separate `ArchivedHousehold` table | structural | structural | structural | rejected — breaks live FK dependents and reversibility |
| **C — Postgres RLS (recommended)** | **structural** | **structural** | **structural** | **recommended** |

### Option A: per-query filter convention (rejected)

Add `archivedAt` and rely on every query site to include `{ archivedAt: null }`.
This is what `LIVE_PERSON` does for Person. The failure evidence is already in:
113 Person query sites, 13 silent defects. Over 100 Household query sites would
produce the same class.

### Client extension (rejected — see the section above)

A `Prisma.defineExtension` that injects `{ archivedAt: null }` into
`household.*` reads. Covers 14 sites structurally, is blind to the other ~99.
Rejected for the reasons in
[Why the earlier draft's answer was insufficient](#why-the-earlier-drafts-answer-was-insufficient):
it does not reach the relation-traversal surface, which is where the
`LIVE_PERSON` defects concentrated.

### Option B: Postgres view (`active_household`) (rejected)

Create a view `active_household` that excludes `archivedAt IS NOT NULL`, and
route queries through it.

Two independent disqualifiers:

- Prisma does not generate a typed client for views in any supported way. The
  `@@view` directive produces no query methods; the view would need raw SQL or a
  second `@@map`'d model, and migrating `prisma.household` → the view is a
  mechanical sweep of every direct call site.
- **It does not fix relation traversals** — the very thing an application-layer
  filter also misses. Prisma relations are defined against the `Household`
  model/table, so `person.findMany({ include: { household: true } })` joins the
  base `Household` table, not the view. A view only helps the queries you
  manually re-point at it, which is the same convention problem in a different
  hat.

### Option D: drift guard only (rejected)

Add the column, add a drift guard like the retired `LIVE_PERSON` one, ship the
per-query filter plus a test that greps for missing ones. This is exactly what
`LIVE_PERSON` has, and `TOMBSTONE_REMOVAL.md` is a 200-line argument that it does
not work: the guard missed three shipped bugs before its widening found 13 more.

### Option E: separate table — move the row out (rejected)

Move the archived Household row to an `ArchivedHousehold` table, so
`prisma.household.*` and every join to it structurally cannot return it. This is
the pattern `TOMBSTONE_REMOVAL` uses for Person.

It gives the strongest guarantee, and it is the reason RLS (below) is the
*second*-strongest rather than the first — RLS keeps the row in the table and
relies on the policy being enforced, where a row-move needs no enforcement at
all. But it does not transfer from Person to Household:

- **Live dependents.** The tombstone-removal design works because the merge
  **already moves everything** off the loser before deleting it — visits,
  enrollments, certifications, all repointed. An archived household still has
  live dependents: `Person.householdId` (every member), `OrgMembership`,
  `EmergencyContact[]`, `TrustedAdult[]`. Moving the row means either cascading
  all of those to parallel archive tables (a second schema for a second copy of
  the world), nulling `Person.householdId` (violates "every person belongs to a
  household" — `people-households.md` Procedure), or moving the Person rows too
  (the person then disappears from all history, not just active surfaces).
- **Reversibility.** Unarchiving means moving rows back: household, its members'
  FK references, membership, contacts, trusted adults. A merge is intentionally
  irreversible ("there is no un-merge"); archival is explicitly reversible. The
  row-move pattern fits one-way operations.
- **Historical queries.** Attendance reports, audit logs, and hours summaries
  reference `householdId` via typed FKs. With the row gone they need a LEFT JOIN
  to `ArchivedHousehold` or lose the household name. `PersonMerge` avoids this
  only because `AuditLog.affectedEntityId` is a bare `Int` with no FK.
- **Schema complexity.** `ArchivedHousehold` duplicates every column of
  `Household`; every future schema change to `Household` must be mirrored.

**The core asymmetry:** a merged Person has no remaining purpose — it is a
data-hygiene artifact. An archived Household is a real family that left; its rows
are still referenced by real people and real history, and the operation is
reversible. The tombstone pattern removes something that should never have
stayed; archival retains something that needs to stop being active. RLS keeps
the row (retention, reversibility, intact FKs) while making it unreadable by
default (structural exclusion) — which is exactly the combination archival
needs and merge does not.

### Option C: Postgres row-level security (recommended)

Enforce `archivedAt IS NULL` as an RLS policy on the `Household` table. The
database applies it on every path that reads the table — a direct
`SELECT`, a join from `Person`/`OrgMembership`/anything else, and raw SQL alike —
because RLS attaches to the table, not to any one query. Opt-in for the surfaces
that must see archived rows is a transaction-scoped session setting.

**Why this is the fit:**

- **It covers the surface that matters.** The 96 relation-traversal and raw-SQL
  sites the extension and the view both miss are covered for free, because the
  policy fires whenever `Household` is touched, however it is reached.
- **Safe by default, opt-in explicit.** Unset session setting → archived rows
  filtered. This inverts the `LIVE_PERSON` failure mode: forgetting is safe;
  seeing archived rows is the thing you must ask for.
- **The row stays put.** Retention, reversibility, and every typed FK survive
  untouched — the advantages Option E throws away.
- **Prior art in this codebase.** The scan route already runs transaction-scoped
  raw SQL inside `prisma.$transaction` (`tx.$executeRaw\`SELECT
  pg_advisory_xact_lock(${id})\``, `scan/route.ts:257`). A `SET LOCAL` opt-in
  uses the identical mechanism.

**Its honest costs** are real and are handled explicitly below — RLS must be
*forced* on the app's role, opt-in reads must be transactional, and the test DB
must enforce RLS or give false confidence. See
[Costs and how they are handled](#costs-and-how-they-are-handled).

## Recommended approach: Postgres RLS

### The policy

Added by migration (Prisma migrations run arbitrary SQL). The column is
`"archivedAt"` — physical columns in this schema are camelCase with no `@map`
(cf. `Household.createdAt`), so the policy quotes it as-is.

```sql
ALTER TABLE "Household" ENABLE ROW LEVEL SECURITY;
-- The table owner bypasses RLS unless forced. The app connects as a non-owner
-- DML role, which RLS binds regardless; FORCE also binds a non-superuser owner.
-- No setting binds a superuser.
ALTER TABLE "Household" FORCE ROW LEVEL SECURITY;

CREATE POLICY household_hide_archived ON "Household"
    FOR SELECT
    USING (
        "archivedAt" IS NULL
        OR current_setting('app.include_archived', true) = 'on'
    );
```

- **Writes get their own policies, one per command, never `FOR ALL`.** An RLS
  table with no permissive policy for a command denies that command, so
  `INSERT`, `UPDATE` and `DELETE` each get an always-true policy (see the
  migration section). A `FOR ALL` policy also covers `SELECT`, and permissive
  policies combine with OR, so `FOR ALL USING (true)` would leave every archived
  row visible.
- **A write that reads the row still needs the opt-in.** Postgres applies the
  `SELECT` policy to an `UPDATE` or `DELETE` whose `WHERE` or `RETURNING` reads
  the table's columns, which covers Prisma's updates. The existing row and an
  updated row must both pass it. So writing `archivedAt` raises a row-security
  error without the opt-in, and any write to an already-archived row matches
  nothing. Archive and unarchive both run inside `withArchivedHouseholds`.
- **`current_setting('app.include_archived', true)`** returns `NULL` when the
  setting is unset (the `true` second argument is `missing_ok`). `NULL <> 'on'`,
  so an ordinary read with no opt-in sees only non-archived rows. Safe by
  default.

### Opt-in: transaction-scoped, greppable

A read that must see archived rows runs inside a transaction that sets the GUC
with `SET LOCAL`, which is scoped to that transaction and reset on commit —
critical under a reused connection pool (this app uses a plain `pg.Pool`, no
pgbouncer). We never use session-level `SET`, so a pooled connection can never
carry the opt-in into an unrelated later request.

```typescript
/**
 * Run reads that must include archived households. The opt-in is scoped to this
 * transaction via SET LOCAL and cannot leak onto a pooled connection.
 */
export function withArchivedHouseholds<T>(
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
    return prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL app.include_archived = 'on'`
        return fn(tx)
    })
}

// Usage (admin household detail, unarchive, historical reports):
//   const h = await withArchivedHouseholds((tx) =>
//     tx.household.findUniqueOrThrow({ where: { id } }))
```

Every opt-in site is a call to `withArchivedHouseholds` — one greppable name,
the inverse of the `LIVE_PERSON` allowlist that lived in a separate file and
drifted. Forgetting the wrapper means you see *fewer* rows, never more.

### Costs and how they are handled

RLS is not free, and the cost is concentrated in three places that this repo has
been bitten by before. Each is a required step, not an afterthought.

1. **Every reading role must be bound.** The app connects as a DML-only role
   that owns no tables, in both stacks: `checkin_dml` in the self-hosted compose
   stack, created by `deploy/prod-initdb/05-checkin-roles.sh` as a plain login
   role, and `checkin_<env>_dml` in AWS, created by the infra repo's cluster
   bootstrap (`DEPLOY_MIGRATION_ORDER_OF_OPERATIONS.md` §9). RLS binds a
   non-owner role as soon as it is enabled. `FORCE` binds a non-superuser table
   owner as well, so it stays as defence in depth. It does not bind a superuser,
   and the roles that migrate and test are superusers: the compose migrate role
   `prisma` is the image's bootstrap user (`deploy/docker-compose.prod.yml`), and
   CI's integration Postgres runs as `testuser`, also the bootstrap user
   (`.github/workflows/ci.yml`). Neither reads Household in production, so
   neither is a production leak, but a test that connects as either sees every
   row whatever the policy says. The one production way to fail open is an app
   role with `BYPASSRLS` or superuser; Decision #6 records that neither stack has one.
2. **Opt-in reads must be transactional.** The ~5 opt-in surfaces (admin detail,
   unarchive, historical/audit reports) must run through
   `withArchivedHouseholds`. Non-transactional opt-in via session `SET` is
   forbidden because the pool reuses connections. This is a small, bounded set
   and each site is deliberate.
3. **The RLS tests must connect as a role RLS binds, or coverage is vacuous.**
   Integration tests connect as `testuser`, a superuser, which bypasses RLS
   even on a `FORCE`d table. Run as that role, an archived household stays
   visible and every "archived rows are hidden" assertion passes for the wrong
   reason, the same trap as a `db push` test DB missing a partial-unique index
   it cannot express. So the archive's RLS suites connect as a non-superuser,
   non-owner role shaped like the app's DML role (see
   [Test role](#test-role-a-dml-like-connection-for-the-rls-suites)). The
   policy still comes from the migration, so the test DB is built with
   `migrate deploy`; `db push` does not run migration SQL and must not be used
   to build the DB that exercises this. A dedicated test asserts the fail-open
   case is closed: as the test DML role, with no opt-in, an archived seed row is
   *absent*, and a guard asserts that role is neither superuser nor
   `BYPASSRLS`, so a test that quietly fell back to `testuser` fails loudly.

Two smaller notes:

- **Aurora scale-to-zero / driver adapter.** RLS is transparent to the
  `@prisma/adapter-pg` driver and to the aurora-resume-retry extension — it is
  server-side SQL evaluation, no client round-trips added, no interaction with
  the resume loop.
- **Performance.** The policy predicate is `"archivedAt" IS NULL` on a column
  that is overwhelmingly null. No index initially; add a partial index
  (`WHERE "archivedAt" IS NOT NULL` is not what helps — the common path filters
  `IS NULL`) only once the archived population is non-trivial. Premature
  indexing is wasted.

### Failure modes: what fails silently, and why 100% query coverage is not needed

The natural worry is that RLS trades the `LIVE_PERSON` per-query risk for a new
one that also has to be tested at every call site. It does not, and the reason is
the whole argument for the mechanism.

**Two failure directions, only one silent:**

| Failure | What the query sees | Fails loudly? |
|---|---|---|
| **Fail-open** — archived rows leak into a normal read | too *many* rows | **no — silent** |
| **Fail-closed** — a read that wanted archived rows didn't opt in | too *few* rows | **yes — loud or visibly empty** |

Forgetting the opt-in fails *closed*: a `findUniqueOrThrow` on an archived row
raises P2025 "record not found"; a report simply omits its archived rows. This is
the safe direction, and it is the inverse of `LIVE_PERSON`, where forgetting the
filter fails open and silent. So the only thing that fails silently is
fail-**open** — and that is the entire surface to defend.

**Fail-open is global, not per-query. This is why coverage is O(1), not
O(queries).** `LIVE_PERSON` fails per-site: each of 113 queries is independently
right or wrong, so catching it needs all 113 checked — which is why the drift
guard grepped source, missed shapes (`updateMany`, `householdMembers`), and let
13 defects through. You cannot cover queries that do not exist yet.

RLS fail-open has exactly **two causes, both global** — properties of the
connection and the codebase, not of any one query:

1. **Enforcement off** — the app role bypasses RLS (table owner without `FORCE`,
   or a `BYPASSRLS`/superuser role). One fact about the connection, true or false
   for all 116 sites at once.
2. **Opt-in leak** — someone used session `SET` instead of `SET LOCAL`, so the
   opt-in sticks on a pooled connection and bleeds into later requests.

The database engine applies the policy to every query it plans, **including code
not written yet**. So the thing to test is that enforcement *holds* — not that
116 (or N-in-the-future) callers each remembered something. You cannot enumerate
future callers; you can prove the engine enforces. That is the structural win
stated as a testing property: the verification surface collapses from
*per-caller, forever* to *two global conditions, once*.

**The four-test contract** (these, not per-site coverage, are what make the
design safe — see [Test plan](#test-plan) for the full list):

1. **Fail-open probe.** Seed one archived + one active household; reading as
   a non-superuser, non-owner role (the test DML role), `household.findMany()`
   with no opt-in returns only the active one. Fails loudly if the policy is
   missing or the role bypasses RLS. Load-bearing.
2. **Opt-in works.** The same query in `withArchivedHouseholds` returns both.
3. **No leak.** An opt-in transaction, then a plain query on the same pool,
   confirms archived rows are not visible afterward — catches any session-`SET`
   misuse.
4. **Meta-assert.** RLS is enabled *and* forced on `Household`, and no permissive
   policy on it applies to `SELECT` except `household_hide_archived` (catches a
   future migration that drops or weakens the policy).

**Fragility controls:**

- **One opt-in path.** Only `withArchivedHouseholds`, only `SET LOCAL`. A guard
  test greps for a raw `app.include_archived` outside that helper — reliable
  because it matches a single fixed literal, not the query *shapes* the
  `LIVE_PERSON` guard had to (and failed to) enumerate.
- **`migrate deploy`, never `db push`,** to build any DB that exercises this. The
  policy lives in raw migration SQL; `db push` does not run it, so the policy is
  absent and all four tests pass vacuously (the same class as a partial-unique
  index `db push` cannot express).
- **Role hygiene is the one real cliff.** RLS is binary: enforced → robust; role
  bypasses it → useless and silently fail-open with no in-app remedy. The app
  connects as a non-owner DML role in both stacks, and neither stack's role has
  `BYPASSRLS` (Decision #6).

**Two residual fragilities RLS itself introduces — both non-silent:**

1. **`include: { household: true }` returns `null` for an archived household.** A
   caller reading `person.household.name` without a null check raises a runtime
   `TypeError` — loud, and `tsc`-visible where the relation type is nullable. It
   crashes rather than lying; the 24 include sites get a compiler-assisted
   null-tolerance sweep.
2. **A read that wanted archived rows and forgot the opt-in returns a plausible
   smaller number** (e.g. an admin metric undercounts). Not fail-open, so not
   dangerous — but silent-*incomplete* rather than loud. Bounded by the opt-in
   surfaces being a known, small set (the [allows](#what-archival-allows-must-still-show-archived-rows)
   table), each with its own test.

The honest summary: RLS does not deliver zero risk. It **converts** the risk —
from distributed, per-site, silent, and unbounded over future code, into
centralized, global, testable, and binary. The fragility that per-query filters
spread across every developer and every query forever collapses to one
connection property and one opt-in helper, both pinned by the four tests above.

### What still needs a human sweep — and what does not

RLS closes the read surface *structurally*. It does **not** decide policy
questions that are genuinely ambiguous, and #1232 is where those get answered:

- **Relation includes** (`include: { household: true }`, 24 sites) now return
  `null` for the household when it is archived and the caller did not opt in.
  Each of these 24 sites must tolerate a null household object (it already must
  handle the FK being to a valid row; this adds "…that may be filtered"). This
  is a **typed, compiler-visible** change — `household` on the result is already
  nullable in the relation type where the FK is nullable, and where it is not,
  the sweep surfaces it. This is the one place RLS shifts work onto callers, and
  it is work `tsc` can point at, unlike the `LIVE_PERSON` sweep.
- **Relation-`where` traversals** (`where: { household: { … } }`, 72 sites) now
  automatically exclude archived-household rows, because the joined `Household`
  row is invisible, so the `is`-style relation filter matches nothing. This is
  the surface that was the whole risk under the extension, and RLS closes it
  with no per-site change. #1232's audit becomes a *verification* pass
  ("confirm each of the 72 now excludes as intended") rather than a *fix-each*
  pass.
- **Person queries with no household join** are not filtered at all, because the
  policy fires only when a query touches `Household`. The badge scan
  (`scan/route.ts`) is one: it resolves the person without reaching `Household`,
  so an archived household's badge would still check in. The scan and people
  search get an explicit exclusion, and the build audits every person query with
  no household join (PR 3 in [Build order](#build-order)).

The distinction from `LIVE_PERSON`: there, the sweep was the mechanism and
missing a site meant a defect. Here, the sweep is confirmation that a mechanism
already in force behaves as intended, and the one class of caller change it does
require (null-tolerance on 24 includes) is type-checked.

## What archival blocks

An archived household is excluded from every active surface, enforced by the
policy wherever a query reaches `Household`, and by an explicit exclusion on
the person queries that do not:

| Surface | Blocked | Why |
|---|---|---|
| Membership-ops household list | yes | Board should not see departed families as active work |
| Household dropdowns (e.g. "move to household") | yes | Cannot move someone into a departed household |
| Program enrollment | yes | Cannot enroll from a departed household |
| Membership processes | yes | No new intake, renewal, or payment for a departed family |
| Check-in / kiosk scan | yes | A badge scan fails exactly as for a badge that matches nobody (Decision #3) |
| Emergency-contact roster | yes | Not in the building |
| Compliance / audit worklists | yes | No obligations to track |
| Nav todo counts | yes | Should not inflate board counts |
| Unclaimed-households list | yes | Not a household to chase |
| Missing-contact list | yes | Not a household to chase |
| People search / person dropdowns | yes | Members of a departed family are not active candidates (Decision #2) |

## What archival allows (must still show archived rows)

These are the sites that call `withArchivedHouseholds`:

| Surface | Allowed | Why |
|---|---|---|
| Admin audit / broken-households | yes | Data hygiene sees everything |
| Historical reports (attendance, hours) | yes | History is not rewritten |
| Audit log entries | yes | Audit trail is permanent |
| Admin household detail (direct link) | yes | Board can look up an archived household by id |
| Unarchive action | yes | Reversibility |

## Migration

### Schema change

```prisma
model Household {
  // ... existing fields ...

  /// @sensitivity:public
  archivedAt DateTime?
}
```

- **Nullable `DateTime?`**, not a boolean. Timestamps record when it happened;
  `null` means active.
- **No backfill needed.** All existing households are active (`null`). The
  column is added as nullable with no default — a zero-downtime column add.
- **Sensitivity: `public`.** Whether a household is archived carries no private
  information — same tier as `id` and `name`.

### Policy migration (raw SQL in the same migration)

Prisma's generated migration for the column add is followed by hand-written SQL
for the policy. In one migration:

```sql
ALTER TABLE "Household" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Household" FORCE ROW LEVEL SECURITY;

CREATE POLICY household_hide_archived ON "Household"
    FOR SELECT USING (
        "archivedAt" IS NULL
        OR current_setting('app.include_archived', true) = 'on'
    );

-- A FORCE'd table with RLS enabled denies any command lacking a permissive
-- policy. One per command: FOR ALL would also cover SELECT and undo the filter.
CREATE POLICY household_insert ON "Household"
    FOR INSERT WITH CHECK (true);
CREATE POLICY household_update ON "Household"
    FOR UPDATE USING (true) WITH CHECK (true);
CREATE POLICY household_delete ON "Household"
    FOR DELETE USING (true);
```

**Deploy ordering.** This is a migration whose new behaviour (rows vanish from
default reads) must be safe against the old code still serving traffic during
the rolling-deploy drain window. It is: the migration only *adds* a filter that
matches nothing at deploy time (no household is archived yet), so old and new
code see identical result sets until a board member archives the first
household — which cannot happen until the new archive route is live. Follow
`DEPLOY_MIGRATION_ORDER_OF_OPERATIONS.md`; the archive *action* ships after the
deploy that carries this migration, never before.

The policy is safe to ship before the reader changes for the same reason: no row
can be archived until the archive route exists, so nothing the policy hides, and
nothing a reader has yet to tolerate, exists until then.

**Infra goes first.** [infra.aws #201](https://github.com/innovationtreehouse/infra.aws/pull/201)
must be applied, and one staging copy run while row security is still off, before
this migration reaches production. Without it, the first staging copy afterwards
fails, even with no household archived.

### The staging copy

Production's `Household` carries one SELECT policy this migration does not create:

```sql
CREATE POLICY stg_copy_read_all ON "Household"
    FOR SELECT TO checkin_prod_ro USING (true);
```

Infra bootstrap adds it (infra.aws #201), so the contract tests never see it: their
database is built from migrations alone. Their "no other permissive `SELECT` policy"
check is about migrations, and does not describe production.

The policy widens one read. `checkin_prod_ro`, whose only member is the staging copy
role `checkin_stg`, can read archived households in production. The app's DML role
cannot, because the policy names only `checkin_prod_ro`.

The copy runs differently from a plain dump, for three reasons:

- **The dump uses `--enable-row-security`, behind a guard.** `pg_dump` otherwise runs
  with `row_security=off`, which errors on any table row security binds. The flag
  stops the error, but on its own it silently leaves out any row a policy hides. So
  the copy first refuses to run unless every row-security table in production has an
  always-true `SELECT` policy for `checkin_prod_ro` and no restrictive policy. A
  future row-security table stops the copy until someone decides how to copy it.
- **The copy drops `stg_copy_read_all` after the restore.** Left in place, `checkin_stg`
  would see archived rows in staging that production's migrate role cannot.
- **The scrub runs with `FORCE` lifted.** The scrub runs as the loading database's
  owner, and `FORCE` binds that owner. A bound `UPDATE` skips the rows a policy hides
  and still exits 0, so an archived household's `intakeNotes` would stay in clear text
  in staging. The scrub also sets `row_security=off`, which turns any table still bound
  into an error. `FORCE` is restored before the database is renamed live.

### Build order

Five PRs, in this order. Each deploys safely on its own.

1. **Expand.** The nullable column and the test DML role. No policy, no reader
   changes.
2. **Policy.** The policy migration, `withArchivedHouseholds`, the enforcement
   contract tests and the opt-in guard. Reaches production only after infra.aws
   #201 is applied and a staging copy has run on it
   (see [The staging copy](#the-staging-copy)).
3. **Readers.** The opt-in sites, null tolerance on the 24 includes, the explicit
   scan and people-search exclusion, and the audit of person queries with no
   household join.
4. **Registry.** The archive route's registry entry, as its own boundary PR, based
   on `main`.
5. **Archive action.** The route and the screen, based on `main`.

### Route for archival

A new mutation on the existing household admin route
(`/api/membership-ops/households/[id]`) — a PATCH setting `archivedAt`. Board
only, and refused while the household has a current Treehouse membership or a
current program enrollment (Decision #4). Unarchive is the same route nulling
`archivedAt`. Both writes run through `withArchivedHouseholds`: Prisma's update
reads the row, an archived row is invisible without the opt-in, and setting
`archivedAt` produces a row the `SELECT` policy would otherwise reject.

No new route file, no new page. The action sits on the existing household detail
view.

## Interaction with #1456 (TOMBSTONE_REMOVAL)

No dependency in either direction. #1228 does not need #1456 to land first, and
#1456 does not need this. If tombstones go away first, `LIVE_PERSON` is deleted
and the Household archive filter is the only remaining exclusion dimension —
and because it is enforced in the database rather than by convention, it needs
no drift guard to survive on its own.

There is a broader point worth recording: RLS is the mechanism `LIVE_PERSON`
itself should arguably have used. `TOMBSTONE_REMOVAL` removes tombstones because
the *convention* is unmaintainable, not because exclusion is wrong. If this
household work validates RLS-based exclusion in the codebase, a future option for
Person is an RLS policy on `mergedIntoId IS NULL` instead of row deletion — out
of scope here, noted so the precedent is deliberate.

## Decisions

IDs are kept so earlier references still resolve. All are settled.

1. **Who can archive?** Decided: the Board only, for archive and unarchive alike.
   Not a sysadmin who is not on the Board, and not household leads.

2. **What about the household's members?** Decided: their Person rows remain.
   They are hidden from people search and person pickers, which RLS delivers for
   every `where: { household: { … } }` traversal (the joined Household row is
   invisible, so the relation filter excludes the person). They stay visible in
   history and audit, through `withArchivedHouseholds`. A person query with no
   household join is not filtered by RLS, so people search gets an explicit
   exclusion.

3. **Check-in behaviour.** Decided: a badge scan for a person in an archived
   household fails exactly as if the person did not exist. There is no
   archived-specific message. The scan does not reach `Household` today, so RLS
   alone does not deliver this: the scan gets an explicit check that sends an
   archived household's badge down the unknown-badge path.

4. **Membership status interaction (HA-7).** Decided: a current Treehouse
   membership or a current program enrollment blocks archiving. Either one is
   enough, and the archive action refuses with a reason.

5. **Opt-in ergonomics.** Proposed: a single `withArchivedHouseholds(tx => …)`
   transaction helper that issues `SET LOCAL app.include_archived = 'on'`.
   Greppable, transaction-scoped, pool-safe. Confirm, or suggest an alternative.

6. **The DB role RLS is enforced against.** Decided: the app connects as a
   rows-only DML role in both stacks, never as the table owner, so row security
   applies to it (`deploy/docker-compose.prod.yml`;
   `DEPLOY_MIGRATION_ORDER_OF_OPERATIONS.md` §9). Both stacks create it as a plain
   login role with no bypass flag: the compose stack in
   `deploy/prod-initdb/05-checkin-roles.sh`, AWS in the infra repo's cluster
   bootstrap.

   **The roles that migrate and test are superusers, and RLS does not bind
   them.** The compose migrate role `prisma` and CI's integration role
   `testuser` are each their container's bootstrap superuser, and a superuser
   bypasses RLS even on a `FORCE`d table. That is harmless in production, where
   neither role serves reads, but it means a test connecting as `testuser` can
   never see the policy work. The archive's RLS tests therefore connect as a
   non-superuser, non-owner test role (see
   [Test role](#test-role-a-dml-like-connection-for-the-rls-suites)).

## Test plan

The safety of this design rests on the **enforcement contract**, not on covering
every query site — see
[Failure modes](#failure-modes-what-fails-silently-and-why-100-query-coverage-is-not-needed)
for why four global tests substitute for per-caller coverage. These four are
non-negotiable; the functional tests below assume them.

**Enforcement contract (the four load-bearing tests):**

1. **Fail-open probe.** Seed one archived + one active household (as
   `testuser` is fine; seeding is a write). Then, connected as the test DML
   role, `household.findMany()` with no opt-in returns only the active one.
   Fails loudly if the policy is missing or the role bypasses RLS.
2. **Opt-in works.** The same query wrapped in `withArchivedHouseholds` returns
   both rows.
3. **No leak across the pool.** Run an opt-in transaction, then a plain query on
   the same pool, and assert archived rows are not visible afterward — catches a
   session-`SET` misuse that would bleed the opt-in onto later requests.
4. **Meta-assert enabled + forced.** Query `pg_class`/`pg_policies` to confirm
   RLS is both enabled and forced on `Household`, and that no permissive policy
   except `household_hide_archived` applies to `SELECT`, so a future migration
   that drops or weakens the policy fails the suite.

**Test-DB integrity (the precondition for the four above):** the DB under test is
built with `migrate deploy`, not `db push`, so the raw policy SQL and `FORCE` are
actually present, and tests 1–3 read as the test DML role, never as `testuser`.
Without both, the four tests pass vacuously. A fifth assertion guards the
second: the role the RLS suites read as has `rolsuper` and `rolbypassrls` both
false in `pg_roles`.

### Test role: a DML-like connection for the RLS suites

The smallest change keeps every other suite as it is and adds one role, created
by the integration harness:

1. **Create the role once per run.** In `checkin-app/test/integrationGlobalSetup.js`,
   after `migrate deploy` on the template, run as the admin connection:
   `CREATE ROLE checkin_test_dml LOGIN PASSWORD '…' NOSUPERUSER NOBYPASSRLS`,
   wrapped in a `DO` block that ignores `duplicate_object`. Roles are
   cluster-wide, and concurrent jest runs from other worktrees share the
   cluster, so creation must tolerate the role already existing.
2. **Grant on the template, so the clones inherit it.** On the template DB:
   `GRANT USAGE ON SCHEMA public`, `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL
   TABLES IN SCHEMA public` and `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA
   public` to `checkin_test_dml`. This mirrors what
   `deploy/prod-initdb/05-checkin-roles.sh` grants `checkin_dml`. Per-worker
   DBs are cloned from the template after this step, so they carry the grants
   with no per-worker work. The role owns nothing, so it is subject to RLS
   exactly as the app's role is.
3. **Publish its URL.** Set `TEST_DML_BASE_URL` to the base URL with the user
   and password swapped, next to the existing `TEST_BASE_URL`. `jest.setup.js`
   already rewrites the database name per worker; it does the same for this URL
   and exposes it as `DML_DATABASE_URL`.
4. **Read through it only in the RLS suites.** The archive's RLS integration
   files build their own Prisma client (or a plain `pg` client for the raw-SQL
   and pool-leak tests) from `DML_DATABASE_URL`. Every other integration suite
   keeps connecting as `testuser`; nothing else changes.

The teardown leaves the role in place. It holds no data, and dropping it would
race the other runs that share the cluster.

**Functional tests:**

- **Relation traversal (the #1232 surface):** `person.findMany({ where:
  { household: { … } } })` excludes members of the archived household with no
  per-site filter; `include: { household: true }` returns `null` for the
  archived household's relation and the caller tolerates it.
- **Raw SQL:** a raw `SELECT` against `Household` as the test DML role honours the
  policy (proves coverage the client extension could never give).
- **Archive action:** PATCH sets `archivedAt` through the opt-in, household disappears from the
  standard list; PATCH nulling it (through the opt-in lookup) restores it.
- **Permission:** only the Board can archive or unarchive; a sysadmin who is not
  on the Board and a household lead both get 403.
- **Refusal:** archiving a household with a current Treehouse membership, or with
  a current program enrollment, is refused, and the household stays visible.
- **Check-in:** a badge scan for an archived household's member returns the
  same response as a badge that matches nobody (Decision #3).
- **Opt-in-path guard:** a source-level test asserts `app.include_archived`
  appears only inside the `withArchivedHouseholds` helper (no other `SET`).

## Out of scope

- **#1456 (tombstone removal).** Independent issue, independent timeline; the RLS
  precedent may inform a future Person exclusion but does not depend on it.
- **Automatic archival.** No cron, no rule that archives after N years of
  inactivity. Archival is a human decision.
- **Person-level archival.** Archival is on the Household. A person who needs to
  disappear is a different problem (merge, or a future person-archive).
- **Bulk archival tooling.** If the board needs to archive 50 households at once,
  that is a UI feature built after the mechanism exists.
- **Data retention / GDPR deletion.** Archival retains the row. A deletion
  obligation would be a separate mechanism with different rules.
