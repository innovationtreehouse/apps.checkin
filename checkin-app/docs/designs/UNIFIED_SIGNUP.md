# Unified Signup: one link → membership + multi-program enrollment + one checkout

**Status: PROPOSAL — approved by owner, up for peer review. No code built.**
Ground truth cited below (lifecycle, webhook, reconciler, intake profiles) was
verified in-tree as of this doc's PR. Implementation is a 6-PR stack (§8);
feedback on this doc can still reshape any of it.

**Addresses:** the fragmented new-family funnel (sign in → membership at
`/membership` → per-program enrollment at `/programs/[id]`, each priced program
a **separate** Shopify checkout). **Related:** `LIFECYCLE.md` (membership state
machine this extends), `SHOPIFY_MEMBER_SEGMENT_PRICING.md` (the anonymous-cart
constraint all of this lives under), #278/#270 (honor-system cart attributes),
`docs/PROGRAM_CAPACITY_AND_SCHOLARSHIPS.md` (single-pool capacity + minted
discount codes), `src/lib/intake/README.md` (shared intake profiles).

## 1. Problem

A new family that wants "join a program, become members while we're at it"
today needs four disconnected steps and two-or-more checkouts. There is no
single link the org can hand out that collects household info once, applies
for membership, enrolls kid A in program A and kid B in program B, and ends in
**one** Shopify payment.

## 2. Product decisions (locked with the owner)

1. **Auth-first.** The link requires Google sign-in up front (existing
   auto-household-on-first-sign-in, `auth-options.ts`). No anonymous writes —
   consistent with the existing auth-first registration posture.
2. **Pay at the end of the form.** The combined checkout is minted immediately
   after intake submit (process at `PENDING_EXTERNAL_ACTION`) — *before* the
   Zoho contract and background check complete. Money can arrive early;
   **activation still waits on BG clearance** (unchanged two-track convergence).
3. **Multi-program in one cart.** Different kids into different programs in a
   single checkout.
4. **Member program pricing in the combined cart**, via one server-minted
   single-use amount-off-order discount code. The volunteer dues discount does
   **not** stack (a cart permalink carries exactly one `discount=` code) —
   volunteer households pay normal dues through this flow; folding the
   volunteer delta into the minted amount is a possible later enhancement.
5. **One form.** No parallel wizard. The existing `/membership` intake form
   gains an optional per-kid program question; `/join` is a redirect-only
   entry link, not a page with a form.

## 3. Design at a glance

```
/join[?program=N]
  └─ signed out → /signin?callbackUrl=…
  └─ ACTIVE member → /programs/N (existing enroll)   [no program param → /membership]
  └─ everyone else → /membership?program=N
/membership intake (existing, resumable)
  + optional "any of these programs?" per-kid picker
  submit → POST /api/join/checkout
             ├─ startIntake/submitIntake (context "unified-signup")
             ├─ createPendingEnrollment per (program, kid)   [PENDING; free → ACTIVE]
             ├─ mint UNI… amount-off-order code = Σ member discounts
             └─ ONE cart permalink:
                /cart/{memVariant}:1,{progA}:{nA},{progB}:{nB}
                  ?discount=UNI…
                  &attributes[Membership_Process_ID]={pid}
                  &attributes[Program_Enrollments]={progA}:{kid1},{kid2};{progB}:{kid3}
orders/paid webhook (one order, BOTH passes)
  ├─ membership: variant-checked → paidAt stamped EARLY, status held
  └─ programs:  per-program variant-checked → PENDING→ACTIVE
contract + BG consent later → advanceExternalIfComplete
  paid row skips PENDING_PAYMENT → PENDING_BG_CLEARANCE (or ACTIVE if cleared)
```

## 4. Lifecycle extension: early payment

Today `activate()` (`src/lib/membership/payment.ts`) ignores payment for any
status except `PENDING_PAYMENT` (and `BLOCKED` → record + refund alert). The
"paid" notion already propagates elsewhere: `clearBackgroundCheck` flips a paid
`PENDING_BG_REVIEW` row straight to `ACTIVE`. This design completes that:
`paidAt` becomes a parallel-track **flag stamp** (same convention as
`contractSignedAt`/`bgConsentAt`), legal from `PENDING_EXTERNAL_ACTION` onward.

- **`activate()`** new branch for `PENDING_EXTERNAL_ACTION` / `PENDING_BG_REVIEW`:
  H2 variant check first (`hasMembershipItem === false` → `underpaid` audit, **no**
  `paidAt` — unchanged rationale: a truthy `paidAt` means "payment satisfied"
  downstream and must never be stamped without a real membership line item).
  Otherwise stamp `paidAt` + pay meta, **status unchanged, `stageEnteredAt` not
  bumped**, audit `{paid:true, early:true}`, then poke
  `advanceExternalIfComplete()` post-tx (no-ops unless contract+consent already
  done). `INTAKE` and all other statuses stay warn+noop — the checkout link is
  only ever minted **after** `submitIntake`, so `intake-is-unpaid` still holds.
