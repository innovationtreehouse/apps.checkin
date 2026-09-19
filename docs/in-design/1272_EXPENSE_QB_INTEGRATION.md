# Expense + QuickBooks: porting `expense-app` into checkin

## Problem

The organization turns hundreds of corporate-card receipts a year into booked
QuickBooks entries: each receipt's money side is split into line items, each line
is signed off by whoever owns that budget, capital purchases get a fixed-asset
number, and the whole thing is posted to QuickBooks against the right account.
Today that lives in a separate application, on separate infrastructure, behind
its own login, that the organization is retiring — and it is the **money-side
tail of the receipt→catalog→inventory pipeline**, the point where a received
receipt finally becomes a general-ledger fact. Finance staff cannot run any of it
where they already work (checkin), and — critically — **checkin has no
QuickBooks integration at all** (no QB model, field, client, or credential
anywhere in schema or `src`; confirmed in `docs/backlog/CUJS.md` A15). So this
port also has to bring the first QuickBooks code into checkin.

## Objective

Expense capture, per-line owner approval, the finance flag/checkoff queues, the
capital register, and QuickBooks posting are available inside the existing staff
application as ordinary navigation, under the same sign-in and look and feel,
deployed and operated as one system — with the expense logic kept cleanly
separable (its own library, its own database), the pipeline couplings (receipt in,
catalog lookups, inventory load out) designed as explicit swappable seams, and
QuickBooks brought in as an **incremental phase ladder** grounded in the real
`@inventory/quickbooks` client rather than a stub.

## Executive summary

- **Finance staff** reach expense in the existing **Finance** nav area;
  checkoffs and holds route to a new `FINANCE` role and (for escalations) the
  existing `BOARD` role, per-line approval routes to the line's **budget owner**,
  and — unlike the catalog/inventory ports — **reads are narrow, not broad**:
  expense data is financially sensitive, so there is no wide viewer gate (§6).
- **Operators** get one application to run and deploy — no second service, no
  second login — with expense on its own database on the shared server, and one
  new operational step: a **one-time QuickBooks OAuth consent** to mint tokens
  (§9).
- **Developers** get expense as an isolated library (`@inventory/expense`): logic,
  data, and screens in one package; checkin only wires it in. QuickBooks arrives
  as the shared `@inventory/quickbooks` package — read client + OAuth already
  built, the write path and checkin token storage net-new (§9).
- **The organization** gets the pipeline's money terminus moved onto the seam the
  catalog and inventory ports established, plus the **first QuickBooks connection**
  — settled once, reused by donations and program-finance later (GC-QB).

---

