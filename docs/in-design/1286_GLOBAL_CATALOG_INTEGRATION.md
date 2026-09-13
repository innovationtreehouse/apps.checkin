# Global catalog: porting `global-catalog-app` into checkin

## Problem

The organization maintains a shared catalog of what its parts, tools, and
consumables *are* — the reference data every inventory and receipt workflow
depends on to name and match items. Today that catalog lives in a separate
application, on separate infrastructure, behind its own login, that the
organization is retiring. Staff who need to read or curate the catalog cannot do
it where they already work (checkin), and it is the first piece of a larger set
of inventory tools that must all move to one place.

## Objective

The catalog is available inside the existing staff application as ordinary
navigation, using the same sign-in and the same look and feel, deployed and
operated as one system — with the catalog's own logic kept cleanly separable so
that the rest of the inventory tools can follow it in later without entangling
the two.

## Executive summary

- **Staff** reach the catalog as a new **Inventory** area in the existing nav;
  those who curate it get a single new manager role, everyone else with a staff
  relationship can read it.
- **Operators** get one application to run and deploy — no second service, no
  second login — with the catalog on its own database on the shared server.
- **Developers** get the catalog as an isolated library: its logic, data, and
  screens live in one package, and the host application only wires it in. Working
  on the catalog does not mean reading the host application.
- **The organization** gets the first inventory tool moved, on a seam designed so
  the remaining tools migrate onto it rather than around it.

---

