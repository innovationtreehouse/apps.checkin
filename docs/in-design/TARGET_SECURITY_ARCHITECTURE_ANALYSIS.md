# Target security architecture: analysis and open decisions

**Status: WORKING ANALYSIS for
[docs/security/TARGET_SECURITY_ARCHITECTURE.md](../security/TARGET_SECURITY_ARCHITECTURE.md).
That document is the register of decided rules and outlives this one; this
file holds the rationale, surveys, comparative evaluation, and open
decisions behind it. Per the documentation standard, this file is deleted
as the phases that consume it land, with anything that hardens into a rule
extracted to the register first.**

## The model space

Four established families solve this class of problem. Judged against the
register's threat model (T1–T4) and constraints:

**1. Per-view serializers / DTOs** (Rails pundit+blueprinter, DRF
serializers): each route × role gets an explicit allowlist mapping. Safe by
construction at the field level, because you cannot leak a field you never
mapped, and simple. But it fails the audit requirement: policy is scattered
across N serializers, which is exactly the disease that produced
#129/#127/#122 here. Rejected as the organizing model. Its virtue,
**allowlist by construction rather than denylist by subtraction**, is the
single most important property the target design steals.

**2. Externalized relationship-based access control** (Zanzibar: SpiceDB,
OpenFGA, Ory Keto): model "caller may X row" as a relationship graph in a
dedicated service. The *abstraction* is exactly right; this app's scope
vocabulary (`their_own`, `their_households`, `their_program_participants`,
…) is a hand-rolled ReBAC, and that is the correct shape for the domain.
The *deployment* is wrong for one app on one database whose relationship
tuples are already the FK graph: an external tuple store adds
infrastructure, a consistency problem (the graph lagging the DB), and a
second source of truth, and buys nothing a same-DB join doesn't already
provide. Rejected; keep the vocabulary, skip the service.

**3. In-process policy engine over the ORM** (ZenStack for Prisma; CASL,
Oso): declare access rules once; an enhanced client **injects row filters
into every query and confines reads to permitted fields, by construction**.
This is the industry-consensus enforcement point for this exact stack:
policy compiles into the query, so a forgotten `where` or an over-wide
`select` is not writable. ZenStack is this productized: schema-level
`@@allow` rules with relation traversal, an enhanced client, field-level
read policy. The model is right; whether to adopt the dependency is the
build-vs-adopt analysis below. The current system is best understood as a
hand-rolled, partially-built member of this family with the enforcement
half missing.

**4. Postgres row-level security**: policies in the database, keyed on
per-request session context. The only layer that narrows T4, and the only
one that also covers non-route readers (jobs, future server components, a
stray script). The costs are real on this stack: per-request context
through Prisma's connection pooling requires wrapping every query in a
transaction that sets a GUC; policies are written in migrations, a second
policy language to keep consistent with the app's; dev/test parity needs
care; and RLS cannot express field tiers or route context, so it can never
be the whole answer. Correctly scoped, it is a backstop for the handful of
tables where a leak is catastrophic, not the primary mechanism. Whether to
adopt it, and at what scope, is open issue 1 below.

The verdict these four produce is recorded in the register: family 3's
enforcement point with family 2's vocabulary, family 4 as a per-table
addition beneath.

## What exists, and what it teaches

The register records what the shipped system got right (policy as
reviewable data, the scope vocabulary, the equivalence-test discipline,
fail-closed defaults). The deviations from the verdict, all structural
rather than tuning:

- **Enforcement happens at the response, not the query.** Routes hand-write
  `select` and `where`; the stripper subtracts afterward. The two-layer
  redundancy itself is legitimate defense in depth. The defect is that one
  of the copies, the hand-written select, has no declared source of truth,
  so when the layers diverge nothing can *detect* it: a stripper pass
  silently masks an over-fetch, sensitive rows transit process memory, and
  nothing checks that a select even includes the FK fields its scopes match
  on. The target keeps the two-layer evaluation and makes disagreement
  observable (the tripwire); what it removes is the unverifiable
  hand-written copy.
