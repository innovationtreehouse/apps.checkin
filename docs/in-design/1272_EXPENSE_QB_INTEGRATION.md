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
separable (its own library, its own database), the pipeline couplings
(orchestrator intake in, catalog lookups, reimbursement status out) designed as
explicit in-process ports, and
QuickBooks brought in as an **incremental phase ladder** grounded in the real
`@inventory/quickbooks` client rather than a stub.

## Executive summary

- **Finance staff** reach expense in the existing **Finance** nav area;
  checkoffs and holds route to a new `FINANCE` role and (for escalations) the
  existing `BOARD` role, per-line approval routes to the approvers of the line's
  **budget-owner bucket** (an accounting bucket, not a person; §6), and — unlike the catalog/inventory ports — **reads are narrow, not broad**:
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
inventory second). Expense sits **downstream of the workflow-mapping
orchestrator** (it receives the receipt money side from it) and **couples
sideways to the catalog** (item/account lookups). It does **not** call
local-inventory: the orchestrator is the sole applier of receipt stock, and
inventory load does not wait on expense sign-off (§8). Where expense touches
Inventory apps that have not moved yet (receipt-app, the orchestrator), we bring
**temporary copies** of the shared contracts — temporary meaning **< 2 weeks,
dev-only, never in a release** — and each crossing is an in-process call behind a
port, per #1286 §8.

The one thing this port adds that neither predecessor had: **QuickBooks**. It
lands `@inventory/quickbooks` as the first QB code in checkin and grows the write
path on an explicit phase ladder (§9).

### Decisions locked (carried over from #1286/#1287, adapted)

| Question | Decision |
|---|---|
| DB topology | **Own dedicated database** (`EXPENSE_DATABASE_URL`) on the **same Postgres server** — separate `schema.prisma` + own Prisma client + own migrations. Same `@inventory/monitoring-db` precedent #1286 followed. |
| Security regime | **Adopt checkin's** registry + `@sensitivity` generator + stripper + scopeBindings over the separate schema (§5). **QBO OAuth tokens never touch a checkin/expense DB** — they live in an external secret backend owned by an Infra refresher (§9), so there is no `secret`-tier schema field to guard; the app reads the access token **read-only** and hosts **no OAuth route** (consent is an operator CLI step, §9). |
| Auth | **Retire** `expense-app`'s `@inventory/auth` + `@inventory/web-auth` (+ `jose`, the login page, `/api/auth/{login,logout}`). checkin next-auth session is the only auth (§6). |
| Roles | **New `FINANCE` role** (RB2 "Finance" umbrella — a role `docs/backlog/TOPDOWN.md` GC-ROLES explicitly *keeps*, not a net-new invention) for the checkoff/queue actor; **existing `BOARD`** for threshold/COI escalation; per-line approval routes to the approvers of the line's **budget-owner bucket** (`BudgetOwner`, checkin-owned accounting buckets; approvers are derived, not stored — §6). **Reads narrow** — no broad viewer gate (§6). This is the port's main divergence from #1286/#1287. |
| Scope | **Full port** of the A13 / FE1–FE5 surface (§ below), with temporary shims at the not-yet-migrated receipt-app / orchestrator boundaries (§8). FE6–FE8 noted, not designed (§9, §13). |
| UI location | **All UI in the library** — components, pages, route handlers. checkin-app only re-exports and mounts (§3). |
| UI style | **Keep the client pattern** — `"use client"` pages + `/api/*` routes; re-auth + re-theme only. Matches checkin's dominant pattern, same as #1286 §7 / #1287 §7. |
| `orgId` / user identity | **Keep the columns; inject the values** — resolved by #1286 §6. Org identity comes from the **checkin-owned `Org` registry table** (seeded on the initial migration with a stable well-known id), injected as an accessor `getOrg(): OrgIdentity` — **not** an env scalar, **not** a `SettingsData` row, **not** a cross-DB read. The user-id columns (`submitterId`, `decidedByUserId`, `capitalOwnerId`, `userId`) map to checkin **`Person.id`** via the injected principal; a line's owner is a `BudgetOwner` bucket id, not a person (§6). Both flow through the single `configureExpense()` injection (§6). |
| QuickBooks | **Incremental phase ladder** QB-0…QB-3 (§9), grounded in `@inventory/quickbooks` (read client + OAuth already built; write path + the `qb_pending` terminus net-new). Static creds (`QBO_CLIENT_ID/SECRET/ENVIRONMENT/REDIRECT_URI`) are **Infra-managed env/secrets** for the refresher and consent tooling; the app never holds `QBO_CLIENT_SECRET`. Writes go through one closed-enum, create-only writer (§9 QB-2). **The app never writes a secret and never holds the rotating refresh token:** an **Infra-owned refresher** (Secrets Manager rotation Lambda / scheduled Lambda) owns the refresh token + rotation and publishes the current access token; the app reads it **read-only** (`GetSecretValue`). **No token in Postgres, no file, no app-side write** (§9 QB-0). |

### The A13 / FE1–FE5 surface (scope)

1. **Expense + line model; per-line owner approval** (FE1). Each line gets a
   `LineItemOwnerApproval`; an approver of the line's bucket approves/rejects it,
   and a reimbursement or card-charge line also needs its sign-off seats filled
   before it posts (§6).
2. **Approval + flag / checkoff / audit** (FE1/FE2, GC-FIN-CONTROL). Flags —
   tax-attached, threshold-crossed, missing-receipt, non-Everyday, **COI/conflict**
   — are surfaced to the right human (finance / board) for a checkoff, all
   audit-logged. The app does **not** enforce approval tiers; it enforces only the
   F2 / F2-COI sign-off seats on reimbursements and card charges (§6). The
   **household-aware COI predicate is the one with real logic** and is *buildable here* because
   checkin has households (§6, the "port gets better" item). COI applies only to
   external payouts (reimbursements) and anything affecting external reporting.
   Actions:
   approve / reject / assign-owner / finance-assign / raise-exception /
   resolve-unknown, each with its queue.
3. **Budget-owner buckets; bucket↔PN associations; owner-conflict resolution**
   (FE2). `PartOwnerMap` (bucket per GTIN) + the owner-conflict resolution queue.
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
`SettingsData` (poll config).

Port dispositions:

- **`SettingsData` is not ported.** Its fields (peer URL, poll window) are dead
  configuration: nothing polls and no peer is reached over HTTP (§7, §8).
- **`ReceivedOrgEvent` and `ReceivedExpensePayload` stay**, as the audit record of
  every catalog event and intake payload received. Colliding names take the
  `Expense` prefix (`ExpenseReceivedOrgEvent`, `ExpenseProvisionalResolution`,
  `ExpenseOrgSettings`), because classifications merge by model name.
- **`LineItemOwnerApproval.budgetOwnerUserId` is dropped.** It always equals
  `decidedByUserId`; the approval stores the bucket id and who decided (§6).
- **New:** `ExpenseQbMatchExclusion` (`@@map("qb_match_exclusion")`), finance's
  permanent exclusions from QuickBooks matching (§9 QB-2).

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
checkin already vendors `money`.** Expense **reuses** those. New to expense — the
headline — is `@inventory/quickbooks`. `org-events-poller` and `service-client`
are not ported.