**Issue:** [#1286](https://github.com/innovationtreehouse/checkin/issues/1286)
— backlog item CI1 (PORT · NEEDS-DESIGN · XL). Relates to RB4 "Catalog Manager"
([#1316](https://github.com/innovationtreehouse/checkin/issues/1316), open) — see
§6.

**Status:** design. No board decision gates the mechanics below; the one product
choice (which staff may operate the catalog) is resolved in §6 as an interim
single role; the strategic two-role model (RB4/#1316) stays open.

**Source:** `global-catalog-app/` in the `innovationtreehouse/Inventory` repo
(not vendored here — it is a separate repo). Not currently deployed in Infra.

**Domain rules relied on:** `docs/rules/principles.md` (least-privilege — the
viewer gate in §6 widens read access and is justified there); the
security-boundary and migration-order rules cited inline in §5 and §4.

---

## 1. Goal and shape

Bring the global catalog into checkin as **more nav items in the existing
checkin app — one Next.js process, one Infra deploy** — not a second service.

**The whole app — domain *and* UI — lands as an isolated library package**
(`@inventory/global-catalog`): services, repositories, workflows, Prisma
schema/client, and every React component, page, and route handler. `checkin-app`
holds **only structural wiring, no catalog logic**: filesystem-routing re-export
stubs, one `configureCatalog()` boot call that injects checkin's auth + DB, a nav
splice, and the security-registry entries (§3). The dependency arrow points one
way — **the library never imports checkin; checkin injects into the library.**
The library boundary is the point: it forces the catalog to stay decoupled from
checkin internals, and keeps "understand the catalog" = "read the package" true —
a catalog change never means analyzing `checkin-app`.

This is the **first move of an eventual whole-Inventory migration**. Where the
catalog touches Inventory apps that have not moved yet (receipt-app), we bring
**temporary copies** across even if that duplicates a Prisma schema or a type —
temporary meaning **< 2 weeks, dev-only, never in a release**. Clean APIs get
defined at each crossing so the temporary seam is explicit and removable.

### Decisions locked (from design Q&A)

| Question | Decision |
|---|---|
| DB topology | **Own dedicated database** (`CATALOG_DATABASE_URL`) on the **same Postgres server** — separate `schema.prisma` + own Prisma client + own migrations. Precedent: `@inventory/monitoring-db` (own `MONITORING_DATABASE_URL`). A dedicated DB namespaces the generic tables, so no renames. |
| Security regime | **Adopt checkin's** registry + `@sensitivity` generator + stripper **over the separate schema/routes**, even though the schema file stays separate. (scopeBindings: catalog needs none — its actor FKs aren't scopable; §5.) |
| Auth | **Retire** `global-catalog-app`'s `@inventory/auth` + `@inventory/web-auth`. checkin next-auth session is the only auth. |
| Roles | One **new** checkin role: `INVENTORY_MANAGER` (source's global- and org-manager collapse into it for now). Viewer = any RBAC-role holder, program leader, or volunteer (not any authenticated user). See §6. |
| Scope | **Full port**, including receipt-facing pieces, with temporary shims at not-yet-migrated app boundaries. |
| UI location | **All UI in the library** — components, pages, route handlers. checkin-app only re-exports and mounts (§3). |
| UI style | **Keep the client pattern** — `"use client"` components + `/api/*` routes; re-auth + re-theme only. This *is* checkin's dominant pattern (72/87 `page.tsx` are `"use client"`, writes via API routes, server actions essentially unused), so the catalog already matches it. No server-component conversion planned. |

---

## 2. What the source is

`global-catalog-app` is a Next 16 / React 19 / Mantine 7 / Prisma 7 app — the
**same stack checkin already runs** (identical Mantine, tabler-icons, Prisma,
pg-adapter, Next, React versions). It is cleanly layered:

```
src/
  repositories/   catalog, itemReference, proposal, conversionChallenge, orgEvent   (Prisma access)
  services/       categoryService, itemService, proposalService, referenceMatchingService,
                  provisionalGtinService, conversionChallengeService,
                  conflictResolutionService, orgEventService                          (domain logic)
  workflows/      xstate state machines (proposal/supersession lifecycle)
  lib/            gtin, normalizeDescription  (next-free domain — portable)
                  validate  (source imports next/server — NOT ported; replaced by next-free src/routes/_shared.ts in track 4)
                  auth, auth-shared, auth-predicates, route-auth  (RETIRE — see §5)
  app/api/…       route handlers (thin: parse → service → response)
  components/…    *Client.tsx client components (Mantine)
  db/, generated/ Prisma client
prisma/schema.prisma   11 models (own migrations)
```

**Prisma models** (own schema, `@@map` to snake_case tables): `Category`,
`Subcategory`, `Item`, `ItemReference`, `ReferenceConflict`,
`ItemReferenceProposal`, `ConversionChallenge`, `ProvisionalPartSequence`,
`ProvisionalItem`, `ProvisionalItemMappingLog`, `WorkflowTransitionLog`,
`OrgEvent`.

The domain layer is framework-light and ports almost verbatim. The friction is
**auth and UI wiring**, not the domain.

### Workspace dependencies — what the source uses today vs. what we bring

The source **currently** depends on `@inventory/{auth, web-auth, gtin,
workflows, receipt-types, receipt-contract-fixtures, pg-test-harness}`. We do
**not** bring all of them. checkin already vendors `@inventory/{money,
pg-test-harness, …}` under `packages/`, so the vendoring mechanism exists.
Disposition:

| Source package | Ported? | Action |
|---|---|---|
| `@inventory/auth`, `@inventory/web-auth` | **No — dropped** | Not brought across. These *are* the source's auth system, which is retired (§6). Every use is replaced by checkin next-auth. |
| `@inventory/gtin` | Yes | **Own `packages/gtin`** — NOT inside `global-catalog`. Shared, cross-app (GTIN normalization/validation, domain-pure); receipt-app uses it too. |
| `@inventory/workflows` | Yes | **Own `packages/workflows`** — shared xstate helpers, not catalog-specific. |
| `@inventory/receipt-types`, `receipt-contract-fixtures` | Yes (temporary) | **Own `packages/`, temporary copies** — the receipt↔catalog contract; becomes the permanent shared contract when receipt-app migrates (§8). |
| `@inventory/pg-test-harness` | n/a | Already present in checkin. Reuse. |

Two things to keep straight:

- **auth/web-auth** are the one group deliberately **left behind** — they *are*
  the source's auth system, retired for checkin auth (§6).
- **gtin / workflows / receipt-types stay standalone shared packages**, siblings
  of `global-catalog`, **not folded into it.** They are cross-app utilities/
  contracts (receipt-app and future Inventory apps consume them), so burying them
  inside the catalog library would recreate the coupling we're trying to remove.
  Only genuinely catalog-specific helpers live inside `global-catalog/src/lib`:
  `normalizeDescription` (next-free domain). The source's `validate` imports
  `next/server`, so it was **not ported** — Track 4 replaced it with a **next-free
  `src/routes/_shared.ts`** (`parseId`/`readJson`/`parseBody`/`query`) that throws
  host-rendered errors via an **injected `httpError` factory** (checkin's
  `ApiResponseError`). Net: the library route layer imports **no `next/server`** —
  the package stays `next`-free **through Track 4**, cleaner than shipping a
  route-layer `validate`.

---

## 3. Target layout — the meat lives in the library

**Goal: a developer working on the catalog works entirely inside
`packages/global-catalog`.** checkin-app must never accumulate catalog *logic* —
only the minimum structural wiring that Next's filesystem router and checkin's
security model genuinely require. "Analyze checkin-app to understand the
catalog" should never be true.

The library owns **everything with substance**: services, repositories,
workflows, `lib`, the Prisma schema/client/migrations, **the React components,
the page components (server + client), the route handlers, and the nav
manifest.** `@inventory/money` already proves workspace packages compile in-app —
checkin consumes it as raw TS source **with no `transpilePackages`** (money ships
no JSX). A package that also ships **tsx** likely needs
`transpilePackages: ['@inventory/global-catalog']` in next.config; **verify this
during track 5** rather than assuming — it is one line if required.

```
checkin/
  packages/
    global-catalog/                       ← the whole app, as a library
      src/
        repositories/  services/  workflows/  lib/       domain (ported verbatim)
        prisma/schema.prisma  prisma/migrations/  generated/   separate schema+client
        components/                        ALL catalog UI (Mantine, reskinned)
        pages/                             page components — server + client
        routes/                            route-handler factories (GET/POST/…)
        nav.ts                             section-tab links (NavLink[]) + top-level entry descriptor
        runtime.ts                         configureCatalog() + getPrincipal()/db/org accessors
        contract.ts                        CatalogAuth / CatalogPrincipal interfaces
      package.json
    gtin/  workflows/                      vendored @inventory/* deps
    receipt-types/                         TEMPORARY vendored copy
  checkin-app/                             ← WIRING ONLY, no catalog logic
    src/instrumentation.ts                 + one configureCatalog({...}) call at boot
    src/app/(catalog)/**/{page,route}.tsx  re-export stubs — human /api/catalog/* (34 endpoints, built)
    # src/app/api/internal/[...path]       org-bearer machine surface — DEFERRED, blocked (§8)
    src/components/AppFrame.tsx            + one NAV_ITEMS entry (Inventory), from the library descriptor
    src/security/registry.ts               + catalog route entries (boundary is checkin's; scopeBindings: none — §5)
    src/security/core.ts                   + spread the catalog classifications into the merge
    next.config.ts                         + transpilePackages (if tsx needs it — verify, §3)
```

### The cut — what's forced into checkin-app, and why it's thin

Next's App Router discovers routes by **filesystem**, so *some* files must
physically sit under `checkin-app/src/app`. That is the only structural
concession. We make each one a **one-line re-export** of a library module, so it
carries no logic:

```ts
// checkin-app/src/app/(catalog)/catalog/items/page.tsx
export { default } from '@inventory/global-catalog/pages/items'

// checkin-app/src/app/(catalog)/api/catalog/items/route.ts
export { GET, POST } from '@inventory/global-catalog/routes/items'
```

These stubs mirror the library's route map (34 human endpoints as built). They
are generated once (a small script can emit them from a route manifest, or
hand-write them — they change only when a *new* route is added, which is a
deliberate act anyway).

**Route-authoring gotcha (Track 4):** the `endpoint` string each handler passes
to `handler()` must be the **full registered path including `/catalog`** — an
endpoint string that drops the segment makes `getRoute()` miss the registry and
the route 500s at runtime (tsc-green). This bit every catalog route until fixed
(`2ce67cb21`); a guard test now covers it.

**Auth + DB + org injection without the library importing checkin:** the library
declares interfaces in `contract.ts` (`CatalogPrincipal`, `CatalogAuth` with
`getPrincipal()` / `requireManager()` / `isViewer()`, and `OrgIdentity =
{ id, name }` behind an accessor `getOrg(): OrgIdentity`). checkin-app calls
`configureCatalog({ auth, db, org })` **once** in `instrumentation.ts`, passing a
next-auth-backed `CatalogAuth`, the connection, and an `org` accessor backed by
checkin's `Org` registry table (§6). Pages and route handlers read the
configured runtime — so the stubs stay pure re-exports and the library's import
graph never reaches into checkin. (`configureCatalog` is an app-boot singleton —
the one justified global; the ceiling is "one runtime per process," fine for a
single Next app.)

**So the total checkin-app footprint is:** the stub tree (trivial, stable), one
`configureCatalog` call, a nav splice (`catalogNav` array rendered by checkin's
shell), the security registry entries (§5 — a checkin boundary artifact by
design, and mostly `public`), one next.config line. None of it is catalog logic.
Everything a catalog change touches lives in `packages/global-catalog`.

**Honest residue** — three things structurally cannot leave checkin-app, all
mechanical/config, none "meat": (1) the FS-routing stub files; (2) their
`pageRegistry` entries (checkin's drift guard fails otherwise — project memory);
(3) the security registry entries (checkin centralizes the boundary on purpose —
do not fight it; catalog adds no scopeBindings, §5). Adding a *new* catalog route
touches all
three; editing catalog behavior touches none.

---

## 4. Database — its own database on the shared server

The catalog gets its **own dedicated database** (its own `CATALOG_DATABASE_URL`)
on the **same Postgres server** as checkin — separate `schema.prisma`, separate
Prisma client (own `generator client` output), own migration history.

**Precedent, followed exactly:** `@inventory/monitoring-db` — *"a separate
database from any watched service (its own `MONITORING_DATABASE_URL`)"* — same
server, dedicated DB, its own connection string read via `process.env`. The
catalog mirrors this.

Rationale: strongest isolation, LLM development touches one small schema, **and
it dissolves the table-naming problem** — a dedicated database namespaces the
catalog's generic tables (`categories`, `items`, `org_events`, …) completely, so
they never collide with checkin's, no schema prefix and **no model/table
renames needed**. (An in-code clarity rename of the most generic model —
`OrgEvent` — is optional, not required; the catalog's Prisma types live in their
own generated client and don't collide with checkin's types. Keep source names
to minimize port churn; rename only if a shared call site reads ambiguously.)

Implications:

- **Two Prisma clients** load in the checkin-app process (catalog +
  checkin), each with its own connection string / pool. **This is new** —
  checkin-app loads only its own client today; `@inventory/monitoring-db` is
  consumed by the Lambda functions and `packages/*` (s-read, telemetry,
  s-ingest-core, monitoring-relay), never by checkin-app, and
  `deploy/docker-compose.prod.yml` sets only `DATABASE_URL`. So monitoring-db is
  the precedent for **own-DB packaging**, not for a second client inside the Next
  process. The catalog is the first to run two clients in checkin-app; the cost
  is a second connection pool (bounded via the client's pool config).
- **No cross-database SQL** (can't JOIN catalog ↔ checkin). By design — the
  catalog↔checkin/receipt crossings are service-level calls (§8), never SQL
  joins, and the S5 outbox lives entirely inside the catalog DB. A transaction
  never needs to span both.
- **Migrations run independently.** The catalog keeps its `prisma/migrations/`;
  checkin's migration flow (`DEPLOY_MIGRATION_ORDER_OF_OPERATIONS.md`) governs
  checkin's DB only. Add a catalog `migrate deploy` step (against
  `CATALOG_DATABASE_URL`) to the deploy sequence.
- **`db push` caveat** (see project memory): the catalog schema likely relies on
  partial unique indexes the Prisma schema can't express; use `migrate deploy`,
  not `db push`, for any DB the P2002/uniqueness tests run against.

---

## 5. Adopting checkin's security regime over a separate schema

checkin's security boundary is a **Prisma generator**: `generator security` in
`prisma/schema.prisma` runs during `prisma generate` and emits
`src/security/generated/classifications.ts` from `@sensitivity:` annotations.
The registry/handler/stripper/scopeBindings consume that.

To bring the catalog under the same regime **without merging schemas**:

1. **Add `@sensitivity:` annotations** to every field in the catalog schema.
   The reference data is generic — `name`, GTIN, `description`,
   `conversionFactor`, codes, `orgName`, `archivedAt` are **`public`**. The
   only non-public fields are **`internal`**, in three groups:
   - **Actor attribution** — `*ByUsername`, `*ByUserId`, `localUserId`,
     `reviewedByUserId`, `resolvedByUserId`, `mappedByUserId`,
     `transitionedByUserId` (who did what).
   - **Free text** — `rejectionReason`, `reason`, `note` (may carry incidental
     sensitive text).
   - **Cross-app plumbing** — `OrgEvent.payload`, `receiptId`, and
     `ReferenceConflict.lineItemId` (Track 3: same group as `receiptId`).

   Two more calls made in build (Track 3), beyond the illustrative list:
   `ReferenceConflict.resolution` → **`public`** (an outcome code, not one of the
   named free-text fields); `ReferenceConflict.lineItemId` → `internal` (above).

   **No `pii` tier is needed** — the catalog schema has no email/DOB/address
   fields (the one email lives on checkin's `VolunteerDesignation`, outside the
   catalog). So per-field stripping is light: `public` reference data flows to
   the viewer tier; the `internal` attribution/plumbing stays behind
   `everyones:internal`.
2. **Add a `generator security` block to the catalog schema** so
   `prisma generate` emits a **second classifications file** for catalog models.
   Wiring **as built (Track 3)**: the generator's `provider` path is **CWD-relative
   to the package dir** (`node ../../checkin-app/scripts/security-generator.js`)
   and its output is relative to the schema dir. Consequence: the catalog
   package's `prisma generate` (including its `postinstall`) writes **cross-package
   into `checkin-app/src/security/generated/`** and **depends on checkin-app's
   generator script existing** — fine in the monorepo, but it **breaks if the
   package is ever built in isolation** (a real constraint if `global-catalog` is
   later extracted). Merge point is a **spread in `core.ts`** (not a new aggregator
   file); `stripper` and `outbound` repoint to `core`.
3. **Register every catalog route** in `src/security/registry.ts` with the right
   scope/tier tokens. **scopeBindings: none needed (Track 3).** Every catalog
   actor FK is `localUserId` / `*ByUserId`, none of which is in checkin's
   `SCOPABLE_FIELDS` — so the binding validator auto-classes all catalog models
   **un-scopable / admin-only by construction**, and their `internal` fields stay
   behind `everyones:internal` with **no per-row binding**. (The earlier "add
   scopeBindings" wording overstated it — the registry entries are the work; the
   bindings are zero.)
4. Route responses go through checkin's **stripper** like any other route.

**Boundary-isolation process applies** (`AGENTS.md` + the
`security-boundary-isolation` workflow): registry/scopeBindings/generator
changes ship in their **own PR(s)**, ahead of the route code. Land the registry
entries first (an unused `defineRoute` is inert), then the routes. This is the
single most process-heavy part of the port — plan it as its own PR track.

---

## 6. Auth and roles

**Retire the source auth entirely.** Delete `lib/auth.ts`, `auth-shared.ts`,
`auth-predicates.ts`, `route-auth.ts`, `LoginForm`, and `/api/auth/{login,
logout,me}`. checkin already owns login and session.

Every catalog route/page guard is re-expressed against the checkin session
(`getServerSession(authOptions)` + role/predicate check).

### Role mapping — one interim manager role + a broad viewer gate

**`INVENTORY_MANAGER` is an interim reduction, not the strategic model.**
[#1316](https://github.com/innovationtreehouse/checkin/issues/1316) (RB4) is the
**strategic** two-role solution — a **Catalog Manager** *and* an **Org Manager**
(the source's two manager tiers kept distinct). For the first landing this port
**collapses both into one role, `INVENTORY_MANAGER`**, to avoid standing up the
full two-role model before it's needed. So:

- This port **does not close #1316** — it partially addresses it with a
  simplification. Track 2 **references #1316 and leaves it open** as the
  strategic target.
- **Doing #1316 fully later means adding `ORG_MANAGER`** (splitting the collapsed
  role back into Catalog Manager + Org Manager) — that is a #1316 decision, not
  this port's.
- GC-ROLES' "no net-new RBAC roles" is respected: RB4 "Catalog Manager" is a
  role `docs/backlog/TOPDOWN.md` explicitly keeps, and `INVENTORY_MANAGER` is a
  single interim role standing in for it (owner-supplied name), not a second new
  row. The *strategic* Org Manager is added only if/when #1316 lands.

Source tiers → checkin:

| Source tier | checkin (this port) | strategic (#1316) |
|---|---|---|
| **global-manager** (≈ Catalog Manager) | `INVENTORY_MANAGER` | `CATALOG_MANAGER` |
| **org-manager** | `INVENTORY_MANAGER` (collapsed) | `ORG_MANAGER` (net-new, gated on #1316) |
| **viewer** | any RBAC-role holder, program leader, or volunteer — not any authenticated user (least-privilege note below) | (unchanged) |

**Adding the role** touches checkin's role foundation (all in checkin's own
schema, not the catalog schema). The exact surface, **as built (Track 2)**:

- `PersonRoleKind` enum in `prisma/schema.prisma` — add `INVENTORY_MANAGER`.
  Following the `isOperations` precedent, it is **PersonRole-table-only, no legacy
  mirror column** (so `FLAG_TO_KIND` only, **not** `KIND_TO_MIRROR`).
- **Migration:** additive `ALTER TYPE "PersonRoleKind" ADD VALUE IF NOT EXISTS
  'INVENTORY_MANAGER'` — **not** transaction-wrapped (Postgres forbids using a
  new enum value in the same txn that adds it).
- `src/lib/roles.ts` `FLAG_TO_KIND` (derives `ROLE_FLAGS`, `rolesToFlags`).
- `src/types/next-auth.d.ts` — the new flag in **3** spots (JWT/Session/user).
- `RoleBadge` `ROLE_META`.
- **Three `ROLE_FLAGS`-indexed row-type interfaces** that tsc forces the optional
  `isInventoryManager?` onto: `src/app/membership-ops/participants/page.tsx`,
  `src/app/membership-ops/roles/page.tsx` (via `RolesEditTarget`),
  `src/components/roles/RolesEditModal.tsx`.
- **No `/api/roles` code change** — the route iterates `ROLE_FLAGS` and
  `setRoleFlag`'s authority matrix already lets sysadmin/board grant any flag, so
  the new role is grantable automatically. (The earlier "grant UI" line
  overstated the surface.) **No `DevLoginPicker` change** either (it renders a
  fixed badge subset, already omitting OPERATIONS).

**Viewer predicate**: a new `isCatalogViewer(session)` = authenticated **and**
any of — holds `INVENTORY_MANAGER`, holds **any** `PersonRole` (RBAC role),
`programsLed` non-empty (program leader), or has a `VolunteerDesignation` (keyed
by email; volunteer). This is the single chokepoint for read access.

**Volunteer signal reaches the client via a claim (Track 5 as-built).** The
first three inputs are already on the session, but `VolunteerDesignation` is
email-keyed with **no session flag** — so nav/UI can't mirror the gate without a
DB call. Track 5 added a **`hasVolunteerDesignation` JWT/session claim** (a new
`next-auth.d.ts` field) so `isCatalogViewerClient` mirrors the server gate
exactly. **Follow-up (boundary PR):** the server resolver still does its own
per-request DB lookup for the designation — it could be deduped to read the
claim instead; tracked in §12.

**Least-privilege note** (`docs/rules/principles.md`): this gate *widens* read
access — a broad set of staff can read the whole catalog. That is deliberate and
proportionate: the catalog is reference data, tiered `public`/`internal` with
**no `pii`** (§5), so a wide read audience exposes no personal data; write access
stays narrow (`INVENTORY_MANAGER` only). The widening is confined to non-personal
reference data, which is what least-privilege permits — stated here so the
widening is a decision on the record, not an accident.

Per-route authorization then reads: **writes** → `INVENTORY_MANAGER`; **reads** →
`isCatalogViewer`.

### Org + user identity — one injected source, consistent across libraries

The catalog carries `org_id` / `org_name` on proposals, provisional items, and
`OrgEvent`, and `local_user_id` for the acting user. In the source these came
from the **org-bearer token minted by the auth-server** (user identity from the
cookie session) — **both of which are retired.** checkin has **no `orgId`
concept at all** (it is inherently single-org: it *is* Treehouse). So the
integration must define where these values come from — and, since receipt-app
and the rest of Inventory follow into this one process, they must be **consistent
across every library**, not defined per-app.

Decision — an **org registry row, not an env scalar.** An env var (`INVENTORY_ORG_ID`)
was the wrong instinct: a scalar in config bakes in single-org, so "go
multi-org" later means ripping env plumbing out of every library. Instead the
org is a **row in an `Org` registry table** (`{ id, name, … }`), so single-org
today is one row and multi-org later is *more rows* — no schema or config
rewrite.

- **Where the table lives: the host app (checkin) owns the `Org` registry.** The
  org concept is cross-cutting, not catalog-specific — every migrated Inventory
  library (receipt, expense, income…) needs the same org identity, so it cannot
  live inside the catalog DB. checkin-app is the host/root of the one process,
  so the `Org` table sits in **checkin's schema**. (Alternative if stronger
  isolation is ever wanted: a dedicated shared org registry DB. Not needed now.)
- **Registered on the initial migration/seed**, not lazily on first load. The
  Treehouse org row is seeded with a **stable, well-known id** (deterministic
  across dev/prod so cross-references and stamped `org_id`s match everywhere).
  Lazy first-load registration is rejected — nondeterministic id, boot races.
- **Consistency across libraries is preserved by injection, not shared reads.**
  checkin-app reads its own `Org` table and passes org identity into
  `configureCatalog({ auth, db, org })`. `org` is an **accessor**
  (`getOrg(): OrgIdentity`), not a frozen value: single-org returns the one row;
  multi-org later resolves the current org per request (from session / tenant /
  route) — same seam, no library change. **No library ever reaches cross-DB into
  checkin's `Org` table** — this is what the earlier "no settings-table row"
  objection was really about (cross-DB per-library reads), and injection avoids
  it while still using a table.
- **Keep the `org_id` / `org_name` columns** (String) — do not drop them. They
  already match a registry id; single-org just stamps every row with the one
  seeded org, and multi-org fills them from the resolved accessor.
- **User identity (`local_user_id`) maps to checkin `Person.id`**, supplied by
  the injected `CatalogPrincipal` (`getPrincipal()`), not a separate users table
  (the source's local-users table is gone with its auth). So **both org and user
  identity flow through the single `configureCatalog()` injection** — one source
  per process, reused unchanged as each Inventory library migrates in.

---

## 7. UI — reskin in place

All UI lives in the library (`packages/global-catalog/src/{components,pages}`).
checkin-app only re-exports pages (§3) and wires nav (see Nav placement). Both
apps use the same Mantine version, so the reskin is component-level, not a
rewrite.

**Keep the source's API-route + `"use client"` pattern** — re-theme and re-wire
auth only. This is not a compromise: it *is* how checkin behaves today (72 of 87
`page.tsx` are `"use client"`, `programs/[id]` etc. fetch `/api/*` from
`useState`/`useEffect`, writes go through API routes, server actions are
essentially unused). So the catalog already matches checkin's server-side model —
there is no client→server conversion to do, now or later.

- Drop the source `Layout`/nav shell. Catalog pages render inside checkin's
  shell (the checkin layout wraps the `(catalog)` route group); the library
  exports `catalogNav` for checkin's nav to render, gated by `isCatalogViewer`.
- Keep `CategoriesClient`, `GlobalInventoryClient`, `ItemReferenceProposalsClient`,
  `ConversionChallengesClient`, `ProvisionalProposalsClient`, etc. **in the
  library** as `"use client"` components; restyle to checkin conventions and
  point their `fetch` calls at the `/api/catalog/*` routes (whose handlers are
  library factories). Wire auth via `useSession` client-side + `getServerSession`
  in the route handlers, exactly as checkin's own client pages do.
- **`/api/catalog/*` is the human surface only** (`catalog-viewer` /
  `INVENTORY_MANAGER`). The **org-bearer** machine reads would live under
  **`/api/internal`**, not `/api/catalog` — kept separate by auth + response
  shape (§8; that surface is deferred).
- **Response shape (Track 4 as-built):** the human `GET /api/catalog/items` ships
  a **bare model-bag array**, *not* a `{items,total,page,…}` envelope —
  `handler()`'s stripper drops non-model bag keys, so pagination meta can't ride
  the response. Any earlier "paginated envelope" wording is superseded by this.
- **Pagination (Track 5 as-built): offset + one-row-lookahead, NOT a count
  endpoint.** A table-wide total can't ride the model-bag response (same stripper
  wall as above; the `_count` precedent is a *relation* count inside a row, not a
  standalone scalar), so a clean count endpoint **isn't available without a
  security-boundary change — treat it as a dead end.** Track 5 built **offset +
  one-row lookahead** (fetch `limit+1`, use the extra row to decide Prev/Next):
  every row reachable, bounded pulls, no total. A later track should **not chase a
  count endpoint** unless a boundary PR makes one possible.

**No server-component migration is planned.** A full server-driven rewrite would
make the catalog *more* server-driven than checkin itself — a checkin-wide
direction decision, not a catalog-port concern. If checkin ever moves that way,
the catalog moves with it, in the library.

### Nav placement

checkin has **two nav layers**, and the catalog uses both:

1. **Top-level sidebar** = a single ordered `NAV_ITEMS` array in `AppFrame.tsx`
   (`{ href, label, icon, visible(user, signedIn, counts) }`, rendered in order,
   filtered by `visible`).
2. **Section tabs** within a section = a `NavLink[]` array (checkin's shared
   `NavLink` type in `src/lib/nav/types.ts`; each section keeps its own array,
   e.g. `FACILITY_NAV_LINKS`) rendered by `SectionTabs`.

Order is a checkin-shell concern, so the library **exports descriptors** — the
top-level entry (href/label/icon + the `isCatalogViewer` predicate) and the
section-tab `NavLink[]` — and **checkin-app places them**: it adds the entry to
`AppFrame.tsx`'s `NAV_ITEMS` at its chosen index. The library never dictates
sidebar order.

- **One top-level entry, label `Inventory`** (forward-looking: catalog is the
  first Inventory surface; more arrive as the migration proceeds). Its
  sub-screens (Items, Categories, Proposals, Conversion Challenges) are the
  section's **`NavLink[]` tabs** rendered by `SectionTabs`, following checkin's
  existing ops-section pattern — not separate top-level nav items.
- **Default position: in the ops cluster, immediately after `Shop Ops`** — the
  catalog is the parts/tools reference domain that Shop Ops consumes, so it reads
  naturally there. (This slot is a recommendation, not load-bearing; checkin can
  reorder freely since it owns the array.)
- **Gate: `isCatalogViewer`** — note this is **broader** than the board-only
  `*-Ops` items around it (any RBAC role / program leader / volunteer sees it, by
  §6), so more staff see `Inventory` than see e.g. `Finance Ops`. That is
  intended.
- **Badge:** if a manager-facing count is wanted (e.g. open proposals), it uses
  checkin's existing `navBadges` mechanism keyed on the section href — optional,
  not first-landing.

---

## 8. Receipt-app crossings — when HTTP becomes an in-process call

**Receipt-app also migrates into this same Next process** (later). So today's
cross-app HTTP calls between catalog and receipt-app become **in-process
cross-library calls**. This section fixes *when and how* each crossing converts.
Guiding decisions: **keep the JSON/contract shapes** (they stay the shared
vocabulary — remove a schema only if a field genuinely dies); convert
**transport, not architecture**.

### The two crossing archetypes (from the source)

| Crossing | Direction | Kind | Contract | Today's transport |
|---|---|---|---|---|
| **S4** — `provisional-gtin/next`, `items/lookup` (3-pass matcher), `items/check-references`, item-reference / provisional-item proposals, conflict report | receipt → catalog | **synchronous RPC** | `@inventory/receipt-types` zod schemas | `POST /api/internal/[...path]`, org-bearer auth |
| **S5** — `emitOrgEvent(tx, orgId, payload)` | catalog → world | **async outbox** — validated payload written to the `OrgEvent` table in-transaction, drained by a poller/consumer | `orgEventPayloadSchema` (S5) | table write + polled read |

These convert **differently** — that is the whole point of deciding now.

### The org-bearer machine surface — DEFERRED, blocked (Track 4)

The source has **more org-bearer routes than the S4 row above enumerates**, and
two of them collide with the human `/api/catalog/*` namespace (§3/§7). Verified
against `global-catalog-app/src/app/api/**` at `innovationtreehouse/Inventory@main`
plus the live remote consumers.

**Track 4 did NOT build the machine surface — it is deferred, pending a boundary
decision.** (An earlier planning note called it "ported verbatim / owner-approved";
that did not survive contact with checkin's auth boundary. This is the corrected
as-built.) The org-bearer route `/api/internal/[...path]` is **blocked** by four
real constraints:

1. Its gate is `requireOrgBearer` from the **retired** `@inventory/web-auth`
   (§6 deletes it) — **no checkin-side org-bearer validator is specified**.
2. checkin's `authenticateRequest`/`resolveAccess`/`handler()` pipeline has **no
   org-bearer auth path**, and the registry `authorize` grammar **cannot express
   one**.
3. `scripts/legacy-authz-routes.txt` (where every other machine route lives) is
   **frozen** — no new entries.
4. Placing it at `src/app/api/internal/[...path]/route.ts` trips
   `check-route-coverage`'s **`new-route-old-authz` ratchet — a blocking error**.

So there is currently **no sanctioned way to land a new machine-bearer route** in
checkin. The options were (A) extend checkin's auth with an org-bearer
`AuthResult`/`Authorize` variant (own boundary PR); (B) a scoped exception to the
frozen `legacy-authz-routes.txt` baseline; (C) never host it in checkin.

**Resolved: (C) (§12).** There are **no remote users at first landing**, so
checkin never hosts `/api/internal` and A/B are not needed. Longer term the
remote-communication model is expected to be a **periodic file export** (catalog
dumped to AWS disk, consumers read the file), not a live endpoint — so hosting
`/api/internal` is likely never built. A design follow-up issue (§12) works the
export format/cadence/contract.

**The folded `/items` flat-list branch depends on the same decision — also not
built.** Disposition of the source's other org-bearer routes (unchanged):
`GET /api/catalog` (bare) and org-token `POST /api/conversion-challenges` are
**dropped** (dead — no consumers); `GET /api/catalog/items` (+`/[gtin13]`) flat
reads still have remote consumers, served today by the **old** server (option C
is their de-facto first-landing state).

**Human vs machine split (built):** `/api/catalog/*` is **human-only**
(`catalog-viewer` / `INVENTORY_MANAGER`). The org-bearer reads, *if* checkin ever
hosts them (A/B), go under `/api/internal`, not `/api/catalog` — they share a
path in the source but differ in auth and response shape, so they cannot be one
handler.

### Conversion rule (per crossing)

1. **Trigger = co-residence.** Convert a crossing only once **both** libraries
   run in the same process **and** the callee's service surface is importable.
   Never depend on unlanded code; convert crossing-by-crossing, not big-bang.
2. **Every crossing sits behind a port** (an interface in `contract.ts`) with
   **two adapters**: `http` (today) and `in-process` (after co-residence). The
   binding is chosen once in `configureCatalog()`. **Converting a crossing = swap
   one adapter binding — zero call-site churn.** The port's types *are* the JSON
   contract, so the shape is identical in both modes.
3. **Synchronous RPC (S4):** at co-residence, bind the in-process adapter — the
   caller imports the catalog service function directly (via the port) instead of
   the `catalog-client` HTTP stub. Keep the zod schemas as the function
   param/return types. (This rule assumes an S4 HTTP server exists to retire; per
   the deferred-machine-surface finding above, checkin may **never host
   `/api/internal`** — under option C the old server carries S4 for the whole
   overlap and there is nothing checkin-side to retire.)
4. **Async outbox (S5):** **do NOT collapse to a direct call.** The outbox
   (durable `OrgEvent` rows, in-transaction write, retry/ordering/audit) has
   value independent of transport. At co-residence the consumer stops
   HTTP-polling the producer and instead **reads the shared `OrgEvent` table
   in-process** (or a shared in-process bus), but the async seam stays. Collapse
   to a synchronous call only with a specific reason; default is keep.
5. **JSON structure stays.** The contract package (`receipt-types` S4 schemas,
   the S5 `orgEventPayload` schema) remains the shared vocabulary in both modes.
   The vendored copy (below) is temporary **as a copy** — it becomes the
   permanent shared `packages/` contract once receipt-app lands. Delete a schema
   only when its field genuinely dies, not merely because the call went
   in-process.

### First landing (catalog in, receipt-app not yet)

- Vendor `@inventory/receipt-types` + `receipt-contract-fixtures` as
  **temporary copies** (mark with a `ponytail:` removal note + tracking
  follow-up). Endgame: promote to a shared `packages/` contract when receipt
  arrives.
- **Machine surface (`/api/internal`, org-bearer) is NOT hosted by checkin** —
  option C (§12), since there are **no remote users at first landing**. Nothing to
  serve; the old server covers any residual consumer during overlap. The eventual
  remote-communication model is a **file export** (§12 follow-up), not this route.
- **Consumer repoint (only if checkin ever hosts A/B):** `local-inventory-app`
  and `workflow-mapping-app` read `/api/catalog/items` (+ `/[gtin13]`) on the old
  server. If/when checkin hosts the machine surface, they repoint to
  `/api/internal/items`. Until then they keep pointing at the old server; no
  checkin change. Tracked as a #1286 follow-up.
- The **S5 consumer / org-events poller** has no producer in checkin yet: land
  it **inert** (no scheduled invocation) behind a flag until receipt-app
  migrates. The outbox producer (`emitOrgEvent`) can run from day one — rows
  simply accumulate until a consumer is enabled. `conversion-challenges` ships
  **manager GET/accept/reject only**; its list stays empty until a receipt
  producer exists.
- Provisional-from-receipt paths stay reachable via the catalog's own manual
  routes (as the source already supports) until the receipt producer exists.

All temporary duplication is **< 2 weeks, dev-only** by the stated philosophy —
acceptable, tracked for removal.

---

## 9. Infra / deploy

The catalog adds **no new service**. It compiles into `checkin-app`'s build and
ships in checkin's existing container (`deploy/docker-compose.prod.yml` +
`Caddyfile`; Infra `checkin-bootstrap` module). Deploy changes:

- Build the new `packages/*` (workspace build already covers `packages/*`).
- **Provision the dedicated catalog database** on the existing Postgres server
  and its `CATALOG_DATABASE_URL` secret — mirroring how `MONITORING_DATABASE_URL`
  / the monitoring DB is provisioned in the Infra database module.
- Add **catalog `prisma migrate deploy`** (against `CATALOG_DATABASE_URL`) to the
  deploy sequence, ordered with checkin's own migration step.
- **Seed the `Org` registry row** for Treehouse (stable well-known id) in the
  initial migration/seed (§6) — checkin-app reads it and injects org identity
  into each library; multi-org later adds rows, no config change.
- No new Caddy route, no new port, no new container — same app, new paths.

---

## 10. Testing

- **Keep vitest** — the source and **every checkin `packages/` package** (money,
  monitoring-db, pg-test-harness, s-ingest-core, telemetry) run `vitest`.
  `global-catalog` is a package, so it keeps vitest. **No jest conversion** (jest
  is checkin-app's convention, not the packages').
- **Unit tier ports ~verbatim (Track 1); the source's integration tier becomes
  checkin FLOW tests in Track 5 (Track 4 finding).** The **unit** tests
  (services/validation, no route/auth) port with almost no change — Track 1 took
  them as-is. The source's **21 integration tests are route+auth-bound** (source
  `app-compat` HTTP shim + `@inventory/auth` `seedGlobalManager`/`seedOrg`), so
  they don't port near-verbatim. In checkin's world that coverage **is flow
  tests** — route+auth+DB e2e over HTTP with persona-mint — which §10 assigns to
  **Track 5**, not a separate "Track 4 integration rewrite." (Earlier wording put
  a "21 integration rewrite" in Track 4; Track 4 as-built was library
  contract/runtime + route factories + `configureCatalog` + 34 human stubs only.
  The integration rewrite and the flow tests are **the same work** here.) The
  catalog journeys those 21 source tests covered must be carried by the Track 5
  flow suite so they don't fall through.
- **CI wiring — mostly already there (Track 1 finding).** The root
  `test:packages` script already globs `npm run test -w ./packages --if-present`,
  so the catalog package's vitest runs **automatically** — no new root script or
  CI job. The one wiring needed: add the catalog client generation to
  `db:generate:test` (run by `pretest:packages`). **Ops gotcha:** the catalog DB
  integration tier **silently skips unless `DOCKER_HOST` reaches the container
  runtime** (the pg-test-harness container) — document this so a green run isn't
  mistaken for coverage.
- **Security tests**: registry/stripper coverage for catalog routes lives in
  `checkin-app/src/security/__tests__` (jest — it tests checkin-app's boundary
  wiring). Companion to the boundary PR (track 3).
- **e2e = flow tests, not Playwright.** checkin has **no Playwright** and does
  end-to-end as **flow tests** (real HTTP journeys against a running dev server —
  `AGENTS.md`). So the source's Playwright specs (`auth`, `categories`, `items`,
  `proposals`, `role-access`, `error-states`) are **re-expressed as
  `flow-tests/*.flow.test.ts`**, not ported as Playwright — introducing
  Playwright would add tooling checkin deliberately doesn't have, and the catalog
  is API-route-driven for the first landing, so HTTP flow tests cover it well.
  These land **in track 5** (with routes + auth + UI), not deferred.
- **Browser-only UI assertions** (client-side form validation, modal behavior —
  the few things a flow test cannot assert): **not** covered by the above. If
  wanted, that is the *only* genuinely deferred test work — track it as a
  **follow-up issue referencing #1286**, not as vague "later." Default position:
  flow tests suffice; open the follow-up only if a real gap appears.

---

## 11. Phasing (PR tracks)

1. **Library skeleton** — `packages/global-catalog` (+ vendored `gtin`,
   `workflows`, temporary `receipt-types`), catalog schema + client + migrations,
   domain services/repositories/workflows ported, **unit tests only** (88 vitest
   pass; the source's integration tier → Track 5 flow tests; source `validate`
   not ported — Track 4 uses a next-free `_shared.ts`). Package stays `next`-free.
   No UI, no checkin wiring. Green in isolation. *(Built: Track 1.)*
2. **Roles foundation** — add the `INVENTORY_MANAGER` `PersonRoleKind` value (the
   interim reduction; references #1316, does **not** close it — strategic
   Catalog+Org split stays open) +
   roles.ts + next-auth types + grant UI. Own PR (role-system change).
3. **Security boundary** — `@sensitivity` annotations, second `generator
   security` (cross-package wiring, §5), registry route entries — **no
   scopeBindings** (catalog FKs aren't scopable; §5). Own PR track,
   **registry-first**.
4. **Routes + auth** — library route factories + `contract.ts` + `configureCatalog`
   wired in `instrumentation.ts`; **34 human `/api/catalog/*` stubs**
   (`catalog-viewer`/`INVENTORY_MANAGER`); next-free `src/routes/_shared.ts` (no
   `next/server` — replaces the source `validate`). **The org-bearer machine
   surface (`/api/internal`) is NOT built — deferred, blocked (§8); needs a
   boundary decision A/B/C.** Human `GET /api/catalog/items` returns a bare
   model-bag array (pagination → Track 5). Depends on 1–3. *(Built locally: Track
   4, `b893d90b7` + `221022be7`; human surface **verified working** — a stub bug
   where `handler()` endpoint strings dropped the `/catalog` segment made
   `getRoute()` miss the registry and every catalog route 500'd; fixed +
   guard-tested in `2ce67cb21`, caught by a Track 5 flow test.)*
5. **UI + nav + flow tests + pagination** — reskinned pages/components (library),
   page stub tree + `pageRegistry` entries, `Inventory` entry in `AppFrame`
   `NAV_ITEMS` + section `NavLink[]` tabs, `transpilePackages` (if tsx needs it —
   verify). **Flow tests carry the source's 21 integration journeys** (route+auth+DB
   e2e via persona-mint) — the "integration rewrite" lands here, not Track 4.
   **Adds list pagination** — offset + one-row-lookahead (Prev/Next, no total); a
   count endpoint is a dead end without a boundary change (§7).
6. **Infra** — deploy sequence + DB provisioning.
7. **(Deferred — each a tracked follow-up issue vs #1286, not prose "later")**
   removal of temporary receipt shims when receipt-app migrates; browser-only UI
   test coverage if a gap appears (§10). File the follow-up issues at merge so
   nothing relies on memory. *(No server-component migration — the catalog stays
   `"use client"`, matching checkin; see §7.)*

---

## 12. Open items / assumptions

- **Production data: none to migrate. Two orthogonal population paths — not
  alternatives.** There is no existing catalog data to import.
  - **Direct** (this design): catalog entries are entered **by hand through the
    UI**, from a Google Sheet. There is **no *direct* bulk-import endpoint or
    script** — the source has none (items are created singly) and none is wanted.
  - **Indirect** (receipt-driven, later): `docs/backlog/TOPDOWN.md` GC-INVENTORY
    (Q22/Q30) describes replaying 1,000–2,000 stored **receipts** to load
    inventory, which **triggers** catalog growth as a side effect (provisional
    GTIN allocation, item-reference proposals — the S4 crossings in §8). That is
    the **receipt pipeline's** job, not a catalog import, and it arrives **when
    receipt-app migrates** into the process. This design neither builds nor
    supersedes it; §8 is where the catalog receives those triggered actions.

  So "no bulk load" (direct) and receipt-replay (indirect) do not conflict — they
  are different mechanisms populating the catalog from different sources.
- **Dev/test seed — pull from `scripts/setup-test-data.sh`.** Inventory's
  `scripts/setup-test-data.sh` carries the baseline catalog rows (category
  `Electronics`/`N`, subcategory `Control System`/`10`, items `Roborio v2` +
  `Power Distribution Hub`, one item-reference). **Lift that data/shape**; drop
  its transport — the script drives the catalog over `curl` + the retired
  `/api/auth/login`, whereas the checkin seed writes **directly via the catalog
  Prisma client / library services** against `CATALOG_DATABASE_URL`. (The
  gc-app `src/__tests__/helpers/seed.ts` is auth-token seeding only — not
  reusable.) Add `VolunteerDesignation` rows too (seed currently has **0** —
  project memory) so the viewer gate and catalog pages are exercisable in dev
  and flow tests.
- **RESOLVED — org-bearer machine surface: option (C).** **No remote users at
  first landing**, so checkin **never hosts `/api/internal`** — the machine
  surface is not built (§8), and there is nothing to gate, ratchet, or repoint.
  Options A/B (extend checkin auth / baseline exception) are **not needed now**.
  This closes the Track 4 blocker for the port. **Future direction (below):** the
  remote-communication story is expected to become a **periodic file export**, not
  a live endpoint at all.
- **FUTURE / follow-up issue — "how do we communicate global catalog items
  remotely?"** The eventual model is a **file export**: the global catalog is
  dumped to **AWS disk (S3/EFS) on a schedule**, and remote consumers read the
  file rather than calling a live endpoint. This replaces the org-bearer
  live-endpoint model (A/B) entirely, and is why hosting `/api/internal` in
  checkin is likely never worth building. **Open a design follow-up issue
  referencing #1286** at end of the conversion to work the export format, cadence,
  location, and consumer-read contract.
- **Consumer repoint (only under A/B).** `local-inventory-app` and
  `workflow-mapping-app` read the old server's `/api/catalog/items` (+
  `/[gtin13]`). checkin does **not** serve those paths at first landing; the old
  server answers them. Only if checkin later hosts the machine surface (A/B) do
  they repoint `/api/catalog/items` → `/api/internal/items`. **Follow-up issue
  referencing #1286**. Also: `POST /api/conversion-challenges` (org-token) and
  bare `GET /api/catalog` were **unused and dropped** — reintroduce under
  `/api/internal` only if a receipt producer needs it.
- **Viewer-gate DB dedup (Track 5 follow-up, boundary PR).** The client now reads
  a `hasVolunteerDesignation` JWT/session claim (§6), but the **server** resolver
  still does its own per-request `VolunteerDesignation` DB lookup. Deduping the
  server to read the claim instead is a possible **boundary PR** — tracked, not
  first-landing.
- **Deferral discipline.** Anything this design pushes past the first landing
  (track 7) becomes a **GitHub follow-up issue referencing #1286**, filed at
  merge — never a bare "later" in prose or a code comment. That is how we
  remember: the issue tracker, not this doc.

**Resolved in Q&A:** single `INVENTORY_MANAGER` role (managers collapsed); viewer
= any RBAC role / program leader / volunteer; catalog gets its **own dedicated
database** on the shared Postgres server (`CATALOG_DATABASE_URL`,
monitoring-db pattern) — no table renames needed; **org identity from an `Org`
registry row (checkin-owned, seeded on initial migration with a stable id),
injected via `configureCatalog` as an accessor — multi-org-ready, not an env
scalar or a cross-DB settings read** (§6); UI stays `"use client"` (no
server-component migration); nav = one `Inventory` entry in `AppFrame`'s
`NAV_ITEMS`, default slot right after `Shop Ops`, gated by `isCatalogViewer`,
sub-screens as `SectionTabs` (§7).

---

*Design for #1286. Whole-Inventory migration context: this is the first app to
move; temporary duplication at receipt-app boundaries is expected and tracked.*