- **Row visibility has no mechanism at all**: hand-rolled `where` clauses,
  human review, and a prose allowlist (`EDGE_INCLUDE_ALLOWLIST`). P0-C and
  #575 shipped through this gap. #1134's diagnosis, that rows must be
  filtered query-side, is correct and is half of the verdict.
- **Coverage is the binding constraint.** About 19 registered endpoints
  across 14 of 142 route files; **116** files call `withAuth` (measured by
  call sites, not string mentions; 5 use the generic `withAuth<T>(` form
  that naive greps miss), **7** files are dual-wrapper (a `handler()` GET
  beside `withAuth` write verbs, so they migrate per-verb), and the
  distinct session-authenticated surface is **123** files, guarded outside
  the registry by a regex scan, a guard class this repo has already
  watched fail three times (`livePersonDriftGuard`, per #1456). Every
  guarantee any of this machinery provides applies only to the registered
  surface.
- **Aggregates are dishonest.** `_count` values are computed over the
  unfiltered relation; the stripper gates only whether the number is
  shown. Only query-side filtering can make a count true.
- **#1134 stops short of the verdict.** It moves rows to the query (right),
  keeps fields at the response (inherited), makes the builders opt-in with
  tests as the only guarantee, and defers by-construction enforcement to
  an undefined "if 1–2 keep leaking" trigger. Tests are a floor, not a
  mechanism: a test-enforced invariant holds only where someone declared
  and fixtured it; a constructed invariant holds everywhere the
  constructor is used.

## Build vs adopt: the analysis

The register records the decision (build, with a constrained include
grammar, and the reversal criterion). The analysis behind it:

What "adopting ZenStack" means for Prisma differs by major version, and
the difference is the trajectory risk in concrete form. **v2 layers on
Prisma**: the ZModel schema is a superset that *generates* `schema.prisma`,
migrations stay `prisma migrate`, and enforcement is `enhance(prisma)`
wrapping the existing client per request, with the raw client remaining
available as the system-context escape. Prisma is not replaced, but
`schema.prisma` becomes a generated artifact, so the `@sensitivity` →
`classifications.ts` pipeline and every schema-comment convention must
survive a move to ZModel. **v3 replaces the runtime**: it reimplements the
Prisma-compatible query API on its own engine (Kysely-based) rather than
wrapping `@prisma/client`. Adopting v2 means betting on a wrapper whose
successor is not a wrapper; adopting v3 means the ORM itself is no longer
Prisma. Either way "adopt" is not a bolt-on; it takes ownership of the
schema toolchain, which is why the build recommendation stands despite
ZenStack's more mature relation-traversal machinery.

### Alternatives to ZenStack

ZenStack is the only tool offering the full package on Prisma (schema-level
policy DSL, row injection, field-level read masking, nested-relation
enforcement), but three neighbors cover parts of it, and one changes the
build option's shape:

- **CASL + `@casl/prisma`**: an ability library whose Prisma adapter
  converts declared conditions into `WhereInput` fragments
  (`accessibleBy(ability).Model`). This is not an alternative *policy
  model*; it is a battle-tested implementation of exactly the `rowsWhere`
  component. It creates a middle path: build the policy layer (registry,
  scopes, bindings, unchanged), borrow the fragment engine instead of
  hand-rolling the conditions-to-`where` conversion. Field-level and
  nested-read enforcement remain ours (stripper + generated selects),
  which we keep anyway. The cost is mapping the scope vocabulary onto
  CASL's ability model and taking a dependency for roughly the 100 lines
  the issue estimated. Worth a day's throwaway prototype (map two or three
  scopes, see whether the vocabulary fits, keep the answer and discard the
  code) before deciding; not obviously worth the indirection.
