# Design Proposal: 3-Tier Program → Instance → Event Restructure

> **Stale on `Fee`/`FeePayment`.** Those models were dropped with issue #354;
> the M2 step that repoints them has nothing to repoint. The rest of the plan
> stands. Reworking M2 belongs to this design's owner, not to the drop.

**Status:** Proposal (no code changes)
**Supersedes:** Audit item **P2-3** (naming confusion around "session"/"program"/"event")
**Scope:** `checkin-app` (schema + security + UI + data migration)
**Baseline:** written to land **after** [`SHOPIFY_MEMBER_SEGMENT_PRICING.md`](../../checkin-app/docs/designs/SHOPIFY_MEMBER_SEGMENT_PRICING.md) (#929). That proposal ships **first** and collapses each program's two priced variants down to **one variant + a segment-gated automatic member discount**, retires the volunteer discount *code*, and adds a member→Shopify customer-tag sync. This doc assumes that end state. The only place the two interact is the Shopify column set (§2/§3): post-#929 a program carries **one** `shopifyVariantId` + one paired member-discount id, not the `shopify{Org,NonOrg}MemberVariantId` pair. The re-tiering decision (confirmed): **the member discount grain moves down with the variant — one automatic discount per `ProgramInstance`**, amount read from the parent `Program`'s board-set price delta. See §2a for the full 929-interaction note.

---

## 0. The core thesis

P2-3 was filed as a *naming* problem. It is actually a *missing structural layer*.

Today `Program` does two jobs at once:

1. It is a **catalog definition** ("Woodworking 101") — a reusable thing with a name, an age range, a membership policy.
2. It is a **concrete offering** ("Fall 2026 Woodworking") — a thing with dates, a roster, a lead mentor, fees, and a capacity you can fill.

Because those two jobs share one row, the URL layer had to invent a fake middle word: `/program-ops/sessions/*` today creates **`Event`** rows (the "New Event form" literally lives at `sessions/new/page.tsx`). "Session" is a placeholder for a tier that does not exist in the schema. That mislabel **is** P2-3.

The fix is to split the tier apart:

```
Program        definition / template   "Woodworking 101" (catalog entry)
  └─ ProgramInstance   offering / run   "Fall 2026 Woodworking"  ← NEW
       └─ Event        occurrence       "Woodworking, Tue Sep 8, 4pm"  (today's Event row)
```

Locked names (product owner): model **`ProgramInstance`** (never bare `instance`/`instanceId` in the *domain* sense — but the FK column **is** `instanceId`, which is fine as a column name because it sits on a row whose model context disambiguates it), UI copy **"Instance"**, leaf stays **`Event`**. `Session` is off-limits (NextAuth owns `model Session` ~840).

---

## 1. Current structure map

### `model Program` (schema.prisma ~586–629)

| Field | Type | Nature |
|---|---|---|
| `id` | Int PK | — |
| `name` | String | definition |
| `leadMentorId` / `leadMentor` | Int? → Person `"ProgramLeadMentor"` | **offering** |
| `startAt` | DateTime? | **offering** |
| `endAt` | DateTime? | **offering** |
| `phase` | ProgramPhase @default(PLANNING) | **offering** (lifecycle of a run) |
| `enrollmentStatus` | EnrollmentStatus @default(CLOSED) | **offering** |
| `orgMemberOnly` | Boolean | definition (policy) |
| `minAge` / `maxAge` | Int? | definition (policy) |
| `maxParticipants` | Int? | **offering** (capacity) |
| `leadMentorNotificationSettings` | Json? | **offering** (follows lead mentor) |
| `orgMemberPriceCents` / `nonOrgMemberPriceCents` | Int? | definition (**board-set** price; post-#929 the pair still exists — the member number now drives the discount *delta*, not a second variant) |
| `shopifyProductId` | String? | **offering** |
| `shopifyVariantId` | String? | **offering** (single variant, priced at non-member rate — post-#929; replaces the old `shopify{Org,NonOrg}MemberVariantId` pair) |
| `shopifyMemberDiscountId` | String? | **offering** (id of the segment-gated automatic member discount paired to the variant — post-#929; exact field name is whatever #929 lands) |

**Child relations off Program:**

- `volunteers` → `ProgramVolunteer[]` (PK `[programId, personId]`, `isCore` flag)
- `participants` → `ProgramParticipant[]` (PK `[programId, personId]`, roster: `status`, `isPaymentPlanRequested`, `pendingSince`)
- `fees` → `Fee[]` (`programId`, `name`, prices; `Fee` → `FeePayment[]`)
- `events` → `Event[]`

**Person side** (schema ~115–117): `programVolunteers`, `programParticipants`, `programsLed` (`Program[] @relation("ProgramLeadMentor")`).

### `model Event` (schema.prisma ~702–729)

`id`, `programId Int?` (~706, nullable — a program-less event is admin/board-only), `name`, `startAt`, `endAt`, `description`, `attendanceConfirmedAt`, `attendanceConfirmedById`/`By` (`"EventAttendanceConfirmer"`), `postEventEmailSent`, `recurringGroupId String?` (~724). Relations: `program Program?`, `rsvps RSVP[]`, `visits Visit[]`.

`recurringGroupId` is a `crypto.randomUUID()` stamped by `POST /api/events` (`events/route.ts` ~87) across every Event generated from one recurrence form submission. **Attendance lives here and does not move**: `RSVP` (PK `[eventId, personId]`), `Visit`, and `Event.attendanceConfirmedAt/By`.

### Everything FK'd to `Program` (grep `programId` — 74 files)

- **Schema FKs:** `ProgramVolunteer.programId`, `ProgramParticipant.programId`, `Fee.programId`, `Event.programId`.
- **Security config:** `access-resolvers.ts` (`buildCallerContext` queries `program.findMany({where:{leadMentorId}})` + `programVolunteer` + `event.findMany({where:{programId}})`), `scopeBindings.ts` (Program/ProgramParticipant/ProgramVolunteer/Event/RSVP bindings), `scopes.ts` (`'programsLed'` scope-ctx key), `generated/classifications.ts` (`programsLed: {model:'Program'}`), `registry.ts` (`returns:` bags + `program-lead-mentor`/`program-core-volunteer` authorize).
- **Auth claim:** `auth-options.ts` (~253/294 select, ~323 assign), `authClaims.ts`, `next-auth.d.ts`, `program-ops/layout.tsx`.
- **Routes/UI/lib:** all of `api/programs/[id]/*`, `api/events/*`, `api/nav/todo-counts`, `api/facility/trends`, `api/webhooks/shopify`, `api/finance-ops/payment-plans`, `api/cron/*`, `lib/program/capacity.ts` (`SELECT ... FROM "Program" ... FOR UPDATE`), `lib/attendanceTransitions.ts`, `lib/postEventEmails.ts`, plus the `program-ops` + `finance-ops` + `facility-ops` pages.

---

## 2. The child-placement split (the central design question)

> You do not enroll in a *definition* — you enroll in an *offering*. So most of Program's current children belong on `ProgramInstance`.

| Item (today on `Program`) | Placement | Justification |
|---|---|---|
| `ProgramParticipant` (roster) | **→ ProgramInstance** | You enroll in a run, not a template. Two runs of "Woodworking 101" have disjoint rosters. |
| `ProgramVolunteer` | **→ ProgramInstance** | Volunteers staff a specific run; `isCore` core-vol status is per-offering (and drives per-offering security scope). |
| `Fee` / `FeePayment` | **→ ProgramInstance** | Fees are charged per run; a payment is against the offering the person joined. |
| `leadMentorId` / `leadMentor` | **→ ProgramInstance** | Different terms have different leads. This move is what re-tiers the whole security claim (§3). |
| `maxParticipants` (capacity) | **→ ProgramInstance** | Capacity is a property of one run's room/session, not the catalog entry. `capacity.ts`'s `FOR UPDATE` lock re-targets the instance row. |
| `startAt` / `endAt` | **→ ProgramInstance** | Run dates. The definition is dateless. |
| `phase` (`ProgramPhase`) | **→ ProgramInstance** | PLANNING→…→done is a run's lifecycle. |
| `enrollmentStatus` (`EnrollmentStatus`) | **→ ProgramInstance** | A run opens/closes enrollment; the definition never does. |
| `leadMentorNotificationSettings` | **→ ProgramInstance** | Follows the (now per-instance) lead mentor. |
| `orgMemberPriceCents` / `nonOrgMemberPriceCents` | **stays on Program** | **Board-set** enrollment price — an authority decision that governs the definition, not something a lead mentor re-sets per run. Single price per definition; every run inherits it. |
| `shopifyProductId` / `shopifyVariantId` (single, post-#929) | **→ ProgramInstance** | Each run is a separately-sold Shopify product/variant; the `webhooks/shopify` order maps a purchase to a concrete offering. The *price number* stays board-set on the definition, but the sellable an order maps back to must identify the concrete run. Instance owns the variant id; the variant's *price* is synced from the parent Program's board-set cents. |
| `shopifyMemberDiscountId` (post-#929) | **→ ProgramInstance** | The member discount is paired to the variant, so it moves with it: **one automatic discount per instance**, amount = the parent Program's `nonOrgMemberPriceCents − orgMemberPriceCents`. See §2a. |
| `name` | **stays on Program** | The definition name ("Woodworking 101"). *See note ↓ — the instance needs its own label too.* |
| `minAge` / `maxAge` | **Program default, instance may NARROW** | Age band is a definition policy, but a run may restrict it tighter (never looser). Instance gets nullable `minAge`/`maxAge` overrides; effective = the **tighter** bound. See §3a. |
| `orgMemberOnly` | **Program default, instance may NARROW** | If the definition is open (`false`), a run may set it member-only (`true`); a member-only definition can never be loosened by a run. Instance gets nullable `orgMemberOnly` override; effective = `program OR instance`. See §3a. |

**Instance needs a label.** `Program.name` = "Woodworking 101"; the instance needs `ProgramInstance.name` (or `termLabel`) = "Fall 2026" so UIs can render "Woodworking 101 — Fall 2026". Backfill sets it from the parent name initially (see §4).

**Net:** the definition owns `name`, the board-set prices, and the *baseline* policy (`minAge`/`maxAge`/`orgMemberOnly`). The instance may carry *narrowing overrides* of that policy (§3a) but never widen it. Everything else operational moves fully down. A `Program` row is cheap to create (a catalog stub with policy + price) and the run-specific weight lives on the instance.

**Price/Shopify split (DECIDED):** enrollment price lives on the definition (board authority); the Shopify *variant id* + its *member-discount id* (single each, post-#929) live on the instance so orders map to a run and the member discount applies per run. One price per definition applies to every run. Per-run pricing (early-bird) is explicitly *someday-maybe* — and post-#929 the escape hatch is a **per-instance discount/price override**, **not** a shareable discount code (#929 retires codes precisely because a code on a public cart link is forgeable/shareable). So there is still no instance *price* column today. (§9.4)

### 2a. Interaction with #929 (member-segment pricing) — the one coupled surface

#929 lands first and changes the Shopify pricing shape this doc re-tiers. Post-#929 baseline, then the move:

| Aspect | Today (pre-#929) | After #929 (this doc's baseline) | After this doc (re-tiered) |
|---|---|---|---|
| Variants per program | two (`shopify{Org,NonOrg}MemberVariantId`) | **one** `shopifyVariantId`, priced at non-member rate | one `shopifyVariantId` **per instance** |
| Member pricing | second variant, client-side tier pick | segment-gated **automatic discount**, one **per program** | automatic discount **per instance**, amount = parent `Program` delta |
| Discount id stored on | — | `Program` | **`ProgramInstance`** |
| Board price columns | `Program` | `Program` (unchanged) | `Program` (unchanged) |

**Why per-instance discount and not per-program:** post-#929 a program has one variant, so one discount cleanly targets it. Once a program fans out to *N* instances = *N* variants, a single program-level discount would have to enumerate every instance variant (and be edited on every instance create/archive) or target a per-program Shopify *collection* (new machinery). The **per-instance** discount is the same mechanism #929 already designs, just re-grained one tier down — it drops out of the existing "instance-create makes the variant" step (§3) at the cost of one more Shopify object per run. The board-set delta is still a single `Program`-level number; each instance's discount just *reads* it.

**Consequences to wire (all mechanical, none structural):**
- **Instance lifecycle owns the discount.** Instance-create makes variant **+ paired member discount** (amount = parent delta); instance-archive **disables** that discount. Mirrors #929's program-create-makes-variant+discount, moved to instance.
- **Price-sync fans out over instances.** A board price edit on the `Program` definition (definition PATCH route, §6) must sync **every** live instance's variant price **and** every paired discount amount — a loop over instances, not a single write. #929's `shopifyPriceSyncedAt` writer becomes an N-fan-out. Not a hot path (price edits are rare); still, don't assume one variant.
- **Webhook resolves the instance variant.** The single variant on the paid order resolves the concrete instance → parent Program (§3 event→instance→program hop already exists). No two-id set, no tier-confusion class of bug.
- **No security interaction.** Discounts/tags are orthogonal to the `programsLed`→`instancesLed` claim swap (§5). The two blast radii don't overlap.

**Not FUBAR — clean rewrite:** the only schema change vs. a pre-#929 world is *one fewer* variant column on the instance (single, not a pair) plus the discount id. Everything else (prices on `Program`, capacity/roster/lead on instance, security re-tier) is unchanged by #929.

---

## 3. New schema

### `model ProgramInstance` (new)

```prisma
model ProgramInstance {
  id                             Int              @id @default(autoincrement())
  programId                      Int              // FK → Program (the definition)
  program                        Program          @relation(fields: [programId], references: [id])
  name                           String           // run label, e.g. "Fall 2026"
  leadMentorId                   Int?
  leadMentor                     Person?          @relation("InstanceLeadMentor", fields: [leadMentorId], references: [id])
  startAt                        DateTime?
  endAt                          DateTime?
  phase                          ProgramPhase     @default(PLANNING)
  enrollmentStatus               EnrollmentStatus @default(CLOSED)
  maxParticipants                Int?
  leadMentorNotificationSettings Json?
  // Narrowing overrides (§3a). NULL = inherit the definition's value.
  // Non-null must be STRICTLY TIGHTER than the parent — enforced at write time.
  minAge                         Int?
  maxAge                         Int?
  orgMemberOnly                  Boolean?
  // Board-set enrollment price stays on Program; the instance holds only the
  // Shopify sellables (variant price synced from the parent's board-set cents).
  // Post-#929: ONE variant + ONE paired member discount (amount = parent delta),
  // not the old org/non-org variant pair. See §2a.
  shopifyProductId               String?
  shopifyVariantId               String?  // single, priced at non-member rate
  shopifyMemberDiscountId        String?  // segment-gated automatic member discount

  volunteers   ProgramVolunteer[]
  participants ProgramParticipant[]
  fees         Fee[]
  events       Event[]
}
```

- Enums `ProgramPhase` / `EnrollmentStatus` are reused unchanged (they already describe an offering's lifecycle).
- `Person."InstanceLeadMentor"` back-relation replaces `"ProgramLeadMentor"`; `Person.instancesLed ProgramInstance[]` replaces `programsLed`.
- `ProgramParticipant`, `ProgramVolunteer`, `Fee` gain `instanceId` (was `programId`); their composite PKs become `[instanceId, personId]`.

### `Program` after the move (definition only)

```prisma
model Program {
  id                     Int      @id @default(autoincrement())
  name                   String
  orgMemberOnly          Boolean  @default(false)
  minAge                 Int?
  maxAge                 Int?
  orgMemberPriceCents    Int?     // board-set
  nonOrgMemberPriceCents Int?     // board-set
  instances              ProgramInstance[]
}
```

### `Event`'s new FK

```prisma
model Event {
  ...
  instanceId  Int?              // was programId; nullable (program-less events stay admin/board-only)
  instance    ProgramInstance?  @relation(fields: [instanceId], references: [id])
  // reaches the definition via event.instance.program — NO denormalized programId
  ...
}
```

**Decision: do NOT keep a denormalized `Event.programId`.** Reasons:

1. The security bindings key `Event` on a single row field (`Event.their_program_participants: {field:'programId', inCtx:[…]}`). That re-keys cleanly to `{field:'instanceId', inCtx:['instancesLed','instancesCoreVolIn']}` — one field swap, symmetric with today. A denormalized `programId` would need a *second* binding and could **drift** (Event pointing at instance A but stamped programId B) — a silent authz-scope bug, exactly the class this repo keeps getting burned by.
2. The event→program reads that remain (e.g. cron post-event emails needing the program name) go through `event.instance.program` — one extra join, not a hot path.

Trade-off accepted: `buildCallerContext` and any "events in my program" query gains one hop (`Event.instanceId ∈ instancesLed`). Cheap; the set is already materialized per-request.

### 3a. Policy narrowing (age band + member-only)

`minAge`, `maxAge`, `orgMemberOnly` exist on **both** models: the definition sets the baseline, the instance holds nullable overrides. **Invariant: an instance may only make policy STRICTER, never looser.** The effective value a run enforces:

```
effectiveMinAge        = max(program.minAge ?? -∞, instance.minAge ?? -∞)   // higher floor wins
effectiveMaxAge        = min(program.maxAge ?? +∞, instance.maxAge ?? +∞)   // lower ceiling wins
effectiveOrgMemberOnly = program.orgMemberOnly || (instance.orgMemberOnly ?? false)  // OR: once true, stays true
```

- `NULL` override = inherit the definition's value.
- **Write-time guard** (instance PATCH route, mirrored in a DB check where practical): reject an override that would *widen* — `instance.minAge < program.minAge`, `instance.maxAge > program.maxAge`, or `instance.orgMemberOnly === false` while `program.orgMemberOnly === true`. Fail closed with a 400; never silently clamp (a clamp hides operator error).
- **One resolver, not scattered `min`/`max`.** Put `effectiveEligibility(program, instance)` in `lib/program/` and route every eligibility check through it. Today age/member gating reads `program.minAge`/`maxAge`/`orgMemberOnly` directly in `programs/[id]/enroll.ts` and the `programAgeBounds` / `programAgeStartDate` integration tests — enrollment is now per-instance, so those read the **effective** value, not the raw definition field. Grep every `.minAge`/`.maxAge`/`.orgMemberOnly` read and re-point it. (A `[[tsc-misses-prisma-rename-escapes]]`-class hazard: the field still exists on `Program`, so a missed call site type-checks green and silently enforces the un-narrowed band.)

Justification for storing on both (vs deriving): the run operator sets and sees the narrowed band as data (it drives the public listing's displayed age range and the enrollment form), and the invariant needs a concrete value to validate against. Derive-on-read can't be edited.

---

## 4. Migration + seed + mocks (REAL data backfill — the app is live)

> **UPDATE — the pre-launch assumption no longer holds.** Production rows exist. There **is** a 1:1 split to run, a `programId → instanceId` map to build, and existing `Event`/`ProgramParticipant`/`ProgramVolunteer`/`Fee` rows to reparent. The migrations are **not** pure DDL anymore — each schema step that moves an FK carries a data-backfill step, run in the same deploy, against real rows. This is the single biggest change forced by launch; §4a and §7 P1–P2 below are rewritten for it. (Post-#929 note: every live `Program` already carries one `shopifyVariantId` + one `shopifyMemberDiscountId` — those copy to the backfilled instance like any other offering column; nothing #929-specific complicates the backfill.)

**The backfill is 1:1 and that's what keeps it cheap.** Every existing `Program` today *is* a single run — one roster, one set of dates, one lead. So the split is exactly one `ProgramInstance` per `Program`, and we exploit that:

**Backfill with the id-alias trick (DECIDED — Option A).** Insert each backfilled `ProgramInstance` with **`id = Program.id`** (force the PK, don't autoincrement). Because the new instance id then *equals* the old `programId` on every child row, the child FKs need **no value rewrite** — a plain `ALTER TABLE … RENAME COLUMN programId TO instanceId` leaves every value already correct, and the composite-PK index + the capacity `FOR UPDATE` target survive the rename untouched (the very guarantees §8 cares about). The one quirk this buys: legacy instance ids permanently alias program ids, so after the backfill **bump `ProgramInstance_id_seq` to `MAX(Program.id) + 1`** or the next new-instance insert collides with a backfilled row. That sequence bump is mandatory and easy to forget — it's in the hazard list (§8).

*Fallback (Option B), if id-aliasing is unacceptable:* add fresh `instanceId` columns, backfill them via an explicit `programId → instance.id` map `UPDATE`, then drop `programId`. No id constraint, but the composite-PK index must be **dropped and recreated** on the new column (not renamed), and the `FOR UPDATE` raw SQL re-targets a genuinely new column. More index churn, more lock-window risk on large tables. Option A is preferred precisely because the 1:1 shape makes the alias safe.

### 4a. Schema migrations (DDL **+ backfill**)

| Step | Operation |
|---|---|
| **M0** | Create `ProgramInstance` table (additive). Add nullable `Event.instanceId` + FK. |
| **M1** | Add the moved columns (`leadMentorId`, dates, `phase`, `enrollmentStatus`, `maxParticipants`, `leadMentorNotificationSettings`, `shopify*`) + the nullable narrowing overrides (`minAge`/`maxAge`/`orgMemberOnly`) to `ProgramInstance`. |
| **MB** *(new — data)* | **Backfill.** For every `Program`, insert one `ProgramInstance` with `id = Program.id`, copying offering columns + `name` (label seed = parent name, §4-note). Set `Event.instanceId = Event.programId`, and (Option B only) the child `instanceId`s. Then `SELECT setval('"ProgramInstance_id_seq"', (SELECT MAX(id) FROM "Program") + 1)`. Idempotent guard: skip programs that already have an instance (re-runnable deploy). |
| **M2** | Repoint the `Fee`/`ProgramParticipant`/`ProgramVolunteer` FK+PK from `programId` to `instanceId` via **RENAME** (`ALTER TABLE … RENAME COLUMN`) — valid **only because MB aliased the ids** — swapping the FK constraint from `Program` to `ProgramInstance`; preserves the `[programId, personId]` → `[instanceId, personId]` composite-PK index and the capacity `FOR UPDATE` raw-SQL target. Drop `Event.programId` once reads cut over (P5). |
| **M3** | Drop the vacated `Program` columns (P5, its own migration). **Prices stay on `Program`.** |

**MB runs against live rows** — it needs the same care as any prod data migration: wrap in a transaction, run behind the P1/P2 dual-write window (below) so a mid-deploy failure leaves `programId` still authoritative and rolls back clean. Local throwaway DBs can still `prisma migrate reset` + re-seed; **staging and prod run MB for real** — no reset.

### 4b. Seed (`prisma/seed.ts` → `seed-helpers.ts`)

The seed becomes the **reference example** of the 3-tier model — get it right and it documents the shape.

- **`seedBaseline` sample** (`seed-helpers.ts` ~211, "Woodworking 101"): split into a `Program` definition (`name`, `minAge`, `orgMemberOnly`, prices) **+ one `ProgramInstance`** offering (`programId`, run `name` e.g. "Fall 2026", `leadMentorId`, dates, `phase`, `enrollmentStatus`, `maxParticipants`). This is the canonical "one definition, one run" example.
- **`createProgram` macro** (~271): today builds Program + `Fee`(`programId`) + `ProgramParticipant`(`programId`). Now builds Program(def) → ProgramInstance(offering) → `Fee`/`ProgramParticipant` on **`instanceId`**.
- **`createEvent` macro** (~301): `latestProgram` → **`latestInstance`** (`prisma.programInstance.findFirst({orderBy:{id:'desc'}})`); `event.create({ instanceId })` instead of `programId`.
- Check `prisma/seed_20_users.ts` for any program/event construction and re-tier likewise.
- Seed is the fastest smoke test: after the change, `npx tsx prisma/seed.ts` on a throwaway PG must run clean and produce a def+instance+events chain the app renders.

### 4c. Test fixtures / mocks (13 non-integration files — tsc-BLIND)

These build response-shaped mock objects with `{programId, leadMentorId, …}` string keys that feed component/route unit tests. Jest mock literals are loosely typed, so a stale `programId` key **compiles green and fails at runtime** (`[[mock-tests-tsc-blind-renames]]`, `[[test-dirs-two-roots]]`). Hand-update each to the instance shape:

```
src/app/my-activities/programs/__tests__/page.test.tsx
src/app/programs/__tests__/page.test.tsx
src/app/programs/[id]/__tests__/page.test.tsx
src/app/api/programs/__tests__/programsCreateDate.test.ts
src/app/api/events/[id]/rsvp/__tests__/rsvpHouseholdLead.test.ts
src/app/finance-ops/payment-plan/__tests__/page.test.tsx
src/app/program-ops/programs/[id]/__tests__/page.test.tsx
src/app/program-ops/sessions/[id]/__tests__/page.test.tsx   (also renames sessions→instances, P4)
src/app/program-ops/new/__tests__/page.test.tsx
src/security/__tests__/payment-plans-strip.test.ts          (CallerContext: programsLed→instancesLed)
src/security/__tests__/rsvp-program-scope.test.ts           (ctx set + Event.programId→instanceId)
src/lib/__tests__/postEventEmails.test.ts
src/lib/__tests__/postEventEmails.bench.test.ts
```

Grep **all three test roots** (`src/**/__tests__`, `tests/`, `__tests__/`) for `programId`/`leadMentorId`/`programsLed` on the renamed models — the list above is the non-integration set; integration fixtures re-tier alongside their routes per-phase. Do NOT scope the fixture sweep to a subdir (`[[sliced-rename-cross-dir-consumers]]`); grep repo-wide with `grep -r`, not `git grep -- 'dir/*'` (`[[git-grep-pathspec-no-recurse]]`).

---

## 5. Security ripple map

This is the large blast radius. All of it is **tsc-blind on Prisma where-clauses** (recursive `WhereInput` widening) — integration tests `--runInBand` are the real net.

### 5a. The `programsLed` → `instancesLed` claim swap

`leadMentor` moving to Instance re-tiers the entire claim chain:

| File | Today | After |
|---|---|---|
| `auth-options.ts` ~253/294 | `programsLed: { select: { id: true } }` on the Person include | `instancesLed: { select: { id: true } }` |
| `auth-options.ts` ~323 | `session.user.programsLed = token.programsLed` | `…instancesLed = token.instancesLed` |
| `authClaims.ts` | `ClaimSourceParticipant.programsLed`, `token.programsLed = p.programsLed?.map(...)` | `instancesLed` |
| `next-auth.d.ts` ~21/62 | `programsLed?: number[]` (Session + JWT) | `instancesLed?: number[]` |
| `program-ops/layout.tsx` ~34 | `user?.programsLed?.includes(editProgramId)` | row gate keys off the **instance** id the edit URL now carries (see §6 URL note) → `instancesLed.includes(editInstanceId)` |

### 5b. `buildCallerContext` (access-resolvers.ts ~61–103)

| Context field | Today | After |
|---|---|---|
| `programsLed` | `program.findMany({where:{leadMentorId: user.id}})` | `programInstance.findMany({where:{leadMentorId: user.id}})` → **`instancesLed`** |
| `programsCoreVolIn` | `programVolunteer.findMany({where:{personId,isCore}}).programId` | same query, field now `instanceId` → **`instancesCoreVolIn`** |
| `participantIdsInScopePrograms` | `program.participants` | `instance.participants` (rename optional; contents identical) |
| `eventIdsInScopePrograms` | `event.findMany({where:{programId: {in: scopePrograms}}})` | `event.findMany({where:{instanceId: {in: scopeInstances}}})` |
| `householdIdsInScopePrograms` | derived from participant ids | unchanged logic, upstream source re-tiered |

### 5c. `scopeBindings.ts` (CODEOWNERS-gated)

Re-tier the bindings — keep the **scope names** (`their_program_participants`, `their_program_households`) stable to minimize churn; only the `field`/`inCtx` change:

| Binding | Today | After |
|---|---|---|
| `Program` entry | `their_program_participants: {field:'id', inCtx:['programsLed','programsCoreVolIn']}` | becomes a **`ProgramInstance`** entry keyed the same way on `instancesLed`/`instancesCoreVolIn` |
| `ProgramParticipant` | `{field:'programId', inCtx:['programsLed','programsCoreVolIn']}` | `{field:'instanceId', inCtx:['instancesLed','instancesCoreVolIn']}` |
| `ProgramVolunteer` | `{field:'programId', …}` | `{field:'instanceId', …}` |
| `Event` | `{field:'programId', inCtx:[…programs…]}` | `{field:'instanceId', inCtx:[…instances…]}` |
| `RSVP` | `{field:'eventId', inCtx:'eventIdsInScopePrograms'}` | **unchanged field**, ctx set contents re-tiered upstream |
| `FeePayment` | keyed on `personId` ∈ `participantIdsInScopePrograms` | unchanged |

`scopes.ts` union: `'programsLed'` → `'instancesLed'` (+ `'programsCoreVolIn'` → `'instancesCoreVolIn'`). `generated/classifications.ts`: `programsLed: {model:'Program'}` → `instancesLed: {model:'ProgramInstance'}` (regenerated, not hand-edited). The `scopeBindingsEquivalence.test.ts` oracle and every `ctx({programsLed: new Set()})` in `src/security/__tests__/*` must swap key names — these are **tsc-visible** for the ctx type but the *string* scope names in test fixtures are not; grep both.

### 5d. The event→program authorize hop → event→instance→program

| Site | Today | After |
|---|---|---|
| `events/[id]/route.ts` inline gate (~31, ~58, ~77, ~84, ~217) | `event.program.leadMentorId`, `event.program.volunteers`, `programParticipant.findFirst({where:{programId: event.programId}})` | `event.instance.leadMentorId`, `event.instance.volunteers`, `where:{instanceId: event.instanceId}` |
| `programs/[id]/route.ts` roster gate + GAP-1 PATCH | reads/writes `program.leadMentorId`, `participants`, `maxParticipants`, prices, phase, `enrollmentStatus` | most of these move to the **instance** — route splits into a definition route (name + **baseline** age/memberOnly + **board prices**) and an instance route (lead/capacity/dates/phase/enrollment/shopify + **narrowing** age/memberOnly overrides, §3a). See §6. |
| `registry.ts` `returns:` bags | include `'Program'` for the roster/event bags | add `'ProgramInstance'`; keep `'Program'` where definition metadata (name) is still returned |
| `resolveAccess` `program-lead-mentor` / `program-core-volunteer` (~216/221) | `callerContext.programsLed.has(id)` where `id = params.id` (a program id) | keys off the **instance** id the route param now carries → `instancesLed.has(id)` |

**Atomicity requirement:** the claim swap (5a) and its consumers (5b–5d) must land in **one** phase (P3), because a session minting `instancesLed` while `layout.tsx`/`buildCallerContext` still read `programsLed` = every lead mentor locked out mid-deploy. See P3 below.

---

## 6. How P2-3 resolves + the public surfaces

**P2-3 output:** the fake "session" word disappears. `/program-ops/sessions/*` (which today CRUDs `Event` rows via the "New Event form") becomes **`/program-ops/instances/*`** — real `ProgramInstance` CRUD — and Events are created *nested under an instance*. The three tiers finally have three names that match the schema:

- `Program` → "Program" (catalog definition)
- `ProgramInstance` → "Instance" (offering/run)
- `Event` → "Event" (occurrence)

**Public surfaces — DECIDED: both list instances.**

- **`/programs` (public directory, `programs/page.tsx`)** — lists **`ProgramInstance` rows with open `enrollmentStatus`** ("Fall 2026 Woodworking, enrolling now"), not definitions. Rationale: you enroll in offerings; enrollment/dates/capacity all live on the instance, and a definition with no open run is nothing to register for. Display each instance's `name` alongside its parent definition's `name` ("Woodworking 101 — Fall 2026"). A pure definition-catalog view, if ever wanted, is a separate staff/admin surface — not this page. This changes the public IA (the directory is now a *schedule*).
- **`/my-activities/programs` (`my-activities/programs/page.tsx`)** — "programs I'm enrolled in." Enrollment (`ProgramParticipant`) moves to the instance, so this lists **instances** the person is enrolled in (rendered "Woodworking 101 — Fall 2026"). Follows the roster FK down.

**Live-IA consequences (the app is not pre-launch — sign off deliberately).** Because real users hit `/programs` today, the catalog→schedule shift ships *to a live audience*, not into an empty site. Three consequences a reviewer should accept on the record before P4:
- **Different page, more rows.** `/programs` goes from one card per *program* to one card per *open run* — a parent sees "Woodworking 101 — Fall 2026" and "…— Spring 2027" as separate cards, not one "Woodworking 101". New mental model, potentially longer list. Not a bug; a deliberate UX change worth a heads-up in release notes.
- **Empty-state / disappearing programs.** The schedule lists only instances with **open** `enrollmentStatus`. A program whose only run is closed, full, or past shows **nothing** on the public page — it silently drops off the directory the moment its run closes. Pre-launch this was theoretical; live, confirm the org is OK with "no open run ⇒ not listed" (vs. a "coming soon" placeholder).
- **Old links resolve to program ids.** Existing bookmarks, shared links, and any search-indexed `/programs/[id]` URLs point at *program* ids; the enrolment/edit paths now key off *instance* ids (§5d, §6). Confirm the public detail route either still accepts a program id (and picks the current open instance) or 301s — don't let live inbound links 404. No such links existed pre-launch; they do now.

These don't change the decision (both surfaces list instances — LOCKED, §9.1); they're the operational cost of making it on a running site.

---

## 7. Phased plan (each phase independently shippable + tsc-green)

Modeled on the Participant→Person A0–A2 cadence. Nothing breaks mid-flight; the security claim swaps atomically with its consumers.

**P1 — Add the tier + backfill it, don't read it yet.**
Migration M0 (`model ProgramInstance` + nullable `Event.instanceId`), M1 (moved columns), then **MB — the real data backfill** (§4a): one instance per existing program, id-aliased, `Event.instanceId` set, sequence bumped. Update the seed (§4b) so `seedBaseline` also produces a def+instance. No reads change; `Event.programId` + child `programId` still authoritative. Ships green — new table + nullable columns + a backfill that populates them, zero read consumers yet. **This is now a data-migration phase, not a pure-DDL one** — MB runs against prod and must be transaction-wrapped + idempotent.

**P2 — Move the child FKs onto the instance.**
Migration M2: repoint `ProgramParticipant`/`ProgramVolunteer`/`Fee` from `programId` to `instanceId` (RENAME, valid because MB aliased the ids — §4a). Add `ProgramInstance.leadMentorId` + shopify/capacity/date/phase columns (done in M1) are already populated by MB. Wire the `effectiveEligibility()` resolver + the write-time widen guard. Update the seed macros (`createProgram`/`createEvent`, §4b) to build on `instanceId`. Old `programId` (where still present, e.g. `Event`) authoritative for reads; writers **dual-write** program+instance so both stay consistent through P3 — this is also the rollback net for MB (drop the instances, `programId` still points home). Ships green.

> **Re-run MB immediately before the M2 RENAME.** P1 adds no instance-write path, so any `Program` created between the P1 and P2 deploys has no id-aliased instance. Renaming its children's `programId → instanceId` would then point them at a `ProgramInstance` id that does not exist (FK violation / dangling scope). M2 must first re-run the idempotent MB backfill (it only touches programs still lacking an instance) so every program is aliased before the column is renamed.

**P3 — Move reads, swap the security claim atomically.**
Cut every *read* to the instance: `buildCallerContext`, `scopeBindings`, `scopes.ts`, `registry.ts`, the event→instance→program hop, and **`programsLed` → `instancesLed`** across `auth-options`/`authClaims`/`next-auth.d.ts`/`program-ops/layout.tsx` — all in **one** PR. This is the dangerous phase: the JWT claim and its four consumers must flip together or lead mentors lose access mid-deploy. Writes still dual-write (P2). Run the **full** integration suite `--runInBand` — this is the net that catches the tsc-blind where-clause escapes.

**P4 — Flip writes + UI to the instance; enable multi-instance.**
`/program-ops/sessions/*` → `/program-ops/instances/*` (instance CRUD); the "New Event form" nests Events under a chosen instance. `programs/[id]` route splits: definition edit (name + baseline age/memberOnly + **board prices**) vs instance edit (dates/lead/capacity/phase/enrollment/shopify + narrowing age/memberOnly overrides). Public `/programs` + `/my-activities/programs` re-point per §6. Stop writing the legacy `Program` operational columns and drop the P2 dual-write.

**P5 — Drop the vacated Program columns.**
Migration M3: drop `leadMentorId`, `startAt`, `endAt`, `phase`, `enrollmentStatus`, `maxParticipants`, `leadMentorNotificationSettings`, `shopify*` from `Program` (**keep the price columns**), and drop `Event.programId`. Its own migration, RENAME/drop only. Grep-to-zero the old field names across all three test roots + `src` before merging.

---

## 8. Hazard checklist (this repo's scar tissue)

- [ ] **Prisma FK/relation renames are tsc-BLIND on where-clauses.** Variable-held or literal `where: {programId}` widens to `*WhereInput` and type-checks green, then throws at runtime. Grep every call site; integration tests are the only net. (`[[tsc-misses-prisma-rename-escapes]]`, `[[fk-rename-tsc-not-enough]]`)
- [ ] **Grep ALL THREE test roots** for the old field name: `src/**/__tests__`, `tests/`, `__tests__/`. Mocked tests compile green and break at runtime on renamed models. (`[[test-dirs-two-roots]]`, `[[mock-tests-tsc-blind-renames]]`)
- [ ] **FK rename touches security config beyond the schema:** `scopeBindings.ts` + `access-resolvers.ts` are **CODEOWNERS-gated**; `generated/classifications.ts` regenerates; the `scopeBindingsEquivalence.test.ts` + `rsvp-program-scope` + `emergency-contact-program-scope` oracles hardcode `programsLed`/`programId`; frontend response mocks carry the old shape. All tsc-blind on the string fixtures. (`[[fk-rename-touches-security-config]]`)
- [ ] **`pageRegistry.test.ts` fails on unregistered renamed routes.** `/program-ops/sessions/*` → `/program-ops/instances/*` must be updated in `pageRegistry` PAGES (or REGISTRY_EXCLUDED). (`[[page-registry-drift-guard]]`)
- [ ] **Integration tests `--runInBand` are the real net** — never parallel (shared DB corrupts counts / "too many clients"). Run via the package.json script, append ONE path regex to narrow; never hand-roll `--testPathIgnorePatterns` (it replaces the config array → 16-min hang). (`[[integration-tests-serial-only]]`, `[[jest-cli-ignore-overrides-config]]`, `[[no-background-jest]]`)
- [ ] **RENAME migrations, not drop+add** — preserves the capacity `FOR UPDATE` raw-SQL target and the `[programId, personId]` → `[instanceId, personId]` PK partial indexes. **The RENAME is only valid because MB id-aliases (`instance.id = program.id`, §4a);** without that, values would be wrong post-rename. (`[[fk-rename-tsc-not-enough]]`)
- [ ] **The app is LIVE — MB is a real prod data migration.** One instance per existing program, id-aliased, transaction-wrapped, idempotent (skip programs that already have an instance so a re-run deploy is safe). Run behind the P1/P2 dual-write window so a failure rolls back to `programId`-authoritative. Not the pre-launch pure-DDL story the earlier draft assumed.
- [ ] **Bump `ProgramInstance_id_seq` after MB** — id-aliasing sets backfilled ids to program ids; without `setval(..., MAX(Program.id)+1)` the next new-instance insert collides with a backfilled row (duplicate-PK error, or worse a silent FK cross-wire). Easiest step in the whole migration to forget.
- [ ] **Sliced-scope trap:** don't scope a rename chip to skip a subdir — the skipped subdir's consumers of the renamed route/wire-key break silently, tsc-blind. Grep repo-wide + grep-to-zero after merge. (`[[sliced-rename-cross-dir-consumers]]`, `[[git-grep-pathspec-no-recurse]]` — use `grep -r`, not `git grep -- 'dir/*'`)
- [ ] **Claim swap must be atomic with consumers** (P3) — JWT `instancesLed` + `layout.tsx` + `buildCallerContext` + `resolveAccess` flip in one PR, or every lead mentor is locked out mid-deploy.
- [ ] **`shop/certifications` IDOR alerts are usually false** (status is public by design) — don't let the security-test churn in P3 spawn noise there. (`[[cert-status-public-by-design]]`)

---

## 9. Decisions (product owner — LOCKED)

1. **Public `/programs` lists instances**, not definitions — open-enrollment `ProgramInstance` rows shown as a schedule ("Woodworking 101 — Fall 2026"). Public IA becomes a schedule; a definition-catalog view, if ever needed, is a separate staff surface. (§6)
2. **`ProgramInstance.name` is a stored, separate run label** ("Fall 2026") — not derived from `program.name + term`. Editable data; the run operator sets it. (§3)
3. **Policy narrowing** (§3a) confirmed: instance may narrow `minAge`/`maxAge`/`orgMemberOnly`, never widen; enforced by the write-time guard. An open definition correctly permits a member-only run; a member-only definition can't be loosened.
4. **Pricing stays on `Program` (single per definition).** Per-run pricing (early-bird) is a *someday-maybe*, not now. Post-#929 the escape hatch is a per-instance automatic discount/price override — **not** a shareable discount code (#929 retires codes as forgeable). No instance price column and no override today. If it ever becomes real, revisit then. (§2, §2a)