| Source package | Ported? | Action |
|---|---|---|
| `@inventory/auth`, `@inventory/web-auth` | **No — dropped** | The source's auth system, retired for checkin next-auth (§6). Drop `jose` with them. |
| `@inventory/gtin` | Reuse | `packages/gtin`, vendored by #1286. |
| `@inventory/workflows` | Reuse | `packages/workflows`, vendored by #1286. Shared xstate helpers. |
| `@inventory/money` | Reuse | Already in checkin `packages/money` (cents math). |
| `@inventory/receipt-types`, `receipt-contract-fixtures` | Reuse (temporary) | Vendored by #1286 as temporary copies. Expense imports the same copy — it needs `CompletedReceiptSchema` (intake, §8a) and the S5 `parseOrgEvent` union (provisional events, §8). |
| `@inventory/org-events-poller` | **No — not ported** | Nothing in checkin polls. Expense is a **second consumer** of catalog events (provisional resolution) through an in-process handler the catalog calls after commit (§8d). |
| `@inventory/service-client` | **No — not ported** | The typed HTTP client the source uses for the catalog crossing (pathPrefix `/api/internal`, org-bearer). In checkin every expense crossing is an in-process call (§8) and QB has its own outbound client (§9), so nothing uses it. |
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
    gtin/  workflows/  receipt-types/  money/   REUSED (vendored by #1286 / already present)
  checkin-app/                            ← WIRING ONLY, no expense logic
    src/instrumentation.ts                + one configureExpense({...}) call at boot (binds only; no DB access)
    src/app/api/cron/reconcile-shopify    + one try/catch step: QB outbox drain + stranded recovery + S5 catch-up (§9)
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
`ExpenseAuth` with `getPrincipal()` / `requireFinance()` / `requireBoard()`,
`OrgIdentity = { id, name }` behind `getOrg()`), the injected **budget-owner
accessor** (§6), plus the crossing **ports** (§8) and the **QB port** (§9).
checkin-app calls
`configureExpense({ auth, db, org, budgetOwners, catalog, quickbooks, catalogEvents })`
**once** in `instrumentation.ts` — the one justified boot singleton, mirroring
`configureCatalog()` / `configureLocalInventory()`.