- **Cerbos**: externalizes the policy *decision* (YAML policies, a policy
  decision point), and its Prisma adapter converts decision query plans
  into `where` filters, so enforcement stays query-side. The right shape
  for an organization standardizing policy across many services; for this
  portfolio it reintroduces a standing service (or an embedded PDP) and a
  second policy language for a vocabulary seven scopes wide. Same verdict
  as Zanzibar: right abstraction, wrong weight.
- **Yates**: manages Postgres RLS *from* TypeScript. Abilities are
  declared in code, compiled into RLS policies, with per-request
  role/context set through a Prisma client extension. Not relevant to
  checkin's rich scopes, but directly relevant to the portfolio
  RLS-primary path: it is the plumbing (policy generation plus a
  GUC-setting extension) that path needs, pre-built. If the portfolio
  decision (open issue 1) lands on RLS, evaluate Yates before hand-rolling
  the extension.

GraphQL-tier permission systems (Hasura, PostGraphile) solve the same
row-and-column problem declaratively but require adopting a different API
layer entirely; not applicable to these REST routes.

### Why the query-builder distinction matters to a policy compiler

ZenStack's v3 move from Prisma-wrapping to a Kysely engine is not a
packaging detail; it responds to the exact problem the facade must solve,
and seeing the same query in both APIs shows the trade. Prisma is an
object-graph API: relations resolve by name, nesting is free, and a filter
is a nested object tree.

```ts
// Prisma: facade-injected row filter merged with the route's narrowing
const rows = await prisma.programParticipant.findMany({
    where: {
        programId: { in: [...ctx.programsLed] },   // policy fragment
        status: 'ACTIVE',                          // route narrowing
    },
    select: { id: true, status: true, person: { select: { id: true, name: true } } },
});
// → [{ id, status, person: { id, name } }]
```

Kysely is a typed SQL builder: joins are explicit, results are flat unless
JSON helpers rebuild the nesting, and types come from a generated DB
interface (`prisma-kysely`; the schema stays the source of truth):

```ts
// Kysely: same read; the join and the nesting are the author's job
const rows = await db
    .selectFrom('ProgramParticipant as pp')
    .select(eb => [
        'pp.id', 'pp.status',
        jsonObjectFrom(
            eb.selectFrom('Person as p')
                .select(['p.id', 'p.name'])
                .whereRef('p.id', '=', 'pp.personId'),
        ).as('person'),
    ])
    .where('pp.programId', 'in', [...ctx.programsLed])   // policy fragment
    .where('pp.status', '=', 'ACTIVE')                   // route narrowing
    .execute();
```

The security-relevant difference is **how a filter composes**. In Kysely,
injecting policy is appending `.where()` calls: every clause ANDs, so
composition is *monotonic narrowing by construction*; a route cannot
accidentally weaken an injected filter, only add to it. In Prisma,
injecting policy means **merging object trees**, and the fail-open case is
key collision: a route key shadowing a fragment key on spread replaces the
policy condition outright. (Sibling keys beside a route `OR:` block still
AND in Prisma's semantics; collision, not coexistence, is the widening
mechanism.) A query builder has no merge step to get wrong, which is
consistent with ZenStack's v3 move to one. The wrap-never-spread rule this
yields is in the register. Prisma's ergonomics (free nesting, named
relations, generated types) remain the reason the facade wraps Prisma
rather than moving to a query builder; the cost of that choice is exactly
one rule, and it is cheap to enforce and test.

### The nested-include leak class

