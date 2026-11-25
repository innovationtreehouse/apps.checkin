# A membership application's year, stored when it opens

## Problem

Every joining application and every renewal is for one membership year. The
system does not write that year down when the application opens. It writes a
year only when the family pays, and then it records the year the checkout sold,
which is the year live on the day of payment.

Until payment, anything that needs the application's year works it out again
from the date the application was created: which background check is fresh
enough, whether a closed application can be reopened, whether a renewal is one
the family said it would not take, and when a renewal is due. Each of those
places repeats the same rule, and each answer depends on the exact instant the
row was created and on how the year boundary is computed. When the boundary
math changes, as it is about to (the year will turn at the organisation's
midnight rather than at UTC midnight), the year of an existing application can
change under it without anyone touching the row.

The owner has decided what the year is: **a new member's application is for the
membership year live when they applied, not when they paid. A renewal is for the
year it was opened for.** Today the payment step contradicts that. A family that
applies in June, before the renewal window opens on July 1, and pays in July is
sold the coming year.

## Objective

- Every joining application and renewal carries its membership year from the
  moment it is created, and nothing re-derives that year from a timestamp.
- The year a payment bought stays recorded separately, as it is now, so the two
  can be compared.
- The checkout sells the application's year.
- Rows that already exist get the year the old rule gave them, with the few that
  sit on a year boundary listed for the owner.

## Executive summary