**Honest residue** — same three mechanical things that structurally cannot leave
checkin-app: (1) the FS-routing stub files; (2) their `pageRegistry` entries
(checkin's drift guard — project memory); (3) the security registry/scopeBindings
entries (checkin centralizes the boundary on purpose). Adding a *new* expense
route touches all three; editing expense behavior touches none. **Nothing runs at
boot.** The QB outbox is drained in the request that commits a new event; the
catch-up drain and the source's crash-recovery `recoverStrandedQbExpenses()` are a
try/catch step in the existing prod `/api/cron/reconcile-shopify` (§9).
`instrumentation.ts` only binds and never touches a database.

---

## 4. Database — its own database on the shared server

Own dedicated database (`EXPENSE_DATABASE_URL`) on the same Postgres server as
checkin — separate `schema.prisma`, separate Prisma client, own migration
history. Identical rationale and precedent to #1286 §4 (`@inventory/monitoring-db`).
A dedicated DB namespaces the generic tables (`expenses`, `account_mapping`,
`capital_assets`, …) so **no table renames** are needed; the few model names that
collide with a sibling library's take the `Expense` prefix (§2), with `@@map`
keeping the table.

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
  mappings, `assetNumber` and the capital register, bucket ids
  (`budgetOwnerId`), all actor ids/usernames (`submitterId`, `decidedByUserId`,
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
inherits the same** — its actor FKs are `submitterId` / `decidedByUserId` /
`userId`, none scopable, and a line's owner is a bucket id, not a person — so **no
scopeBindings**, registry entries are the whole boundary work.

But expense wants something the prior ports did not: a **per-row narrow read** (a
bucket approver sees only the lines in buckets they approve, §6). Do **not** try
to express that as a per-row field scope (it would need a new `SCOPABLE_FIELD` — a
boundary change). Instead the narrow read is enforced **at the handler**: the route
guard decides *who may call* (finance/board vs approver), and for an approver the
handler **filters the query** to lines whose bucket the principal approves (a
`WHERE budgetOwnerId IN (buckets the principal approves)`, from the injected
budget-owner accessor), returning a
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
**all human routes** (`FINANCE`/`BOARD`, or bucket-approver-filtered per above):
`expenses` (GET list) + `expenses/[id]` (+ `capital-review`,
`set-depreciation-cycle`, `line-item-approvals[/*]` approve/reject/assign-owner/
finance-assign/raise-exception/resolve-unknown); `expense-holds[/*]` resolve +
resubmit + line-item account; `account-mapping[/*]` + `/catalog`; `qb-accounts[/*]`;
`capital-assets/seed` (finance user session); `local-owners`; `ownership-map`;
`provisional-items`; `org-settings`; `queue`; `counts`;
`expense-events` (+ finance's match actions: pick a candidate, create, exclude —
§9 QB-2); `received-expense-payloads`. The source's `system-data` route is not
ported (`SettingsData` is dropped, §2).
**Not registered / not hosted:** the source's `POST /api/expenses` **intake
machine route (org-bearer)** — checkin can't host a machine-bearer route (§8a), so
the orchestrator's intake call is in-process only, not a registered surface. `POST /api/capital-assets/seed`
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

### Role mapping — a new `FINANCE` role, existing `BOARD`, budget owner as a bucket

The source has four auth predicates: `isFinance` (dominant — 60 uses),
`isOrgManager`, `isBudgetOwner`, `isAdmin`. checkin's `PersonRoleKind` today is
`SYSADMIN, BOARD, KEYHOLDER, BG_REVIEWER, OPERATIONS` — **no finance role.** The
mapping:

| Source guard | checkin (this port) | Notes |
|---|---|---|
| `isFinance` (hold resolution, capital seed/review, QB queues, account/vendor mapping, owner-map management, finance-assign, resolve-unknown, raise-exception) | **`FINANCE`** — a **distinct** new `PersonRoleKind` row (owner-decided) | **RB2 "Role: Finance"** ([#1314](https://github.com/innovationtreehouse/checkin/issues/1314)) — the umbrella GC-ROLES **explicitly keeps**, a kept role not a net-new invention. This port stands it up as a distinct row (not folded onto `BOARD`); #1314 keeps only the sub-actor detail (Treasurer / Bookkeeper / Accountant designations). Referenced without a closing keyword. Follows the `isOperations` precedent: PersonRole-table-only, **no legacy mirror column**. |
| `isOrgManager` (account-mapping + owner-assignment management) | **`FINANCE`** (collapsed) | The source's org-manager is finance-staff pipeline management; collapse onto `FINANCE` rather than standing up a second role. Split later only if a real duty boundary appears. |
| `isBudgetOwner` (approve/reject *your own* lines) | **bucket-approver predicate** — derived from data, not an RBAC role | The line's owner is a `BudgetOwner` bucket (resolved via `PartOwnerMap`, FE2), not a person. "Is this session an approver of the line's bucket?" is a per-row handler query filter, not an authorize token. Approvers are derived (next subsection). |
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
- **No `DevLoginPicker` change** — the `/api/roles` route iterates `ROLE_FLAGS`,
  so `FINANCE` is grantable through `setRoleFlag`'s authority matrix without a
  new route.

**Who may grant (owner).** Nobody assigns any role or flag — `BOARD`, `FINANCE`,
`INVENTORY_MANAGER`, Program Treasurer, any RBAC — to themself or to anyone in
their own household. `setRoleFlag` rejects a grant whose target is the actor or
shares a household with the actor; the check lives in that one shared function,
so it covers every flag, and Program Treasurer (`isTreasurer`) gets the same
check. `isTreasurer` is set by `BOARD` only — it comes from the Board-approved
program budget. Every RBAC change, `isTreasurer` included, writes an audit row
(actor, target, flag, old → new). Adult-only for `FINANCE` and Program Treasurer
is corporate policy, not enforced in software.

| Test | Expect |
|---|---|
| actor grants any flag to themself, or to a member of their own household | rejected; no row changes |
| non-Board actor sets `isTreasurer` | rejected |
| any accepted RBAC change | one audit row naming actor, target, flag, old → new |

This is **its own PR track** (§11), independent of #1286's `INVENTORY_MANAGER` —
expense is finance, not inventory management, so it does **not** reuse that role.

### Budget owners are buckets, and approvers are derived

A budget owner is an **accounting bucket, not a person.** Most buckets map to a
Program; some are org-level (Facility is one of several). The bucket table is
checkin-owned host data, like the `Org` registry:
`BudgetOwner { id, name, programId?, archivedAt?, qbClassId }`. Its QuickBooks
reference is a **Class**. It lands as its own small checkin boundary PR off
`main` (checkin schema + classifications) before expense's routes, and expense
reaches it through an injected accessor in `contract.ts`, never by import.

**Approvers are derived, never stored:**

- A **program bucket** is approved by the program's leader (`Program.leadMentorId`)
  and its program treasurers (`ProgramVolunteer.isTreasurer`; several are
  allowed). `isTreasurer` is added in the same boundary PR as the bucket table,
  and only `BOARD` sets it (§6 "Who may grant").
- An **org-level bucket** has no derived approvers. Assigning a line there is
  internal accounting and needs no sign-off; a reimbursement or card-charge line
  in an org-level bucket still needs every sign-off seat, and its program
  approver seat is filled by an independent Board member (§6 "Reimbursement and
  card-charge sign-off").

`LineItemOwnerApproval` stores the bucket id and `decidedByUserId` (who decided).
The source's `budgetOwnerUserId` is dropped; it always equals
`decidedByUserId`.

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
2. **Owner-assignment management** — curating **which bucket owns which parts**
   and clearing lines that did not auto-assign. Standing map: `PartOwnerMap`
   (bucket per GTIN), routes `/api/ownership-map`, `/api/local-owners`; at intake
   `initFinancialFlow` calls `resolveItemOwner(gtin)` so a mapped line routes
   straight to its bucket's approvers for signoff (an org-level bucket has no
   derived approvers; its program-approver seat is a Board member, §6). Queue side: an unmapped line lands in
   `assign_ownership` and is resolved via `assign-owner` / `finance-assign` /
   `resolve-unknown` on the `LineItemOwnerApproval` (owner-conflict resolution,
   FE2/#1273). This is what routes each line to the *right* bucket — the approval
   itself stays with the bucket's approvers.

Both curation tasks are **`FINANCE`'s** — and this is a deliberate ownership
principle, not an interim simplification: **bucket assignment is an org-level
decision that `FINANCE` makes.** A program's leader and treasurers **react** to
those assignments (they sign off the lines in their program's bucket), but do not
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
- **A bucket approver** (a program's leader or treasurer) reads **the lines in
  the buckets they approve and the expenses containing them** — a per-row scope,
  not the whole ledger.
- **Program leads / assistant leads / program treasurer** read the
  **budget-vs-actual view for their program** (FE8, later) — a scoped, aggregated
  read, not raw line access.
- **No broad viewer gate.** A volunteer or arbitrary RBAC-role holder does **not**
  read expenses.

**A caller with no integer id is unauthenticated** (boundary rule 6). Expense's
checkin-side adapter `getPrincipal()` returns `null` unless
`typeof user.id === "number"`, as `checkin-app/src/lib/catalog/configure.ts`
does, and the derived bucket-approver filter (program leader
`Program.leadMentorId` and `ProgramVolunteer.isTreasurer`, matched to the
session's person id) reads the id only from that principal. Prisma drops a
`where` key whose value is `undefined`, so an id-less session (a JWT whose
re-sync missed after a person merge or delete) would otherwise match every
bucket. Every per-caller filter takes the id through `callerId(auth): number`,
which throws on anything but an integer; an empty derived set (the caller
approves no bucket, leads no program) returns an empty result, never "skip the
filter". A caller-asserted id in a payload (e.g. `receipt-types` `localUserId`)
is never used for authorization, approval or sign-off attribution.

| Test | Expect |
|---|---|
| id-less session (`user.id` undefined) calls an approver read or approve/reject route | 401, never "approver of everything" |
| caller with an integer id who approves no bucket calls an approver read | empty list |
| payload `localUserId` names an approver | ignored; attribution comes from the principal |

**Least-privilege note** (`docs/rules/principles.md`): unlike #1286/#1287 this gate
does not widen anything — it confines financial data to finance, board, and the
approvers of the row's bucket. Stated here so the divergence from the prior ports is a decision
on the record, not an oversight.

### Flag / checkoff / audit (GC-FIN-CONTROL)

The app does not enforce approval tiers or thresholds. It surfaces a **flag** to
the right human for a **checkoff**, all **audit-logged** (`ExpenseAuditLog`).
Flags: **tax-attached**, **threshold-crossed** ($500 / $2k / $50 awareness, from
Procurement policy H — *awareness, not enforcement*), **missing-receipt**,
**non-Everyday**, and **COI/conflict**. Each routes to finance or board and lands
a checkoff + audit row. This **replaces** the source's implicit tiering with the
lightweight flag pattern GC-FIN-CONTROL specifies — the flags are low-volume
(~1–2 of each per year) even though the expense process itself is high-volume, so
the flag machinery stays deliberately thin.

**The one enforced control is the sign-off on money leaving the org.** A
reimbursement or card-charge line does not reach QuickBooks until its sign-off
seats are filled by distinct, independent people (next subsections). Separation
of duties and COI are enforced there, as a hold; everywhere else they stay flags.

### The household-aware COI flag — the port gets *better* in checkin

**The conflict flag is the one flag with real logic**, and it is *buildable here
and was not buildable in the source*: a **household-aware "approver is in the
submitter's household" check** (Q27). The ported `expense-app` never had a
household model, so it could not express COI at all. checkin **has** households, so
this is a genuine port-gets-better item.

**COI scope.** Accepting an item into a program budget is internal accounting and
raises no conflict of interest. COI controls apply only to **external payouts**
(reimbursements) and to anything affecting **external reporting**. So the predicate runs on reimbursement and card-charge lines: a
signer who is the submitter or the reimbursee, or shares a household with either,
is conflicted. A conflicted signer cannot fill a seat, and a conflicted Treasurer
adds Board seats (F2-COI, next subsection). Design it as a real predicate over
checkin's household graph (read via the injected principal/port, not a cross-DB
join — §4), not as another rubber-stamp. This directly discharges GC-ROLES'
"expense approval + conflict constraints" duty gap.

### Reimbursement and card-charge sign-off (Financial Policy F2 / F2-COI)

Policy chain: purchaser → Program Leader or Program Treasurer → Treasurer (→ +1
or +2 non-conflicted Board members on conflict). The Treasurer pays in
QuickBooks; the system creates the Bill and never pays it (§9 QB-2).

**Seats.** A reimbursement line needs every seat filled by a distinct person:

| Seat | Who may fill it |
|---|---|
| Submitter | the person who submitted (an attestation, not an approval) |
| Program approver | the bucket's Program Leader or one of its Program Treasurers (`ProgramVolunteer.isTreasurer`); for an org-level bucket, an independent Board member who is not the Treasurer-seat signer |
| Treasurer | any `FINANCE` holder (a Treasurer-only seat can come later via #1314 designations) |
| +1 / +2 Board | non-conflicted Board members, when F2-COI requires them |

**Independence — who cannot fill a seat:**

- the submitter, the reimbursee, or anyone in either one's household;
- anyone already in another seat for the same line (no one authorises and
  executes);
- a conflicted program approver: another PL/PT of that program signs; if none
  can, a Board member takes the seat.

**F2-COI escalation:**

- Treasurer conflicted (is the submitter or related to them) → +1 non-conflicted
  Board member;
- Treasurer is the same person who signed as PL/PT → +1 (and a different
  Treasurer-seat signer is required anyway by "distinct people");
- both → +2.

**Exceptions carried from F2:**

- a signed note in lieu of a receipt, under $50, in a program budget → PL/PT +
  Treasurer;
- $50 or more, or not in a program budget → Board;
- a non-member purchaser's reimbursement → Board only.

**Card charges** use the same seats and independence rules with a reduced
escalation: at most **+1** non-conflicted Board member, never +2.

**Hold and record.** A line with an unfilled seat stays out of the QB-2 outbox
(§9); no `ExpenseEvent` row is committed for it. Each sign-off writes an
`ExpenseAuditLog` row: who, in which seat, when. A sign-off is attributed only
from the principal (`callerId()`), never from a payload. The reimbursement option
is hidden for non-adults (owner), so a minor never appears as a submitter of a
reimbursement.

| Test | Expect |
|---|---|
| one person fills two seats on a line | second sign-off rejected |
| signer shares a household with the reimbursee | rejected for every seat |
| Treasurer conflicted | line held until +1 Board seat is filled |
| Treasurer also signed as PL/PT, and conflicted | +2 Board seats required |
| card charge with both conflicts | +1 Board seat, never +2 |
| org-level bucket line | program approver seat accepts only a Board member who is not the Treasurer-seat signer |
| line with any seat unfilled | no `ExpenseEvent`, nothing posted |

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
- `ownership-map` / `local-owners` — budget-owner buckets and bucket↔PN
  associations; owner-conflict resolution (surface 3, FE2).
- capital review + depreciation panels (`CapitalReviewPanel`,
  `SetDepreciationCyclePanel`) on the expense detail — surface 4, FE4; the
  loop-closing "assign ITFA → log in QB → sticker reminder" step (Q66) lands here.
- `capital-assets/seed` — the **`FINANCE` capital-seed upload page**, the port of
  the source's `receipt-load-app` `capital/seed` screen; it posts to
  `POST /api/capital-assets/seed` (§9 QB-1).
- `provisional-items` — provisional resolution view (consumes catalog S5 events,
  §8).
- `received-expense-payloads` — intake ledger (surface for the orchestrator→
  expense crossing, §8a).
- `expense-events` — the QB **outbox** ledger, and (§9 QB-2+) the **QB
  sync-failure / ambiguity queue**, where finance picks a match candidate,
  creates, or excludes a QuickBooks transaction from matching.
- `org-settings` (capital thresholds). The source's `system-data` page is **not
  ported**: `SettingsData` held only dead configuration (`pollIntervalMinutes`,
  `globalServerUrl`), since nothing polls and the catalog is read in-process (§8).

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

Expense sits mid-pipeline: **workflow-mapping orchestrator → expense → (catalog
lookups) → QuickBooks**, and receipt reads reimbursement status back from it. Every
crossing follows the **crossing rules #1286 §8 set**: *keep the JSON/contract
shapes; every crossing is a synchronous in-process call behind a port that
checkin-app binds in `configureExpense()`; the callee parses its input and the
caller parses the response; nothing polls, nothing touches a database at boot,
and any catch-up is a step in `/api/cron/reconcile-shopify`.* No crossing has an
HTTP adapter: the Inventory apps all move into checkin and none runs remotely
(owner decision, on security grounds), so there is no remote peer to serve.

**Each callee's zod parse asserts `orgId`.** Expense's callee ports (S2 intake,
X12 reimbursement status, the S5 handler) reject a payload whose `orgId` is not
the injected org (§6). This keeps the per-org scoping Inventory's own auth
enforced at the bearer, now that the call is in-process.

**Inventory load is not an expense crossing.** The orchestrator is the sole
applier of receipt stock (#1287 §8c), and inventory load does not wait on expense
sign-off (owner), so expense never calls local-inventory.

| Crossing | Direction | Kind | Contract | Source transport |
|---|---|---|---|---|
| **S2 — expense intake** | workflow-mapping → expense | **in-process call (callee)**; machine route not hostable, §8a | `CompletedReceiptSchema` (`@inventory/receipt-types`) | `POST /api/expenses`, org-bearer; idempotent on `receiptId` via `ReceivedExpensePayload` |
| **C — catalog lookups** | expense → catalog | **in-process read (caller)** | `catalog-schemas` (categories, subcategories, item info, item lookup) | `service-client` (pathPrefix `/api/internal`) → catalog's org-bearer **machine** surface `/api/internal/[...path]` (#1286 §8) |
| **X12 — reimbursement status** | receipt → expense | **in-process read (callee)** | `ReimbursementStatus.forReceipts` (§8c) | none; receipt stamped "reimbursed" by hand |
| **S5 — provisional events** | catalog → expense | **post-commit call-out (consumer)** | `orgEventPayloadSchema` | catalog's `OrgEvent` table, HTTP-polled |
| **QB — post** | expense → QuickBooks | **outbox** | `QbExpenseEventSchema` / `QbLineItemSchema` (schemaVersion 1) | `ExpenseEvent` outbox row; drained by the write path (§9) |

### 8a. Expense intake (S2) — in-process only; checkin cannot host the org-bearer route

The receipt's **money side** (total / tax / shipping / discount / vendor / lines)
arrives as a `CompletedReceipt` from the **workflow-mapping orchestrator**, which
is the only caller in the source; receipt-app never calls expense directly.
`processCompletedReceipt` stores it idempotently in `ReceivedExpensePayload`
(keyed on `receiptId` — a re-push is a safe retry), creates the `Expense` +
lines, and calls `initFinancialFlow`. **Idempotency is part of the contract**,
preserve it exactly. In the source this is `POST /api/expenses` gated by
`requireOrgBearer`.

**The "already applied" check moves into the service.** In the source the
short-circuit for an already-received `receiptId` sits in the HTTP route, so a
direct call to `processCompletedReceipt` would skip it. The port moves that check
into the exported service, so the in-process call gets it. The orchestrator's S2
crossing is gated on this move.

**checkin cannot host the org-bearer route** (#1286 §8; the same wall
local-inventory's apply hit, #1287 §8c): checkin has no org-bearer validator, no
org-bearer path in `authenticateRequest` / `handler()`, a frozen
`scripts/legacy-authz-routes.txt`, and a blocking `new-route-old-authz` ratchet
for any new machine-bearer route. It does not need to: the orchestrator is
co-resident.

**Resolution — intake is in-process only.** The orchestrator calls expense's
exported `processCompletedReceipt` through a port in its own `contract.ts`
(#1289), bound by checkin-app. **No inbound HTTP intake route is built in
checkin.** There is no remote fallback, ever: an open inbound machine surface is an
unacceptable security exposure, so checkin never grows one.

**First-landing consequence:** at expense's first landing there is **no automated
intake**. The human surfaces (approval queues, holds, capital review, account
mapping) and manual expense entry work; the high-volume pipeline goes live **when
the orchestrator co-resides**. Until then, expenses are entered by hand / seeded.
**Same disposition for `POST /api/capital-assets/seed`?** No — that route is gated
by `requireRole(isFinance)` (a normal **user session**, the finance user's JWT
forwarded as the cookie), **not** a machine bearer, so it is a normal
`FINANCE`-gated route and **is** hostable (§9 QB-1).

### 8b. Catalog lookups (C) — in-process read (mirrors #1287 §8b)

The QB processor resolves each line's account by reading the catalog:
`lookupItems` (3-pass matcher) → `getItem` → `listCategories` / `listSubcategories`
(`inventory-client.ts`). In the source these go over `service-client`
(pathPrefix `/api/internal`) to the catalog's **org-bearer machine surface** —
`/api/internal/{items/lookup, items/[gtin13], categories, subcategories}`, which
checkin does not host (#1286 §8).

**checkin's expense reads catalog in-process**, the pattern #1287 §8b established
for local-inventory. Catalog is co-resident from day one (dependency gate, §1), so:

- Add a **`CatalogReader` port** (`contract.ts`: `lookupItems()`, `getItem(gtin13)`,
  `listCategories()`, `listSubcategories()` — broader than local-inventory's
  reader because expense also needs category/subcategory + the 3-pass lookup) bound
  in `configureExpense()` to the **in-process** catalog library service — a direct
  call into `@inventory/global-catalog`, **no HTTP, no `globalServerUrl`, no
  org-bearer token**. It touches **neither** catalog's `/api/catalog/*` (human) nor
  `/api/internal/*` (machine).
- The source's `service-client` HTTP path is **dropped**; keep the
  `catalog-schemas` zod shapes as the port's param/return types.

### 8c. Reimbursement status (X12) — expense is the callee

**QuickBooks is the system of record for reimbursement**, past and future, so
receipt keeps no in-app "mark reimbursed" stamp. Receipt asks expense instead:

`ReimbursementStatus.forReceipts(receiptIds) → Map<receiptId, { paidOn }>`

- **A reimbursement the system booked** is a QuickBooks **Bill** (§9 QB-2), which
  the system never pays. Finance pays it in QuickBooks; expense reads the Bill's
  linked **BillPayment** (the Bill's `LinkedTxn`, or `Balance = 0` plus the
  payment's date) and returns that date as `paidOn`.
- **A backfilled receipt** (matched to a transaction finance booked by hand) gets
  `paidOn` from that hand-booked transaction's date, located by its `qbEntity` +
  `qbTxnId` (kept on the receipt's `ReceiptDetail`).
- A receipt with no payment yet is returned as not yet paid. Reads use the
  windowed QuickBooks readers (§9); nothing walks QuickBooks history.

Receipt calls this through a port in its own `contract.ts`, bound by checkin-app.
Until it is bound, the port answers "not yet paid" for every receipt. It goes live
after QB-1/QB-2 and receipt's routes.

### 8d. Provisional resolution (S5) — second consumer of catalog events

Expense is a **second consumer** of catalog's S5 provisional-resolution events
(`provisional_approved` / `_rejected` / `_mapped_to_existing`) — it keeps its own
`ProvisionalItemMap` / `ExpenseProvisionalResolution` in step so account
resolution can proceed. It consumes them exactly as local-inventory does (#1287
§8a): an **in-process handler** registered with the catalog's post-commit
call-out (#1286 §8 X1). The handler parses each event, records it in
`ExpenseReceivedOrgEvent` (kept as the audit record of every event received, and
expense's own cursor), and applies it. The record and the reaction commit in one
expense transaction, so a reaction that throws rolls the record back too. A throw
therefore leaves the cursor behind; the
catch-up step in `/api/cron/reconcile-shopify` (or a retry button) replays from
it. No poller, no timer, no boot drain. `conversion_challenge_*` events stay
unconsumed (BYDESIGN, forward-only), same as #1287.

### First landing (expense in; catalog + inventory in; receipt/orchestrator not yet)

- Reuse the temporary vendored `receipt-types` / `receipt-contract-fixtures`
  (#1286's copies).
- **S2 (intake)**: **no HTTP route** (checkin can't host org-bearer, §8a) —
  in-process only when the orchestrator co-resides; until then exercised via
  seeded `CompletedReceipt` fixtures and manual entry.
- **C (catalog)**: bind in-process immediately (catalog co-resident).
- **X12 (reimbursement status)**: inert ("not yet paid") until QB-1/QB-2 and
  receipt land.
- **S5**: the handler lands with the catalog's post-commit call-out (#1286 §8 X1).

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
  The OAuth half runs only in the refresher and the consent CLI, never in the app.
- **Net-new — the app is a read-only token consumer; an Infra-owned refresher owns
  rotation.** The source refreshes inline (`ensureFresh` → `refreshTokens` →
  `saveTokens` to a gitignored file). That model requires the app to **write** the
  rotating secret, and a file does not survive an ephemeral, multi-replica
  container. **The app should not — and here cannot — write to the secret store.**
  So invert the lifecycle: rotation moves **out of the app** to a dedicated
  **Infra-owned refresher** (the standard AWS "credential that must rotate but the
  app shouldn't manage" shape — a Secrets Manager **rotation Lambda**, or a small
  scheduled Lambda on checkin's existing external scheduler). Three secrets, three
  homes, and the app touches only the access token, **read-only**:
  - **Static credentials** — `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`,
    `QBO_ENVIRONMENT`, `QBO_REDIRECT_URI` — loaded by Infra into the refresher and
    the consent tooling only. Never change. The "keys to generate the key."
    **`QBO_CLIENT_SECRET` is never in the app's environment**: the app does not
    refresh, so it has no use for it. The app gets `QBO_ENVIRONMENT` and the
    `realmId`, and uses the production realm only when `CHECKIN_ENV=prod`; any
    other environment pointed at production fails closed at configure time.
  - **The rotating refresh token** (~100 days, **rotates every refresh**) — held
    and rotated **only by the refresher**, which has the **sole write grant** to the
    secret. The app never sees it, never holds it, never writes it. This is what
    removes the write-back-from-the-app problem entirely.
  - **The current access token** (~1h) — the refresher refreshes it on a schedule
    (e.g. every ~45 min, before expiry) and publishes it into the secret; the
    **app reads it read-only** (`GetSecretValue`) when it needs to call QBO. The app
    has **read-only IAM on the access-token secret and nothing else** — no write, no
    refresh-token access.
  So the port narrows to a **read-only `AccessTokenSource { current():
  Promise<string> }`**, defined in `packages/quickbooks` (not in expense's
  `contract.ts`). checkin-app builds **one** instance (a Secrets-Manager-read
  adapter; a file/env adapter for local dev) and injects it into
  `configureExpense()` and `configureIncome()`, so there is one QB connection. The write-side `TokenStore` lives in
  the **refresher**, not the app. `QuickBooksClient` is adjusted so production never
  calls `refreshTokens`/`saveTokens` — it fetches the current access token from the
  source; if it ever reads a just-expired one (refresher lagged) it errors and the
  caller retries, rather than trying to refresh. **No token in Postgres; no secret
  write from the app.**
- **Refresh concurrency — solved by construction.** Because rotation has a
  **single writer** (the refresher Lambda), the multi-replica refresh race is gone:
  app replicas only *read* the published access token; none of them refresh. A
  refresher run that gets `invalid_grant` (the refresh token is dead and consent
  must be redone) raises an alert; it does not retry silently.
- **Token reads are alarmed.** A CloudWatch alarm fires on `GetSecretValue` for
  the access-token secret from any principal other than the app's task role and
  the refresher.
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

### QB-1 — read (windowed reads + account/vendor bootstrap + capital seed)

QuickBooks is read **one record at a time, inside a short date window**, never
walked from a start date. `packages/quickbooks` exposes **windowed readers only**
— `purchasesBetween(from, to)`, `billsBetween(from, to)`,
`billPaymentsBetween(from, to)` (and `depositsBetween` for income and donations) —
plus readers for **Account, Vendor and Class**. Matching (QB-2), reimbursement
status (§8c) and drift (QB-3) all call these with a window around one record's
date.

- **Exists:** `query` / `pagedSince` / `toGroundTruth` and the Purchase / Bill
  readers that page **since** a date. The windowed readers are a narrowing of the
  same `query` path; the app never calls the since-a-date entry points.
- **Net-new — one-time bootstrap, FINANCE-triggered.** Finance starts it from a
  `FINANCE` page; it has no schedule. It pulls the chart of accounts, the vendor
  list and the Classes to bootstrap `AccountMapping` / `ExpenseQbAccount`, vendor
  alias normalization, and the bucket ↔ Class references (§6).
- **Net-new — capital-seed intake.** The `FINANCE` capital-seed upload page (§7,
  the port of the source's `receipt-load-app` `capital/seed` screen) posts to
  `POST /api/capital-assets/seed` (FE4), which parses ITFA tags out of QB memos
  into the `CapitalAsset` register (`seeded=true`, idempotent per
  `(orgId, assetNumber)`).
- **History stays in QuickBooks.** GC-QB's "reconcile with 3 years of existing QB"
  works through the `backfill` / `qb_skipped` path (§2): an expense with a receipt
  is matched to the already-booked QB transaction without re-posting. **Past
  expenses with no receipt stay in QuickBooks only;** they are matched against
  when a receipt arrives, never imported. Finance can exclude one from matching
  for good (QB-2).

### QB-2 — write path (the `qb_pending` terminus)

Post signed-off expense lines to QuickBooks. **This is the headline net-new
work** and FE3's core. A reimbursement or card-charge line enters the outbox only
once every sign-off seat is filled (§6); until then it is held and nothing is
committed for it.

- **Exists in the source (checkin side of the port):** the `expense-qb-processor`
  already builds and **validates** the outbound payload against `QbExpenseEventSchema`
  / `QbLineItemSchema` (schemaVersion 1), resolves each line to **one** QB account
  (rules → one account/line, **no category splits by design**), allocates
  tax/shipping/discount, and commits the `ExpenseEvent` **outbox row** in one
  transaction (`qb_pending → qb_complete`). The outbox, idempotency
  (`expense_events_org_expense_unique`), holds, and crash-recovery
  (`recoverStrandedQbExpenses`) all port verbatim.

**Which QuickBooks entity each line becomes:**

- A line with **`needsReimbursement`** becomes a **Bill** to the reimbursee, who
  is a QuickBooks **Vendor**. A Bill is a liability: the system creates it and
  **never pays it**. Finance pays it in QuickBooks, and expense reads the payment
  back (§8c).
- **Every other line** becomes a **Purchase** against the card or bank account
  it was paid from.
- **Invariant: the system never writes a BillPayment, a Check or a Payment.**
- **Reimbursee → Vendor.** A person not yet mapped to a Vendor goes to the
  ambiguity queue. Finance picks an existing Vendor or chooses **"Create new"**,
  which creates the Vendor in QuickBooks. QuickBooks display names are unique
  across Customers, Vendors and Employees, so when the name already belongs to a
  Customer the new Vendor is named `<name> (Vendor)`.

**Match before create.** Finance often books a card charge by hand (frequently
from the bank feed) before its receipt arrives; posting again would book it
twice. So each line is matched first, using the matching model shared with income
and bulk donation, and driven **from our side**:

- **The work list is our own unmatched lines.** Each carries a match state:
  `UNMATCHED` → `MATCHED(qbTxnId)` / `CREATED(qbTxnId)`, or a finance queue state
  (`AMBIGUOUS`, `BEFORE_LINE`, `POST_FAILED`). The queue should fall to zero and
  stay there.
- **Each search is narrow.** For one line, ask QuickBooks only for entries of the
  right type in a short date window around the line's date, through the windowed
  readers (QB-1): a Purchase on amount + date window + payment account; a Bill on
  amount + Vendor + date window. Old history is never walked.
- **A QuickBooks entry can be claimed once.** The claimed `qbTxnId` is stored on
  the line under a unique constraint, so two lines can never match the same entry,
  and already-claimed ids are dropped from every candidate list.
- **Exclusions.** Finance can permanently exclude a QuickBooks transaction from
  matching, in one click with a reason, so a hand-booked expense that will never
  have a receipt stops appearing as a candidate. `ExpenseQbMatchExclusion
  { orgId, qbTxnId, reason, by, at }` (`@@map("qb_match_exclusion")`), unique on
  `(orgId, qbTxnId)`. Claimed and excluded ids are the only QuickBooks-side state
  kept.
- **Outcomes.** One candidate → `MATCHED`: link it and post nothing. More than one
  → `AMBIGUOUS`: equal amounts are common, so finance picks or creates; the system
  never guesses. None, and the line is after the takeover line → create. None,
  and before it → `BEFORE_LINE` for finance; the system never creates into a
  hand-closed period.
- **The takeover line is derived, not configured.** Each run takes it as the
  newest line tied to a QuickBooks entry the app did **not** create (hand-booked,
  found by matching or chosen by finance). App-created entries never move it.
  With no hand-booked match yet there is no line, and the system creates nothing
  (fail closed).
- **The find-or-create is shared and stateless.** It lives once in
  `packages/quickbooks`; expense passes its line, its takeover line, and its
  claimed + excluded ids.

**The write itself — one closed, create-only writer.** `@inventory/quickbooks` is
read-only today. QB-2 adds exactly one write entry point, `create(entity, fields)`,
whose `entity` is a closed enum: `Purchase`, `Bill`, `Deposit`, `Vendor`. Nothing
else is exported that can write. The writer, **including `Deposit`**, is owned by
the QuickBooks ladder (L4) in `packages/quickbooks`, not by expense: expense uses
`Purchase`, `Bill` and `Vendor`, and the designs for #1885 and #1886 use
`Deposit` and cite this writer rather than adding their own.

- **Create only.** No update, delete, void or sparse-update path exists.
- **Field allowlists per entity.** Only listed fields reach the request body;
  `Vendor` takes `DisplayName` only.
- **No Check-type Purchase.** A `Purchase` with `PaymentType: "Check"` is rejected
  before the request. With the closed enum this is what keeps the invariant: the
  system never writes a BillPayment, a Check or a Payment.
- **Idempotency key in the entry, looked up before create.** The key derived from
  the event goes in `DocNumber` (or `PrivateNote` where `DocNumber` is taken) and
  as the QBO `requestid`. Before each create the writer queries QuickBooks for an
  entry carrying that key; a hit is recorded as "found", never a second booking.
  The `requestid` window is short, so the lookup is what makes a retry days later
  safe (GC-QB "idempotent, sync-not-clobber").
- **Per-run cap.** A drain run stops after a fixed count and a fixed total amount;
  the rest waits for the next run, and hitting the cap raises an alert.

It maps account name → QBO account ref and the line's bucket → its Class (§6), on
the `AccessTokenSource` QB-0 established.

**Draining the outbox.** The request that commits an `ExpenseEvent` drains it
right away. Anything that request did not finish (a crash, a QuickBooks outage),
plus `recoverStrandedQbExpenses`, is picked up by a try/catch step in the existing
prod `/api/cron/reconcile-shopify`. No boot drain, no timer, no new schedule. The
step is idempotent, capped (above), and returns counts only (posted, matched,
held, failed) — no ids, names or amounts in the cron response.

**The QB sync-failure / ambiguity queue** (A13 step 6). A post can fail (auth,
validation, QBO rejection) or be **ambiguous** (more than one match candidate; a
reimbursee with no Vendor; an account name unmatched). These land in a **queue
screen** (`expense-events`, §7) for finance to resolve — pick, create, exclude,
vendor mapping, account remap, retry. This mirrors the account-mapping
`MULTIPLE_MATCHES` hold pattern (§7) but on the QB side.

### QB-3 — drift detection & reconciliation (FE5)

Detect and reconcile **external edits** to QB entries the system originated: a
try/catch step in `/api/cron/reconcile-shopify` re-reads each system-originated
QBO transaction (tracked by `sourceQbTxnId` / the outbox) through the windowed
readers, compares it against what was posted, flags drift (amount / account /
vendor changed in QB after we posted), and routes it to a reconciliation queue.
Like every cron step, it is capped and returns counts only.
**Exists:** the read path (QB-1). **Net-new:** the diff + drift queue. Grounds on
GC-QB's "reverse-reconcile against existing QB to enumerate what the system still
can't model."

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

- Build the new `packages/*` (`expense`, `quickbooks`); the workspace build
  already covers `packages/*`.
- **Provision the dedicated expense database** + `EXPENSE_DATABASE_URL` secret
  (monitoring-db pattern in the Infra database module).
- Add **expense `prisma migrate deploy`** (against `EXPENSE_DATABASE_URL`) to the
  deploy sequence, ordered with checkin's / catalog's / inventory's steps.
- **QB static creds (env):** `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`,
  `QBO_ENVIRONMENT` (`sandbox` → `production`), `QBO_REDIRECT_URI` (the consent
  redirect — the operator's `localhost` for the CLI consent flow, since the app
  hosts no callback) — **Infra-managed env vars / secrets** for the refresher +
  consent tooling only. The app's task definition carries `QBO_ENVIRONMENT` and
  the realm id, never `QBO_CLIENT_SECRET`; the production realm is configured only
  where `CHECKIN_ENV=prod`.
- **Alarms:** `GetSecretValue` on the access-token secret by any principal other
  than the app task role and the refresher; refresher `invalid_grant`; a QB drain
  run hitting its cap.
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
- **Outbox / recovery lifecycle:** **no background timer, no boot drain, no new
  schedule.** The request that commits an `ExpenseEvent` drains it. The catch-up
  drain, `recoverStrandedQbExpenses`, the S5 catch-up and the QB-3 drift check are
  one try/catch step in the existing prod `/api/cron/reconcile-shopify`.
  `instrumentation.ts` never touches a database, so the 06:45 prewarm wakes no DB.
  The QB-1 bootstrap is FINANCE-triggered and has no schedule.
- No new Caddy route, no new port, no new container.

---

## 11. Phasing (PR tracks)

**Dependency gate.** Expense implementation **follows both prior ports**: it
consumes the catalog's item/account lookups and S5 events (**#1286 must land**),
and it reads budget-owner buckets from checkin (the bucket table's boundary PR
must land before track 4, §6). Track 1 can start once #1286 track 1 (catalog
library skeleton + shared packages) has landed.

1. **Library skeleton** — `packages/expense` (reuse
   `gtin`/`workflows`/`receipt-types`/`money`; `org-events-poller` and
   `service-client` are not ported — §2), expense schema + client +
   migrations, domain (repositories / services / the xstate machine / QB processor /
   capital register / financial-flow) ported, **unit tests only** (the source's
   route+auth-bound integration tier → flow tests in track 5, §12). Package stays
   `next`-free (next-free `_shared.ts`; source `validate`/`route-auth` not ported).
   No UI, no QB write, no checkin wiring. Green in isolation. Drops
   `SettingsData` and `LineItemOwnerApproval.budgetOwnerUserId`, prefixes the
   colliding models, and moves the intake "already applied" check into the
   service (§2, §8a).
2. **`FINANCE` role foundation** — add the `FINANCE` `PersonRoleKind` as a
   **distinct row** (RB2, a kept role; owner-decided — **references #1314 without
   closing it**), the **exact #1286 Track-2 surface** (non-txn `ADD VALUE` migration,
   `FLAG_TO_KIND`, next-auth in 3 spots, `RoleBadge`, the 3 `ROLE_FLAGS`-indexed row
   types; **no `DevLoginPicker` change**, §6), plus the "who may grant" check in
   `setRoleFlag` (no self or own-household grant, any flag) and its audit row.
   Own PR (role-system change). Defines the household-COI predicate over
   checkin's household graph (reimbursement and card-charge lines, §6).
   - **2a. Budget-owner bucket table** — its own small checkin boundary PR off
     `main`: `BudgetOwner` + `ProgramVolunteer.isTreasurer` (set by `BOARD`
     only, audited) + classifications, and the derived bucket-approver lookup
     (§6).
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
   **human** `/api/…` stubs (`FINANCE`/`BOARD`, bucket-approver query-filter) +
   guards + the household-COI flag + the sign-off seats and outbox hold (§6),
   written test-first; the `capital-assets/seed` finance route; the `C`
   (catalog) crossing bound in-process. **No intake machine route — checkin can't
   host it (§8a); intake is in-process only.** Watch the route-endpoint-string gotcha (§5);
   list routes return bare arrays (pagination → track 5). Depends on 1–3.
5. **UI + nav + flow tests + pagination** — reskinned pages/components (library),
   page stub tree + `pageRegistry` entries, the library's `NavLink[]` in a **finance
   area** gated by `FINANCE`/`BOARD` (not the Inventory area — §7),
   `transpilePackages` (if tsx needs it — verify). **Flow tests carry the source's
   integration journeys** (route+auth+DB e2e via persona-mint), incl. the A13
   journey (§12). **Adds numbered pagination** via a `.../count` endpoint, enabled
   by a registry-first boundary commit declaring a synthetic public count response
   model so the scalar total crosses the stripper (§7) — not offset+lookahead.
6. **Reimbursement status (X12)** — the `ReimbursementStatus.forReceipts` callee
   (§8c), answering "not yet paid" until QB-1/QB-2 can read Bills and their
   BillPayments.
7. **S5 provisional consumer** — the in-process handler registered with the
   catalog's post-commit call-out, plus its catch-up in the reconcile cron step
   (§8d). No timer, no boot drain. Depends on #1286 §8 X1.

**QB sub-sequence** (its own explicit ladder, interleaved with the tracks above):

- **QB-0** (connection + auth) — the QB client package + the read-only
  **`AccessTokenSource`** in the app, paired with the **Infra-owned refresher** that
  owns the refresh token and rotation, and the **operator CLI consent** that seeds
  the initial token (§9/§10). The app never writes a secret and hosts no OAuth
  route. Small app-side PR (mostly the read adapter + client tweak); the refresher +
  secret + read-only IAM grant are **Infra work to coordinate**. **Everything QB
  depends on QB-0.**
- **QB-1** (read) — windowed readers + FINANCE-triggered account / vendor / Class
  bootstrap + the capital-seed upload page and intake (FE4). After QB-0. Feeds
  tracks 4–5.
- **QB-2** (write path / `qb_pending` terminus) — the one closed-enum,
  create-only QBO **writer** (Purchase, Bill, Deposit, Vendor; never BillPayment,
  Payment or a Check-type Purchase; field allowlists; key looked up before
  create; per-run cap) in `@inventory/quickbooks`, match-before-create with `ExpenseQbMatchExclusion`, the
  outbox drain (on commit + the reconcile cron step), and the **QB sync-failure /
  ambiguity queue** (FE3, A13 step 6). After QB-0 and after the
  domain/outbox tracks (1, 4). **The QB write path follows the QB read/client-port
  — QB-2 cannot precede QB-0/QB-1.**
- **QB-3** (drift / reconciliation, FE5) — after QB-2.

8. **Infra** — deploy sequence + expense DB provisioning + QB env/secrets + the
   consent runbook step.
9. **(Deferred — each a tracked follow-up issue vs the FE issues, not prose
   "later")** the in-process intake crossing goes **live** when the orchestrator
   co-resides (no route to retire — none was hosted, §8a); FE6 (membership→QB,
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
  `flow-tests/*.flow.test.ts`. Priority journey: **A13 end to end** — intake →
  per-line bucket approval → capital review + depreciation → account
  resolution (incl. a `MULTIPLE_MATCHES` hold + resubmit) → QB outbox emit → (QB-2)
  QB post → ambiguity-queue resolve. Land in track 5 (domain flow) + a QB-2 flow
  once the write path exists.
- **QB tests hit the QBO sandbox only.** The write path and OAuth are tested
  against a QBO **sandbox** company (the source's model), gated out of the default
  CI run (they need external creds + network) exactly as the Inventory monorepo's
  `*.shopify-live.ts` are (`AGENTS.md` shopify-live precedent). **No CI tier posts
  to production QuickBooks.**
- **Coupling tests** — the crossing ports get contract tests that the **in-process**
  binding (S2 intake, C catalog read, S5 events, X12 reimbursement status) behaves
  identically to the source's HTTP shapes for the same input — the cheapest guard
  that the transport change is behavior-preserving. S2 includes a repeat-call
  test: a second intake of the same `receiptId` through the service changes
  nothing.
- **Matching tests** (packages-only, no QuickBooks): one candidate links, two go
  to `AMBIGUOUS`, a claimed or excluded id is never a candidate, no takeover line
  creates nothing, and no writer ever emits a BillPayment, Check or Payment.
- **QB entity-path test (CI, packages-only).** It fails if `packages/quickbooks`
  can issue a request to any QBO entity path other than create on `purchase`,
  `bill`, `deposit` or `vendor`; if a field outside an entity's allowlist reaches
  a request body; if a Check-type Purchase is sent; or if a create is sent without
  first looking up its idempotency key.
- **Sign-off tests** (§6 tables) land first in the expense routes track, before
  the outbox wiring they guard.

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
- **In-scope post-first-landing deferrals (this work):** the in-process intake
  crossing goes live when the orchestrator co-resides (§8a); QB-3 drift-queue
  polish.

*(No inbound-machine-surface item: the Inventory apps all move into checkin and
never run remotely — owner decision, on security grounds — so checkin never hosts a
machine-bearer route and there is nothing left open there. §8a.)*

**Deferral discipline:** each of the above is filed as a tracked issue at merge —
never a bare "later" in prose or a code comment. The issue tracker remembers, not
this doc.

### Assumptions

- **No production expense data to migrate; existing QB is reconciled, not clobbered.**
  Expenses arrive by intake from the orchestrator (§8a, live once it co-resides)
  or by hand; the existing 3 years of QuickBooks are reconciled against (GC-QB)
  through windowed matching + the `backfill`/`qb_skipped` path, not overwritten
  (§9). Past expenses with no receipt stay in QuickBooks only: matched against,
  never imported (§9 QB-1).
- **Dev/test seed to build.** Lift the baseline (org settings / account mappings /
  a `CompletedReceipt` fixture / a capital-seed sample) from Inventory's
  `scripts/setup-test-data.sh` + the QB `.ground-truth.json` sample; drop the
  curl+retired-auth transport (write via the expense Prisma client against
  `EXPENSE_DATABASE_URL`); stamp the one seeded `Org` id (§6); add
  `VolunteerDesignation` / household rows (seed has 0), a program bucket with a
  leader and a treasurer, an org-level bucket, and enough Board and `FINANCE`
  holders in separate households, so the COI flag, the bucket-approver gate and
  every sign-off seat (including +2 Board) are exercisable.
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
- **Flag / checkoff / audit:** the app **surfaces** procurement/finance flags
  (tax-attached, threshold-crossed, missing-receipt, non-Everyday, COI) to a
  human for checkoff + audit; it does not enforce approval tiers or thresholds —
  *cite GC-FIN-CONTROL* (§6). Threshold numbers ($500/$2k/$50) are *awareness*,
  from Procurement Policy H.
- **Money leaving the org needs filled sign-off seats:** a reimbursement or
  card-charge line is held out of QuickBooks until its submitter, program
  approver and Treasurer seats (plus +1/+2 Board under F2-COI; at most +1 for a
  card charge) are filled by distinct, independent people, and each sign-off is
  audit-recorded — *cite Financial Policy F2 / F2-COI* (§6).
- **COI is household-aware and limited to external payouts and external
  reporting:** the submitter, the reimbursee and their households cannot sign;
  accepting an item into a program budget is internal accounting and raises no
  COI (§6).
- **Nobody grants a role or flag to themself or their own household;
  `isTreasurer` is set by `BOARD` only; every RBAC change is audit-logged** (§6).
- **Budget owners are buckets; approvers are derived, never stored:** a program
  bucket is approved by the program's leader and treasurers; an org-level
  bucket's program-approver seat is an independent Board member (§6).
- **One closed, create-only QuickBooks writer:** Purchase, Bill, Deposit, Vendor
  only, field-allowlisted, never a Check-type Purchase, idempotency key looked up
  before create, capped per run; the app holds no QuickBooks client secret and
  writes to the production realm only in prod (§9).
- **A reimbursement is a QuickBooks Bill the system never pays:** the system
  writes Bills and Purchases and **never writes a BillPayment, a Check or a
  Payment**; finance pays in QuickBooks and the system reads the payment back
  (§8c, §9 QB-2).
- **Match before create:** a QuickBooks entry is claimed by at most one line;
  more than one candidate goes to finance, never a guess; an entry finance
  excluded is never a candidate; nothing is created before the derived takeover
  line (§9 QB-2).
- **Past expenses with no receipt stay in QuickBooks only** — never imported
  (§9 QB-1).
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
  person-linked data — reads are narrow** (finance/board, or the approvers of the
  row's bucket via a handler query-filter), **not** the broad Inventory viewer gate;
  writes/checkoffs = `FINANCE`/`BOARD` — *cite `principles.md` least-privilege* (§6).
- **Org-stamping invariant:** every row carries the one injected org identity (§6).
- **Role decision:** the finance actor is a **distinct `FINANCE` role** (RB2 /
  #1314, kept role; owner-decided). #1314 keeps only the sub-actor designation
  detail — cross-ref, do not restate.
- **Bucket assignment is an org-level `FINANCE` decision** — `FINANCE` *makes*
  bucket assignments; a program's leader and treasurers *react* to them (sign off
  the lines in their bucket) but do not make them. Assignment is owned by
  the org, not the program (§6).

**(2) Architecture/ops reference that stays true → `docs/designs/EXPENSE_QB.md`**
(§4 "operational reference → move, don't delete"). Later finance/QB work (FE6–FE8,
GC-DONOR, GC-PROGRAM-FINANCE) relies on it: the library-isolation + `configureExpense`
injection seam; own-DB / fourth-Prisma-client packaging; **the QuickBooks
connection foundation** — `@inventory/quickbooks`, the read-only-app + Infra-owned
refresher token model, the `secret`-never-in-DB decision, sandbox→prod; the
windowed-read rule; the QB-2 entity rule (Bill for reimbursement, Purchase
otherwise), the shared matching model, ambiguity queue and outbox-drain design;
the crossings' in-process port model and the **machine-surface-not-hosted** decision (§8/#1286 option C).
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
migration; downstream of the workflow-mapping orchestrator, coupled to the catalog
(#1286), and landing after local-inventory (#1287). Brings the first QuickBooks
integration into checkin via `@inventory/quickbooks` on an explicit phase ladder.
Temporary duplication at the receipt-app / orchestrator boundaries is expected and
tracked.*
