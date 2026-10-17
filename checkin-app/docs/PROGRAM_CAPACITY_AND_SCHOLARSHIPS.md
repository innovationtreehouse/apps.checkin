# Program Capacity & Scholarships

**Status:** Merged — PR #930 (`4cb5d1d2`), with #926 (`a86f3727`, request guarded to
PENDING) and #931 (`34a92fb7`, org-member snapshot at approval) on top.
**Product decisions:** 2026-07-06 (single-pool capacity, hold-ledger scholarship lifecycle).
**Statechart:** the enrollment trunk + scholarship parallel region are formalized as one
declarative machine — see `generated/lifecycle/enrollment.md`. This doc (§1–4) is the Shopify/capacity
mechanics it builds on.

## 1. Shopify is the source of truth for program capacity

A program's enrollment capacity is not tracked as a separate counter in the app — it lives
in Shopify's own inventory for the program's variant. `Program.maxParticipants` sets the
*initial* Shopify inventory at creation time and drives `PATCH /api/programs/[id]`'s
delta propagation, but from then on Shopify's `available` count for the variant is what's
authoritative — every seat-consuming or seat-returning event in the app moves it by a
delta, because Shopify decrements `available` itself as seats sell and the app doesn't
need to know that running total to stay in sync.

Every app-initiated stock change goes through ONE writer, `adjustProgramInventory`
(`lib/shopify.ts`):

- **Owed first, then pushed.** The caller's delta is added to `Program.shopifyStockCarry`
  (what the app owes Shopify), then a push lands the whole carry.
- **One writer per program, no transaction across Shopify.** A push holds a short lease
  (`shopifyStockLeaseUntil`/`Token`, taken with one conditional update). Every booking is
  fenced by the lease token, and no DB transaction or connection is held while Shopify is
  called. A writer that finds the lease busy polls until its cap; the holder re-reads the
  carry before letting go, so it usually lands the waiter's delta too.
- **One keyed delta per write.** It reads `available` and sends the owed carry as one
  delta: GraphQL `inventoryAdjustQuantities` (Admin API 2026-04) with
  `@idempotent(key: program-<id>-<reason>-<uuid>)` and `changeFromQuantity: null`. Deltas
  commute with store sales, so there is no compare. Each write is booked as pending (its
  amount moved out of the carry) before it is sent, and its outcome is booked after, so a
  crash leaves the exact write to be resent under its key. A variant not yet stocked at
  the location is activated first (`inventoryActivate`). An absolute target (re-arm) is
  turned into the carry `target − available` under the lease and lands the same way.