- **Families.** Nothing changes for a family that applies and pays inside one
  membership year. A family that applies before the renewal window opens and
  pays after it is sold the year it applied for, not the coming one, and then
  renews ([§3](#q1)). The store discounts that first payment.
- **The Board.** Reopen, the "won't renew" marker, the check threshold and the
  renewal due date read the year stored on the application. They stop shifting
  when the boundary math changes.
- **Data.** One new column on the application table, `membershipYear`, filled
  at creation for joining applications, renewals and adult children's
  agreements, and left empty on background-check reviews and key-volunteer
  agreements. The existing `appliesToYear` keeps its meaning: the year a
  payment settled.
- **Cost.** Two releases. The first adds the column, fills it, and moves every
  writer and reader. The second, after the first is in production, re-runs the
  fill and adds a database check that the column is set on every joining
  application and renewal.
- **What does not change.** Membership pricing, discount codes, the renewal
  sweep's timing, and every "settled for this year" query. Those already read
  `appliesToYear`, which keeps its meaning.

---

## 1. Schema

Two ways to store the year at creation.

**A. Set `appliesToYear` at creation.** No new column. The payment step would
then overwrite it with the year the payment bought, or leave it alone.

**B. Add `membershipYear`, set at creation.** `appliesToYear` stays "the year a
payment settled", written only by the payment step.

Every reader of `appliesToYear` on the application table, and what option A
would do to it:

| Reader | Filter | Under A |
|---|---|---|
| `lifecycle.ts` `settledThisCycleWhere` (households list, valid-through, outreach audience, the grant action's "already paid" check, "won't renew" refusal) | ACTIVE or paid-awaiting-check, and `appliesToYear` = year | Still correct: every arm is gated on a paid status |
| `lifecycle.ts` `handledThisCycleWhere` (renewal sweep skip) | ACTIVE and `appliesToYear` = year | Still correct |
| `people/search` year list and badge roster | ACTIVE and `appliesToYear` = year | Still correct |
| `membership-audit/compliance` | latest ACTIVE row's `appliesToYear` | Still correct |
| `checkStanding.checkValidForApplication` and its three callers | `appliesToYear` first, else the derived year | Same answer |
| `archive.ts` reopen | `paidAt` set and `appliesToYear` null means "paid with no year recorded" | **Breaks**: a null no longer marks that case |
| `payment.ts` settle | writes the bought year | Overwrites the application's year, so a payment for a different year than the application's leaves no trace |
| schema comment, `lifecycle.ts:218` | "null reads as unsettled" | **Inverted**: a non-null year no longer means paid |

Every current filter happens to pair the year with a paid status, so option A
would mostly still give the right answers. It would do so by accident. The
natural reading of the column, "has a year, so it's settled", becomes wrong, and
the next reader written against it inherits the trap. Option A also loses the
one comparison the payment cases in §3 need: the year the family applied for
against the year it paid for.

**Recommendation: B.**

```prisma
/// The membership year this joining application or renewal is for, as the year
/// its boundary opens in (2026 for 2026-2027). Set when the row is created and
/// never changed. Also set on an adult child's PERSON_AGREEMENT (§2a). Null on
/// PERSON_BG and KEY_VOLUNTEER_AGREEMENT.
/// @sensitivity:public
membershipYear        Int?
```

It is nullable in Prisma because a background-check review and a key-volunteer
agreement have no year. The database
enforces "set on every joining application and renewal" with a check constraint
in the second release (§5). A narrowing helper beside `asHouseholdProcess`
gives household code a `number` rather than `number | null`.

The tier is `public`, matching `appliesToYear`; `classifications.ts` is
regenerated in the same PR. No index: every query that would filter on it is
already narrowed by membership or status.

## 2. Writers

Every `orgMembershipProcess.create` site, and the one raw SQL insert:

| Site | Kind | Year |
|---|---|---|
| `intake.ts` `startIntake` | INITIAL | Live year on the org's calendar day at creation |
| `grant.ts` `openInitial` (the grant action opens a joining application when the household has none) | INITIAL | Live year on the org's calendar day at creation |
| `renewal.ts` `createRenewalProcess`, from the sweep | RENEWAL | The sweep's coming year. The sweep runs only in season, when the live year is the coming year, so this equals the live year |
| `renewal.ts` `createRenewalProcess`, from `grant.ts` `openRenewal` (the grant action opens a renewal) | RENEWAL | The live year, which `openRenewal` already computes to refuse a household that has paid for it. Out of season that is the year in progress, for a lapsed household |
| `personBgTriggers.ts` `openPersonBg` | PERSON_BG | None |
| `checkStarted.ts` | PERSON_BG | None |
| `settleHouseholdBg.ts` `openRequestedReview` | PERSON_BG | None |
| `personAgreementTriggers.ts` `openPersonAgreement` | PERSON_AGREEMENT | Yes, from its trigger: see [§2a](#q6) |
| `keyVolunteerProcess.ts` `createKva` | KEY_VOLUNTEER_AGREEMENT | None |
| migration `20261115130000_key_volunteer_grandfather` | KEY_VOLUNTEER_AGREEMENT | None; already applied |

`createRenewalProcess` takes the year as a parameter, so both callers state it.
The sweep passes the `comingYear` it already holds; `openRenewal` passes its
`liveYear`.

Each household writer resolves the org's calendar day once, before its
transaction, and stamps `liveMembershipYear(boundary, today)` in the same
`create`. The live year follows the org-day boundary math from the separate
change that moves the year to the org's midnight; this design depends on that
change landing first. The audit row's `newData` gains `membershipYear`.

<a id="q5"></a>
**No boundary configured (decided).** Today, when the Board has not set a
boundary, an application opens with no year anywhere and its payment records
none.

**Decision: refuse to open.** A household application never opens without a
year, so `membershipYear` stays required and release 2's database check stays.

- `startIntake` refuses with a 409 before its transaction: "Membership year
  isn't set up yet; contact the Board." The "won't renew" note already refuses
  this way.
- The Board's grant action refuses with the same text before it opens a
  joining application or a renewal.
- The renewal sweep already returns early with no boundary, and is unchanged.
- The refusal reaches the family's page and the Board's grant dialog as a red
  error chip that never closes on its own.

<a id="q6"></a>
## 2a. The adult child's agreement

**Decision: a PERSON_AGREEMENT carries `membershipYear` too.** The owner wants the
agreement per year. Its year is set where it is created, from a stored value or
a Board pick, and is never worked out from a date.

Today the agreement has a cycle but no year. Whether a person already has one is
judged by date: an agreement signed or closed on or after the "cycle floor" (the
current cycle's renewal-window opening, one year back) covers the cycle.

### Where an agreement is created

All three paths go through `openPersonAgreement`. There is no separate annual
re-sign: the nightly pass opens a fresh agreement once the last one is older
than the cycle floor.

| Path | Event | Explicit year available then |
|---|---|---|
| `runPersonAgreementSweep`, from the nightly cron | A person who passes `autoPopulationWhere`: a non-lead aged 18-25 in an ACTIVE household who is attached to a recent program (enrolled participant, volunteer or leader) | The household's latest paid year: the highest `appliesToYear` among its settled applications ([decided](#q9)). Program years are not used |
| `openPersonAgreementForNewMember`, a clearance step after a joining application goes ACTIVE | People in the household that just joined who pass `autoPopulationWhere`, the same filter as the nightly pass. Not every adult child: one who is over 25 or not attached to a recent program gets none | The activating application's `appliesToYear`, the year paid for ([decided](#q10)) |
| `openPersonAgreementForBoard`, the compliance page's manual open | The Board opens one for a person the automatic rule doesn't reach (not in a program, or over 25) | A Board pick. Following the Q4 (ii) ruling, the year is required in the dialog and the route, with no default |

Two more paths touch existing agreements but create none:

- **Reopen** (`archive.ts`) restores an archived agreement to its previous step.
  The row keeps its stored year. Reopen refuses an agreement whose year has
  ended ([below](#q11)).
- **Person merge** moves agreements to the kept person. Each keeps its year.

`openPersonAgreement` takes the year as a required argument and writes it in the
same `create`, and the audit row records it.

### What reads an agreement's year

| Read | Today | After |
|---|---|---|
| `openPersonAgreement`'s "already handled" check | Any open agreement, or one ACTIVE or ARCHIVED with `stageEnteredAt` on or after the cycle floor | Any open agreement (see [Q11](#q11)), or one ACTIVE or ARCHIVED whose `membershipYear` is the year being opened |
| `agreementCycleFloor` | Feeds that check and compliance | Deleted |
| Compliance "over the age ceiling, not yet asked" list | Settled agreements since the cycle floor count as handled | Settled agreements for the household's latest paid year count |
| Compliance "awaiting signature" list | Every open agreement | Unchanged; each row also shows its year |
| Signing (`external.ts`) | Signs the caller's open agreement | Unchanged; the signing page names the year |

### Open questions on the agreement

<a id="q9"></a>
**The nightly pass: which year (decided).** The nightly pass opens one agreement,
for the household's latest paid year: the highest `appliesToYear` among its
settled joining applications and renewals. A program's year does not set it.
The "already handled" check and the compliance list compare against the same
year.

Example: a household is a member for 2025-2026 and pays its 2026-2027 renewal
on July 10, 2026. On July 20 its son turns 18, having never signed. The nightly
pass opens one agreement, for 2026. No 2025 agreement opens.

<a id="q10"></a>
**New-member activation: which field (decided).** A joining application is for
2025, and the Board mapped its payment to 2026 with the warning acknowledged.
The household goes ACTIVE. For each person in it who passes
`autoPopulationWhere`, an agreement opens for 2026, the year paid for
(`appliesToYear`). The application's own year, 2025, is not used.

<a id="q11"></a>
### An unsigned agreement: expiry and year end

**How it works today.** Opening an agreement creates no Zoho Sign request. The
request is created on the person's first click on "Sign", and it expires after
15 days unsigned. The app finds out only when the person comes back: their
return from signing, or their next click, asks Zoho for the request's state. A
declined, expired, recalled or deleted request is then forgotten, and that
click creates a fresh one. The Zoho webhook acts only on completed signings and
ignores every other event. The agreement stays open throughout. The Board sees
it only as a row in the compliance page's "awaiting signature" list, the same as
any other open agreement, and nothing marks it as expired. An agreement nobody
ever clicked has no request, so it never expires in Zoho.

**The owner's direction.** An expired request needs the Board's attention, and
should get it before the agreement's year ends.

**Proposed: expiry surfaces to the Board.**

- The nightly pass checks every open agreement with a stored request older than
  the 15-day expiry. It asks Zoho for each one's state, as the signing page
  does today. A dead request is forgotten as today, and the agreement is marked
  as needing the Board.
- An open agreement with no request, opened more than 15 days ago, is marked
  the same way: the person has not started signing.
- The mark is a new nullable column on the agreement, set by the nightly pass.
  It is cleared when a fresh request is created, the agreement is signed, or the
  Board closes it.
- While the mark is set, the compliance page shows a red error chip that never
  closes on its own, with specific text. For example: "The signing request for
  <name>'s 2026-2027 agreement expired on March 3, 2027. Reset signing or close
  the agreement." Or: "<name> has not started signing their 2026-2027 agreement,
  opened February 1, 2027." Each such agreement also counts toward the
  compliance badge in the nav.
- A failed Zoho lookup is logged and retried the next night. It never sets the
  mark.
- The person can still sign: a click creates a fresh request, as today.

**Proposed guard for the residual case.** The year can still end with the
agreement open. Two parts need no choice:

- Signing a 2025 agreement records a 2025 agreement. It never counts as the
  2026 one, because "already handled" compares years.
- Reopen refuses an archived agreement whose year has ended, the same rule
  household applications follow.

What remains is whether the old open agreement blocks the new year's:

**Q11. An open agreement when its year ends.** A household renews for
2026-2027. Its daughter's 2025 agreement was opened in August 2026. Her request
expired in Zoho, the compliance chip has shown since, and the Board hasn't acted.
On September 1, 2026 the 2025-2026 year ends. Today any open agreement blocks a
new one, so no 2026 agreement opens while the 2025 one stays open.

- **a.** The nightly pass closes the 2025 agreement on the day its year ends,
  recalling any live request and recording the reason. The next pass opens a
  2026 agreement. The chip changes to say that the 2025 agreement was closed
  unsigned.
- **b.** The 2025 agreement stays open, and keeps blocking, until the Board
  closes it. The chip changes to "2025-2026 has ended; close this agreement to
  open the 2026-2027 one". Signing the old one is refused once its year has
  ended.
- **c.** Only an open agreement for the same year blocks. The 2026 agreement
  opens beside the old one, and the Board closes the old one when it chooses.

<a id="q12"></a>
**Q12. Existing agreements.** Rows created before this change have no year,
and no stored value states one. A row signed on August 10, 2025 counts today
for 2025-2026, because it falls after that cycle's floor of July 1, 2025.
Backfilling it means working the year out from a date, which the ruling forbids
at creation.

- **a.** Rejected. No year is stamped from today's date rule, which the owner
  considers wrong.
- **b.** Leave old rows null. The "already handled" check treats a null-year
  settled agreement by the old date rule until one cycle has passed, then
  ignores it. This still leans on the rejected rule for that cycle.
- **c.** Leave old rows null, and the next nightly pass opens a year-stamped
  agreement for everyone it covers, so each of them signs again once.

The database check in release 2 covers PERSON_AGREEMENT only if every row has
a year, which depends on this answer.

## 3. Payment

The checkout sells the variant for the application's `membershipYear`, not the
live year's. `liveYearVariantId` becomes `yearVariantId(year)`: that year's
`MembershipYearVariant` row, else the dev mock variant while the Shopify mock is
active. `ensurePaymentLink` passes the application's year. The renewal sweep's
guard keeps asking for the coming year's variant.

`settle` keeps writing `appliesToYear` from what was bought: the Shopify line's
year, or the Board's year on a manual activation. It never writes
`membershipYear`.

The examples below use a boundary of September 1 and a renewal window that
opens July 1.

<a id="q1"></a>
### Paying after the application's year is no longer live (decided)

A family applies on June 20. The live year is 2025-2026, so the application is
for 2025. They pay on July 10. The 2026-2027 window opened on July 1.

The family buys 2025-2026, which ends on September 1, seven weeks later. The
household is now ACTIVE, has not paid for 2026, and the next renewal sweep opens
a 2026 renewal for it. The family pays twice in about two months.

**Decision: accept it.** The application is for 2025, and the renewal follows.

The first of the two payments is not full price: the store carries a discount
for it. That discount is set up in the Shopify store, not in the app. This
design adds no pricing logic for it.

<a id="q2"></a>
### The stamped year's product is missing or retired (decided)

**Missing.** No `MembershipYearVariant` row exists for the application's year.
Example: an application for 2026 opened on July 2, before the Board has entered
a 2026 variant.

**Retired.** The row exists, but in Shopify the product is archived or the
variant is deleted. Example: the 2025 product is archived in August 2026, and a
2025 application is still unpaid.

**Decision: no silent fallback.** The checkout never sells the live year's
variant in place of the application's.

- The family gets no checkout link. The payment page says: "Payment for
  2025-2026 isn't available right now. Please contact the Board."
- The Board sees a red error chip until the product is fixed. It never closes
  on its own, and its text names the year and the cause, for example: "The
  2025-2026 membership product is archived in Shopify. Families with a
  2025-2026 application can't pay until it is restored." The chip appears on
  the applications page and the membership settings page while any unpaid
  application is for that year.
- Telling "retired" from "missing" needs a Shopify Admin lookup of the variant
  when the link is built. A failed lookup (Shopify unreachable) is a different
  error with its own text. It is never reported as a retired product, and never
  yields a link to another year.
- While the Shopify mock is active, the mock variant stands in and no lookup
  runs.

<a id="q3"></a>
### Paying for a year that has ended (decided)

An application for 2025 is still unpaid on September 15, 2026. The 2025-2026
year ended on September 1.

**Decision: refuse.** No link. The payment page says: "This application is for
2025-2026, which has ended. Please contact the Board." This matches
payment-plan approval, which already refuses an ended year. Missing or retired
products therefore matter only while their year is running.

<a id="q4"></a>
### Payment-plan requests and Board-picked years

**Payment-plan request (decided).** The family applies on June 20 (application
for 2025) and asks for a payment plan on July 5. Today `paymentPlanYear` is the
live year when they ask: 2026.

**Decision: the request's year follows the application.** The request route sets
`paymentPlanYear` from `membershipYear`, here 2025. Approval certifies that year
and refuses it once ended, as today. A request stored before this change keeps
the year it holds.

**Manual payment or certify: the Board names the year (decided).** Today
`certifyPaymentPlan` records the live year when no year is given, and the
certify-payment route sends none.

**Decision: the year is required.** There is no default and nothing is inferred.

- `certifyPaymentPlan` takes `year: number` as a required argument. The
  fallback to the live year is deleted.
- The certify-payment route requires `year` in its body, next to `reason`. A
  body with no year, or a year that isn't a whole number, is refused with a 400:
  "Choose the membership year this payment is for." The route checks the year
  against the same set of years the grant action may map a payment to.
- The applications page's certify dialog gets a required year field with no
  preselected value. Confirm stays disabled until a year is picked.
- When the grant action maps a payment, it already passes the Board's year and
  is unchanged.
- Payment-plan approval passes the request's stored `paymentPlanYear` (see
  [below](#q8)).

**A payment mapped to a different year (decided).** The application is for
2025. On July 10 the Board's grant action maps a payment to 2026.

**Decision: allowed, with an acknowledged warning.** `appliesToYear` becomes
2026. `membershipYear` stays 2025. The two fields differ, and neither is
rewritten to match.

- When the year the Board picks differs from the application's, the grant and
  certify dialogs show a warning before Confirm. For example: "This application
  is for 2025-2026. You are recording a payment for 2026-2027." Confirm stays
  disabled until the Board member ticks "I understand the year doesn't match the
  application".
- The server enforces the same rule. The grant route and the certify-payment
  route take `acknowledgeYearMismatch: true`. A year that differs without it is
  refused with a 409 naming both years, and nothing is written.
- The audit row records both years and the acknowledgement.

After such a payment, each field is read by:

| Field | Value in the example | Read by |
|---|---|---|
| `appliesToYear`, the year bought | 2026 | Every "settled for this year" query: valid-through and member pricing, the households list, the outreach audience, the grant action's "already paid" check, the "won't renew" refusal. The renewal sweep's skip test, so no 2026 renewal opens. The badge roster and the people-search year list. The compliance check threshold. The application's check threshold, which prefers this field. The new-member background-check opener |
| `membershipYear`, the year applied for | 2025 | Reopen's year refusal. The "won't renew" marker on a renewal. The renewal banner's due date. The checkout's variant and its ended-year refusal, both of which apply only while unpaid. A payment-plan request's year. The check threshold before payment |

So the household in the example is a member through September 1, 2027, and is
judged against the 2026 check threshold. Its application still reads as a 2025
application wherever the question is "which year was this opened for".

<a id="q8"></a>
**A payment-plan request with no stored year (decided).** Today approval
certifies the live year for a request whose `paymentPlanYear` is null, which
covers requests made before that column existed. No open request has a null
year today, so there is no such case to carry forward.

**Decision: the year is required, and approval never guesses.**

- Every open request carries `paymentPlanYear`. The request route sets it from
  the application's `membershipYear`.
- The live-year fallback at approval is deleted.
- Approval refuses a request with no year with a 409: "This request has no
  membership year. Deny it; the family can ask again." Nothing is written.
- The release-1 migration checks the assumption rather than trusting it (§5).
- The schema comment on `paymentPlanYear` changes to say it is set on every
  request.

## 4. Readers

The five reads that re-derive a year from a timestamp become reads of the stored
year. None calls the boundary math on a row instant afterwards.

| Read | Today | After |
|---|---|---|
| `checkStanding.ts` `checkValidForApplication` | `appliesToYear`, else the live year at `createdAt` | `appliesToYear`, else `membershipYear`. Takes `{ appliesToYear, membershipYear }`. Its callers `settleHouseholdBg`, `checkStarted` and `openPersonBgForNewMember` select `membershipYear` in place of `createdAt`. `checkStarted`'s fallback, when the household has no open application, passes the live year on the org's day |
| `notRenewing.ts` `isNotRenewingRenewal` | live year at the RENEWAL's `createdAt` | the RENEWAL's `membershipYear`. Callers: the applications route and the renewal-status route |
| `programYear.ts` `reopenYearRefusal` | live year at `createdAt` | the row's `membershipYear`. Callers: `archive.ts` reopen, and the applications page, which needs `membershipYear` in the applications route's rows |
| `archive.ts` reopen year fill | paid row with no `appliesToYear` gets the live year at `paidAt` | Removed. The backfill (§5) fills every such row first |
| `renewal-status` route due date | next boundary on or after `createdAt` | the boundary that opens the renewal's `membershipYear` |

<a id="q7"></a>
**A renewal whose year is already under way (decided).** In October 2026 the
Board's grant action opens a renewal for a lapsed household. The renewal is for
2026, the year in progress. Today the login banner says it is due September 1,
2027.

**Decision: the banner shows the past date.** It reads "was due September 1,
2026": the boundary that opened the renewal's year. The route returns the due
date as it does now, and the banner says "was due" when that date is before the
org's today.

The dev mock line in `reconcile/membership.ts` (the year of the mock variant at
`paidAt`) is dev-only and stays as it is.

Not in this design: the renewal sweep's "closed this cycle" arm still uses the
archive date against the window start, and the per-person agreement still uses
its signing date against a cycle floor. Neither re-derives an application's year.

## 5. Migration and backfill

The deploy runs every migration before the rolling deploy starts, and the
previous release keeps serving through the drain window. So the previous
release's code runs against the new column, and rows it creates in that window
have no year.

### Release 1: expand, fill, cut over

Migration, in one transaction:

1. `ALTER TABLE "OrgMembershipProcess" ADD COLUMN "membershipYear" INTEGER;`
2. Fill `appliesToYear` on paid household rows that have none, with the live
   year at `paidAt`. This is what the archive fill would do on reopen. It is done
   once here so that fill can go.
3. Stop if any open payment-plan request has no year. The migration then fails
   and nothing applies, so the assumption is checked before any code relies on
   it. The error gives a count only, because the request is hardship data.

   ```sql
   DO $$
   DECLARE n integer;
   BEGIN
     SELECT count(*) INTO n FROM "OrgMembershipProcess"
     WHERE "isPaymentPlanRequested" AND status = 'PENDING_PAYMENT' AND "paymentPlanYear" IS NULL;
     IF n > 0 THEN
       RAISE EXCEPTION '% open payment-plan request(s) have no paymentPlanYear', n;
     END IF;
   END $$;
   ```

4. Fill `membershipYear` on household rows:
   - paid rows (`paidAt` set) from `appliesToYear`, which is what the family
     bought;
   - unpaid rows from the live year at `createdAt`, the rule every reader
     applies today.

With no boundary configured, steps 2 and 4 write nothing.

The live year at an instant, in SQL, matching `membershipYearCycle`: the
renewal window of year `y` opens at the boundary's month and day in `y`, moved
back two calendar months with the same day rollover JavaScript uses. The live
year is `y` from that day until the next year's window opens.

```sql
-- ws(y): the day year y's renewal window opens
(make_date(y, bm, 1) - interval '2 months')::date + (bd - 1)
-- live year at day d
CASE WHEN d >= ws(extract(year FROM d)::int + 1) THEN extract(year FROM d)::int + 1
     WHEN d >= ws(extract(year FROM d)::int)     THEN extract(year FROM d)::int
     ELSE extract(year FROM d)::int - 1 END
```

`d` is the org's calendar day of the instant:
`(("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE tz)::date`, with `tz` from
`AppSettings.timezone`. The columns are `timestamp(3)` holding UTC.

The code in this release:

- Every household writer stamps `membershipYear` (§2).
- Every reader in §4 reads `membershipYear`, falling back to today's derivation
  when it is null. Only rows the previous release created during the drain have
  a null.
- The archive fill stays for this release, for the same reason.
- The checkout sells `membershipYear`'s variant (§3). For a row with a null
  year it uses the year today's derivation gives that row, never the live year.

Nothing is destructive. The previous release never selects the new column and
inserts without it. Its reads of `appliesToYear` see what they saw before, plus
the rows step 2 filled, which it would have filled itself on reopen.

### Release 2: contract

Only after release 1 is in production. Until then this PR stays in draft.

Migration, in one transaction:

1. Re-run step 4 of release 1 for rows still null: those the previous release
   created during release 1's drain.
2. `ALTER TABLE "OrgMembershipProcess" ADD CONSTRAINT "household_process_has_year" CHECK (kind NOT IN ('INITIAL', 'RENEWAL') OR "membershipYear" IS NOT NULL);`

This is safe against old code: the code serving during release 2's drain is
release 1, which stamps every household row. The fallbacks and the archive fill
are deleted. The migration fails, and wedges the deploy, if any household row is
still null, which happens only with no boundary configured. The owner runs the
query below before release 2 ships; it must return zero.

```sql
BEGIN READ ONLY;
SELECT count(*) FROM "OrgMembershipProcess"
WHERE kind IN ('INITIAL', 'RENEWAL') AND "membershipYear" IS NULL;
ROLLBACK;
```

Release 2 also updates the integration-test fixtures. About 80 test files
create joining applications or renewals directly. Those that run against a real
database must set `membershipYear` once the constraint exists.

### Rows on a boundary

The old rule judged the year at UTC midnight. The org-day rule judges it at the
organisation's midnight. For a Chicago organisation, an application created on
June 30 at 8 PM local time is 01:00 UTC on July 1: the old rule says 2026, the
org's day says 2025. The same gap exists on the boundary day itself for the
renewal due date.

The backfill uses the org's day, because that is the rule from now on and the
owner's decision is about the day the family applied. The rows where the two
rules disagree are listed by this read-only query, for the owner to run against
production before release 1 ships:

```sql
BEGIN READ ONLY;
WITH cfg AS (
  SELECT extract(month FROM b."orgMembershipYearBoundary")::int AS bm,
         extract(day   FROM b."orgMembershipYearBoundary")::int AS bd,
         a.timezone AS tz
  FROM "BoardSettings" b CROSS JOIN "AppSettings" a
  WHERE b.id = 1 AND a.id = 1 AND b."orgMembershipYearBoundary" IS NOT NULL
),
p AS (
  SELECT o.id, o.kind, o."appliesToYear", o."paidAt" IS NOT NULL AS paid,
         o."createdAt"::date AS utc_day,
         ((o."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE cfg.tz)::date AS org_day,
         cfg.bm, cfg.bd
  FROM "OrgMembershipProcess" o CROSS JOIN cfg
  WHERE o.kind IN ('INITIAL', 'RENEWAL')
),
y AS (
  SELECT p.*, d.which, d.day, extract(year FROM d.day)::int AS cy
  FROM p CROSS JOIN LATERAL (VALUES ('utc', p.utc_day), ('org', p.org_day)) AS d(which, day)
),
live AS (
  SELECT id, which,
    CASE WHEN day >= (make_date(cy + 1, bm, 1) - interval '2 months')::date + (bd - 1) THEN cy + 1
         WHEN day >= (make_date(cy,     bm, 1) - interval '2 months')::date + (bd - 1) THEN cy
         ELSE cy - 1 END AS year
  FROM y
)
SELECT p.id, p.kind, p.paid, p."appliesToYear",
       u.year AS year_utc_rule, o.year AS year_org_day,
       p.utc_day <> p.org_day
         AND p.kind = 'RENEWAL'
         AND (p.utc_day = make_date(extract(year FROM p.utc_day)::int, p.bm, p.bd)
           OR p.org_day = make_date(extract(year FROM p.org_day)::int, p.bm, p.bd)) AS on_boundary_day
FROM p
JOIN live u ON u.id = p.id AND u.which = 'utc'
JOIN live o ON o.id = p.id AND o.which = 'org'
WHERE u.year <> o.year
   OR (p.utc_day <> p.org_day AND p.kind = 'RENEWAL'
       AND (p.utc_day = make_date(extract(year FROM p.utc_day)::int, p.bm, p.bd)
         OR p.org_day = make_date(extract(year FROM p.org_day)::int, p.bm, p.bd)))
ORDER BY p.id;
ROLLBACK;
```

It returns each joining application or renewal whose year differs between the
two rules, and each renewal created in the gap on a boundary day, whose due date
changes. How each kind of row is settled:

- **Paid rows** take `appliesToYear`, so the boundary rule does not touch them.
  The query lists them so the owner can see where the bought year differs from
  the applied-for year.
- **Unpaid rows** take the org's-day year. If the query lists any, the owner
  confirms each, or names a different year, before release 1 ships. The
  migration then sets those rows by id.
- **Renewals on a boundary day** need nothing: the due date comes from the
  stored year (§4), and the year itself is unaffected, because the year turns
  at the window, not at the boundary.

A second read-only query, for context: how many paid applications bought a
different year than the one they were applied for. These are the rows option A
would have hidden.

```sql
BEGIN READ ONLY;
WITH cfg AS (
  SELECT extract(month FROM b."orgMembershipYearBoundary")::int AS bm,
         extract(day   FROM b."orgMembershipYearBoundary")::int AS bd,
         a.timezone AS tz
  FROM "BoardSettings" b CROSS JOIN "AppSettings" a
  WHERE b.id = 1 AND a.id = 1 AND b."orgMembershipYearBoundary" IS NOT NULL
),
p AS (
  SELECT o."appliesToYear", cfg.bm, cfg.bd,
         ((o."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE cfg.tz)::date AS day
  FROM "OrgMembershipProcess" o CROSS JOIN cfg
  WHERE o.kind IN ('INITIAL', 'RENEWAL') AND o."paidAt" IS NOT NULL AND o."appliesToYear" IS NOT NULL
),
live AS (
  SELECT "appliesToYear",
    CASE WHEN day >= (make_date(extract(year FROM day)::int + 1, bm, 1) - interval '2 months')::date + (bd - 1)
           THEN extract(year FROM day)::int + 1
         WHEN day >= (make_date(extract(year FROM day)::int, bm, 1) - interval '2 months')::date + (bd - 1)
           THEN extract(year FROM day)::int
         ELSE extract(year FROM day)::int - 1 END AS applied_for
  FROM p
)
SELECT count(*) FILTER (WHERE "appliesToYear" <> applied_for) AS bought_other_year,
       count(*) AS paid
FROM live;
ROLLBACK;
```

### Checklist

- Additive column and backfill in release 1; the constraint in release 2, after
  release 1 is in production.
- Both migrations wrap in `BEGIN;` and `COMMIT;`.
- No shell script, seed file or audit-log literal inserts household rows; the
  seed opens no applications. The one raw insert, the key-volunteer
  grandfather migration, writes a per-person kind.
- `/// @sensitivity:public` on the new field, `classifications.ts` regenerated.
- If the applications route's registry entry lists the fields it returns, the
  registry change ships first in its own PR.
- `docs/VOCABULARY.md`'s "Membership application" entry gains one line: an
  application's year is set when it opens.

## 6. Release order

| Release | Contents | Gate |
|---|---|---|
| 0 | The org-day boundary change | Separate design |
| 1 | Column, backfill, writers, readers with fallbacks, checkout by stamped year, and the payment answers from §3 | Release 0 merged. The owner has run the boundary query and settled any unpaid rows it lists |
| 2 | Re-fill, check constraint, fallbacks and archive fill removed, test fixtures | Release 1 in production; the null-count query returns zero |

---

## Open questions

| # | Question | Section |
|---|---|---|
| Q11 | Whether an open agreement blocks the next year's once its own year ends | [§2a](#q11) |
| Q12 | Backfilling existing agreements | [§2a](#q12) |
| B1 | Backfill unpaid rows on the org's calendar day, with boundary rows listed for the owner to confirm | [§5](#rows-on-a-boundary) |
| B2 | Paid rows take `membershipYear` from `appliesToYear` | §5 |
| B3 | Paid rows with no `appliesToYear` get it from `paidAt`, so the archive fill can go | §5 |

---

## Appendix: related work

- The org-day boundary change, which moves the year and renewal-window math
  from UTC midnight to the organisation's midnight, and leaves the five reads in
  §4 for this design.
- #3811 and #3831, which moved program sale days and membership "today" to the
  org's configured zone.