**Issue:** [#1272](https://github.com/innovationtreehouse/checkin/issues/1272)
— backlog epic **FE** (§6 of `docs/backlog/INDEX.md`), anchor item **FE1**.
Journey **A13** in `docs/backlog/CUJS.md`. The epic's other issues —
[#1273](https://github.com/innovationtreehouse/checkin/issues/1273) (FE2 budget
owners / owner conflict),
[#1274](https://github.com/innovationtreehouse/checkin/issues/1274) (FE3 QB
posting + account/vendor mapping),
[#1275](https://github.com/innovationtreehouse/checkin/issues/1275) (FE4 capital /
depreciation),
[#1276](https://github.com/innovationtreehouse/checkin/issues/1276) (FE5 QB drift /
reconciliation), and the later
[#1277](https://github.com/innovationtreehouse/checkin/issues/1277)–[#1279](https://github.com/innovationtreehouse/checkin/issues/1279)
(FE6–FE8) — are referenced **without any closing keyword**: this is a design-doc
PR, and a closing link here would auto-close them on merge with nothing built.
Relates to **RB2 "Role: Finance"**
([#1314](https://github.com/innovationtreehouse/checkin/issues/1314), open) — the
canonical backlog issue for the finance role this port stands up (§6). **Owner
decision: `FINANCE` is a distinct `PersonRoleKind` row** (not folded onto `BOARD`),
so #1314's core question is settled here. Still referenced **without a closing
keyword** (design-doc rule); #1314 tracks only the residual sub-actor detail
(Treasurer / Bookkeeper / Accountant designations under the role).

**Status:** design. No board decision gates the mechanics below. This doc is the
**third in a series** and **reuses the base architecture** established by the
global-catalog design
([#1286](https://github.com/innovationtreehouse/checkin/issues/1286),
`docs/in-design/1286_GLOBAL_CATALOG_INTEGRATION.md`) and the local-inventory
design
([#1287](https://github.com/innovationtreehouse/checkin/issues/1287),
`docs/in-design/1287_LOCAL_INVENTORY_INTEGRATION.md`) — **read those two first.**
Everything about in-process packaging, the own-database topology, the security
regime over a separate schema, the retire-source-auth decision, the injected
`Org` registry, and the per-crossing coupling rule is carried over verbatim from
them; this doc states the expense-specific surface, the finance role/read
divergence, and the QuickBooks phase ladder that is unique to it.

**Source:** `expense-app/` in the `innovationtreehouse/Inventory` repo (a separate
repo — not vendored here). Not currently deployed in Infra.
**QuickBooks client:** `packages/quickbooks/` (`@inventory/quickbooks`) in the same
monorepo — a working read-only QBO client (OAuth2 in three `fetch` calls, no SDK),
**not a stub** (§9).

**Domain rules relied on:** `docs/backlog/TOPDOWN.md` **GC-FIN-CONTROL**
(flags + checkoff + audit — the app surfaces flags for human checkoff, it does
**not** enforce approval tiers), **GC-PROGRAM-FINANCE** and **GC-QB** (settle the
QB connection/auth first); `docs/rules/principles.md` (least-privilege — here it
*narrows* reads, §6); the security-boundary and migration-order rules cited inline
in §5, §9, and the QB token handling in §9.

---

## 1. Goal and shape

Bring expense into checkin as **more nav items in the existing checkin app — one
Next.js process, one Infra deploy** — not a second service. Identical to the
catalog (#1286 §1) and inventory (#1287 §1) decisions.

**The whole app — domain *and* UI — lands as an isolated library package**
(`@inventory/expense`): repositories, services, the xstate expense state machine,
the QB processor, the capital register, Prisma schema/client, and every React
component, page, and route handler. `checkin-app` holds **only structural wiring,
no expense logic**: filesystem-routing re-export stubs, one `configureExpense()`
boot call that injects checkin's auth + DB + org + the crossing adapters, a nav
splice, and the security-registry entries (§5). The dependency arrow points one
way — **the library never imports checkin; checkin injects into the library.**

This is the **third app of the whole-Inventory migration** (catalog first,
inventory second). Expense sits **downstream of receipt-app** (it consumes the
receipt money side) and **couples sideways to the catalog** (item/account lookups)
and **to local-inventory** (signoff triggers inventory load). Where expense
touches Inventory apps that have not moved yet (receipt-app, the
workflow-mapping orchestrator), we **keep the HTTP seam / bring temporary copies**
exactly as #1286 §8 prescribes — temporary meaning **< 2 weeks, dev-only, never
in a release** — with a clean port at each crossing (§8).

The one thing this port adds that neither predecessor had: **QuickBooks**. It
lands `@inventory/quickbooks` as the first QB code in checkin and grows the write
path on an explicit phase ladder (§9).

### Decisions locked (carried over from #1286/#1287, adapted)

| Question | Decision |
|---|---|
| DB topology | **Own dedicated database** (`EXPENSE_DATABASE_URL`) on the **same Postgres server** — separate `schema.prisma` + own Prisma client + own migrations. Same `@inventory/monitoring-db` precedent #1286 followed. |
| Security regime | **Adopt checkin's** registry + `@sensitivity` generator + stripper + scopeBindings over the separate schema (§5). **QBO OAuth tokens never touch a checkin/expense DB** — they live in an external secret backend owned by an Infra refresher (§9), so there is no `secret`-tier schema field to guard; the app reads the access token **read-only** and hosts **no OAuth route** (consent is an operator CLI step, §9). |
| Auth | **Retire** `expense-app`'s `@inventory/auth` + `@inventory/web-auth` (+ `jose`, the login page, `/api/auth/{login,logout}`). checkin next-auth session is the only auth (§6). |
| Roles | **New `FINANCE` role** (RB2 "Finance" umbrella — a role `docs/backlog/TOPDOWN.md` GC-ROLES explicitly *keeps*, not a net-new invention) for the checkoff/queue actor; **existing `BOARD`** for threshold/COI escalation; per-line approval routes to the line's **budget owner** (a `Person`, a data relationship not an RBAC role). **Reads narrow** — no broad viewer gate (§6). This is the port's main divergence from #1286/#1287. |
| Scope | **Full port** of the A13 / FE1–FE5 surface (§ below), with temporary shims at the not-yet-migrated receipt-app / orchestrator boundaries (§8). FE6–FE8 noted, not designed (§9, §13). |
| UI location | **All UI in the library** — components, pages, route handlers. checkin-app only re-exports and mounts (§3). |
| UI style | **Keep the client pattern** — `"use client"` pages + `/api/*` routes; re-auth + re-theme only. Matches checkin's dominant pattern, same as #1286 §7 / #1287 §7. |
| `orgId` / user identity | **Keep the columns; inject the values** — resolved by #1286 §6. Org identity comes from the **checkin-owned `Org` registry table** (seeded on the initial migration with a stable well-known id), injected as an accessor `getOrg(): OrgIdentity` — **not** an env scalar, **not** a `SettingsData` row, **not** a cross-DB read. The heavy user-id columns (`submitterId`, `ownerId`, `budgetOwnerUserId`, `decidedByUserId`, `capitalOwnerId`, `userId`) map to checkin **`Person.id`** via the injected principal. Both flow through the single `configureExpense()` injection (§6). |
| QuickBooks | **Incremental phase ladder** QB-0…QB-3 (§9), grounded in `@inventory/quickbooks` (read client + OAuth already built; write path + the `qb_pending` terminus net-new). Static creds (`QBO_CLIENT_ID/SECRET/ENVIRONMENT/REDIRECT_URI`) are **Infra-managed env/secrets**. **The app never writes a secret and never holds the rotating refresh token:** an **Infra-owned refresher** (Secrets Manager rotation Lambda / scheduled Lambda) owns the refresh token + rotation and publishes the current access token; the app reads it **read-only** (`GetSecretValue`). **No token in Postgres, no file, no app-side write** (§9 QB-0). |

### The A13 / FE1–FE5 surface (scope)

1. **Expense + line model; per-line owner approval** (FE1). Each line gets a
   `LineItemOwnerApproval`; the budget owner approves/rejects their own lines.
2. **Approval + flag / checkoff / audit** (FE1/FE2, GC-FIN-CONTROL). Flags —
   tax-attached, threshold-crossed, missing-receipt, non-Everyday, **COI/conflict**
   — are surfaced to the right human (finance / board) for a checkoff, all
   audit-logged. The app does **not** enforce approval tiers; the **household-aware
   COI conflict flag is the one with real logic** and is *buildable here* because
   checkin has households (§6, the "port gets better" item). Actions:
   approve / reject / assign-owner / finance-assign / raise-exception /
   resolve-unknown, each with its queue.
3. **Budget owners; owner↔PN associations; owner-conflict resolution** (FE2).
   `PartOwnerMap` (owner per GTIN) + the owner-conflict resolution queue.
4. **Capital review + depreciation-cycle designation** (FE4), including the
   **capital-register seed intake** the QB script feeds (§8, §9 QB-1), and the
   NET-NEW loop-closing step (assign ITFA number → log in QB → remind finance to
   sticker the physical asset, Q66).
5. **Expense holds + resubmit; MULTIPLE_MATCHES hold** (FE3). The account-mapping
   exception screen: `NO_MATCH` / `MULTIPLE_MATCHES` / `NO_PART_NUMBER` holds,
   resolve + resubmit.

Each surface has its own **exception/queue screen** — those queues are the
"missed oversight surfaces" A13 is about.

---

## 2. What the source is

`expense-app` is a Next 16 / React 19 / Mantine 7 / Prisma 7 app — the **same
stack checkin already runs**, and the same stack as the two prior ports. Cleanly
layered:

```
src/
  repositories/   expense, org, orgEvents, provisionalItemMap, provisionalResolution   (Prisma access)
  services/       provisionalItemMapService                                            (domain logic)
  workflows/      expense.machine + events/guards/invariants + expense-event-schema     (xstate lifecycle; QbLineItemSchema)
  lib/            expense-qb-processor, expense-rules, financial-flow, capital-register,
                  workflow-engine, expense-constants, catalog-schemas          (domain; portable)
                  inventory-client, api-client, org-events-poller, org-events-container (crossings)
                  auth, auth-shared, route-auth                                (RETIRE — see §6)
  app/api/…       route handlers (thin: guard → validate → service → response)
  app/…           page.tsx (client) per surface
  components/      AppShellLayout, CapitalReviewPanel, LineItemOwnerApprovals, … (reskin/retire)
prisma/schema.prisma  16 models (own migrations)
```

**Prisma models** (own schema, `@@map` to snake_case): `Expense`,
`ExpenseLineItem`, `LineItemOwnerApproval`, `AccountMapping`, `ExpenseHold`,
`ExpenseEvent` (the **QB outbox**), `ExpenseQbAccount`, `ExpenseAuditLog`,
`PartOwnerMap`, `ProvisionalItemMap`, `ProvisionalResolution`,
`ReceivedExpensePayload` (receipt intake), `ReceivedOrgEvent`, `CapitalAsset`
(the **ITFA fixed-asset register**), `OrgSettings` (capital thresholds),
`SettingsData` (poll config — dead on arrival, §8).

The domain layer is framework-light and ports almost verbatim. The friction is
**auth wiring, the QuickBooks terminus, and the three pipeline couplings** (§8/§9),
not the domain. Two mechanisms worth flagging up front because the port must
preserve them exactly:

- **The QB "post" is an outbox emit, not a direct API call.** The state machine
  runs `owner_approval → (capital_review → set_depreciation_cycle) → qb_pending`,
  and at `qb_pending` `expense-qb-processor.ts` resolves each line to one QB
  account, allocates tax/shipping/discount, and — in **one interactive
  transaction** — writes a validated `QbExpenseEvent` row to the `ExpenseEvent`
  table and advances `qb_pending → qb_complete`. The row is the durable outbox;
  **something downstream posts it to QuickBooks.** In the source that downstream
  writer does not exist yet — the machine terminates the moment the event is
  committed. **The write path is exactly what §9 QB-2 builds** in
  `@inventory/quickbooks`.
- **`backfill` / `qb_skipped`.** An expense reconciled to an already-booked QB
  transaction auto-approves owner signoff and lands terminal `qb_skipped` (QB post
  skipped) while still building the capital register. This is the hook for GC-QB's
  "reconcile with 3 years of existing QB, idempotent, sync-not-clobber" (§9 QB-1).

### Workspace dependencies — reuse the prior ports' vendored packages, add QuickBooks

The source depends on `@inventory/{auth, gtin, money, org-events-poller,
receipt-types, service-client, web-auth, workflows}`. **The catalog port (#1286)
already vendors `gtin`, `workflows`, `receipt-types`, `receipt-contract-fixtures`;
the inventory port (#1287) already vendors `org-events-poller`; checkin already
vendors `money`.** Expense **reuses** those. New to expense: `service-client` and
— the headline — `@inventory/quickbooks`.

| Source package | Ported? | Action |
|---|---|---|
| `@inventory/auth`, `@inventory/web-auth` | **No — dropped** | The source's auth system, retired for checkin next-auth (§6). Drop `jose` with them. |
| `@inventory/gtin` | Reuse | `packages/gtin`, vendored by #1286. |
| `@inventory/workflows` | Reuse | `packages/workflows`, vendored by #1286. Shared xstate helpers. |
| `@inventory/money` | Reuse | Already in checkin `packages/money` (cents math). |
| `@inventory/receipt-types`, `receipt-contract-fixtures` | Reuse (temporary) | Vendored by #1286 as temporary copies. Expense imports the same copy — it needs `CompletedReceiptSchema` (receipt intake, §8) and the S5 `parseOrgEvent` union (provisional events, §8). |
| `@inventory/org-events-poller` | Reuse | `packages/org-events-poller`, vendored by #1287. But **drop the wall-clock timer** — the S5 consumer is push-driven exactly as #1287 §8a decided; expense is a **second consumer** of catalog events (provisional resolution). |
| `@inventory/service-client` | **Only if a remote crossing is ever bound** | The typed HTTP client the source uses for the catalog crossing (pathPrefix `/api/internal`, org-bearer). In checkin **every** expense crossing is in-process or not-hosted (catalog read in-process §8b; receipt intake in-process §8a; inventory-load in-process §8c; QB is its own outbound client §9), so `service-client` is the **unused `http` fallback** — **not bound at first landing.** Vendor it only if a genuinely remote crossing ever appears; check whether #1286/#1287 already vendored it first. |
| `@inventory/quickbooks` | **Yes — new `packages/quickbooks`, NET-NEW to checkin** | The first QuickBooks code in checkin. Read client + OAuth2 (three `fetch` calls, no SDK) + types **already built**; write path + checkin token storage + the outbox-drain terminus are net-new (§9). Standalone shared package — donations (GC-DONOR) and program-finance (GC-PROGRAM-FINANCE) consume it later. |
| `@inventory/pg-test-harness` | n/a | Already present in checkin. Reuse. |

Only genuinely expense-specific helpers (`expense-qb-processor`, `expense-rules`,
`capital-register`, `financial-flow`, `workflow-engine`, `catalog-schemas`,
`inventory-client` wiring) live inside `expense/src/lib`.

---

## 3. Target layout — the meat lives in the library

**Goal: a developer working on expense works entirely inside
`packages/expense`.** Same cut #1286 §3 / #1287 §3 established.

```
checkin/
  packages/
    expense/                              ← the whole app, as a library
      src/
        repositories/  services/  workflows/  lib/       domain (ported verbatim)
        prisma/schema.prisma  prisma/migrations/  generated/   separate schema+client
        components/                        ALL expense UI (Mantine, reskinned)
        pages/                             page components — client
        routes/                            route-handler factories (GET/POST/…)
        routes/_shared.ts                  next-free parse/validate (injected httpError; replaces source route-auth, §6)
        nav.ts                             section-tab links (NavLink[]) for the Finance nav section (§7)
        runtime.ts                         configureExpense() + getPrincipal()/db/org/crossing accessors
        contract.ts                        ExpenseAuth / ExpensePrincipal / OrgIdentity + crossing ports (§8) + QB port (§9)
      package.json
    quickbooks/                           NEW — @inventory/quickbooks (first QB code in checkin, §9)
    service-client/                       http-fallback client — only if a remote crossing is ever bound (§2; not at first landing)
    gtin/  workflows/  receipt-types/  org-events-poller/  money/   REUSED (vendored by #1286/#1287 / already present)
  checkin-app/                            ← WIRING ONLY, no expense logic
    src/instrumentation.ts                + one configureExpense({...}) call at boot (+ QB outbox drain, §9)
    src/app/(finance)/**/{page,route}.tsx  re-export stubs
    src/lib/nav/…                           the library's NavLink[] in the finance section tabs (§7)
    src/security/{registry,scopeBindings}.ts   + expense entries (QB has no app OAuth route; consent is operator CLI — §5/§9)
    next.config.ts                        + transpilePackages (if tsx needs it — verify, §3)
```

### The cut — same as the prior ports

Next's App Router discovers routes by **filesystem**, so the ~30 route handlers +
~10 page files must physically sit under `checkin-app/src/app`. Each is a
**one-line re-export** of a library module:

```ts
// checkin-app/src/app/(finance)/expenses/[id]/page.tsx
export { default } from '@inventory/expense/pages/expense-detail'

// checkin-app/src/app/(finance)/api/expenses/[id]/line-item-approvals/[approvalId]/approve/route.ts
export { POST } from '@inventory/expense/routes/line-item-approval-approve'
```

**Auth + DB + org + crossings injected without the library importing checkin:**
the library declares interfaces in `contract.ts` (`ExpensePrincipal`,
`ExpenseAuth` with `getPrincipal()` / `requireFinance()` / `requireBoard()` /
`isBudgetOwner()`, `OrgIdentity = { id, name }` behind `getOrg()`), plus the
crossing **ports** (§8) and the **QB port** (§9). checkin-app calls
`configureExpense({ auth, db, org, catalog, inventory, quickbooks, catalogEvents })`
**once** in `instrumentation.ts` — the one justified boot singleton, mirroring
`configureCatalog()` / `configureLocalInventory()`.

**Honest residue** — same three mechanical things that structurally cannot leave
checkin-app: (1) the FS-routing stub files; (2) their `pageRegistry` entries
(checkin's drift guard — project memory); (3) the security registry/scopeBindings
entries (checkin centralizes the boundary on purpose). Adding a *new* expense
route touches all three; editing expense behavior touches none. **One extra boot
concern** expense has: the QB outbox **drain** and the source's crash-recovery
`recoverStrandedQbExpenses()` run once from `instrumentation.ts` (server runtime
only, never during `next build`) — no wall-clock timer, exactly as #1287 §8a
handled the org-events poller (§9).

---

## 4. Database — its own database on the shared server

Own dedicated database (`EXPENSE_DATABASE_URL`) on the same Postgres server as
checkin — separate `schema.prisma`, separate Prisma client, own migration
history. Identical rationale and precedent to #1286 §4 (`@inventory/monitoring-db`).
A dedicated DB namespaces the generic tables (`expenses`, `account_mapping`,
`capital_assets`, …) so **no model/table renames** are needed.

Implications (same as #1286 §4 / #1287 §4, plus):

- **Four Prisma clients** now load in the checkin-app process (catalog +
  local-inventory + expense + checkin), each its own connection string / pool.
  Expense is the **fourth**; the incremental cost is one more bounded connection
  pool. (monitoring-db is the own-DB *packaging* precedent, not the
  second-client-in-Next precedent — that is catalog, #1286.)
- **No cross-database SQL.** expense ↔ catalog ↔ local-inventory ↔ checkin
  crossings are service-level (§8), never SQL joins. The household-COI check (§6)
  reads checkin's `Person`/household graph via the injected principal/port, not a
  cross-DB join.
- **Migrations run independently** — add a `migrate deploy` step against
  `EXPENSE_DATABASE_URL` to the deploy sequence (§9), ordered with checkin's,
  catalog's, and inventory's.
- **`db push` caveat** (project memory): the source relies on `@@unique`
  constraints (`expense_events_org_expense_unique`,
  `part_owner_map_org_gtin_unique`, `capital_assets_org_number_unique`, …) that
  are the idempotency/dedup backstops. Use `migrate deploy`, not `db push`, for
  any DB the uniqueness tests run against.

**The QB OAuth tokens do NOT live here.** The rotating refresh token is owned by
an external Infra-owned refresher (a Secrets Manager rotation Lambda); the app
reads only the current access token, read-only. Never a row in this — or any —
checkin/expense database, and the app never writes a secret. See §9 QB-0.

---

## 5. Adopting checkin's security regime over a separate schema

Same mechanism as #1286 §5 / #1287 §5: a `generator security` block for the
expense schema, **merged into `core.ts` by a spread** (not a new aggregator file);
registry route entries; responses through checkin's stripper. Carry over three
as-built facts the prior ports settled (Track 3/4/5):

- **Generator wiring** (#1286 Track 3): the generator `provider` path is
  **CWD-relative to the package dir** (`node ../../checkin-app/scripts/security-generator.js`)
  and its output writes **cross-package into `checkin-app/src/security/generated/`**,
  so the package's `prisma generate` (incl. `postinstall`) depends on checkin-app's
  generator script — fine in the monorepo, breaks only if the package is later
  extracted. `stripper`/`outbound` repoint to `core`.
- **Synthetic public-scalar classification** (#1286 Track 5): to return a **bare
  scalar** (a count/total/badge) — which the stripper otherwise drops as a
  non-model bag key — hand-author a small **synthetic public classification** for
  its shape and merge it in `core.ts`, behind its own registered endpoint. This is
  the sanctioned way any count/badge crosses the boundary (expense list counts §7,
  QB queue depth, nav badges §7); prefer it over envelope workarounds.
- **Route-endpoint-string gotcha** (#1286 Track 4): the `endpoint` string each
  handler passes to `handler()` must be the **full registered path including its
  prefix** — a string that drops a segment makes `getRoute()` miss the registry and
  the route 500s at runtime (tsc-green). Every catalog route hit this; a guard test
  now covers it. Watch for it on the expense routes.

Two things are **different from the prior ports**, and both matter:

### Expense data is genuinely sensitive — this is not public reference data

The catalog and inventory ports could widen reads because their data was
non-personal `public`/`internal` reference data. **Expense is not.** Vendor names,
amounts, `reimbursementFor` (names a person and why they were paid),
`submitterId`, and the audit log's before/after values are financial and
person-linked. So the tiering is heavier and the **read audience is narrow** (§6):

- **No `secret`-tier schema field.** QBO OAuth tokens and the client secret are
  the obvious "never return this" data — but they **do not live in any expense/
  checkin table** (§4/§9): the client secret is an Infra-managed env var, and the
  rotating OAuth tokens live in an external secret backend. So there is nothing to
  annotate `@sensitivity:secret` on the schema, and the app hosts **no OAuth route**
  (consent is an operator CLI step, §9) — so QB adds no new boundary surface at all
  beyond the app's read-only IAM grant to the access-token secret.
- **`internal`** — **money + vendor + attribution + free text + plumbing**:
  amounts (`*Cents`, `unitPriceCents`, `taxCents`, thresholds), `vendorName`,
  `receiptNumber` / `orderNumber`, `reimbursementFor`, `qbAccount` / account
  mappings, `assetNumber` and the capital register, all actor ids/usernames
  (`submitterId`, `ownerId`, `budgetOwnerUserId`, `decidedByUserId`,
  `capitalOwnerId`, `userId`, `username`), free text (`notes`, `reason`,
  `rejectionReason`, `failureReason`, audit `valueBefore`/`valueAfter`), and
  cross-app plumbing (`payload`, `payloadJson`, `matchedRows`, `receiptId`,
  `sourceQbTxnId`, `sourceEventId`).
- **`public`** — essentially nothing operational leaves the boundary public here.
  (Non-sensitive enums like a hold `status` string are `internal`, surfaced only
  to the finance/board reader.)

**`reimbursementFor` and `submitterId` are person-linked** — treat them at least
`internal` and consider whether the reimbursee's identity warrants `pii`
handling if it is ever joined to a name in a response; default to `internal` +
the narrow read gate, and raise it to `pii` if a route ever returns the person's
contact details alongside.

### No scopeBindings — but the narrow read is a route+query concern, not a field scope

Both prior ports found they needed **zero scopeBindings**: every actor FK
(`localUserId` / `*ByUserId`) is absent from checkin's `SCOPABLE_FIELDS`, so the
binding validator auto-classes every model **un-scopable / admin-only** and their
`internal` fields sit behind `everyones:internal` with no per-row binding. **Expense
inherits the same** — its actor FKs are `submitterId` / `ownerId` /
`budgetOwnerUserId` / `decidedByUserId` / `userId`, none scopable — so **no
scopeBindings**, registry entries are the whole boundary work.

But expense wants something the prior ports did not: a **per-row narrow read** (a
budget owner sees only their own lines, §6). Do **not** try to express that as a
per-row field scope (it would need a new `SCOPABLE_FIELD` — a boundary change).
Instead the narrow read is enforced **at the handler**: the route guard decides
*who may call* (finance/board vs owner), and for an owner the handler **filters the
query** to their own expenses/lines (a `WHERE owner = principal.id`), returning a
`FINANCE`-tier response shape over a restricted row set. So the field tiers stay
flat (`internal` behind the finance/board reader), scopeBindings stay zero, and the
row-narrowing lives in the handler — consistent with catalog/inventory's
registry-only boundary.

### QB adds no new app auth surface — it is read-only on one secret

The QB tokens never enter a guarded DB (§4/§9), and the app hosts **no OAuth
route** — consent is an operator CLI step (§9). So QB's only security footprint is
the app's **read-only IAM grant** to the access-token secret, provisioned by Infra
(§10). The registry entries still ship **registry-first** per `AGENTS.md` + the
`security-boundary-isolation` workflow for the *expense* routes below; QB-0 itself
adds no registered app route. This keeps QB-0's security half trivial — the real
controls are the Infra secret's access policy and the refresher owning the write
side.

**Route inventory to register** (~18 registry entries, one per verb×route family) —
**all human routes** (`FINANCE`/`BOARD`, or budget-owner-filtered per above):
`expenses` (GET list) + `expenses/[id]` (+ `capital-review`,
`set-depreciation-cycle`, `line-item-approvals[/*]` approve/reject/assign-owner/
finance-assign/raise-exception/resolve-unknown); `expense-holds[/*]` resolve +
resubmit + line-item account; `account-mapping[/*]` + `/catalog`; `qb-accounts[/*]`;
`capital-assets/seed` (finance user session); `local-owners`; `ownership-map`;
`provisional-items`; `org-settings`; `system-data`; `queue`; `counts`;
`expense-events`; `received-expense-payloads`.
**Not registered / not hosted:** the source's `POST /api/expenses` **receipt-intake
machine route (org-bearer)** — checkin can't host a machine-bearer route (§8a), so
intake is in-process only, not a registered surface. `POST /api/capital-assets/seed`
**is** registered — it is a normal `FINANCE` **user-session** route (JWT-as-cookie),
not a machine bearer (§8a/§9 QB-1). **QB adds no app route to register** — consent
is an operator CLI step and token refresh is the Infra refresher's job (§9).

---

## 6. Auth and roles

**Retire the source auth entirely.** Delete `lib/auth.ts`, `auth-shared.ts`,
`route-auth.ts`, the login page, and `/api/auth/{login,logout}`. checkin already
owns login and session. Every route/page guard is re-expressed against the checkin
session. The source's `route-auth`/`web-auth` **parse+error helpers**
(`parseBody`/`parseQuery`/`unauthorized`/…) go with it — they import `next/server`;
the library route layer instead uses a **next-free `src/routes/_shared.ts`**
(parse/validate throwing via an injected `httpError` factory = checkin's
`ApiResponseError`), the exact pattern #1286/#1287 established (Track 4), so the
library imports **no `next/server`**.

### Role mapping — a new `FINANCE` role, existing `BOARD`, budget owner as data

The source has four auth predicates: `isFinance` (dominant — 60 uses),
`isOrgManager`, `isBudgetOwner`, `isAdmin`. checkin's `PersonRoleKind` today is
`SYSADMIN, BOARD, KEYHOLDER, BG_REVIEWER, OPERATIONS` — **no finance role.** The
mapping:

| Source guard | checkin (this port) | Notes |
|---|---|---|
| `isFinance` (hold resolution, capital seed/review, QB queues, account/vendor mapping, owner-map management, finance-assign, resolve-unknown, raise-exception) | **`FINANCE`** — a **distinct** new `PersonRoleKind` row (owner-decided) | **RB2 "Role: Finance"** ([#1314](https://github.com/innovationtreehouse/checkin/issues/1314)) — the umbrella GC-ROLES **explicitly keeps**, a kept role not a net-new invention. This port stands it up as a distinct row (not folded onto `BOARD`); #1314 keeps only the sub-actor detail (Treasurer / Bookkeeper / Accountant designations). Referenced without a closing keyword. Follows the `isOperations` precedent: PersonRole-table-only, **no legacy mirror column**. |
| `isOrgManager` (account-mapping + owner-assignment management) | **`FINANCE`** (collapsed) | The source's org-manager is finance-staff pipeline management; collapse onto `FINANCE` rather than standing up a second role. Split later only if a real duty boundary appears. |
| `isBudgetOwner` (approve/reject *your own* lines) | **budget-owner predicate on `Person`** — a data relationship, not an RBAC role | The line's owner is a `Person` (resolved via `PartOwnerMap`, FE2); "is this session the owner of this line?" is a per-row check, not a global role. Program Treasurer / Assistant Lead map here too (relationship-attached, GC-ROLES). |
| `isAdmin` (a few admin-only ops) | **`SYSADMIN`** (existing) | Direct. |
| board-level threshold / COI escalation (net-new, GC-FIN-CONTROL) | **`BOARD`** (existing) | The escalation target for threshold-crossed and conflict flags. |

**Adding `FINANCE`** touches checkin's role foundation (all in checkin's own
schema, not the expense schema) — the **exact surface #1286 Track-2 built** for
`INVENTORY_MANAGER`, so follow it literally:

- `PersonRoleKind` enum — add `FINANCE`; PersonRole-table-only, **no legacy mirror
  column** (`FLAG_TO_KIND` only, **not** `KIND_TO_MIRROR`), per the `isOperations`
  precedent.
- **Migration:** additive `ALTER TYPE "PersonRoleKind" ADD VALUE IF NOT EXISTS
  'FINANCE'` — **not** transaction-wrapped (Postgres forbids using a new enum value
  in the same txn that adds it).
- `src/lib/roles.ts` `FLAG_TO_KIND` (derives `ROLE_FLAGS`, `rolesToFlags`).
- `src/types/next-auth.d.ts` — the new flag in **3** spots (JWT / Session / user).
- `RoleBadge` `ROLE_META`.
- The **`ROLE_FLAGS`-indexed row-type interfaces** tsc forces the optional
  `isFinance?` onto (catalog found three for its flag — expect the same set of
  membership-ops/roles page + roles-edit-modal row types).
- **No `/api/roles` code change** and **no `DevLoginPicker` change** — the route
  iterates `ROLE_FLAGS` and `setRoleFlag`'s authority matrix already lets
  sysadmin/board grant any flag, so `FINANCE` is grantable automatically. (An
  earlier "grant UI" line here overstated the surface — corrected per #1286 Track-2.)

This is **its own PR track** (§11), independent of #1286's `INVENTORY_MANAGER` —
expense is finance, not inventory management, so it does **not** reuse that role.

**What `isOrgManager` folds into `FINANCE` — two curation task-sets, not
per-expense approval.** The source's org-manager role does not *approve* expenses
(that is the budget owner's per-line job); it keeps the two reference tables that
drive the pipeline correct. Both fold onto `FINANCE`:

1. **Account-mapping management** — curating the rules that turn a catalog item
   into **one** QB account. Tables: `AccountMapping` (rules —
   `(category, subcategory, partNumber, isDelayed?, isCapital?) → qbAccount`, with
   `*` wildcards) + `ExpenseQbAccount` (valid QB account names). Routes
   `/api/account-mapping[/*]`, `/api/account-mapping/catalog`, `/api/qb-accounts[/*]`.
   At QB time `resolveAccountsForExpense` matches each line against these rules; a
   line matching **0** rules raises a `NO_MATCH` hold and **>1** a
   `MULTIPLE_MATCHES` hold. So this curation is exactly how finance keeps the
   account-mapping exception queue (§7, surface 5) empty — config work, not
   per-receipt work.
2. **Owner-assignment management** — curating **who owns which parts** and clearing
   lines that did not auto-assign. Standing map: `PartOwnerMap` (owner `Person` per
   GTIN), routes `/api/ownership-map`, `/api/local-owners`; at intake
   `initFinancialFlow` calls `resolveItemOwner(gtin)` so a mapped line routes
   straight to its owner for signoff. Queue side: an unmapped line lands in
   `assign_ownership` and is resolved via `assign-owner` / `finance-assign` /
   `resolve-unknown` on the `LineItemOwnerApproval` (owner-conflict resolution,
   FE2/#1273). This is what routes each line to the *right* budget owner — the
   approval itself stays the owner's.

Both curation tasks are **`FINANCE`'s** — and this is a deliberate ownership
principle, not an interim simplification: **owner-assignment is an org-level
decision that `FINANCE` makes.** A program Treasurer / Assistant Lead **reacts** to
those assignments (they sign off the lines assigned to their people), but does not
**make** them — assignment is owned by the org, not the program. So there is no
program-treasurer split to leave open here.

### Reads are narrow — the port's main divergence from #1286/#1287

Both prior docs widened reads with a broad `isCatalogViewer` /
`isInventoryViewer` gate (any RBAC role / program leader / volunteer), justified
because the data was non-personal public reference data. **Expense inverts that.**
Expense data is financial and person-linked (§5), so least-privilege *narrows*
reads:

- **Finance / board** read the whole expense surface (queues, holds, capital
  register, QB queues).
- **A budget owner** reads **their own lines and the expenses containing them** —
  a per-row scope, not the whole ledger.
- **Program leads / assistant leads / program treasurer** read the
  **budget-vs-actual view for their program** (FE8, later) — a scoped, aggregated
  read, not raw line access.
- **No broad viewer gate.** A volunteer or arbitrary RBAC-role holder does **not**
  read expenses.

**Least-privilege note** (`docs/rules/principles.md`): unlike #1286/#1287 this gate
does not widen anything — it confines financial data to finance, board, and the
row's own owner. Stated here so the divergence from the prior ports is a decision
on the record, not an oversight.

### Flag / checkoff / audit — surface, don't enforce (GC-FIN-CONTROL)

The app **does not enforce approval tiers, COI, or segregation-of-duties.** It
surfaces a **flag** to the right human for a **checkoff**, all **audit-logged**
(`ExpenseAuditLog`). Humans decide; the software records, routes, and proves.
Flags: **tax-attached**, **threshold-crossed** ($500 / $2k / $50 awareness, from
Procurement policy H — *awareness, not enforcement*), **missing-receipt**,
**non-Everyday**, and **COI/conflict**. Each routes to finance or board and lands
a checkoff + audit row. This **replaces** the source's implicit tiering with the
lightweight flag pattern GC-FIN-CONTROL specifies — the flags are low-volume
(~1–2 of each per year) even though the expense process itself is high-volume, so
the flag machinery stays deliberately thin.

### The household-aware COI flag — the port gets *better* in checkin

**The conflict flag is the one flag with real logic**, and it is *buildable here
and was not buildable in the source*: a **household-aware "approver is in the
submitter's household" check** (Q27). The ported `expense-app` never had a
household model, so it could not express COI at all. checkin **has** households, so
this is a genuine port-gets-better item: when a line's would-be approver (owner /
finance-assignee) shares a household with the expense's `submitterId`, raise the
COI flag and route it to `BOARD` for checkoff. Design it as a real predicate over
checkin's household graph (read via the injected principal/port, not a cross-DB
join — §4), not as another rubber-stamp. This directly discharges GC-ROLES'
"expense approval + conflict constraints" duty gap.

### Org + user identity — one injected source, shared with catalog + inventory

Resolved by #1286 §6 — expense **adopts the same decision, not a variant**. Org
identity is a **checkin-owned `Org` registry row** (seeded on the initial
migration with a stable well-known id), injected as an accessor `getOrg()` into
`configureExpense()` — not an env scalar, not a `SettingsData` row, not a cross-DB
read. checkin-app injects the **same** id into catalog, inventory, and expense, so
the `orgId` stamped on `ExpenseEvent`, the S5 provisional events, and the
cross-DB uniques all line up. The `org_id` / `org_name` columns are **kept**
(String). User ids map to checkin **`Person.id`** via the injected
`ExpensePrincipal` (`getPrincipal()`); attribution columns store the principal id
+ a username snapshot, no FK to checkin (separate DB).

---

## 7. UI — reskin in place

All UI lives in the library (`packages/expense/src/{components,pages}`);
checkin-app only re-exports pages (§3) and wires nav. Same Mantine version →
component-level reskin, not a rewrite. **Keep the source's `"use client"` +
`/api/*` pattern** (matches checkin; #1286 §7). Drop `AppShellLayout` /
`NavbarLogout` / `AuthContext`; pages render inside checkin's shell and read
`useSession` client-side + the checkin session in the route handlers.

**List-route shape + numbered pagination (carry over #1286 Track-5, corrected).**
checkin's `handler()` stripper drops non-model bag keys, so a list route returns a
**bare model-bag array**, not a `{items,total,page}` envelope. A table-wide `total`
scalar therefore can't ride the list response — but that does **not** kill numbered
pagination: the sanctioned fix is the **synthetic public-scalar classification**
pattern (#1286 Track-5). Hand-author a small public response model for the scalar
(e.g. `ExpenseListCount { total: public }`), merge it in `core.ts`, and register a
separate **`.../count` endpoint** — now `total` crosses the stripper legitimately as
a model field, giving real numbered pagination. It is a **registry-first boundary
commit** (classification + registry entry first; the count route factory + stub
follow). Apply it per-list where volume warrants (the audit/`expense-events` and
`queue` lists especially) — **not** an offset+lookahead workaround. (An earlier
draft here called the count endpoint a dead end, mirroring #1286's since-reversed
Track-5 attempt; corrected.)

Pages, each an A13 surface / exception screen:

- `expenses` (list, filtered by the `queue` view; bare-array + numbered pagination
  via a `.../count` endpoint per above) + `expenses/[id]` (detail with
  `LineItemOwnerApprovals`) — surfaces 1/2.
- `expense-holds` **exception screen** — `NO_MATCH` / `MULTIPLE_MATCHES` /
  `NO_PART_NUMBER` account-mapping holds; resolve + resubmit (surface 5).
- `account-mapping` + `qb-accounts` — the rules that map a resolved item to one QB
  account (**one account per line, no category splits, by design**) + the QB
  account list (surface, feeds §9 QB-2).
- `ownership-map` / `local-owners` — budget owners and owner↔PN associations;
  owner-conflict resolution (surface 3, FE2).
- capital review + depreciation panels (`CapitalReviewPanel`,
  `SetDepreciationCyclePanel`) on the expense detail — surface 4, FE4; the
  loop-closing "assign ITFA → log in QB → sticker reminder" step (Q66) lands here.
- `provisional-items` — provisional resolution view (consumes catalog S5 events,
  §8).
- `received-expense-payloads` — receipt-intake ledger (surface for the receipt→
  expense crossing, §8).
- `expense-events` — the QB **outbox** ledger, and (§9 QB-2+) the **QB
  sync-failure / ambiguity queue**.
- `org-settings` (capital thresholds) + `system-data` (settings). The
  `SettingsData` poll fields (`pollIntervalMinutes` / `globalServerUrl`) are **dead
  on arrival** — the S5 crossing is in-process and push-driven (§8), so there is no
  timer to configure. Keep the row (the model ports cleaner intact); drop the
  fields with the deferred cleanup, exactly as #1287 §7 decided.

### Nav placement — the Finance part of the navbar (owner-decided)

**Expense lives in checkin's Finance nav area** — not the Inventory area the
catalog/inventory ports created (#1287 §7), and not a new top-level area. Unlike
those ports, expense is finance-facing with a narrow read gate (§6), so its screens
are **section tabs under Finance** (alongside the existing Finance Ops surfaces),
gated by `FINANCE` / `BOARD`. The library exports its `NavLink[]` descriptor;
checkin-app appends it to the Finance section (order is a checkin-shell concern).
Badges (open holds, pending checkoffs, QB queue depth) use checkin's existing
`navBadges` — optional, not first-landing.

---

## 8. Pipeline couplings — expense is the money-side tail

Expense sits mid-pipeline: **receipt → expense → (catalog lookups) → inventory
load → QuickBooks**. Four crossings, all designed with the **same per-crossing rule
#1286 §8 set**: *keep the JSON/contract shapes; convert transport, not architecture;
every crossing sits behind a port; converting = swap one adapter binding in
`configureExpense()`, zero call-site churn; trigger = co-residence.* **One
correction the prior ports' as-built forced:** the `http` adapter is **not a live
option inside checkin** — checkin cannot host a new machine-bearer route (§8a,
#1286 Track-4), so the crossings that were HTTP in the source (R receipt intake, I
inventory-load) are **in-process only** here; `http` is shown only as the source's
transport for reference, **never bound in checkin** — the Inventory apps all move
into checkin and none runs remotely (owner decision, on security grounds), so there
is no remote peer to serve.

| Crossing | Direction | Kind | Contract | Today's transport |
|---|---|---|---|---|
| **R — receipt intake** | receipt-app → expense | **in-process only** (callee; machine route not hostable, §8a) | `CompletedReceiptSchema` (`@inventory/receipt-types`) | source: `POST /api/expenses`, org-bearer; idempotent on `receiptId` via `ReceivedExpensePayload`. checkin hosts no such route — in-process when receipt co-resides |
| **C — catalog lookups** | expense → catalog | **sync read — caller** | `catalog-schemas` (categories, subcategories, item info, item lookup) | `service-client` (pathPrefix `/api/internal`) → catalog's org-bearer **machine** surface `/api/internal/[...path]` (#1286 Track-4) |
| **I — inventory load** | expense → local-inventory | **sync RPC — caller** (new co-resident wiring) | `ResolvedInventoryDeltaSchema` (local-inventory's apply surface, #1287 §8c) | today mediated by the orchestrator; in checkin, an in-process call into local-inventory's apply port |
| **QB — post** | expense → QuickBooks | **async outbox** | `QbExpenseEventSchema` / `QbLineItemSchema` (schemaVersion 1) | `ExpenseEvent` outbox row; drained by the write path (§9) |

### 8a. Receipt intake (R) — in-process only; checkin cannot host the org-bearer route

The receipt's **money side** (total / tax / shipping / discount / vendor / lines)
arrives as a `CompletedReceipt`; `processCompletedReceipt` stores it idempotently
in `ReceivedExpensePayload` (keyed on `receiptId` — a re-push is a safe retry),
creates the `Expense` + lines, and calls `initFinancialFlow`. **Idempotency is part
of the contract**, preserve it exactly. In the source this is `POST /api/expenses`
gated by `requireOrgBearer`.

**checkin cannot host that org-bearer route — #1286 §8 Track-4 finding, same wall
local-inventory's apply surface hit (#1287 §8c).** checkin has **no sanctioned way
to land a new machine-bearer HTTP route**: (1) `requireOrgBearer` /
`@inventory/web-auth` is retired (§6) with no checkin-side org-bearer validator;
(2) checkin's `authenticateRequest` / `handler()` pipeline has no org-bearer auth
path and the registry `authorize` grammar can't express one; (3)
`scripts/legacy-authz-routes.txt` is frozen; (4) a new `src/app/api/internal/…` (or
any new machine-bearer) route trips `check-route-coverage`'s `new-route-old-authz`
ratchet (blocking). And expense **can't lean on "the old server carries it during
overlap"** — the migration **moves the write target**: once expenses live in
checkin's expense DB, a remote receipt-app pushing to the *old* expense-app server
would split-brain the ledger.

**Resolution — receipt intake is in-process only.** The crossing sits behind a port
(`ReceiptIntake { ingest(receipt): void }`) bound in `configureExpense()`; when
receipt-app (A10) co-resides, receipt calls `processCompletedReceipt` **directly via
the port**, no HTTP. **No inbound HTTP receipt route is built in checkin** (nothing
to keep "live" and nothing to "retire last" — the earlier wording assumed checkin
could host it; corrected per #1286).

**First-landing consequence (honest):** receipt-app is a separate, not-yet-migrated
port, so at expense's first landing there is **no automated receipt feed**. The
human surfaces (approval queues, holds, capital review, account mapping) and the
manual expense-entry path work; the high-volume receipt→expense pipeline goes live
**only when receipt-app co-resides**. Until then, expenses are entered by hand /
seeded. **There is no remote-receipt fallback, ever, by decision:** receipt-app
(and every other Inventory app) is being *moved into* checkin and will not run
outside it — an open inbound machine surface is an unacceptable security exposure,
so checkin never grows one and no "option A" boundary variant is pursued. Receipt
intake is in-process, full stop. **Same disposition for
`POST /api/capital-assets/seed`?** No — that route is gated by
`requireRole(isFinance)` (a normal **user session**, the
finance user's JWT forwarded as the cookie), **not** a machine bearer, so it is a
normal `FINANCE`-gated route and **is** hostable (§9 QB-1).

### 8b. Catalog lookups (C) — in-process read, no repoint (mirrors #1287 §8b)

The QB processor resolves each line's account by reading the catalog:
`lookupItems` (3-pass matcher) → `getItem` → `listCategories` / `listSubcategories`
(`inventory-client.ts`). In the source these go over `service-client`
(pathPrefix `/api/internal`) to the catalog's **org-bearer machine surface** —
`/api/internal/{items/lookup, items/[gtin13], categories, subcategories}`. #1286's
**Track-4 finding** explicitly names **`expense-app`'s inventory-client** as a live
remote consumer of catalog's `/api/internal/[...path]`, and settles that catalog's
org-bearer machine reads live under **`/api/internal`** (not the human
`/api/catalog/*`), with a one-line `pathPrefix` repoint for still-**remote**
consumers.

**For checkin's expense that repoint is moot — it reads catalog in-process**, the
exact pattern #1287 §8b established for local-inventory. Catalog is co-resident
from day one (dependency gate, §1), so:

- Add a **`CatalogReader` port** (`contract.ts`: `lookupItems()`, `getItem(gtin13)`,
  `listCategories()`, `listSubcategories()` — broader than local-inventory's
  reader because expense also needs category/subcategory + the 3-pass lookup) bound
  in `configureExpense()` to the **in-process** catalog library service — a direct
  call into `@inventory/global-catalog`, **no HTTP, no `globalServerUrl`, no
  org-bearer token**. It touches **neither** catalog's `/api/catalog/*` (human) nor
  `/api/internal/*` (machine) — the human/machine route split (#1286 §7/§8) is an
  HTTP concern expense sidesteps by reading the service.
- The source's `service-client` HTTP path is **dropped** for this crossing;
  `SettingsData.globalServerUrl` (which pointed at the old catalog server) is dead
  (§7). Keep the `catalog-schemas` zod shapes as the port's param/return types.
- The `http`/`service-client` adapter stays in the port only as the fallback for a
  hypothetical *remote* catalog; since catalog lands first it is never bound here.
  (`service-client` is still vendored — §2 — for the receipt/QB-remote seams, just
  not for this crossing.)

So the repoint #1286 tracks for *other* still-remote consumers does not apply to
checkin's expense.

### 8c. Inventory load (I) — sync RPC into local-inventory's apply surface

TOPDOWN GC-FIN-CONTROL describes the high-volume flow as **"signoff → inventory
load → QB"**: when an expense's lines are signed off, the received stock is loaded
into org inventory. In the source monorepo the **orchestrator** (workflow-mapping,
CI4/#1289 — out of scope here) mediates this; expense does not call
local-inventory directly. In checkin, co-resident, the pipeline step is realized as
an **explicit port from expense into local-inventory's apply surface** (defined in
#1287 §8c): on owner-signoff, expense hands the resolved delta to
`receiptService.applyReceipt` / `enqueueItem` via the port, preserving
`ResolvedInventoryDeltaSchema` and its **idempotency on `receiptId`** (a re-push is
a safe retry — that is why the orchestrator can "retry-apply"). **This is
in-process only — there is no HTTP fallback.** #1287 §8c decided local-inventory's
apply surface is **not hosted over HTTP in checkin** (same machine-bearer wall as
§8a, and a remote push would split-brain the stock), so expense reaches it as a
direct in-process call once local-inventory is co-resident (it will be — #1287
lands before this). **Do not assume the orchestrator "collapses away"** — its
calls into local-inventory are real; expense's signoff→load call sits behind the
same in-process apply port. The known fulfill/apply concurrency hazard (#1287 §8c,
CONCURRENCY.md #2) is *local-inventory's* to close — track it there, not in expense.

### 8d. Provisional resolution (S5) — async, second consumer of catalog events

Expense is a **second consumer** of catalog's S5 provisional-resolution events
(`provisional_approved` / `_rejected` / `_mapped_to_existing`) — it keeps its own
`ProvisionalItemMap` / `ProvisionalResolution` in step so account resolution can
proceed. This is **async and stays async** (#1286 §8 rule 4): reuse
`@inventory/org-events-poller` but **drop the wall-clock timer** exactly as #1287
§8a decided — boot catch-up drain + drain-on-emit from catalog's post-commit
signal, no `setInterval`. Land the consumer **inert** until catalog emits.
`conversion_challenge_*` events stay unconsumed (BYDESIGN, forward-only), same as
#1287.

### First landing (expense in; catalog + inventory in; receipt/orchestrator not yet)

- Reuse the temporary vendored `receipt-types` / `receipt-contract-fixtures`
  (#1286's copies).
- **R (receipt intake)**: **no HTTP route** (checkin can't host org-bearer, §8a) —
  in-process only when receipt-app co-resides; until then exercised via seeded
  `CompletedReceipt` fixtures and manual entry.
- **C (catalog)**: bind in-process immediately (catalog co-resident).
- **I (inventory load)**: bind in-process once #1287 + the orchestrator co-reside;
  the apply crossing is **in-process only** (checkin can't host it either — #1287
  §8c) and goes live with the orchestrator, not before.
- **S5**: in-process push adapter, inert until catalog emits.

All temporary duplication is **< 2 weeks, dev-only** — acceptable, tracked.

---

## 9. QuickBooks — the phase ladder

**QuickBooks is not a stub.** `@inventory/quickbooks` (`packages/quickbooks/` in
the Inventory monorepo) is a working **read-only QBO client**: OAuth2 in three
`fetch` calls (authorize / code→token / refresh — no SDK), a `QuickBooksClient`
that runs QBO SQL-ish queries and pages `Purchase` / `Bill` since a date, a
`toGroundTruth` normalizer, and `QboTokens` / `QboPurchase` / `GroundTruthRecord`
types. Its README states it **"later grows the write path for the `qb_pending`
state-machine terminus"** — that write path is exactly what this port builds. QB
is designed as an **incremental ladder**; each rung states plainly **what already
exists in `@inventory/quickbooks` vs what is net-new.**

Because checkin has **zero** prior QB integration (CUJS A15), this port also
settles GC-QB's *"settle the QB connection/auth first"* — QB-0 is that settlement,
and donations (GC-DONOR) / program-finance (GC-PROGRAM-FINANCE) reuse it.

### QB-0 — bring the client in (connection + auth foundation)

Port `@inventory/quickbooks` into `packages/quickbooks` as the first QB code in
checkin.

- **Exists:** the OAuth2 flow (`authUrl` / `exchangeCode` / `refreshTokens` /
  `isExpired`), `oauthConfigFromEnv` (`QBO_CLIENT_ID` / `QBO_CLIENT_SECRET` /
  `QBO_ENVIRONMENT` / `QBO_REDIRECT_URI`), the sandbox↔production `apiBase` switch,
  `realmId` capture from the consent redirect, and refresh-token **rotation**.
- **Net-new — the app is a read-only token consumer; an Infra-owned refresher owns
  rotation.** The source refreshes inline (`ensureFresh` → `refreshTokens` →
  `saveTokens` to a gitignored file). That model requires the app to **write** the
  rotating secret, and a file does not survive an ephemeral, multi-replica
  container. **The app should not — and here cannot — write to the secret store.**
  So invert the lifecycle: rotation moves **out of the app** to a dedicated
  **Infra-owned refresher** (the standard AWS "credential that must rotate but the
  app shouldn't manage" shape — a Secrets Manager **rotation Lambda**, or a small
  scheduled Lambda on checkin's existing external scheduler). Three secrets, three
  homes, and the app touches only two of them **read-only**:
  - **Static credentials** — `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`,
    `QBO_ENVIRONMENT`, `QBO_REDIRECT_URI` — plain **env vars loaded by Infra** at
    boot (`oauthConfigFromEnv` reads them). Never change. The "keys to generate the
    key."
  - **The rotating refresh token** (~100 days, **rotates every refresh**) — held
    and rotated **only by the refresher**, which has the **sole write grant** to the
    secret. The app never sees it, never holds it, never writes it. This is what
    removes the write-back-from-the-app problem entirely.
  - **The current access token** (~1h) — the refresher refreshes it on a schedule
    (e.g. every ~45 min, before expiry) and publishes it into the secret; the
    **app reads it read-only** (`GetSecretValue`) when it needs to call QBO. The app
    has **read-only IAM on the access-token secret and nothing else** — no write, no
    refresh-token access.
  So the library's port narrows to a **read-only `AccessTokenSource { current():
  Promise<string> }`** (bound by `configureExpense` to a Secrets-Manager-read
  adapter; a file/env adapter for local dev). The write-side `TokenStore` lives in
  the **refresher**, not the app. `QuickBooksClient` is adjusted so production never
  calls `refreshTokens`/`saveTokens` — it fetches the current access token from the
  source; if it ever reads a just-expired one (refresher lagged) it errors and the
  caller retries, rather than trying to refresh. **No token in Postgres; no secret
  write from the app.**
- **Refresh concurrency — solved by construction.** Because rotation has a
  **single writer** (the refresher Lambda), the multi-replica refresh race is gone:
  app replicas only *read* the published access token; none of them refresh.
- **Net-new — consent + initial seed (one-time, operator/Infra, no app route).**
  Consent stays the **source's CLI flow** (`npm run consent` — a local server
  catches the redirect at the operator's `localhost:8087`, exchanges the code, and
  yields the initial refresh token). Because the app has **no write access** to the
  secret store, the app must **not** host the callback: consent runs in an
  operator/Infra context with the write grant, and the resulting **initial refresh
  token is seeded into the secret the refresher owns**. After that one-time seed the
  refresher owns the lifecycle and the app is pure-read forever. There is **no
  `/api/qb/*` route in the app.** Sandbox first; production by switching
  `QBO_ENVIRONMENT` and re-consenting/re-seeding.
- **Security:** the fail-closed OAuth-callback registry entry (§5) is QB-0's
  security half — **registry-first, its own PR.** There is no `secret` schema tier
  to add (tokens are external, not DB fields — §4/§5), and the app holds only a
  **read-only** grant to the access-token secret.

### QB-1 — read / ground truth (account mapping + vendor bootstrap + capital seed)

Pull `Purchase` / `Bill` since a date as **ground truth**; use it to bootstrap
account mapping and vendor normalization, and to seed the capital register.

- **Exists:** `purchasesSince` / `billsSince` / `query` / `pagedSince` /
  `toGroundTruth` — the entire read path. The Inventory scripts already consume it
  (`receipt-load-app/scripts/{capital-seed,match-run}.mts` read
  `packages/quickbooks/.ground-truth.json`).
- **Net-new — checkin wiring:** run the pull server-side (or as a checkin
  scheduled job on the **external** scheduler, never an in-app timer), drive
  `AccountMapping` / `ExpenseQbAccount` bootstrap and vendor alias normalization
  from real QB accounts, and expose the **capital-seed intake** (`POST
  /api/capital-assets/seed`, FE4) that parses ITFA tags out of QB memos into the
  `CapitalAsset` register (`seeded=true`, idempotent per `(orgId, assetNumber)`).
  This is also where **GC-QB reconciliation with 3 years of existing QB** starts:
  the `backfill` / `qb_skipped` path (§2) reconciles an expense to an
  already-booked QB transaction without re-posting.

### QB-2 — write path (the `qb_pending` terminus)

Post signed-off expense lines to QuickBooks. **This is the headline net-new
work** and FE3's core.

- **Exists in the source (checkin side of the port):** the `expense-qb-processor`
  already builds and **validates** the outbound payload against `QbExpenseEventSchema`
  / `QbLineItemSchema` (schemaVersion 1), resolves each line to **one** QB account
  (rules → one account/line, **no category splits by design**), allocates
  tax/shipping/discount, and commits the `ExpenseEvent` **outbox row** in one
  transaction (`qb_pending → qb_complete`). The outbox, idempotency
  (`expense_events_org_expense_unique`), holds, and crash-recovery
  (`recoverStrandedQbExpenses`) all port verbatim.
- **Net-new — the actual QBO write.** `@inventory/quickbooks` is read-only today;
  QB-2 **grows its write methods** (create Purchase/Bill from a `QbExpenseEvent`,
  map account name → QBO account ref, vendor ref → QBO vendor, with the same
  OAuth/refresh machinery QB-0 established). A **drain worker** reads unposted
  `ExpenseEvent` rows and posts them; run it from `instrumentation.ts` (boot
  drain + drain-on-commit signal, **no wall-clock timer**, §3) — the outbox stays
  async (rule 4, do not collapse to a direct call).
- **Net-new — the QB sync-failure / ambiguity queue** (A13 step 6). A post can
  fail (auth, validation, QBO rejection) or be **ambiguous** (vendor name matches
  0 or >1 QBO vendors; account name unmatched). These land in a **queue screen**
  (`expense-events`, §7) for finance to resolve — vendor mapping / alias, account
  remap, retry. This mirrors the account-mapping `MULTIPLE_MATCHES` hold pattern
  (§7) but on the QB side. **Idempotency across retries** is essential: a re-post
  of the same `ExpenseEvent` must not double-book (key on the event / a QBO
  idempotency token), per GC-QB "idempotent, sync-not-clobber".

### QB-3 — drift detection & reconciliation (FE5)

Detect and reconcile **external edits** to QB entries the system originated: a
periodic (external-scheduler) re-pull compares system-originated QBO transactions
(tracked by `sourceQbTxnId` / the outbox) against their current QBO state, flags
drift (amount/account/vendor changed in QB after we posted), and routes it to a
reconciliation queue. **Exists:** the read/pull path (QB-1). **Net-new:** the
diff + drift queue. Grounds on GC-QB's "reverse-reconcile against existing QB to
enumerate what the system still can't model."

### Out of scope for this work — noted, not designed (followups)

FE6–FE8 are **not part of this landing.** This work is FE1–FE5 on the QB-0…QB-3
ladder; the items below are separate future epics that build on the QB substrate
QB-0…QB-2 establishes.


- **FE6** membership/plan payment → QB sync (primary adult; conflict → Financial
  Ambiguity Record; retry → manual queue). Reuses QB-0's connection + the QB-2
  ambiguity-queue pattern. Its own issue (#1277).
- **FE7** shop-hour fee → QB **inter-class journals** (Q49, monthly cadence,
  GC-PROGRAM-FINANCE): checkin has the hours; given rates + application rules it
  initiates monthly journals between QBO classes. A different QBO write shape
  (journal, not Purchase). Its own issue (#1278).
- **FE8** budget-vs-actual view (view-only, per-program, semi-rolling). Depends on
  FE1–FE3 data + FE7. Its own issue (#1279).

These **reuse QB-0's settled connection** and the QB-2 write/ambiguity machinery;
this design neither builds nor blocks them.

---

## 10. Infra / deploy

Adds **no new service** — compiles into `checkin-app`'s build, ships in checkin's
existing container. Same as #1286 §9 / #1287 §9, plus the QB specifics:

- Build the new `packages/*` (`expense`, `quickbooks`, `service-client`); the
  workspace build already covers `packages/*`.
- **Provision the dedicated expense database** + `EXPENSE_DATABASE_URL` secret
  (monitoring-db pattern in the Infra database module).
- Add **expense `prisma migrate deploy`** (against `EXPENSE_DATABASE_URL`) to the
  deploy sequence, ordered with checkin's / catalog's / inventory's steps.
- **QB static creds (env):** `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`,
  `QBO_ENVIRONMENT` (`sandbox` → `production`), `QBO_REDIRECT_URI` (the consent
  redirect — the operator's `localhost` for the CLI consent flow, since the app
  hosts no callback) — **Infra-managed env vars / secrets** for the refresher +
  consent tooling.
- **QB token refresher (Infra-owned, the only writer):** Infra provisions the
  access-token **secret** (AWS Secrets Manager) and a **refresher** — a Secrets
  Manager rotation Lambda or a scheduled Lambda on checkin's existing external
  scheduler — that holds the rotating **refresh token**, refreshes the access token
  before expiry, and `PutSecretValue`s it. The **refresher has the sole write
  grant**; the **app gets read-only** (`GetSecretValue`) on the access-token secret
  and nothing else. Nothing lands in Postgres or a file (§9 QB-0). One-time: seed the
  initial refresh token into the secret after consent (operator/Infra step).
- **One-time operator step:** run **QB OAuth consent** against the sandbox company
  after first deploy (and again against the real company at production cutover) —
  the only manual step this port adds. Document it in the deploy runbook.
- **Org registry** — the checkin-owned `Org` table + seeded Treehouse row is
  **#1286's** deploy artifact; already present once catalog lands. Expense adds no
  env and no seed here — it receives the injected `org` accessor at boot.
- **Outbox / recovery lifecycle:** **no background timer.** The QB drain worker and
  `recoverStrandedQbExpenses` run once at boot from `instrumentation.ts` (server
  runtime only, never during `next build`); thereafter the drain is woken by the
  in-process commit signal. The QB-1 ground-truth pull and QB-3 drift scan, if
  scheduled, run on checkin's **external** scheduler (cron/Lambda), never an in-app
  `setInterval` — same discipline as #1287 §9.
- No new Caddy route, no new port, no new container.

---

## 11. Phasing (PR tracks)

**Dependency gate.** Expense implementation **follows both prior ports**: it
consumes the catalog's item/account lookups and S5 events (**#1286 must land**),
and it calls local-inventory's apply surface (**#1287 must land** — its §8c apply
port is expense's crossing I target). Track 1 can start once #1286 track 1 (catalog
library skeleton + shared packages) has landed; the inventory-load crossing (track
6) gates on #1287.

1. **Library skeleton** — `packages/expense` (reuse
   `gtin`/`workflows`/`receipt-types`/`org-events-poller`/`money`; `service-client`
   only if a remote crossing is ever bound — §2), expense schema + client +
   migrations, domain (repositories / services / the xstate machine / QB processor /
   capital register / financial-flow) ported, **unit tests only** (the source's
   route+auth-bound integration tier → flow tests in track 5, §12). Package stays
   `next`-free (next-free `_shared.ts`; source `validate`/`route-auth` not ported).
   No UI, no QB write, no checkin wiring. Green in isolation.
2. **`FINANCE` role foundation** — add the `FINANCE` `PersonRoleKind` as a
   **distinct row** (RB2, a kept role; owner-decided — **references #1314 without
   closing it**), the **exact #1286 Track-2 surface** (non-txn `ADD VALUE` migration,
   `FLAG_TO_KIND`, next-auth in 3 spots, `RoleBadge`, the 3 `ROLE_FLAGS`-indexed row
   types; **no `/api/roles` and no `DevLoginPicker` change** — grantable
   automatically, §6). Own PR (role-system change). Defines the budget-owner per-row
   predicate + the household-COI predicate over checkin's household graph.
3. **Security boundary** — `@sensitivity` annotations (`internal` for money /
   vendor / attribution / plumbing; **no `secret` field — QB tokens are external**,
   §5/§9), `generator security` for the expense schema (cross-package wiring, §5),
   registry route entries — **no scopeBindings** (expense FKs aren't scopable; the
   narrow read is a handler query-filter, not a field scope — §5). **QB adds no app
   route to register** (consent is operator CLI; the app is read-only on the
   access-token secret — §5/§9). Own PR track, **registry-first**.
4. **Routes + auth + in-process seams** — library route factories + a next-free
   `src/routes/_shared.ts` (parse/validate via injected `httpError`, no
   `next/server`) + `contract.ts` (crossing ports + the read-only QB
   `AccessTokenSource` port) + `configureExpense` wired in `instrumentation.ts`;
   **human** `/api/…` stubs (`FINANCE`/`BOARD`, budget-owner query-filter) + guards +
   the household-COI flag; the `capital-assets/seed` finance route; the `C` (catalog)
   crossing bound in-process. **No receipt-intake machine route — checkin can't host
   it (§8a); intake is in-process only.** Watch the route-endpoint-string gotcha (§5);
   list routes return bare arrays (pagination → track 5). Depends on 1–3.
5. **UI + nav + flow tests + pagination** — reskinned pages/components (library),
   page stub tree + `pageRegistry` entries, the library's `NavLink[]` in a **finance
   area** gated by `FINANCE`/`BOARD` (not the Inventory area — §7),
   `transpilePackages` (if tsx needs it — verify). **Flow tests carry the source's
   integration journeys** (route+auth+DB e2e via persona-mint), incl. the A13
   journey (§12). **Adds numbered pagination** via a `.../count` endpoint, enabled
   by a registry-first boundary commit declaring a synthetic public count response
   model so the scalar total crosses the stripper (§7) — not offset+lookahead.
6. **Inventory-load crossing (I)** — bind the in-process call into local-inventory's
   apply port on owner-signoff (#1287 §8c). **In-process only — no HTTP fallback**
   (local-inventory hosts no apply route in checkin; §8c). Depends on #1287 landed
   and, for the live pipeline, on the orchestrator co-residing.
7. **S5 provisional consumer** — bind the in-process catalog-events adapter
   (push-driven, no timer), inert until catalog emits. Depends on #1286's
   post-commit signal hook.

**QB sub-sequence** (its own explicit ladder, interleaved with the tracks above):

- **QB-0** (connection + auth) — the QB client package + the read-only
  **`AccessTokenSource`** in the app, paired with the **Infra-owned refresher** that
  owns the refresh token and rotation, and the **operator CLI consent** that seeds
  the initial token (§9/§10). The app never writes a secret and hosts no OAuth
  route. Small app-side PR (mostly the read adapter + client tweak); the refresher +
  secret + read-only IAM grant are **Infra work to coordinate**. **Everything QB
  depends on QB-0.**
- **QB-1** (read / ground truth) — pull + account-mapping / vendor bootstrap +
  capital-seed intake (FE4). After QB-0. Feeds tracks 4–5.
- **QB-2** (write path / `qb_pending` terminus) — the net-new QBO **write methods**
  in `@inventory/quickbooks`, the outbox **drain worker**, and the **QB
  sync-failure / ambiguity queue** (FE3, A13 step 6). After QB-0 and after the
  domain/outbox tracks (1, 4). **The QB write path follows the QB read/client-port
  — QB-2 cannot precede QB-0/QB-1.**
- **QB-3** (drift / reconciliation, FE5) — after QB-2.

8. **Infra** — deploy sequence + expense DB provisioning + QB env/secrets + the
   consent runbook step.
9. **(Deferred — each a tracked follow-up issue vs the FE issues, not prose
   "later")** the in-process receipt-intake + inventory-load crossings go **live**
   when receipt-app / the orchestrator co-reside (no route to retire — none was
   hosted, §8a/§8c); drop the dead `SettingsData` poll fields; FE6 (membership→QB,
   #1277), FE7 (shop-hour journals, #1278), FE8 (budget-vs-actual, #1279); QB-3
   drift-queue polish. File these at merge.

---

## 12. Testing

Posture mirrors #1286 §10 / #1287 §10.

- **Keep vitest; unit ports ~verbatim, source integration → flow tests** (#1286
  Track-1/4/5 finding). `expense` is a `packages/` package → keeps vitest (jest is
  checkin-app's convention). The **unit** tests (services/validation, no route/auth)
  port near-as-is in track 1. The source's **integration** tier is route+auth-bound
  (its `app-compat` HTTP shim + `@inventory/auth` seeding), so it does **not** port
  verbatim — in checkin that coverage **is flow tests** (route+auth+DB e2e via
  persona-mint), landing in track 5, not a separate integration rewrite. Reuse
  `@inventory/pg-test-harness`.
- **CI wiring — mostly already there** (#1286 Track-1 finding): the root
  `test:packages` script globs `npm run test -w ./packages --if-present`, so the
  expense package's vitest runs **automatically** — no new root script. One wiring:
  add expense client generation to `db:generate:test` (run by `pretest:packages`).
  **Ops gotcha** (project memory): the DB integration tier **silently skips unless
  `DOCKER_HOST` reaches the container runtime** — a green run isn't coverage
  otherwise.
- **Security tests** — registry/stripper coverage for expense routes lives in
  `checkin-app/src/security/__tests__` (jest — checkin boundary wiring). Companion
  to the track-3 boundary PR. There is **no QB token test** — the tokens are not in
  any DB the stripper guards and the app hosts no OAuth route (§5/§9); the QB
  control is the Infra secret's access policy, verified in Infra, not app tests.
- **e2e = flow tests, not Playwright.** Re-express the source's Playwright specs as
  `flow-tests/*.flow.test.ts`. Priority journey: **A13 end to end** — receipt
  intake → per-line owner approval → capital review + depreciation → account
  resolution (incl. a `MULTIPLE_MATCHES` hold + resubmit) → QB outbox emit → (QB-2)
  QB post → ambiguity-queue resolve. Land in track 5 (domain flow) + a QB-2 flow
  once the write path exists.
- **QB tests hit the QBO sandbox only.** The write path and OAuth are tested
  against a QBO **sandbox** company (the source's model), gated out of the default
  CI run (they need external creds + network) exactly as the Inventory monorepo's
  `*.shopify-live.ts` are (`AGENTS.md` shopify-live precedent). **No CI tier posts
  to production QuickBooks.**
- **Coupling tests** — the crossing ports get contract tests that the **in-process**
  adapter (R receipt intake, C catalog read, I inventory-load, S5 events) behaves
  identically to the source's HTTP shapes for the same input — the cheapest guard
  that a transport flip is behavior-preserving. (There is no live `http` adapter to
  test — those surfaces aren't hosted, §8a/§8c.)

---

## 13. Open items

Only genuinely open work lives here. Resolved decisions are recorded in the
sections they belong to (§3–§9) — this section does not recap them.

**Scope line:** this work is **FE1–FE5** (the A13 surface) on the **QB-0…QB-3**
ladder. **FE6–FE8 are out of scope** — future epics, not this landing.

- **Out-of-scope future epics (followups, NOT this landing):** FE6
  (membership→QB, #1277), FE7 (shop-hour inter-class journals, #1278), FE8
  (budget-vs-actual view, #1279). They reuse this work's QB connection + write /
  ambiguity-queue substrate (§9), but are separate work — noted, not designed here.
- **In-scope post-first-landing deferrals (this work):** the in-process
  receipt-intake / inventory-load crossings go live when receipt-app / the
  orchestrator co-reside (§8a/§8c); drop the dead `SettingsData` poll fields;
  QB-3 drift-queue polish.

*(No inbound-machine-surface item: the Inventory apps all move into checkin and
never run remotely — owner decision, on security grounds — so checkin never hosts a
machine-bearer route and there is nothing left open there. §8a/§8c.)*

**Deferral discipline:** each of the above is filed as a tracked issue at merge —
never a bare "later" in prose or a code comment. The issue tracker remembers, not
this doc.

### Assumptions

- **No production expense data to migrate; existing QB is reconciled, not clobbered.**
  Expenses arrive by receipt intake (§8a, live once receipt-app co-resides) or by
  hand; the existing 3 years of QuickBooks are reconciled against (GC-QB) via QB-1's
  pull + the `backfill`/`qb_skipped` path, not overwritten (§9).
- **Dev/test seed to build.** Lift the baseline (org settings / account mappings /
  a `CompletedReceipt` fixture / a capital-seed sample) from Inventory's
  `scripts/setup-test-data.sh` + the QB `.ground-truth.json` sample; drop the
  curl+retired-auth transport (write via the expense Prisma client against
  `EXPENSE_DATABASE_URL`); stamp the one seeded `Org` id (§6); add
  `VolunteerDesignation` / household rows (seed has 0) so the COI flag and
  budget-owner gate are exercisable.
- **`reimbursementFor` / reimbursee tiering** defaults to `internal` behind the
  narrow gate; raise to `pii` if a route ever returns the person's contact details
  alongside (§5).
- **QuickBooks account/vendor identity:** the QBO chart of accounts + vendor list
  are the authority (QB-1 bootstraps the mapping tables); a 0-or-many match is
  resolved by the QB ambiguity queue, never guessed (§9 QB-2).

---

## 14. Distillation at merge (`DOCUMENTATION_STANDARD.md` §4)

This doc lives in `docs/in-design/` — **deleted at merge**. Planning the split now
keeps the extract step a file move, not a months-later judgement call over every
paragraph (§4.2). Content splits three ways.

**(1) Standing domain rules → the EXISTING `docs/rules/finance-payments.md`.**
Unlike catalog (which created `docs/rules/catalog.md`) and local-inventory
(`inventory.md`), expense is **not** a new domain — `finance-payments.md` already
covers *"fees, refunds, payment plans, and reconciliation,"* and expense→QB is
reconciliation's core. So **add rules to that file, do not create a new one**
(creating a near-duplicate finance file would fragment the register). Run the §3.9
test (*could a later change violate this?*) on each; seeds that qualify — decisions
and invariants only, no mechanism:
- **Flag / checkoff / audit, not enforcement:** the app **surfaces** procurement/
  finance flags (tax-attached, threshold-crossed, missing-receipt, non-Everyday,
  COI) to a human for checkoff + audit; it does **not** enforce approval tiers,
  segregation-of-duties, or thresholds — *cite GC-FIN-CONTROL* (§6). Threshold
  numbers ($500/$2k/$50) are *awareness*, from Procurement Policy H.
- **COI is household-aware:** an approver in the submitter's household is a
  conflict → flag to `BOARD` (buildable because checkin has households; §6).
- **One QB account per expense line — no category splits** (§7/§9 QB-2).
- **QB reconciliation is idempotent, sync-not-clobber:** never double-book on
  retry; reconcile against existing QuickBooks rather than overwrite; an
  already-booked expense is recognized (`backfill`/`qb_skipped`), not re-posted —
  *cite GC-QB* (§9).
- **QB ambiguity is resolved by a human, never guessed:** an unmatched/multi-match
  vendor or account parks in the QB queue for finance (§9 QB-2).
- **Capital register invariant:** one ITFA row per physical asset; numbers minted
  here or seeded from QB memos; `(orgId, assetNumber)` unique (§9 QB-1).
- **Access invariant (divergence from catalog/inventory):** expense is **financial,
  person-linked data — reads are narrow** (finance/board, or the row's own budget
  owner via a handler query-filter), **not** the broad Inventory viewer gate;
  writes/checkoffs = `FINANCE`/`BOARD` — *cite `principles.md` least-privilege* (§6).
- **Org-stamping invariant:** every row carries the one injected org identity (§6).
- **Role decision:** the finance actor is a **distinct `FINANCE` role** (RB2 /
  #1314, kept role; owner-decided). #1314 keeps only the sub-actor designation
  detail — cross-ref, do not restate.
- **Owner-assignment is an org-level `FINANCE` decision** — `FINANCE` *makes*
  budget-owner assignments; a program Treasurer / Assistant Lead *reacts* to them
  (signs off their assigned lines) but does not make them. Assignment is owned by
  the org, not the program (§6).

**(2) Architecture/ops reference that stays true → `docs/designs/EXPENSE_QB.md`**
(§4 "operational reference → move, don't delete"). Later finance/QB work (FE6–FE8,
GC-DONOR, GC-PROGRAM-FINANCE) relies on it: the library-isolation + `configureExpense`
injection seam; own-DB / fourth-Prisma-client packaging; **the QuickBooks
connection foundation** — `@inventory/quickbooks`, the read-only-app + Infra-owned
refresher token model, the `secret`-never-in-DB decision, sandbox→prod; the QB-2
write-path + ambiguity-queue + outbox-drain design; the four crossings' in-process
port model and the **machine-surface-not-hosted** decision (§8/#1286 option C).
This is the reusable QB substrate donations and program-finance build on — GC-QB's
"settle the connection first." Runnable-ops bits (dev seed recipe, `DOCKER_HOST`
skip gotcha, the one-time consent runbook step) go to `docs/ops/` if worth keeping.

**(3) Pure mechanism now in the code → deleted** with the working doc (route
mounting, stub tree, `NavLink[]` splice, `_shared.ts`, security-generator wiring,
handler-endpoint gotcha, pagination/count mechanics, outbox-drain wiring, test
tiers) — a reader derives it from the source (§3).

**Cross-doc note:** catalog (#1286) and local-inventory (#1287) distill first, so
`docs/rules/{catalog,inventory}.md` and their `docs/designs/*` will exist by the
time expense merges. The finance rules here **reference** the shared decisions
(org identity, the crossing rule, the security regime) rather than restating them;
`EXPENSE_QB.md` references `GLOBAL_CATALOG.md`/`LOCAL_INVENTORY.md` for the shared
library-isolation and DB-topology substrate.

---

*Design for #1272 (FE1) and epic FE (#1272–#1279). Third app of the whole-Inventory
migration; downstream of receipt-app, coupled to the catalog (#1286) and
local-inventory (#1287), both of which land first. Brings the first QuickBooks
integration into checkin via `@inventory/quickbooks` on an explicit phase ladder.
Temporary duplication at the receipt-app / orchestrator boundaries is expected and
tracked.*