- **`advanceExternalIfComplete()`** (`src/lib/membership/external.ts`) next-status
  becomes three-way; the chosen branch is pinned **in the CAS `updateMany`
  where-clause** (`paidAt` / `bgClearedAt` conditions), not just the pre-read,
  so a webhook racing the Zoho callback cannot flip the wrong way:
  - note-hold (unchanged): → `PENDING_BG_REVIEW` (reviewers must see the note
    first; a paid note-held row later converges via `clearBackgroundCheck`).
  - else paid: → `bgClearedAt ? ACTIVE : PENDING_BG_CLEARANCE` — **a paid row
    never visits `PENDING_PAYMENT`.** The ACTIVE branch mirrors
    `clearBackgroundCheck`'s paid path: `orgMembership.status = ACTIVE` in-tx;
    `sendCongrats` + `openPersonBgForNewMember` (INITIAL) post-tx.
  - else: → `PENDING_PAYMENT` (classic flow, unchanged).
- **`lifecycle.ts`**: two new TRANSITIONS edges
  (`PENDING_EXTERNAL_ACTION → PENDING_BG_CLEARANCE` and `→ ACTIVE`, event
  `advanceExternalIfComplete`); `paidAt` added to the flag-stamp note.
  **INVARIANTS unchanged** (`intake-is-unpaid`, `active-is-bg-cleared` both
  still hold). `LIFECYCLE.md` updated in the same PR.
- **Deliberately NOT widened:** `ensurePaymentLink` and `certifyPaymentPlan`
  stay `PENDING_PAYMENT`-only. Since a paid row never reaches
  `PENDING_PAYMENT`, no widening is needed; the unified flow mints its own
  link (§6). A board certify of an early-paid application is meaningless.
- Applicant-facing: `phases.ts` / `getIntakeState` expose `paidAt` so an
  early-paid application reads "Dues paid ✓ — finish contract & background
  check" instead of a pending payment step.

## 5. Combined cart: attribute scheme, webhook, reconciler

**New attribute** (single, unique-named as Shopify requires), formatted/parsed
by one shared fail-closed module `src/lib/programs/enrollmentAttributes.ts`
used by the checkout builder, webhook, reconciler, and dev mock:

```
Program_Enrollments = <progId>:<personId>,<personId>;<progId>:<personId>
```

`Membership_Process_ID` is unchanged. Legacy `Program_ID` +
`CheckMeIn_Account_ID` remain understood forever (in-flight links, mirrored
history).

- **Webhook** (`src/app/api/webhooks/shopify/route.ts`): drop the membership
  early-return. One order runs the membership pass (unchanged; early-status
  process records `paidAt` per §4) **and** a program pass looping parsed
  programs, each with its own fail-closed variant-id line-item check →
  `activateProgramEnrollment` per program. One program failing its check must
  not stop the others. One combined receipt outcome.
- **Reconciler** (`src/lib/finance/reconcile.ts`, same PR, lockstep):
  `Program_Enrollments` branch above the legacy one; the known-order
  early-return is dropped for attribute-carrying orders (per-program
  `status: PENDING` filters are the idempotency); a membership claim no longer
  suppresses the program pass for combined orders; `resolveMembershipProcess`
  admits unpaid `PENDING_EXTERNAL_ACTION`/`PENDING_BG_REVIEW` as recovery
  candidates; `reconcileReversals` widens to any `paidAt`+`shopifyOrderId` row
  so an early payment refunded pre-activation raises a `PaymentException`.
- **Dev mock** (`/api/dev/shopify/orders-paid`): new combined payload
  `{ processId?, enrollments: [{programId, participantIds}] }` synthesizing one
  order with both attributes and self-firing the real webhook, so the full
  path is exercisable locally.