The row leaks that actually shipped did not enter through the top-level
model; they rode in on relation traversal: #575 (`programs/[id]` including
full participant/volunteer rosters) and the whole `EDGE_INCLUDE_ALLOWLIST`
class. (#957, the raw-row echoes on household write routes, is the
neighboring top-level class: whole rows echoed from writes, caught by the
same generated-select rule rather than by relation recursion.) The lesson
is mechanism-independent: enforcement must be per model, applied
recursively at every node of the query graph, because a route author
reasons about the top model and the leak enters through the include. Both
build and adopt close that hole the same way, so the hole itself argues
for *construction*, not for either engine. But it is not neutral on engine
choice: relation recursion is where the build cost concentrates. Injecting
`where` into to-many includes is simple composition; to-one relations take
no `where` in Prisma and need explicit handling (the register bans
null-out and names the two allowed constructions); filtered `_count`,
required relations, and arbitrary include depth are exactly the machinery
ZenStack has already built and debugged. A hand-rolled compiler that
supports arbitrary include graphs *is* the "general policy engine" the
reversal criterion warns about.

### The route survey (checkin)

Whether a constrained grammar can hold is an empirical question about the
routes that exist, so the full route surface was surveyed (all 142
`route.ts` files):

- **Include shapes are shallow and uniform.** 39 files use `include:`; the
  heaviest files have three include sites; observed depth tops out around
  three levels (e.g. `membership-ops/households`: Household →
  householdMembers → programParticipants → program). The recurring shape
  is one pattern, *to-many include + row filter + field select*, sometimes
  nested once more. No route needs arbitrary graph support.
- **69 files use flat `select:`**, trivially covered by generated selects.
- **Raw SQL (8 files) is concurrency control, not read shape**: advisory
  locks (`pg_advisory_xact_lock`) inside write transactions on the
  attendance/scan/visit paths, guarding the one-open-visit invariant. No
  read path ships raw-SQL rows, so the facade's read guarantees are
  unaffected; these transactions go through the write/`asSystem` escape
  regardless of engine.
- **Aggregates are marginal**: two ops-dashboard routes use
  `groupBy`/`aggregate`; nine files use `_count`.
- The survey also found `where: LIVE_PERSON` hand-sprinkled inside nested
  includes: the I5 exclusion being remembered per include site today,
  which is precisely what shared injection removes.

The grammar in the register (to-many with injected filter and select,
to-one to a declared model, filtered counts, depth ≤ 3) is the observed
entirety of this usage, not a hopeful subset.

### The portfolio survey

The wider portfolio (`/Volumes/Untitled/Inventory`: auth, receipt,
expense, income, bulkdonation, local-inventory, global-catalog,
workflow-mapping; 8 Next.js + Prisma apps, ~195 routes, ~76 models,
surveyed the same way) is a different problem on the same stack:

- **The dominant row axis is `orgId` multi-tenancy**, not relationship
  scopes: 131 of 195 route files touch `orgId`, enforced per-route through
  shared helpers (`requireRole` ×110, `requireUser` ×66,
  `requireOrgBearer` for M2M). One tenant-equality predicate, hand-written
  everywhere: the same forgettable-convention disease, but with a far
  simpler cure.
- **Sensitivity is real but differently shaped.** The inventory apps hold
  financial records and customer PII (receipt customer emails and names,
  three plaintext copies per the F9 analysis in `Inventory/ENCRYPTION.md`,
  plus donations, expenses, income). The *tier vocabulary* therefore
  applies there too; what is absent is checkin's per-relationship
  visibility problem, because inventory's sensitive fields are role-banded
  within a tenant, not scoped by household or program relationships.
  (F9's retention/erasure question is a separate axis on top, not replaced
  by any of this.)
- **Query shapes are trivial**: 4 files with `include:` across all eight
  apps, zero raw SQL in routes.

This survey produced the register's portfolio rule (declarations
standardize; enforcement engines are per-app compile targets; RLS is
always generated from declarations, never hand-written).

### Topology and shared databases

If the monorepos split into many repos, the portfolio spine travels as a
small shared package (declaration schema, report generator, validators;
deliberately free of runtime enforcement, so versioning it across repos is
low-risk), and app-local engines don't care where their repo is.

