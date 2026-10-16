# QuickBooks: closed books, open period, switch-on

**Status: PROPOSED. The owner has ruled on every question; implementation
follows the PR split below.**

The app stops deriving a "takeover line" from finance's newest hand-booked
entry. Three facts replace it. QuickBooks' own books closing date is a hard
line: the app never books anything dated on or before it. Between that date and
the moment a lane's posting is switched on, the app only matches, and anything
it cannot match goes to finance, who either has the app book it or skips it with
a reason. Records created after switch-on book themselves, matching first, as
today.

The rest of this document says, lane by lane, what changes and in what order it
ships.

---

## Owner ruling (2026-10-16)

1. **Closed books.** The app never books or changes anything dated on or before
   QuickBooks' books closing date. The app reads the date from QuickBooks;
   finance sets it there (first value 2026-06-30). With no closing date set, the
   app books nothing dated before switch-on.
2. **Open period** (after the closing date, before a lane's switch-on). The app
   never creates entries on its own. A matched record is marked booked; an
   ambiguous or unmatched record goes to finance's queue, where finance picks
   "book it" (the app creates the entry) or "already booked / skip" (with a
   reason, audited).
3. **After switch-on.** Each lane records when it was switched on. Records
   created after that book automatically, matching first.

## Rules this changes

- `docs/rules/revenue.md` § Income, "Finance's own bookings come first. The app
  books only payouts newer than the last one finance booked by hand…" becomes:
  the app never books anything dated on or before the books closing date in
  QuickBooks; before income's posting is switched on it only matches, and finance
  decides each payout it cannot match.
- Open PR #2210 (principle *QuickBooks is finance's book*) carries the same
  sentence as a principle, "The app books only what is newer than what finance
  has booked by hand." It needs the same rewrite before it merges.

Relies on, unchanged: *Fail closed* (an unreadable or unset closing date never
widens what the app books), *Apply once* (every path still matches before it
creates), *Accountability* (every skip names who and why), and "the app never
changes or deletes anything already in QuickBooks".

---

## Where the takeover line is used today

| Lane | Derivation | Gate | Outcome when not found and too old |
|---|---|---|---|
| Shared | `packages/quickbooks/src/match.ts:86` `takeoverLine()`; request field `match.ts:26-27`, checked at `:57`, decided at `:75-76` | `write.ts:8` passes it through (`:69`) | `write.ts:76-81` returns `too-old` or `no-line` |
| Expense | `packages/expense/src/lib/expense-qb-poster.ts:64-74` (configured `takeoverDate` or newest hand match, whichever is later); `ExpensePosting.takeoverDate` at `src/contract.ts:210`; `qbMatchInputs` repeats it at `src/services/qbMatchService.ts:38,58` | no date → `no_takeover_date` at `expense-qb-poster.ts:252-255` and `:390-393`; line computed at `:331`, passed at `:338` | `:365-366` parks `BEFORE_LINE`; `:369-370` leaves it waiting |
| Income | `packages/income/src/lib/outbox.ts:54-66` (newest hand match in the audit log) | drain `:249`, post `:162`; finance retry `src/services/reconciliationService.ts:225`; reconcile matches with no line at `src/lib/reconcile.ts:227` | `outbox.ts:207-209` leaves the payout waiting; once the match window passes, reconcile opens it as `NO_DEPOSIT` (`reconcile.ts:270-274`) |
| Donation (Benevity) | `packages/bulk-donation/src/lib/qb-match.ts:30-41,67-73` (newest `QB_MATCHED` event) | `src/lib/qb-poster.ts:286,296` | `:317-318` parks `BEFORE_LINE`; `:319-322` leaves it waiting |

Expense posting is not bound in the host today (`checkin-app/src/lib/expense/configure.ts:177`
passes only the reader), so expense has created nothing and its `BEFORE_LINE`
rows, if any, came from tests or dev. Donation posting binds when
`QBO_DONATION_BANK_ACCOUNT_ID` is set (`checkin-app/src/lib/bulkDonation/configure.ts:29-37`).

---

## Design

### 1. One gate, in the shared package

`findOrCreate` already sees the date it would write (`write.fields.txnDate`) and
runs the match first. The gate moves there, so every lane gets it from one place
and no lane can forget it.

The request loses `takeoverLine` and gains two inputs:

- `closedThrough`: the last closed date, as YYYY-MM-DD. Never null; section 2
  says what the caller passes when QuickBooks has no closing date.
- `mayCreate`: true when the lane may create this record without asking, which
  is when the record was created after switch-on, or when finance pressed "book
  it".

After the match, unchanged, the not-found branch becomes:

| Not found, and | Result | Lane does |
|---|---|---|
| date on or before `closedThrough` | `closed` | to finance's queue with a message that its date is in closed books; only skip is offered |
| `mayCreate` is false | `needs-finance` | to finance's queue; book it or skip |
| otherwise | create, as today | marks it booked |

A match is allowed in the closed period. Linking a record to an existing entry
changes nothing in QuickBooks, so it falls outside the ruling's "never books or
changes". (Owner, 2026-10-16.)

A record created after switch-on but dated in closed books should not happen in
practice; it would take a late receipt for a closed year, say. If someone else's
use of the app produces one, it is treated like any closed record and the lane
tells finance: expense raises its existing finance flag, and income and donation
put a note on the queue entry. (Owner, 2026-10-16.)

`takeoverLine()`, `deriveTakeoverLine()`, `benevityTakeoverLine()`,
`incomeTakeoverLine()`, `expenseTakeoverLine()`, `ExpensePosting.takeoverDate`,
the `no_takeover_date` outcome and the `takeoverDate` field of `qbMatchInputs`
are deleted. The `QB_MATCHED` events and income's match audit rows stay: they
are the audit trail, and nothing reads them for a line any more.

### 2. Reading the closing date

QuickBooks keeps the closing date in the `Preferences` entity, at
`AccountingInfoPrefs.BookCloseDate` (an ISO date, read-only through the API,
absent when no closing date is set). The client's `query()` already runs
`SELECT * FROM Preferences` with the same token and realm guard as every other
read; it is a read, so the create-only writer is untouched. The client pins
minor version 70, well past the version that exposes the field. I have checked
the field name against Intuit's developer blog and third-party API docs, not
against a live company; the first PR confirms it in the sandbox.

A new `QuickBooksClient.bookCloseDate(): Promise<string | null>` returns the
date, or null when none is set. It throws when the read fails.

**Cache:** none across runs. Each drain run reads it once at the start and uses
it for every record in that run; each "book it" reads it again at the moment of
the action. One request per run is cheap, and a cache would let a date finance
just moved later be ignored.

**Failing closed:**

- The read fails → the run books nothing and creates nothing. Matching still
  runs, because it changes nothing in QuickBooks. "Book it" answers 503.
- No closing date set → `closedThrough` is the day before the lane's switch-on,
  so nothing dated before switch-on is ever created. If the lane is not switched
  on either, nothing is created at all, and "book it" is refused with a message
  that names the missing closing date.

The closing date moves forward when finance closes a year. A record still in the
queue that the new date covers can then only be skipped; that falls out of
reading the date at action time and needs no code of its own. The closing state
is not stored on the record for the same reason: it would go stale.

QuickBooks also refuses to post into a closed period (fault 6200). The app's
gate is the line it promises; QuickBooks' refusal is a second one the app does
not rely on.

### 3. Switch-on timestamp

Each lane holds one nullable timestamp, `qbPostingOnAt`. A
record is created after switch-on when its own creation time in the app is later
than the stamp:

| Lane | Stored on | Compared with |
|---|---|---|
| Expense | `ExpenseOrgSettings` (new column) | `Expense.submittedAt` |
| Income | `IncomeOrgSettings` (new column) | `PayoutReconciliation.createdAt`, the time the app first saw the payout |
| Donation, Benevity | new `DonationOrgSettings` row (the package has no settings model) | `DisbursementEvent.createdAt` |
| Donation, in-kind (#2182) | same row, its own column | the in-kind record's creation time |

The migration is additive: nullable columns and one new table. Old code never
reads them. Null means not switched on, so the lane creates nothing on its own.

**The lane switches itself on.** The stamp is written the first time the lane's
posting job runs with QuickBooks connected, which is as soon as the lane is
deployed and its QuickBooks settings are filled in. There is no switch-on route,
screen or person: the deploy and the configuration change are the record. The
job sets the stamp only while it is null, in one statement, so two overlapping
runs cannot move it. (Owner, 2026-10-16.)

Switching on is permanent: the stamp is set once and there is no "off".
(Owner, 2026-10-16.)

**Income must book payouts that arrive weeks late.** Shopify's mirror can hand
the app a payout weeks after its date, and the owner requires those to reach
QuickBooks. Two changes make that work:

- A payout the app first sees after switch-on is "created after switch-on",
  whatever its date, so it books automatically down to the closed line.
  Comparing the payout's own date instead would send every late payout to
  finance, which is the work this design removes.
- Today reconcile opens a payout first seen after its match window as
  `NO_DEPOSIT` at once (`reconcile.ts:257-261`), and the drain skips any payout
  past its window (`outbox.ts:258`). For a payout first seen after switch-on,
  both checks go: it waits in the outbox and the drain creates it. The deposit
  search still uses the window around the payout's date (`matchWindow`), so a
  deposit finance booked by hand is still found first.

For the same reason, income's first connected run reconciles before it writes
the stamp, so every payout the mirror already holds has a row dated before the
stamp and stays in the open period. Without that order, the first run would
treat the mirror's whole history as new and book it unasked. The drain already
runs reconcile first (`outbox.ts`, `drainIncomeOutbox`); the stamp goes between
the two.

Benevity needs nothing extra: a file uploaded after switch-on is new records,
whatever the gift dates in it.

### 4. Finance's queue: book it, skip

"Already booked" means finance matches it to the existing entry, which every
lane already offers. The new actions are "book it" and "skip".

| Lane | Today | Adds | Route |
|---|---|---|---|
| Expense | `POST /api/expense/expenses/[id]/qb-match` (match only) | book, skip | new `POST /api/expense/expenses/[id]/qb-resolve`, finance, returns `Expense` |
| Income | `POST /api/income/reconciliation/[id]/resolve` with match, dismiss, retry | book | same route, new action |
| Donation | `POST /api/donations/disbursement-events/[disbursementId]/qb-resolve`, registered; #2215 implements match, dismiss, retry | book | same route, new action |

Only expense needs a new registry entry. The other two add an action to a
finance-only route whose role and response types stay the same.

- **Book it** runs the lane's own post path with `mayCreate: true`, outside the
  per-run caps, as finance's retry already does. It still matches first and
  still stops at the closed line. Allowed only from the lane's "finance decides"
  state.
- **Skip** needs a non-empty reason and writes the lane's audit log with the
  person and the reason. The record leaves the queue for good, and the drain
  never posts or matches it again. Income's and donation's `dismiss` already do
  exactly this, so skip is `dismiss` under its existing name; expense gains it.

The states each lane uses for "finance decides" are:

- **Expense:** a new `UNBOOKED` replaces `BEFORE_LINE`, plus `SKIPPED` for a
  skip. `MATCHABLE_STATES` (`qbMatchService.ts:93`) swaps `BEFORE_LINE` for
  `UNBOOKED`.
- **Income:** no new kind. A payout the drain may not create is opened as
  `NO_DEPOSIT` at once, rather than waiting out the match window, since waiting
  cannot change the answer. "Book it" is offered on `NO_DEPOSIT`.
- **Donation:** `UNBOOKED` replaces `BEFORE_LINE` in `QB_HELD_STATES`, and the
  `DISMISSED` state from #2215 serves as skipped.

**Income's NEEDS_MAPPING hold (#2236) wins over all of this.** A payout held
because an item has no Class decision never turns into `NO_DEPOSIT` and is never
opened by the open-period rule while it waits; "book it" on it is refused until
finance maps the item. The order inside a run is: match, then the mapping check,
then the closed and open-period checks.

### 5. Rows already parked BEFORE_LINE

Expense and donation rows in `BEFORE_LINE` are rewritten to `UNBOOKED` by a
data migration in the same PR as the code that understands `UNBOOKED`. That is
safe against old code during the deploy: old code never posts either state, so
the only effect is that finance's manual match on such a row is refused for the
minutes the old code still serves. No row is re-armed to `UNMATCHED`, because an
old drain could then create it against the old line.

Income has no `BEFORE_LINE`. Its waiting payouts are sorted by the next run
under the new rules; `NO_DEPOSIT` rows already open keep their state and gain
"book it".

---

## PR split

One kind per PR. Registry entries first, each in its own PR based on `main`.

1. **Security:** the registry entry for `POST /api/expense/expenses/[id]/qb-resolve`.
   No app code.
2. **Shared gate:** `packages/quickbooks` replaces `takeoverLine` with
   `closedThrough` and `mayCreate`, and adds `bookCloseDate()`. It confirms the
   field in the sandbox. Until each lane PR lands, its caller passes its old line
   as `closedThrough` with `mayCreate: true`, which behaves exactly as today
   (`closed` is today's `too-old`, and no line still creates nothing).
3. **Expense:** gate wiring, `UNBOOKED` and `SKIPPED`, the `qb-resolve` route
   and its screen, the self-set stamp, and its migration (the switch-on
   column and the `BEFORE_LINE` rewrite).
4. **Income:** gate wiring, immediate `NO_DEPOSIT`, the "book" action, the
   late-payout path (reconcile before the stamp, no window cut-off after it),
   the self-set stamp, the NEEDS_MAPPING ordering, and its switch-on column.
5. **Donation:** gate wiring, `UNBOOKED`, the "book" action, switch-on for
   Benevity and in-kind, and its migration (`DonationOrgSettings` and the
   `BEFORE_LINE` rewrite). Lands after #2215.
6. **Rules:** `revenue.md` and, if it has merged, the `principles.md` line from
   #2210.

Each lane keeps its own Prisma schema and migrations, so each lane's migration
ships with that lane's code.

PRs 3, 4 and 5 touch different packages and can run in parallel once 1 and 2
have landed.

## What this supersedes

- **#2236** (income design for #2180): its takeover-date question is already
  withdrawn in favour of this design. Only the NEEDS_MAPPING constraint carries
  over, in section 4.
- **#2215** (donation queue): its `BEFORE_LINE` handling (held, never retryable)
  becomes `UNBOOKED` with "book it"; its match, dismiss and retry stay. Its PR
  body's "moves the takeover line" stops being true.
- **The expense takeover date:** `ExpensePosting.takeoverDate` and the
  `no_takeover_date` gate.
- **#2210**'s "finance's own bookings come first" bullet.
- The takeover-line passages of `1272_EXPENSE_QB_INTEGRATION.md`
  (around lines 1139-1148), `1280_BULK_DONATION_INTEGRATION.md` (424-442) and
  `1283_INCOME_INTEGRATION.md` (160-170), which the lane PRs update.

---

## Open questions for the owner

- **Q1.** Resolved: automatic. A lane switches on the first time its posting
  job runs with QuickBooks connected (owner, 2026-10-16). Section 3.
- **Q2.** Resolved: matching in the closed period is allowed (owner,
  2026-10-16). Section 1.
- **Q3.** Resolved: switch-on is permanent, with no "off" (owner, 2026-10-16).
  Section 3.
- **Q4.** Resolved: payouts Shopify delivers weeks late must reach QuickBooks
  (owner, 2026-10-16). They count from when the app first sees them; section 3.
- **Q5.** Resolved: does not happen in practice; if it does, the lane tells
  finance (owner, 2026-10-16). Section 1.