- **Timeouts settle by key.** A timeout, 5xx, throttle or `IDEMPOTENCY_CONCURRENT_REQUEST`
  resends the SAME request with backoff. On the dev store (2026-10-14, shopify-live run
  38673844917) Shopify dedupes `inventoryAdjustQuantities` by key: a resend of a write that
  landed returns its original result instead of applying it again. So a timed-out write
  that landed is booked once, and a hard error, original or replayed, means it did not
  apply. (`inventorySetQuantities` with compare-and-set is not used: its resend is refused
  as stale rather than replayed, which can't tell "landed" from "didn't".) The cap covers
  the lease wait too: about 15 s inside a user request, about 3 minutes for jobs. Webhooks
  (`orders/paid` activation) record the delta and push in the background, staying inside
  Shopify's 5 s webhook timeout.
- **Only a key past its lifetime is unconfirmable.** Shopify keeps a key for 24 h. A write
  still pending after 23 h is not resent, since it could apply twice. Its delta moves to
  `shopifyStockUnconfirmed`, the board is emailed, and a board member checks Shopify and
  settles it on Revenue Ops > Unconfirmed Shopify stock: "Shopify has it" clears it with no
  Shopify call; "Shopify doesn't have it" moves it back into the carry for the next push.
  Each settle is audited and refused if the amount changed since the page loaded.
- **Never below 0.** A negative delta only takes stock down to 0, so an over-capacity
  program is held at 0 and the shortfall stays owed as a negative carry. Later positive deltas pay it
  down before any seat goes back on sale. The board is alerted when the shortfall grows. A
  refund that Shopify restocks itself triggers a background push (reversals webhook), so
  the shortfall takes that seat straight back off sale.
- **Failure is durable and loud, never thrown.** Whatever doesn't land stays owed,
  `shopifyStockPushNeededAt` is set, the board is emailed (`reportShopifyFailure`), and the
  writer returns false. `changeProgramStock` also says whether the delta was
  *recorded*: once it is in the carry it lands later, so a comp's
  `seatTakenWithoutSaleAt` and a scholarship hold stand whenever it was recorded, and
  only an unrecorded -1 rolls a hold back (PENDING_HOLD_FAILED). The daily
  `reconcile-shopify` job (`healProgramStock`) re-pushes every program left owing; the flag
  clears once nothing is owed.

## 2. Single pool, single variant

Each program has **one** Shopify variant, priced at the base (non-member) rate
(`Program.shopifyVariantId`). Inventory on that one variant IS the program's whole
capacity — there is no second, member-priced pool to keep numerically consistent.

Members pay less at the same variant via a **server-minted, single-use discount code**
(`mintMemberDiscountCode`, `lib/shopify.ts`), minted per checkout by
`POST /api/programs/[id]/discount-code` after recomputing the caller's membership status
server-side (never trusting a client flag). A failed mint degrades to an undiscounted link
— checkout is never blocked.

This is an interim mechanism. `docs/designs/SHOPIFY_MEMBER_SEGMENT_PRICING.md` is the
planned upgrade — segment-gated automatic discounts, once checkout identity (that doc's
§5) is solved — at which point per-checkout discount codes go away entirely.

### Legacy two-variant shape (removed)

An earlier design gave each program two variants with separate inventory pools kept in
step by a sibling-adjustment on every seat-consuming event. All of that code is gone
and the four legacy columns are dropped:
`shopifyVariantId` is the only variant any program has, and `adjustProgramInventory`
writes exactly that one pool.

## 3. Scholarship lifecycle — the hold ledger

A scholarship / payment-plan request takes a seat out of Shopify's pool the moment it's
requested, not when it's approved. The invariant: **every application-time `-1` is
returned `+1` exactly once**, by whichever of three release paths fires first, or is
**consumed permanently** by approval. `ProgramParticipant.inventoryHeldAt` is the ledger's
state: non-null means a hold is outstanding.

```
                          ┌──────────────┐
                 apply    │              │  approve
        PENDING ───────►  │  HELD        │ ───────────►  ACTIVE (comped)
     (no hold)   -1       │ (inventoryHeldAt set)        inventoryHeldAt -> null
                          │              │               (hold CONSUMED; +1 on withdrawal)
                          └──────┬───────┘
                                 │ deny (no Shopify op)
                                 ▼
                          ┌──────────────┐
                          │  HELD +      │  re-apply (same seat, no 2nd -1)
                          │  DENIED      │ ─────────────────────────────► back to HELD
                          │ (paymentPlanDeniedAt set)   (deniedAt cleared)
                          └──────┬───────┘
                                 │
              ┌──────────────────┼───────────────────────┐
              │ (a) withdraw     │ (b) pay anyway         │ (c) grace expires
              ▼                 ▼                        ▼
     +1, row removed     +1 (compensates the       +1, auto-withdrawn
                          webhook's real sale),     (reuses path (a))
                          row -> ACTIVE
```

### Application (`POST /api/programs/[id]/request-payment-plan`)

Stamps `inventoryHeldAt = now()` and clears `paymentPlanDeniedAt`, guarded so the `-1`
only fires the moment `inventoryHeldAt` transitions **null → set**. A denied re-applicant
already has `inventoryHeldAt` set (denial never clears it — see below), so re-applying
just flips `isPaymentPlanRequested` back to `true` and clears the denial stamp — it does
**not** decrement a second time for a seat it's already holding. On a genuine transition
(fresh hold or re-request after denial) this now emails the Scholarship Review Team and
sends the applicant household an acknowledgement — see §5.

### Denial (`POST /api/finance-ops/payment-plans/refuse`)

Performs **no Shopify operation**. The seat stays held exactly as the application left it
— `isPaymentPlanRequested` clears and `paymentPlanDeniedAt` stamps, but `inventoryHeldAt`
is untouched. The applicant may still pay normally; a board member did not "give away"
their held seat by saying no to a payment plan. (This supersedes an earlier design where
denial fired a `+1` — that let the seat resell out from under a denied-but-not-withdrawn
applicant, silently drifting DB capacity and Shopify's count apart.) Sends no automatic
email — see §5.

### Approval (`POST /api/finance-ops/payment-plans`)

No Shopify operation either (the seat was already taken out of the pool at application
time) — approval only stops billing the applicant. It additionally clears
`inventoryHeldAt` to `null` **without** a `+1`: the hold is **consumed**, not released. An
approved participant is a comped enrollment (`ACTIVE`, no order). Removing one later puts
the seat back on sale (`+1`) like any comped place — see "Withdrawing a comped place"
below. Sends no automatic email — see §5.

### Release, exactly once — three paths

All three share one implementation, `withdrawAndReleaseHold`
(`lib/program/capacity.ts`): delete the `PENDING` row, and if the deleted row's
`inventoryHeldAt` was set, fire the compensating `+1`. `delete()` is the atomicity
boundary — a given row can be deleted at most once, so double-release across concurrent
callers isn't possible; a second delete attempt hits Prisma P2025 and is treated as an
idempotent no-op by every caller.

**Withdrawing a comped place.** The same function returns the seat (`+1`) when the deleted
row is `ACTIVE` with `seatTakenWithoutSaleAt` set. That stamp records a `-1` actually taken
without a sale: a confirmed admin comp whose decrement succeeded, or approval of a request
whose hold was held (a request whose hold failed is approved without one). A paid place, a
place enrolled while the program was free, and a comp or approval from before the stamp
existed return nothing; the board restocks those by hand if it wants to.

**Failure semantics (best-effort, not transactional).** The DB write and the Shopify
call cannot share a transaction, so "every −1 comes back +1 exactly once" is guaranteed
against *failed calls* but not against *crashes between the two steps*:

- **Failed `-1` at application time**: the hold stamp is rolled back
  (`request-payment-plan` clears `inventoryHeldAt` again), so no phantom hold is
  recorded; re-submitting retries the decrement. Every failure also emails
  sysadmins/board via `reportShopifyFailure`.
- **Failed `+1` at release time**: the row is already deleted; the caller gets a
  `warning` and the same failure email goes out. Reconciliation is manual (**Sync to
  Shopify** / System Status → Link Status).
- **Crash windows** (process dies between the DB commit and the Shopify call): a
  stranded hold or a missed release can survive. These are visible in the DB
  (`inventoryHeldAt` vs. Shopify's count) and are fixed by the same manual sync; a
  periodic reconcile job is deliberately deferred until the drift is observed in
  practice.

- **(a) Withdrawal** — `DELETE /api/programs/[id]/participants` (self, admin, or
  board removal; the same route handles all three) funnels through this, and is
  the *only* path a non-payment kick takes: `cron/pending-participants` never
  removes anyone itself (§5.5).
- **(b) Normal payment** — the `orders/paid` webhook's activation path. A denied
  applicant who pays anyway makes Shopify auto-decrement a *second* unit for the same
  seat (the application's hold already took one out); the webhook releases the hold
  (+1) to compensate, guarded transactionally (`inventoryHeldAt` not-null → null) so a
  webhook retry can't release twice. Never allowed to fail the webhook's 200 — Shopify
  retries the whole order on a non-2xx.
- **(c) Grace-period expiry** — `cron/scholarship-grace-expiry`. See below.

## 4. Grace-period expiry

`BoardSettings.scholarshipDenialGraceDays` (nullable int; **NULL = the feature is off**,
never a guessed default) sets how many days a denied applicant keeps their held seat
before being auto-withdrawn. The cron sweep (`GET /api/cron/scholarship-grace-expiry`,
`Authorization: Bearer $CRON_SECRET`, same auth guard as every other cron route) finds
`PENDING` rows with `isPaymentPlanRequested: false`, `inventoryHeldAt` set,
`paymentPlanDeniedAt` set, and `paymentPlanDeniedAt + scholarshipDenialGraceDays days` in
the past, then auto-withdraws each one (reusing release path (a) — semantically, expiry
*is* auto-withdrawal + seat restore) and audit-logs with a distinct
`reason: "scholarship_grace_expired"` context so it reads differently from a manual
withdrawal in the audit trail. Each row is processed independently (a per-row failure
doesn't block the rest of the sweep), and the sweep never touches non-`PENDING` rows —
an approved (`ACTIVE`) participant's hold was already consumed, not left outstanding, so
it can never match this query regardless of how old `paymentPlanDeniedAt` is.

Configured on the membership settings surface (`/settings/membership` →
`PUT /api/settings/membership`), alongside the other board policy knobs
(`bgRecheckMonths`, dues) — board/sysadmin only, audit-logged, blank input clears it back
to `null`.

## 5. Notifications

**User decision: an applicant receives exactly one automatic email — the request
acknowledgement.** `src/lib/scholarshipEmails.ts` resolves recipients / fans out; callers
build their own subject/html and pass them in. Sends fire *after* the state transition
commits, fire-and-forget (a failed send never fails the request), and only when the
request actually transitioned (no duplicate mail on a no-op re-POST). Recipient
resolution itself lives in `src/lib/emailRecipients.ts` (`resolveHouseholdRecipients`) — a
household-generic helper, not scholarship-specific — with `scholarshipEmails.ts`
re-exporting it as `resolveScholarshipRecipients` for its existing call sites. The
pending-participants cron (rows below) calls `resolveHouseholdRecipients` directly.

The ACK's subject and body (per variant: membership dues / program, the latter
supporting a `{{programName}}` token) are settings-configurable —
`BoardSettings.scholarshipAck{Subject,MembershipBody,ProgramBody}`, set on the same
Settings → Email page as `scholarshipNotifyEmail`, NULL/blank falling back to the
default copy in `scholarshipEmails.ts` (`resolveAckCopy`/`renderAckBody`, plain text,
HTML-escaped). The contract above is unchanged: still the applicant's only automatic
email, just with configurable copy; the Shopify-seat-hold-failure body stays hard-coded.

**1. Who is emailed when:**

| Event | Route | Review Team | Household |
|---|---|---|---|
| Program request (fresh hold or re-request-after-denial) | `POST /api/programs/[id]/request-payment-plan` | ✅ `scholarshipNotifyEmail` → else all board | ✅ ack (leads ∪ participant), ungated |
| Membership request | `POST /api/membership/request-payment-plan` | ✅ | ✅ ack (leads only), ungated |
| Program approve | `POST /api/finance-ops/payment-plans` | — | **no automatic email** |
| Program deny | `POST /api/finance-ops/payment-plans/refuse` | — | **no automatic email** |
| Membership approve (certify) | `POST /api/finance-ops/membership-payment-plans` | — | **no automatic email** |
| Membership deny | `POST /api/finance-ops/membership-payment-plans/refuse` | — | **no automatic email** |
| Manual-hold | `…/payment-plans/manual-hold` | — | **no email** |
| Non-payment warning (day 1 / 3 / 6) | `GET /api/cron/pending-participants` | — | ✅ warning (non-payer household: leads ∪ participant), ungated |
| Leadership digest (board) | `GET /api/cron/pending-participants` | ✅ all board (`emailBoardMembers`) — one digest per run, day-3 + day-7+ tiers | — |

(The cron rows are not scholarship-applicant emails — the sweep excludes requested and
denied rows by design; they are ordinary non-payment notices and do not count against the
one-automatic-email rule.)

**2. Approve/deny are silent by design.** The Scholarship Review Team communicates board
decisions (program approve/deny, membership approve) **manually** — hence no automatic
applicant email. A **denial** starts the `scholarshipDenialGraceDays` clock (§4) with no
automatic notice, so the board's manual denial message should state the deadline itself;
the grace-expiry auto-withdraw (§4) also sends nothing — both silences are deliberate, not gaps.

**3. Fallback rule.** `BoardSettings.scholarshipNotifyEmail` unset (or unparseable) → email
**all board members** (the board *is* the review team until configured). Set on
**Settings → Email** (distinct from `scholarshipDenialGraceDays`, set on Settings → Membership).

**4. Membership deny — parity closed, still silent.** The membership side now has both approve and deny (`POST /api/finance-ops/membership-payment-plans/refuse`). Denial clears `isPaymentPlanRequested` back to `false`; the process stays `PENDING_PAYMENT` and the household returns to normal pay-to-activate (membership holds no seat and has no grace cron, so denial state is the cleared flag plus the audit row). Like every other board decision it sends **no automatic email** — the board communicates the denial manually.

**5. The pending-participants cron never removes anyone — reviewer decision (core customer
service, not a job for a computer).** Day-1/3/6 household warnings send to leads ∪
participant, ungated (previously `[EMAIL DISPATCH]` log stubs while the kick really fired —
now real sends). Day-7+ rows are classified `overdue`, not deleted; removal is a manual
board action via `DELETE /api/programs/[id]/participants` (§3(a)), which routes through
`withdrawAndReleaseHold` for the hold-ledger release. Any accompanying communication is
manual too (§5.2) — no automatic "you've been removed" email. The cron also sends **one
leadership digest per run** (`emailBoardMembers`, subject `Non-payment digest: <a>
approaching deadline, <b> overdue`) whenever there's ≥1 day-3 ("approaching deadline") or
day-7+ ("overdue") row, listing each by person/program/day-count so the board can decide to
remove or reach out. Nothing sends when both lists are empty.

## 6. Related

- `docs/designs/SHOPIFY_MEMBER_SEGMENT_PRICING.md` — the segment-gated pricing design
  that per-checkout discount codes stand in for until checkout identity is solved.
- `docs/DEPLOY_MIGRATION_ORDER_OF_OPERATIONS.md` — the expand/contract migration
  convention this design's legacy-variant transition follows.
