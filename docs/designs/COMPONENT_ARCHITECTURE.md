# Component architecture

checkin is moving to a **composed-component** shape: each app domain is an
isolated library component that compiles into checkin's single Next process,
rather than a separate service. One process, one deploy, one login; the domains
are decoupled packages behind clean seams.

The **Inventory apps prove the model first** — global catalog (#1286) is the
first to land, with local-inventory (#1287), expense (#1272), income (#1283),
bulk-donation (#1280), receipt (#1265), and workflow-mapping (#1289) following
onto the same seam. Once the model is proven, checkin's **own** domains
(check-in, registration, and the rest) are pulled out as components the same
way. So nothing here is inventory-specific: it is the shared architecture every
component inherits, and it survives the per-app working docs, which are deleted
as each lands.

Each component's **domain rules** (its access, identity, and invariants) live in
that domain's `docs/rules/` file — the catalog's are in `docs/rules/inventory.md`.
This file is the architecture those rules sit on, and it uses the catalog as the
worked example because it is the first component built.

## One process, many component packages

Each component lands as an isolated library under `packages/` (the catalog is
`@inventory/global-catalog`): its services, repositories, workflows, Prisma
schema/client/migrations, React components, pages, and route handlers. It
compiles into `checkin-app`'s single Next process and ships in checkin's
existing container — no second service, no second login.

`checkin-app` holds **only structural wiring, no component logic**:
filesystem-routing re-export stubs, one `configure<Component>()` boot call, a nav
splice, and the security-registry entries. The dependency arrow points one way —
the component never imports checkin; checkin injects into the component.
"Understand a component" stays equal to "read its package."

The residue that structurally cannot leave `checkin-app`, all mechanical: the
filesystem-routing stub files (Next discovers routes by path), their
`pageRegistry` entries (checkin's drift guard requires them), and the security
registry entries (checkin centralizes the boundary on purpose). Adding a new
route touches all three; editing behavior touches none.

## The injection seam

A component declares interfaces in its own `contract.ts` (principal, auth, an
`OrgIdentity` accessor, and any consumer ports). `checkin-app` calls
`configure<Component>({ auth, db, org, ... })` once at boot in
`instrumentation.ts` (the catalog's is `configureCatalog`), passing a
next-auth-backed auth, the connection, and an org accessor. Pages and route
handlers read the configured runtime, so the stubs stay pure re-exports and the
component's import graph never reaches into checkin. `instrumentation.ts` only
binds — it never touches a database at boot.

**Constraint — the org accessor is synchronous (`getOrg(): OrgIdentity`), read
once at boot and closed over.** Fine for single-org. The multi-org future
(resolve the current org per request) cannot use this sync seam as-is: it needs
an async accessor or a per-request cache. Multi-org is therefore a contract
change, not just "add rows."

## Database — own database per component

A component that owns data gets its own dedicated database (its own
`*_DATABASE_URL`) on the **same** Postgres server as checkin — separate
`schema.prisma`, separate Prisma client, own migration history. Precedent:
`@inventory/monitoring-db`.

- A dedicated database namespaces the component's generic tables (`items`,
  `categories`, `org_events`), so no table/model renames are needed.
- A second Prisma client loads in the checkin process (the first component to do
  so was the catalog; monitoring-db is consumed only by Lambdas). The cost is a
  second connection pool, bounded by the client's pool config.
- No cross-database SQL — a crossing is a service call (below), never a JOIN,
  and no transaction spans two databases.
- Migrations run independently; add each component's `migrate deploy` (against
  its own URL) to the deploy sequence. Use `migrate deploy`, not `db push`: a
  schema may rely on partial unique indexes the Prisma schema cannot express.

## Security — adopt checkin's boundary over a separate schema

A component's schema is annotated with `@sensitivity:` and carries its own
`generator security` block, which emits a classifications map that is merged
into checkin's via a spread in `src/security/core.ts`. Routes go through
checkin's registry/handler/stripper like any other.

- **Cross-package coupling.** The component's `generator security` `provider`
  path is CWD-relative and shells out to
  `checkin-app/scripts/security-generator.js`, writing its output cross-package
  into `checkin-app/src/security/generated/`. This is fine in the monorepo but
  **bites the prod image build** (the generator script must be present when the
  component installs) and **breaks if a package is ever extracted** standalone.
- **scopeBindings only where FKs are scopable.** The catalog's actor FKs are
  bare user ids, none in checkin's `SCOPABLE_FIELDS`, so the binding validator
  classes all its models un-scopable / admin-only by construction — the registry
  entries are the work, the bindings are zero. A component with scopable FKs
  adds bindings; one without does not.
- **Synthetic public-scalar classification.** `handler()`'s stripper drops
  non-model bag keys, so a bare scalar (a count, a total, a nav badge) cannot
  ride a response. The sanctioned way across is a small hand-authored `public`
  classification for the scalar's shape, merged in `core.ts`, behind its own
  registered endpoint (the catalog's `CatalogItemCount { total: public }` is the
  reference example). Prefer this over envelope workarounds.
- **Boundary-isolation process applies.** Registry/generator changes ship in
  their own PR(s), registry-first, ahead of the route code (`AGENTS.md`).

## Crossings between components — in-process calls

Components co-reside in one process, so cross-app calls are synchronous
in-process calls behind ports. A component never imports another component; the
caller declares a port in its `contract.ts` and checkin-app binds the
implementation in the caller's `configure<Component>()`.

- Every crossing is schema-checked at runtime with the shared zod contract, and
  the callee asserts the payload's `orgId` matches its injected org — this is
  what replaces a per-org bearer token's scoping now that the token is gone.
- No polling, no new schedules. Any catch-up a crossing needs is an idempotent,
  capped, counts-only step inside the existing `/api/cron/reconcile-shopify`.
- JSON contract shapes are kept (the shared vocabulary); only the transport
  changes. A field is removed from a contract only when it genuinely dies.

**A legacy org-bearer machine surface is not hosted.** checkin has no org-bearer
validator, its auth pipeline cannot express one, and the legacy-authz baseline
is frozen. The options were (A) extend checkin's auth, (B) a scoped exception to
the frozen baseline, or (C) never host it — resolved **C**, because every caller
is a component that co-resides and calls the service in-process. Remote orgs
outside this checkin are served by a **periodic file export** (data dumped to
disk, consumers read the file), whose format and cadence are a tracked design
follow-up. The in-app HTTP surface is human-only.

### The post-commit call-out (outbox pattern)

When a component must notify others of a committed change across database
boundaries, it uses a post-commit call-out, of which the catalog's org-event
producer is the first instance.

- The producer validates and writes an outbox row (the catalog's `OrgEvent`)
  **inside** its own transaction — the row is the commit receipt. Producer and
  consumer have separate databases, so a cross-component effect is always two
  commits, and the row is what lets the second be replayed.
- After that transaction commits, the producer calls each registered consumer
  in-process in the same request. Consumers register through a consumer port
  (the catalog's `OrgEventConsumer`); the producer never imports a consumer.
- A consumer failure never undoes the producer's write: a throwing consumer is
  logged, the rest still run, the request succeeds.
- Each consumer keeps its own cursor in its own database and advances it in the
  same transaction as its reaction, so the cursor never passes an event whose
  reaction did not commit. Replay reads the producer's rows after a given id;
  the catch-up cron step re-applies from the cursor. The producer records
  nothing about who consumed what — tracking consumers would couple it to them.

## UI and nav

All UI lives in the component (components, pages, route handlers); checkin-app
re-exports pages and places nav. Components keep the `"use client"` + `/api/*`
pattern — this *is* checkin's dominant pattern, so there is no client→server
conversion to do. The component exports nav descriptors (a top-level entry with
its viewer predicate, and section-tab links); checkin-app places them in its
`NAV_ITEMS` array and renders section tabs with `SectionTabs`. The first
component of a product area opens a top-level entry (the catalog opens
**Inventory**); later components in the same area add section tabs under it
rather than new top-level entries.

## Org and user identity — one injected source

checkin is inherently single-org (it *is* Treehouse) and had no org concept. Org
identity is an **`Org` registry row**, not an env scalar: single-org is one row,
multi-org is more rows — no config rewrite. The table lives in checkin's schema
(the org concept is cross-cutting, not component-specific), is seeded on the
initial migration with a **stable, well-known id** (deterministic across
dev/prod so stamped `org_id`s match), and is injected — a component never reads
it cross-database. User identity maps to checkin `Person.id` via the injected
principal. Both flow through the one `configure<Component>()` injection, reused
unchanged as each component is built.

## Roles and access

Each component's read/write admission is expressed against the checkin session —
a write role plus a read gate, wired through the injected auth, never a
component-local auth system. The catalog uses `INVENTORY_MANAGER` for writes and
a broad viewer gate (any of several staff role flags, a program leader, or a
volunteer designation) for reads; those specific roles are domain rules in
`docs/rules/inventory.md`, not architecture. The pattern — gate at the component
boundary against checkin's session — is what is universal.

## Deploy — the prod image is not free

A component adds no new service, container, or Caddy route, but the image needs
real Dockerfile work:

- The deps stage copies the component package **plus its workspace dependency
  manifests** and the component schema/config — not just checkin-app's.
- A component's `postinstall` shells out to checkin-app's security generator (the
  cross-package coupling above), so the build stage must have that script present
  when the component installs.
- The runner must ship the component's Prisma client + migrations **and a
  zero-import deploy config** (a Prisma config pulling in no app code) so
  `migrate deploy` runs in the image.
- Provision the dedicated database and its `*_DATABASE_URL` secret, and seed the
  `Org` registry row. Infra uses standalone secret shells with explicit
  two-branch phasing (the staged two-phase secret idiom was removed upstream) —
  do not follow any "staged" wording literally.

## Testing

Components keep **vitest** (every `packages/*` does; jest is checkin-app's
convention, not the packages'). The root `test:packages` script already globs
package tests, so a component's vitest runs automatically. Source **unit** tests
port near-verbatim; route+auth-bound **integration** tests and Playwright specs
are re-expressed as checkin **flow tests** (real HTTP journeys via persona-mint)
— checkin has no Playwright, and introducing it would add tooling checkin
deliberately lacks. A component's DB integration tier silently skips unless
`DOCKER_HOST` reaches the container runtime — a green run there is not coverage.