Shared databases deserve a more honest statement, because the portfolio is
already multi-app-on-shared-data: checkin-app reads the s-read function's
`shopify_read_<env>` mirror on the *same Aurora cluster* as its own
database; s-read and s-replay share one dedicated DB through a common
schema-owning package; the monitoring DB takes writes from several
functions. And the boundary already in production for the mirror is
database-resident enforcement: a SELECT-only Postgres role granted in
infra (`modules/s-read/init.sql`), "by GRANT, not by convention." DB-level
enforcement is not a foreign idea here; it is the trusted precedent for
every cross-app boundary the portfolio has.

What distinguishes today's arrangement from the scenario that forces RLS
is granularity. Role grants handle **app-to-app** boundaries (this app may
read those tables, read-only), and that is all today's shared surfaces
need. RLS becomes necessary when a shared database must enforce
**per-caller row** policy: the situation that arrives if checkin splits
into several services over its own DB, where app-layer enforcement would
multiply into N drifting copies. That split is a standing trigger to
re-run open issue 1; the generated-from-declarations rule is already in
place, so the move would not cost the governance surface, and the
grant-based precedent makes it an extension of existing practice, not a
new philosophy.

## Open issues

Decisions needed before the design is final, ordered by how much they
change what gets built.

1. **RLS: backstop here, primary mechanism in the portfolio?** For checkin
   the candidate set is small (Person, EmergencyContact, TrustedAdult
   narratives, Visit) and the question is whether T4 (app-layer
   subversion) and non-route readers are in the protection goal. The
   portfolio survey raises the stakes: for eight apps whose row policy is
   `orgId` equality, one RLS pattern applied uniformly may be the primary
   mechanism, not a backstop; in that case checkin's GUC plumbing
   (per-request context through Prisma pooling) becomes shared portfolio
   infrastructure rather than a per-app cost, so the answer should be
   decided jointly with the portfolio, not per-app. Wherever RLS lands,
   the register's constraint holds: policies are *generated from the
   declarations*, never hand-written SQL, so the governance report and
   equivalence tests survive the mechanism choice. A future split of
   checkin into multiple services over one database re-opens this issue
   in RLS's favor (see Topology above). The acceptance criterion is fixed
   regardless of tooling: the application's database role must not own
   the tables and must not hold `BYPASSRLS`, and the no-context-set state
   must return **zero rows, not all rows**, proven by a standing test
   that issues a query with no context and asserts an empty result. That
   test is most of the layer's value, because the guarded failure is
   someone restoring a permission during an incident and never removing
   it. Two honesty conditions attach. First, **system readers need an
   explicit design before the criterion is adoptable**: the candidate
   tables are exactly what the cron jobs and `asSystem` paths touch, and
   under no-context-equals-zero-rows those silently no-op; the system
   context must be a designed, enumerated role, not an afterthought.
   Second, the escape (an app-set GUC or privileged role) is settable by
   the very subverted app layer T4 posits, so RLS **narrows** T4 rather
   than surviving it outright; the claim must be stated at that strength
   and the system-context path kept as small as the `asSystem` inventory.
2. **Second-party confirmation on the highest-stakes relationship edges.**
   The audit trail and governance-report section for access-granting
   edges are decided (register, "Relationship edges are policy writes");
   still open is whether creating the highest-stakes edges, household
   membership and household lead, additionally requires a second person's
   confirmation, and if so which roles may confirm. A
   friction-versus-safety call on front-desk workflows that the board,
   not this document, should make.
3. **Provenance fields on the family's trusted-adult view.** `/mine`'s
   hand-written select also withholds `origin`, `disclosedById`,
   `hiddenAt`, and `updatedAt`: all `internal`, all granted on paper, and
   provenance rather than deliberation, so the `deliberative` split does
   not cover them. The mechanism now exists (a declared field withhold,
   register, "The tier split"); what remains is the product decision: may
   a family see who disclosed a trusted adult and how? Declare the
   withhold or record the exposure as deliberate. Due before a generated
   select would ship them (sequencing step 5 reaching this route).
