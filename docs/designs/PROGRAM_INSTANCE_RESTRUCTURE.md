# Design Proposal: 3-Tier Program → Instance → Event Restructure

**Status:** Approved direction (owner 2026-10-16): complete; plan refreshed
**Supersedes:** Audit item **P2-3** (naming confusion around "session"/"program"/"event")
**Scope:** `checkin-app` (schema + security + UI + data migration)
**Progress:** P1 (table + backfill, no readers) merged in September 2026 (issue #1361). P2–P5 remain. The `ProgramInstance` table stays; it is not to be dropped.
**Baseline:** today's `main` (2026-10-16). The earlier draft assumed the member-segment pricing proposal (#929) would ship first; it has not (`checkin-app/docs/designs/SHOPIFY_MEMBER_SEGMENT_PRICING.md` is still a proposal). Member pricing today is a minted single-use discount code per household checkout (§2a). `Fee`/`FeePayment` were dropped with issue #354 and are not part of this plan.

**Naming.** This doc says **program leader** for the person who runs a program, matching the rules register (`docs/rules/programs.md`). The schema still says `leadMentor` (`Program.leadMentorId`, `ProgramInstance.leadMentorId`, the `programsLed` claim, the `program-lead-mentor` resolver). The architectural review's WI 4.5 renames "lead mentor" to "program leader" in code; that review is not on `main` yet. The two pieces of work touch the same files — see open question Q6. No step of this plan renames a leader column or claim in place.

---

## 0. The core thesis

P2-3 was filed as a *naming* problem. It is a *missing structural layer*.

Today `Program` does two jobs at once:

1. It is a **catalog definition** ("Woodworking 101") — a reusable thing with a name, an age range, a membership policy, a Board-set price.
2. It is a **concrete offering** ("Fall 2026 Woodworking") — a thing with dates, a roster, a program leader, a capacity, a store listing and a sale window.

Because those two jobs share one row, the URL layer invented a fake middle word: `/program-ops/sessions/*` creates **`Event`** rows. "Session" is a placeholder for a tier that does not exist in the schema. That mislabel **is** P2-3.

```
Program        definition / template   "Woodworking 101" (catalog entry)
  └─ ProgramInstance   offering / run   "Fall 2026 Woodworking"
       └─ Event        occurrence       "Woodworking, Tue Sep 8, 4pm"  (today's Event row)
```

Locked names: model **`ProgramInstance`**, FK column **`instanceId`**, UI copy **"Instance"**, leaf stays **`Event`**. `Session` is off-limits (NextAuth owns `model Session`).

---

## 1. What exists on `main` today

### P1 as merged

- Migration `checkin-app/prisma/migrations/20260910120000_program_instances_phase1/migration.sql` (the only migration that mentions the table). It creates `ProgramInstance`, adds nullable `Event.instanceId` (FK, `ON DELETE SET NULL`), and runs a one-off backfill between `>>> BACKFILL START` / `>>> BACKFILL END` markers: one instance per program with `id = Program.id` (id-aliased), `Event.instanceId = Event.programId`, and the id sequence bumped to `MAX(id) + 1`. The backfill is idempotent; `programInstanceBackfill.integration.test.ts` extracts it between the markers and runs it twice.
- `ProgramInstance` columns: `id`, `programId`, `name`, `leadMentorId`, `startAt`, `endAt` (`@db.Date`), `phase`, `enrollmentStatus`, `maxParticipants`, `minAge`, `maxAge`, `orgMemberOnly` (the three nullable narrowing overrides, left NULL), `shopifyProductId`, `shopifyVariantId`. Relations: `program`, `leadMentor` (`"InstanceLeadMentor"`), `events`.
- Not copied in P1: `leadMentorNotificationSettings`, and every column added to `Program` since (listed in §2).
- Nothing reads instances. The only writer is the person-merge route (`api/membership-ops/participants/merge/route.ts`), which repoints `ProgramInstance.leadMentorId` alongside `Program.leadMentorId`. Program create, program PATCH, event create and the seed write no instance.

### Finding P33: the copy has drifted

P1 copied rows once and nothing kept them in sync. On today's data:

- every program created since P1 has **no instance**;
- every existing instance is **stale** wherever the program's leader, dates, phase, enrollment status, capacity or Shopify ids have changed since;
- every event created since P1 has `instanceId = NULL` even when it has a `programId`.

None of this is visible yet because nothing reads instances. P2 handles it (§4): before any reader moves, re-run the idempotent backfill, refresh every copied column from its program, and refill `Event.instanceId`; and from P2 on, every writer keeps the instance in step.

### Children of `Program` today

`volunteers` (`ProgramVolunteer`, PK `[programId, personId]`), `participants` (`ProgramParticipant`, PK `[programId, personId]`, roster plus seat-hold state), `events`, `instances`, `budgetOwners` (`BudgetOwner.programId`, nullable, `onDelete: Restrict`).

### Consumers of the program tier that the phases must move

- **Security boundary (`src/security/`):** `access-resolvers.ts` (`buildCallerContext`; `program-lead-mentor` / `program-core-volunteer` cases), `core.ts`, `scopes.ts` (`programsLed`), `scopeBindings.ts` (`their_program_participants` / `their_program_households`), `registry.ts`, `generated/classifications.ts` (regenerated).
- **The `programsLed` claim and its readers:** `lib/auth-options.ts`, `lib/authClaims.ts`, `types/next-auth.d.ts`, `program-ops/layout.tsx`, `lib/libraryNav.ts`, `lib/volunteer.ts`.
- **The `Person.programsLed` relation (Prisma, not the claim):** `lib/person/filters.ts`, `lib/receipt/configure.ts`, `lib/membership/personAgreementTriggers.ts`, `api/household/member/route.ts`, `api/membership-audit/compliance/route.ts`. These move to `Person.instancesLed` with the reads in P3.
- **Capacity:** `lib/program/capacity.ts` locks `SELECT id FROM "Program" … FOR UPDATE`.
- **Store and sale:** `lib/shopify.ts` (product create, claimant product, stock writer, price sync, off-sale, `mintMemberDiscountCode`), `lib/programs/variants.ts`, `lib/programs/memberDiscountCode.ts`, `lib/programs/saleSweep.ts`, `lib/programs/saleState.ts`, `lib/programs/activateEnrollment.ts`, `api/programs/[id]/sync-shopify`, `api/programs/[id]/discount-code`, the `orders/paid` webhook, `lib/finance/reconcile.ts`, `lib/finance/matchAudit.ts`.
- **Routes and pages:** `api/programs/[id]/*`, `api/events/*`, the `program-ops`, `finance-ops`, `facility-ops` pages, `programs/` and `my-activities/programs`.

Grep `programId`, `leadMentorId` and `programsLed` repo-wide before each phase; this list is a starting point, not a gate.

---

## 2. Where each column lives

> You do not enroll in a *definition* — you enroll in an *offering*. Most of `Program`'s operational weight belongs on `ProgramInstance`.

"In P1" says whether the instance column already exists.

| `Program` column today | Home | In P1 | Why |
|---|---|---|---|
| `name` | definition | — | "Woodworking 101". The instance has its own `name` ("Fall 2026"). |
| `orgMemberPriceCents`, `nonOrgMemberPriceCents` | **definition** | — | Board-set price, one per definition (§9.4). Only the Board and sysadmins set it. |
| `minAge`, `maxAge`, `orgMemberOnly` | definition baseline; instance may **narrow** | yes (overrides) | §3a. |
| `leadMentorId` (program leader) | instance | yes | Different runs have different leaders; this re-tiers the security claim (§5). |
| `leadMentorNotificationSettings` | instance | **no** | Follows the leader. |
| `startAt`, `endAt` | instance | yes | Run dates. Age eligibility is measured at the run's start. |
| `phase`, `enrollmentStatus` | instance | yes | A run's lifecycle. |
| `maxParticipants` | instance | yes | Capacity is a room for one run; the capacity lock moves to the instance row. |
| `shopifyProductId`, `shopifyVariantId` (public item) | instance | yes | Each run is sold separately; an order must map to a run. |
| `claimantShopifyProductId`, `claimantShopifyVariantId` (hidden reserved-seat item) | instance | **no** | `checkoutVariantId` prefers it; it is per run because a claim is per run. |
| `shopifyStockCarry`, `shopifyStockUnconfirmed`, `shopifyStockPushNeededAt`, `shopifyStockPendingWrite`, `shopifyStockLeaseUntil`, `shopifyStockLeaseToken` (#2055, #2136) | instance | **no** | Bookkeeping for the public item's stock, which is per run. One writer per run. |
| `shopifySyncStartedAt`, `shopifySyncToken` (#2169) | instance | **no** | The sync creates the run's two products. |
| `offSaleAt` | instance (Board-only write) | **no** | Defaults to the run's start; see Q1. |
| `saleEndedAt`, `productHiddenAt`, `unpaidClaimsNotifiedAt` | instance | **no** | Sale-sweep markers for a run's sale. |
| `publiclyVisible` | **open — Q2** | no | |
| `announceOnOpen`, `announcedAt` | **open — Q3** | no | |
| `shopifyOrgMemberVariantId`, `shopifyNonOrgMemberVariantId` (`@ignore`) | neither | — | Legacy; dropped with the P5 contract. |

| Child of `Program` | Home | Why |
|---|---|---|
| `ProgramParticipant` | instance | You enroll in a run. Seat-hold state rides on the roster row. |
| `ProgramVolunteer` | instance | Volunteers staff a run; `isCore` drives per-run security scope. |
| `Event` | instance | `Event.instanceId` exists (P1); no denormalized `programId` long-term (§3). |
| `BudgetOwner` | **open — Q4** | |

**Instance label.** `ProgramInstance.name` is stored ("Fall 2026"); UIs render "Woodworking 101 — Fall 2026". The backfill seeded it from the parent name.

### 2a. Pricing and the store, as built

What `main` does, and what each piece becomes:

| Piece | Today | After the restructure |
|---|---|---|
| Price | `Program.{org,nonOrg}MemberPriceCents`, Board-only | unchanged, on the definition |
| Public item | one product + `shopifyVariantId` per program, counted stock | one per **instance** |
| Reserved-seat item | hidden, unlisted, untracked `claimantShopify*` per program; every app checkout uses it (`checkoutVariantId`) | one per **instance** |
| Price sync | `syncProgramPrice` writes the full price to both variants; never sends a member price, never sends zero/none | a Board price edit on the definition fans out to **every live instance's** two variants |
| Member price | `mintMemberDiscountCode`: a 48 h, single-use code `PRG{programId}-H{householdId}-XXXX` limited to the checkout variant, checked at the money event by `memberDiscountCode.ts` | the code names the **instance** (Q5) |
| Stock | `changeProgramStock` / `adjustProgramInventory`: one writer per program under `shopifyStockLease*`, carry pays down negatives, unconfirmed changes never resent and settled by the Board (#2136) | same writer, keyed on the instance |
| Sale end | `saleSweep.ts` over programs by `offSaleAt ?? startAt` | sweep over instances |
| Product handle | `programProductHandle({id,name})` → `checkin-program-{id}-…` | built from the instance id. Backfilled instances alias program ids, so existing handles still match. |
| Webhook | paid variant → program via `programVariantIds` | paid variant → instance → program |

Per-instance variants fall out of the existing sync: the sync route already creates both products and records their ids; it moves to the instance. No new Shopify machinery is needed for the restructure. If #929's segment pricing ever ships, its automatic discount would also be per instance; that is #929's design to settle, not this one.

---

## 3. Target schema

### `ProgramInstance` (P1 columns plus the ones P2 adds)

```prisma
model ProgramInstance {
  id                             Int              @id @default(autoincrement())
  programId                      Int
  program                        Program          @relation(fields: [programId], references: [id])
  name                           String
  leadMentorId                   Int?             // program leader; name per Q6
  leadMentor                     Person?          @relation("InstanceLeadMentor", fields: [leadMentorId], references: [id])
  startAt                        DateTime?        @db.Date
  endAt                          DateTime?        @db.Date
  phase                          ProgramPhase     @default(PLANNING)
  enrollmentStatus               EnrollmentStatus @default(CLOSED)
  maxParticipants                Int?
  minAge                         Int?             // narrowing overrides (§3a)
  maxAge                         Int?
  orgMemberOnly                  Boolean?
  shopifyProductId               String?
  shopifyVariantId               String?
  // ── added in P2 ──
  leadMentorNotificationSettings Json?
  claimantShopifyProductId       String?
  claimantShopifyVariantId       String?
  shopifyStockPushNeededAt       DateTime?
  shopifyStockPendingWrite       String?
  shopifyStockCarry              Int       @default(0)
  shopifyStockLeaseUntil         DateTime?
  shopifyStockLeaseToken         String?
  shopifyStockUnconfirmed        Int       @default(0)
  shopifySyncStartedAt           DateTime?
  shopifySyncToken               String?
  offSaleAt                      DateTime? @db.Date
  saleEndedAt                    DateTime?
  productHiddenAt                DateTime?
  unpaidClaimsNotifiedAt         DateTime?
  // plus publiclyVisible / announceOnOpen / announcedAt if Q2/Q3 put them here

  volunteers   ProgramVolunteer[]
  participants ProgramParticipant[]
  events       Event[]
}
```

Each new column copies its `@sensitivity` annotation from the `Program` column it mirrors. `startAt`/`endAt` stay nullable here until the contract, then follow the rule that both dates are required.

### `Program` after P5 (definition only)

`id`, `name`, `orgMemberOnly`, `minAge`, `maxAge`, `orgMemberPriceCents`, `nonOrgMemberPriceCents`, `instances`, plus whatever Q2–Q4 leave on the definition.

### `Event`

`instanceId` (exists), no denormalized `programId` once P5 drops it. The security binding keys `Event` on one field; a second field could drift (event under instance A stamped program B) — a silent scope bug. Reads that need the definition go through `event.instance.program`.

### 3a. Policy narrowing (age band + member-only)

The definition sets the baseline; the instance's nullable override may only make it **stricter**.

```
effectiveMinAge        = max(program.minAge ?? -∞, instance.minAge ?? -∞)
effectiveMaxAge        = min(program.maxAge ?? +∞, instance.maxAge ?? +∞)
effectiveOrgMemberOnly = program.orgMemberOnly || (instance.orgMemberOnly ?? false)
```

- Write-time guard on the instance edit route: reject (400, never clamp) an override that widens.
- One resolver, `effectiveEligibility(program, instance)` in `lib/program/`, and every age/member check goes through it — `programAge.ts`, the enroll route, the leader's add-person picker verdicts, the start-date/age-edit report to the Board. A missed call site type-checks green (the field still exists on `Program`) and silently enforces the un-narrowed band.
- The existing caps still apply to the effective band: no age limit above 25.

---

## 4. Data migration

The app is live; every step runs against real rows and follows `checkin-app/docs/DEPLOY_MIGRATION_ORDER_OF_OPERATIONS.md`: expand first, cut over every reader and writer, contract in a later release, hand-written SQL, `BEGIN;`/`COMMIT;` (CI-linted for new migrations).

**Id-aliasing is kept; the RENAME is not.** P1 made `instance.id = program.id` for every existing program, so a child's `instanceId` equals its `programId`. The earlier draft used that to turn the child FK move into `ALTER TABLE … RENAME COLUMN programId TO instanceId`. Rule 3 forbids that: old tasks in the drain window still read and write `programId`, so a rename of a column old code touches is a contract step, and the code that reads `instanceId` cannot ship before the column exists. The child move is therefore expand → cut over → contract: add `instanceId`, fill it by copying `programId` (a straight copy, thanks to the alias), dual-write, move readers, then drop `programId` and swap the composite PK to `[instanceId, personId]` in P5.

**The re-sync (fixes P33).** One idempotent SQL block, run in P2 and again after dual-write is live:

1. Re-run P1's backfill `INSERT` (programs with no instance get one, id-aliased) and its `setval`.
2. Refresh every copied column on aliased instances from their program (`UPDATE "ProgramInstance" i SET … FROM "Program" p WHERE i.id = p.id`), including the columns P2 adds.
3. Refill `Event.instanceId = programId` where it is null.
4. Fill each child's new `instanceId` from `programId` where it is null.

Every instance today is aliased (nothing else creates one), so step 2 is complete. The re-sync lives only in the two P2 migrations; once P4 creates non-aliased instances nothing may run it again.

**Seed.** `prisma/seed.ts` / `seed-helpers.ts` create no instances today. P2 makes `createProgram` also create the aliased instance (via the same writer the app uses) and `createEvent` set `instanceId`. P4 makes the seed the reference example of one definition with two runs.

**Fixtures.** Mock literals carrying `programId`/`leadMentorId`/`programsLed` compile green and fail at runtime. Grep all three test roots (`src/**/__tests__`, `tests/`, `__tests__/`) with `grep -r` in every phase that renames a key.

---

## 5. Security

All of this is tsc-blind on Prisma where-clauses; integration tests are the net.

### Rules and conventions that shape the cut

- **Boundary isolation** (`.github/workflows/security-boundary-isolation.yml`, AGENTS.md): any change to `src/security/**` (except `generated/` and `__tests__/`), `src/middleware.ts` or the generator ships in its own PR with only tests, docs and schema annotations. A new registered route lands its registry entry first (inert), then the route.
- **This plan's convention (not a repo rule):** migrations go in their own PR, and migration and security PRs merge one at a time. It is the coordinators' working practice; CI does not enforce it.

So the earlier draft's "swap the claim and all its consumers in one PR" cannot be built: `access-resolvers.ts`, `scopes.ts`, `scopeBindings.ts` and `registry.ts` are boundary files; `auth-options.ts`, `layout.tsx` and the rest are not. The swap becomes **add alongside, move consumers, remove the old**:

1. **Boundary PR, additive.** `scopes.ts` gains `instancesLed` and `instancesCoreVolIn`; `buildCallerContext` computes them from `ProgramInstance.leadMentorId` and `ProgramVolunteer.instanceId`; `scopeBindings.ts` gains a `ProgramInstance` entry and `instanceId` bindings next to the `programId` ones; scope names (`their_program_participants`, `their_program_households`) stay. Grants are unchanged because aliased ids and dual-written columns give the same sets — `scopeBindingsEquivalence.test.ts` must show it.
2. **Feature PR.** Mint `instancesLed` in the JWT next to `programsLed` (`auth-options.ts`, `authClaims.ts`, `next-auth.d.ts`); move the non-boundary consumers listed in §1. Tokens minted before the deploy carry no `instancesLed`; consumers fall back to `programsLed` (equal ids while every instance is aliased) until P5.
3. **Boundary PR, P4.** Registry entries for the instance routes; `resolveAccess` program-leader / core-volunteer checks key on the instance id the new routes carry; `returns:` bags gain `ProgramInstance`.
4. **Boundary PR, P5.** Remove `programsLed`/`programsCoreVolIn` and the `programId` bindings; then a feature PR stops minting `programsLed`; then the contract migration.

The roster gate on `GET /api/programs/[id]` reads the viewer's household from the DB, not the session (#2184). Every move of that gate — to the instance, and into the split routes — keeps that.

---

## 6. How P2-3 resolves + the public surfaces

`/program-ops/sessions/*` (which creates `Event` rows) becomes **`/program-ops/instances/*`** — real `ProgramInstance` CRUD — and Events are created under an instance. `pageRegistry` PAGES must follow the rename.

**Public surfaces (§9.1, locked): both list instances.**

- `/programs` lists open-enrollment instances as a schedule ("Woodworking 101 — Fall 2026"), filtered by the same visibility rules as today (members-only hidden unless publicly visible; anonymous callers never told a hidden program exists).
- `/my-activities/programs` lists the instances the person is enrolled in.

Live-site consequences to accept before P4: one card per open run, not per program; a program with no open run drops off the directory; existing `/programs/[id]` links carry program ids, so the detail route must resolve a program id to its current open instance or redirect, never 404.

---

## 7. Phased plan

Each phase is an ordered list of PRs. **[mig]** = migrations group, **[sec]** = security group (boundary-only), **[app]** = feature. Each PR is green and shippable on its own. Only the [sec] split is a repo rule (boundary isolation); keeping [mig] separate and merging [mig]/[sec] one at a time is this plan's convention. "Keeps" lists the `docs/rules/programs.md` rules (and recent fixes) the phase's tests must keep passing — the phase is not done if one of them regresses.

**P1 — Done** (#1361): table, `Event.instanceId`, one-off id-aliased backfill.

**P2 — Make the instance complete and keep it in step (expand + dual-write).**

1. [mig] Add the P2 columns (§3) to `ProgramInstance` and nullable `instanceId` (+ FK, index) to `ProgramParticipant` and `ProgramVolunteer` (and `BudgetOwner` if Q4 says instance). Add the index on `Event.instanceId` that P1 shipped without. Run the re-sync (§4). Additive only.
2. [app] One writer for the pair: program create also creates the aliased instance; every program write (PATCH, sync-shopify, stock writer, sale sweep, publish, person merge) writes the instance's copy in the same transaction; enroll/volunteer writes set `instanceId`; event create sets `instanceId`. Seed uses the same writer. Reads unchanged.
3. [mig] Run the re-sync again, closing the window between 1 and 2. Same SQL.

Keeps: everything — no reader moves. Specifically: price and store variant set only by the Board/sysadmin (dual-write must not open a leader path to the instance's Shopify columns); never enroll beyond capacity; one stock writer per program; the person-merge drift guard (`mergeRepointDriftGuard.test.ts`) covers the new FK columns.

**P3 — Move reads to the instance (programs still 1:1).**

1. [sec] Additive scopes and bindings (§5 step 1).
2. [app] Claim: mint `instancesLed`; move the claim's non-boundary readers (§5 step 2).
3. [app] Roster and enrollment: `effectiveEligibility()` (§3a) and every age/member read through it; capacity lock on the instance row; enroll/withdraw/roster reads by `instanceId`; the roster gate keeps the DB household (#2184).
4. [app] Store and sale: stock writer, carry, lease and unconfirmed-stock settle screen keyed on the instance; sale sweep over instances; webhook and reconciler map variant → instance; `checkoutVariantId` / `programVariantIds` read the instance; price sync fans out over the definition's instances; event pages read via `event.instance`.

During the cutover release old tasks still lock the `Program` row and take the `Program` stock lease. PRs 3 and 4 therefore take **both** locks — `Program` row then instance row, `Program` lease then instance lease — for one release; P4 drops the `Program` side. Without that, a draining task and a new task can both sell the last seat or both push stock.

Keeps: never enroll beyond capacity, including the simultaneous last-seat claim; household-lead enrollment (only the person, their household lead, the Board, a sysadmin; nobody under 18 or of unknown age enrolls themself); a paid place is not withdrawn by the household; one order pays for one household; the store never shows fewer than no places and an unconfirmed change is never resent; a held seat returns exactly once; youth never see payment state; a leader sees paid/unpaid, never how; the roster is visible only to the people running the run and those enrolled in it.

**P4 — Writes and UI on the instance; several runs per program.**

1. [sec] Registry entries for the instance routes; `resolveAccess` on instance ids; `returns:` bags (§5 step 3).
2. [app] Routes split: definition edit (name, baseline age/member-only, **Board-only price**) and instance edit (dates, leader, capacity, phase, enrollment, narrowing overrides, **Board-only store variant and off-sale date**). `/program-ops/instances/*`, events nested under an instance, public `/programs` and `/my-activities/programs` per §6, old program-id links resolve. The widen guard (§3a) is enforced here, plus a DB check if practical.
3. [app] Instance create runs the Shopify sync for that instance (handle from instance id; claim on the instance row); stop dual-writing `Program`'s operational columns; drop the transitional `Program` lock and lease.

Keeps: only the Board and sysadmins set a price or a store variant; the off-sale date is Board-set and defaults to the run's start; new claims stop on that date, the sweep closes enrollment and hides the public item, retrying until confirmed; after it no seat goes back on sale; automatic changes only reduce visibility and the Board reopens a sale by moving the date later; a member price is never sent to the store and a zero/none full price is never sent; nobody sets themself or their household as leader; moving a start date or narrowing ages never removes an enrollment and names the misfits to the Board.

**P5 — Contract.**

1. [sec] Remove `programsLed`/`programsCoreVolIn` and the `programId` bindings (§5 step 4).
2. [app] Stop minting `programsLed`; grep-to-zero the old fields across `src` and all three test roots.
3. [mig] In a later release: drop `Program`'s operational columns (§2, keep prices and whatever Q2–Q4 leave), the two `@ignore` legacy variant columns, child `programId`s and `Event.programId`; set child `instanceId` NOT NULL; swap the composite PKs to `[instanceId, personId]`. Hand-written SQL. No leader-column rename here: renaming `ProgramInstance.leadMentorId` in the release that ships readers of the new name breaks deploy rule 3 (draining old tasks fail on the missing column). That rename belongs to WI 4.5 (Q6).

Keeps: every rule above, on the contracted schema.

---

## 8. Hazard checklist

- [ ] **Where-clause renames are tsc-blind.** `where: {programId}` widens to `*WhereInput` and throws at runtime. Integration tests are the net; run them via the package script with one path regex, never a hand-rolled `--testPathIgnorePatterns`.
- [ ] **Grep all three test roots** (`src/**/__tests__`, `tests/`, `__tests__/`) with `grep -r`, repo-wide; never scope a rename to a subdirectory.
- [ ] **P33 drift.** No reader moves before the P2 re-sync has run twice and dual-write is live.
- [ ] **Re-sync only while all instances are aliased.** It must not run after P4 creates non-aliased instances.
- [ ] **No RENAME of a column old code touches** (deploy rule 3). Expand, cut over, contract in a later release.
- [ ] **Boundary isolation.** No boundary file in a feature PR; registry before route.
- [ ] **Old JWTs** lack `instancesLed` until they refresh; consumers fall back until P5.
- [ ] **Two lock owners during cutover** (P3): row lock and stock lease taken on both tiers for one release.
- [ ] **`pageRegistry.test.ts`** fails on the renamed `/program-ops` routes until PAGES is updated.
- [ ] **Sequence.** Any re-sync insert re-runs the `setval`, or the next new instance collides with an aliased id.
- [ ] **Shopify handles** are built from the instance id; aliased ids keep existing handles; a new instance gets a new handle.

---

## 9. Decisions (product owner — LOCKED)

1. **Public `/programs` lists instances**, not definitions, as a schedule. (§6)
2. **`ProgramInstance.name` is a stored, separate run label**, editable by the run operator. (§3)
3. **Policy narrowing** (§3a): an instance may narrow `minAge`/`maxAge`/`orgMemberOnly`, never widen, enforced at write time.
4. **Pricing stays on `Program` (single per definition).** Per-run pricing is someday-maybe. Post-#929 the escape hatch is a per-instance automatic discount/price override — not a shareable discount code (#929 retires codes as forgeable). No instance price column and no override today. If it ever becomes real, revisit then. (§2, §2a)
   > **Contradicted by today's code (reasoning only).** #929 has not shipped: member pricing *is* a discount code, minted per household checkout and bound to that household (`mintMemberDiscountCode`, `docs/rules/programs.md` › Pricing). The decision itself — price on the definition, no instance price column — still holds.

## 10. Open questions for the owner

- **Q1 — Off-sale date per run.** Placement on the instance follows from it defaulting to the run's start. Confirm the Board (not the program leader) keeps sole authority to set and move it on each run, as today.
- **Q2 — `publiclyVisible`.** Per definition (one switch for every run) or per run? It interacts with narrowing: a run that narrows an open definition to members-only would need its own switch.
- **Q3 — Announce on open.** Today it fires once in a program's life and never again. With several runs: once per definition, or once per run?
- **Q4 — Program budget (`BudgetOwner.programId`).** Does a budget, and its QuickBooks class, belong to the definition or to each run? Policy says every sponsored program has a budget and a leader identified in writing; the leader is moving to the run.
- **Q5 — Member discount code.** Should a minted code name the instance (so a code from one run is never evidence for another) rather than the program? Aliased ids keep live codes valid across the switch.
- **Q6 — Leader rename ordering.** The architectural review's WI 4.5 renames "lead mentor" to "program leader" in code; P3–P5 touch the same claim, resolver and columns. This plan never renames in place, and WI 4.5 must not either: it adds the new column, dual-writes, moves readers, and drops the old column in a later release. Which lands first — WI 4.5, so this plan's remaining steps use the new names, or this plan, with WI 4.5 following on the instance columns? (The coordinator recommends WI 4.5 first.)