Threat model unchanged: attributes stay customer-controlled (#278); per-item
**variant-id checks remain the real gate** on both passes. New accepted risk:
a customer who deletes the membership line but keeps program lines pays
member program prices without dues — the membership pass records `underpaid`
(board alerted, no `paidAt`), program seats still activate. Board-visible;
the real fix is #278's checkout token.

## 6. Orchestrator: `POST /api/join/checkout`

Thin `withAuth({})` route + in-handler session/lead checks (defense in depth);
service in `src/lib/join/checkout.ts`. **No security-registry entry in this
stack** — an optional follow-up PR migrates it to `handler()`/`defineRoute`
in isolation (boundary-isolation rule) with a positive delivery assertion.

Body `{ includeMembership, selections: [{programId, personIds}] }`:

1. **Membership leg** (skipped if already ACTIVE or paid in-flight):
   `startIntake` (idempotent) → `submitIntake` with new intake context
   `"unified-signup"` (§7). Validation failure → 400 with field keys.
2. **Enrollment leg**: per (program, kid) → `createPendingEnrollment` — the
   enroll logic extracted from `/api/programs/[id]/participants` into
   `src/lib/program/enroll.ts` (lead authz, CLOSED check, age check, capacity
   lock, PENDING create / free→ACTIVE, audit, notification, P2002 = 409 =
   already-enrolled = success). Partial failures reported per-person.
3. **Pricing**: member pricing iff `includeMembership` or caller already
   covered; `computeUnifiedDiscountCents` (pure) =
   Σ (nonOrgMemberPriceCents − orgMemberPriceCents) × seats over paid
   member-priced selections → `mintUnifiedDiscountCode(id, cents)` in
   `shopify.ts`: `discountCodeBasicCreate`, code `UNI{id}-{8hex}`,
   `usageLimit: 1`, 48h TTL, **amount-off-order** (`appliesOnEachItem: false`),
   mock-mode aware, never throws (null → undiscounted link).
4. **Cart URL** built server-side (`BoardSettings.orgMembershipVariantId` is
   tier-internal and never reaches the client).
5. **Edges**: all-free + no membership → everything already done, returns
   `{done:true}` (no checkout); membership-only and programs-only carts both
   valid (a programs-only cart simply has no `Membership_Process_ID`, so the
   membership pass never runs). Re-POST while unpaid rebuilds the cart from
   the current process + still-PENDING seats and mints a fresh code (old code
   expires unused) — this is the "finish payment" resume path.

## 7. One form: `/membership` + program question; `/join` redirect

- New intake profile in `src/lib/intake/profiles.ts`:
  `"unified-signup"` — shown: address, emergencyContact, primaryName,
  participantDob, notes; required: first four. `participantDob` already gates
  only age-restricted enrollees, so it is vacuous for membership-only submits.
  `submitIntake` grows `opts?: { context?, participants? }` defaulting to
  `"membership-initial"` — existing callers unchanged.
- `/membership` intake gains `ProgramPickerSection` (per-kid picker; listing
  rule: `enrollmentStatus OPEN` ∧ `phase ∈ {UPCOMING, RUNNING}` ∧
  (`shopifyVariantId` set ∨ free) — legacy two-variant programs are excluded
  from the picker, their own page still works; `?program=N` preselects).
  Submit becomes "Submit & continue to payment" → §6. The classic
  `PENDING_PAYMENT` step remains for legacy in-flight rows and note-holds.
- `/join` (`src/app/join/route.ts`) renders **no form**: it resolves the
  session and redirects (§3 diagram). It is the single shareable link.

## 8. Delivery: PR stack (each off main, `tsc --noEmit` + `test:ci` green)

| # | PR | Contents |
|---|----|----------|
| 0 | this doc | peer review gate |
| 1 | lifecycle early payment | payment.ts, external.ts, lifecycle.ts, LIFECYCLE.md + membership unit tests |
| 2 | attribute scheme | enrollmentAttributes.ts, webhook, reconciler, dev mock — lockstep; parser unit + webhook/reconcile integration tests |
| 3 | unified discount mint | shopify.ts + tests |
| 4 | profile + enroll service | profiles.ts, intake.ts, program/enroll.ts, participants-route refactor (behavior-preserving; existing integration suites are the net) |
| 5 | orchestrator | join/checkout service + route + integration tests |
| 6 | UI | ProgramPickerSection, membership page submit/resume/copy, /join redirect |
| 7 | (optional, isolated) | registry migration of /api/join/checkout + positive delivery assertion |

1 and 2 are independent; 3 and 4 independent; 5 needs 1–4; 6 needs 5.
**No schema changes** anywhere in the stack: `OrgMembershipProcess.paidAt` /
`shopifyOrderId` and `ProgramParticipant.shopifyOrderId` already exist; a
unified checkout is reconstructable as "same `shopifyOrderId` across process +
participants". No migration, no `@sensitivity` classification work.

## 9. Verification

- Per PR: `tsc --noEmit` + `test:ci` locally (mocked); integration suites in
  CI only (shared dev DB is never touched locally).
- Local E2E (`CHECKIN_ENV=local`): `/join` → `/membership` with picker →
  checkout → dev-mock combined payload fires the real webhook → process has
  `paidAt`, status held at `PENDING_EXTERNAL_ACTION`, participants ACTIVE →
  mock Zoho sign + BG consent → converges to `PENDING_BG_CLEARANCE`/`ACTIVE`
  **without ever visiting `PENDING_PAYMENT`**.
- Pre-PR-5 spike (5 min, dev store): confirm a multi-line cart permalink
  honors `discount=` + attributes together. Fallback if flaky: scope the
  minted code to the program variants instead of amount-off-order.

## 10. Open questions / accepted risks

1. **Cart tampering** (§5): membership line removed → member pricing kept,
   dues dodged; board-visible (`underpaid` alert). Accepted until #278's token.
2. **Paid-but-stalled**: family pays, never signs the contract → parks at
   `PENDING_EXTERNAL_ACTION` with `paidAt` set. No board queue today —
   follow-up issue: dashboard indicator or cron nudge.
3. **Volunteer households** pay normal dues here (locked, §2.4).
4. Assumes all currently-enrollable programs are single-pool
   (`shopifyVariantId`). Legacy two-variant programs are picker-excluded —
   confirm none are live before PR 6.
