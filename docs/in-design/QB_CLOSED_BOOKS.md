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

- `docs/rules/revenue.md` § Income (line 198), "Finance's own bookings come first. The app
  books only payouts newer than the last one finance booked by hand…" becomes:
  the app never books anything dated on or before the books closing date in
  QuickBooks; before income's posting is switched on it only matches, and finance
  decides each payout it cannot match.
- Open PR #2210 (principle *QuickBooks is finance's book*) carries the same
  sentence as a principle, "The app books only what is newer than what finance
  has booked by hand." It needs the same rewrite before it merges.

Relies on: *Fail closed* (an unreadable or unset closing date never widens what
the app books), *Apply once* (every path still matches before it creates),
*Accountability* (every skip names who and why), and "the app never changes or
deletes anything already in QuickBooks".

Adds to *Apply once*: a record whose create may already have landed in
QuickBooks looks for its own entry before anything creates, matches, skips or
dismisses it (section 6).

---

## Where main stands

No lane derives a takeover line any more. Expense, income and in-kind each work
out the books closing date and the lane's switch-on time, and pass
`closedThrough` and `mayCreate` to the shared gate
(`packages/quickbooks/src/write.ts`: `findOrCreate`, or
`findOrCreateInKindJournal` for in-kind), which runs the match first and then
applies the gate in section 1. `BEFORE_LINE` survives only as a stored state
on older expense and donation records, held exactly like `UNBOOKED`.

Posting is bound in the host for every lane that books: expense through the books
map's Organisation card account, income through the books map, and in-kind through
the books map's gift-of-goods accounts. Donation books no deposit itself. Where
`QBO_REALM_ID` is set it hands each completed disbursement to income, which books
it to the `BENEVITY_BANK` role.

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
the action. A cache would let a date finance just moved later be ignored.

**Re-read before each create.** `findOrCreate` reads the closing date again
after the match and just before it creates, and gates on the later of that date
and `closedThrough`. That costs one read per create, which is cheap next to the
create itself, and it shrinks the window in which finance can close a period
while a run is under way. If that read fails, the record is not created and
the post ends as a failed post. Expense and donation retry it on the next drain
run. Income parks it as `POST_FAILED` for finance, as it does any failed post.

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

**QuickBooks' refusal guards the last gap.** Finance can still close a period
between the app's last read and the create itself. For that gap the app relies
on QuickBooks refusing to post into a closed period (fault 6210).
`findOrCreate` reports fault 6210 as `closed`, the same result as a date the
gate stopped itself. The lane holds the record as closed, never as
`POST_FAILED`, so it is never retried as a failed post. The next run reads the
closing date again and keeps the record held under the new date. The shared
gate PR's sandbox check confirms that QuickBooks returns fault 6210 for a create
dated in a closed period, in the closing mode finance uses. It was observed in
the sandbox in "Required password" mode, as HTTP 400 (2026-10-18).

### 3. Switch-on timestamp

Each lane holds one nullable timestamp, `qbPostingOnAt`. A
record is created after switch-on when its own creation time in the app is later
than the stamp:

| Lane | Stored on | Compared with |
|---|---|---|
| Expense | `ExpenseOrgSettings` (new column) | `Expense.submittedAt` |
| Income | `IncomeOrgSettings` (new column) | `PayoutReconciliation.createdAt`, the time the app first saw the payout |
| Donation, Benevity | new `DonationOrgSettings` row (the package has no settings model) | `DisbursementEvent.createdAt` |
| Donation, in-kind (#2182) | same row, its own column | when the gift's money side arrived (receipt) or ops recorded it (no receipt) |

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
| Donation | `POST /api/donations/disbursement-events/[disbursementId]/qb-resolve` with match, dismiss, retry (`src/lib/qb-queue.ts:22-25`) | book | same route, new action |
| Donation, in-kind (#2182) | none | book, skip, match by id, clear a note | new `POST /api/donations/in-kind/{receipt,manual}/[id]/qb-resolve`, finance, returns the queue row |

Expense and in-kind need new registry entries. Income and donation add an
action to a finance-only route whose role and response types stay the same.

- **Book it** runs the lane's own post path with `mayCreate: true`, outside the
  per-run caps, as finance's retry already does. It still matches first and
  still stops at the closed line. Allowed only from the lane's "finance decides"
  state.
- **Skip** needs a non-empty reason and writes the lane's audit log with the
  person and the reason. The record leaves the queue for good, and the drain
  never posts or matches it again. Income's and donation's `dismiss` already do
  exactly this, so skip is `dismiss` under its existing name; expense gains it.
  Skip, dismiss and match on a record whose create may already have landed in
  QuickBooks first look for the app's own entry (section 6).

"Book it" goes through the same post path as the drain, so everything that path
checks today still holds: an expense still needs every sign-off seat and, for a
card charge that is not Everyday, the Board authorization (the Everyday result
frozen at intake); a reimbursement still needs its reimbursee's Vendor link; a
match by amount still records the drift baseline. A held drift (donation
`DRIFT`, or an expense `QB_DRIFT` flag) is not a "finance decides" state and
never offers "book it".

The states each lane uses for "finance decides" are:

- **Expense:** a new `UNBOOKED` replaces `BEFORE_LINE`, plus `SKIPPED` for a
  skip. `MATCHABLE_STATES` (`qbMatchService.ts:94`) swaps `BEFORE_LINE` for
  `UNBOOKED`.
- **Income:** no new kind. A payout the drain may not create is opened as
  `NO_DEPOSIT` at once, rather than waiting out the match window, since waiting
  cannot change the answer. "Book it" is offered on `NO_DEPOSIT`.
- **Donation:** `UNBOOKED` replaces `BEFORE_LINE` in `QB_HELD_STATES`
  (`src/lib/qb-queue-states.ts:5`), and the existing `DISMISSED` state serves as
  skipped. `UNBOOKED` is not added to `QB_RETRYABLE_STATES`; "book it" is its
  way back to the drain.

**Income's NEEDS_MAPPING hold wins over all of this.** It is designed in the
merged #2236 and not built yet; whichever of it and the income lane PR lands
second applies this ordering. A payout held
because an item has no Class decision never turns into `NO_DEPOSIT` and is never
opened by the open-period rule while it waits; "book it" on it is refused until
finance maps the item. The order inside a run is: match, then the mapping check,
then the closed and open-period checks.

### 5. Rows already parked BEFORE_LINE

The rename from `BEFORE_LINE` to `UNBOOKED` takes two releases, because old code
keeps writing `BEFORE_LINE` until the rolling deploy has finished. Migrations run
before that deploy, so a rewrite in the same release can run first, and an old
task reached by the posting cron or a finance retry during the drain then saves
a fresh `BEFORE_LINE` row (`qb-poster.ts:340-341`). If the new code no longer
knew that state, the row would be out of finance's queue, unable to be matched,
retried or posted, and nothing would report it.

1. **Expand, in the lane PR.** New code treats `BEFORE_LINE` exactly as
   `UNBOOKED`: held, listed in finance's queue, with the same actions. New code
   writes only `UNBOOKED`. No data is rewritten.
2. **Contract, a release after the lane PR has rolled out.** A cleanup PR
   rewrites every `BEFORE_LINE` row to `UNBOOKED`, then drops `BEFORE_LINE` from
   the code. By then no task running old code is left to write it.

Expense and donation both take these two steps, so the lanes stay alike and the
safety does not depend on a deploy setting.

No row is re-armed to `UNMATCHED` at any point, because an old drain could then
create it against the old line.

Income has no `BEFORE_LINE`. Its waiting payouts are sorted by the next run
under the new rules; `NO_DEPOSIT` rows already open keep their state and gain
"book it".

### 6. A create that may have landed

A create call can fail after QuickBooks has applied it, for example when the
call times out. The record then sits in `POST_FAILED` while its entry exists in
QuickBooks. Match-before-create finds that entry by its key only while the
entry's date stays inside the record's window. Three paths would then book
twice, or leave the app's entry linked to nothing and never checked for drift.
The rules below close them in all three lanes.

**Mark the attempt.** Each lane's record gains one nullable timestamp,
`qbCreateAttemptedAt`, on `Expense`, `PayoutReconciliation` and
`DisbursementEvent`. `findOrCreate` decides inside itself whether to create,
and the shared package has no database, so the lane writes the mark when it
claims the record, in the claim transaction that commits before any QuickBooks
call. It is set only while null and never moved, so every later lookup starts
from the first attempt. It therefore marks every post attempt, including ones
that end in a match and never send a create. A record that carries it is
"attempted", whatever its state now; a lookup on one that never created simply
finds nothing. Income marks only a post the gate lets create (`mayCreate`, dated
after the closed line): a post that can only match leaves nothing to find, and an
attempted payout is never matched by amount in reconcile, so marking every
open-period payout would stop a later hand booking from matching on its own. The
column is additive and ships in the lane's PR.

**Income gets the same claim, call and settle.** Today income calls QuickBooks
inside the database transaction that also settles, under its advisory lock and
a 90-second budget sized for two requests. A mark written there rolls back with
everything else when that transaction dies after QuickBooks applied the create,
and the reads this design adds overrun the budget. The income lane PR gives
income's post path the shape expense and donation already have:

1. **Claim.** A short transaction marks the payout as being posted, with the
   claim time, sets `qbCreateAttemptedAt` while null, and commits.
2. **Call.** The match, lookup, closing-date re-read and create run outside any
   transaction.
3. **Settle.** A new transaction checks the claim is still this post's, then
   saves the result. A claim older than 10 minutes can be reclaimed, as in the
   other lanes.

The advisory lock stays for reconcile only, and reconcile leaves a claimed
payout alone. With that in place, the marker, timeout and lost-claim rules
below hold for income too.

**Looking up the key.** For an attempted record, the lookup reads every entry of
the lane's entity that QuickBooks created since the attempt:

```
SELECT * FROM <Deposit | Purchase | Bill> WHERE MetaData.CreateTime >= <qbCreateAttemptedAt minus one hour> ORDERBY MetaData.CreateTime
```

The attempt time comes from the app's clock and the creation time from
QuickBooks', so the read starts one hour early. It reads up to 10 pages of 1,000
entries, QuickBooks' largest page, oldest first, and keeps one copy of each entry.
A read that fills all 10 pages has hit the cap, and more entries may exist. The
app then keeps the entries whose memo carries the record's `[checkin:<key>]`
marker. This query is the narrowest that works:

- The memo (`PrivateNote`), where the key lives, cannot be filtered in a
  QuickBooks query.
- The document number is too short for the key (21 characters against up to
  50), and on purchases and bills it already holds finance's check or bill
  number.
- Creation time does not change when finance edits the entry's date, which is
  the case the window misses.

The outcome of the lookup:

| Lookup finds | Then |
|---|---|
| exactly one entry with the key, held by no other record | it is the app's own entry: link it as `CREATED`; a date or amount finance changed shows up as drift, like any edited entry |
| exactly one entry with the key, already held by another record | finance's queue with the note "app entry X is held by record Y"; never linked, never created |
| no entry with the key | the normal match and gate run, and may create |
| more than one entry with the key, a read that hit the cap (more may exist), or the read fails | finance's queue with a note that the app may already have booked this record; nothing is created |

The shared gate PR confirms this query in the sandbox, as it does the closing
date field. If the query is not reliable there, the post path never creates an
attempted record: it goes to finance's queue with that note instead.

**A retry never creates on the window alone.** Before any create on an attempted
record, the post path runs the lookup. This covers the drain, finance's retry
and "book it".

**A lost claim after a create raises a flag.** A post that stalls long enough
for another worker to reclaim its record can still create its entry. Both posts
then create, and the stalled one settles to find its claim gone. Today expense
only logs that, and donation returns "waiting" without a word; income has no
claim until its lane PR adds one. Instead, when a settle finds its claim lost
after a `created` result, the lane tells finance that the app's entry may need
voiding, with the entry's id. Expense raises its `QB_POST_FAILED` flag, and
donation and income put the note on the record in finance's queue. Expense's
and donation's same-lane conflict paths already raise this warning; income
gains it with its claim.

**Finance's actions look first.** Before finance matches, dismisses or skips an
attempted record, the route runs the lookup:

- **The app's entry is found.** The record is linked to it as `CREATED`, the
  action is not applied, and the response tells finance which entry the app had
  already booked.
- **The app's entry is held by another record.** The action is refused with
  "app entry X is held by record Y", and nothing changes.
- **Nothing is found.** The action goes ahead.
- **The lookup reads more than one keyed entry, hits the cap, or fails.** The
  action is refused, and nothing changes. A failed read answers 503.

Skip and dismiss on a record that was never attempted need no lookup.

### 7. Daily orphan sweep

The rules in section 6 run inside the post path, so they cannot see a create
that lands after every other path has looked. A post can stall past its claim's
10 minutes, send its create after the reclaimer and finance have checked, and
then die before it settles; or its create can time out after QuickBooks applied
it, so the post settles with a failure rather than `created` and raises no flag.
Either way the app's second entry sits in QuickBooks with nobody told.
QuickBooks offers no way to fence off a stalled caller, so a check after the
fact closes this.

Once a day the `qbo-posting` cron runs a sweep for each lane:

- **One read per lane.** It runs the section 6 created-since query from the
  oldest `qbCreateAttemptedAt` in the lane within the last 30 days. It reads at
  most 10,000 entries, the same cap as the lookup; hitting the cap alerts finance
  that the sweep could not see every entry. The read also returns finance's own
  entries, so a lane with more than 10,000 entries in that window would alert
  every day; at this organisation's volume that is acceptable.
- **Match the keys.** It reads the `[checkin:<key>]` marker from each entry's
  memo and finds the lane's record with that key.
- **Report what does not fit.** An app-keyed entry whose record does not link
  it, or whose record links a different entry, raises the lane's finance flag or
  queue note: "app entry X is not linked; void or link it". Expense raises
  `QB_POST_FAILED`; income and donation put the note on the record.

The sweep only reads QuickBooks and fixes nothing itself. Finance voids or links
the entry. A stalled post's stray entry therefore reaches finance within a day.

---

## Related fixes

Checking this design turned up three faults in today's posting code that it
does not need. Each ships as its own PR, and the order is scheduled separately.
A fourth, that expense drift never compares the entry's date, is part of the
expense lane PR, because section 6 relies on drift catching a re-dated entry.

- **Income and donation can both hold one hand-booked deposit.** Each lane
  already keeps the other lane's held deposits out of its matching, so runs one
  after the other cannot double-hold. The gap is two runs at the same moment: a
  payout and a disbursement with the same net, into the same bank account, can
  each match one deposit before either settles. The fix is a claim table unique
  across lanes.
- **Expense takes its drift baseline from a separate read.** An edit between
  the match read and the baseline read, or a failed baseline read that the first
  drift check fills in later, becomes the baseline unreported. The fix takes the
  baseline from the entry the match itself saw.
- **Donation pins the booked date late.** After any match the booked date stays
  empty, and the first drift check pins whatever date the deposit
  has by then. The fix stores the date at settle, from the read that matched.

---

## PR split

One kind per PR. Registry entries first, each in its own PR based on `main`.

1. **Security:** the registry entry for `POST /api/expense/expenses/[id]/qb-resolve`.
   No app code.
2. **Shared gate:** `packages/quickbooks` replaces `takeoverLine` with
   `closedThrough` and `mayCreate`, and adds `bookCloseDate()`. It re-reads the
   closing date just before each create and reports fault 6210 as `closed`
   (section 2). It adds the created-since read used by the key lookup and the
   sweep (sections 6 and 7). It confirms the closing date field, fault 6210 for
   a closed period, and the created-since query in the sandbox. Until each lane PR lands, its caller passes its old line
   as `closedThrough` with `mayCreate: true` (or `mayCreate: false` when it has no
   line), and maps `closed` to today's `too-old` and `needs-finance` to today's
   `no-line`. Behaviour is unchanged, except that a create QuickBooks refuses
   as closed is held as `too-old` rather than failed.
3. **Expense:** gate wiring, `UNBOOKED` and `SKIPPED`, `BEFORE_LINE` read as
   `UNBOOKED` (section 5, expand), the `qb-resolve` route and its screen, the
   self-set stamp, the key lookup, the lost-claim flag and the lookup before
   finance's match and skip (section 6), date drift (the entry's date stored and
   compared), the daily sweep (section 7), and its migration (the switch-on and
   create-attempt columns).
4. **Income:** gate wiring, immediate `NO_DEPOSIT`, the "book" action, the
   late-payout path (reconcile before the stamp, no window cut-off after it),
   the self-set stamp, the NEEDS_MAPPING ordering, the claim, call and settle
   restructure, the key lookup, the lost-claim note and the lookup before
   finance's match and dismiss (section 6), the daily sweep (section 7), and
   its switch-on, claim and create-attempt columns.
5. **Donation:** gate wiring, `UNBOOKED`, the "book" action, the self-set
   Benevity stamp, `BEFORE_LINE` read as `UNBOOKED` (section 5, expand), the key
   lookup, the lost-claim note and the lookup before finance's match and dismiss
   (section 6), the daily sweep (section 7), and its migration
   (`DonationOrgSettings` and the create-attempt
   column). In-kind has no posting lane yet; its column comes
   with that lane (#2182).
6. **Rules:** `revenue.md` and, if it has merged, the `principles.md` line from
   #2210, plus the *Apply once* addition above.
7. **Cleanup, a release after 3 and 5 have rolled out:** the data migration
   that rewrites `BEFORE_LINE` to `UNBOOKED` in expense and donation, and the
   removal of `BEFORE_LINE` from both lanes' code (section 5, contract).

Each lane keeps its own Prisma schema and migrations, so each lane's migration
ships with that lane's code. The three related fixes are separate PRs, outside
this split.

Only PR 1 changes the security boundary. The new columns and
`DonationOrgSettings` carry `@sensitivity:internal`, like their neighbours. Income's
reconciliation routes return whole `PayoutReconciliation` rows, so its claim,
create-attempt and `qbNote` columns reach finance and the board as internal fields, under the
existing registry entries; the settings route selects only the caps. The income
and donation "book" actions ride on routes whose role and response types stay as
registered.

PRs 3, 4 and 5 touch different packages and can run in parallel once 1 and 2
have landed.

## What this supersedes

- **#2236** (merged income design for #2180): its takeover-date question was
  withdrawn in favour of this design. Only the NEEDS_MAPPING constraint carries
  over, in section 4.
- **#2215** (merged donation queue): its `BEFORE_LINE` handling (held, never
  retryable) becomes `UNBOOKED` with "book it"; its match, dismiss and retry
  stay. The comments in `qb-queue.ts:92` and `qb-poster.ts:283-290` that a hand
  match "moves the takeover line" go with the line.
- **The expense takeover date:** `ExpensePosting.takeoverDate` and the
  `no_takeover_date` gate.
- **#2210** (open)'s "finance's own bookings come first" bullet.
- The takeover-line passages of `1272_EXPENSE_QB_INTEGRATION.md`
  (around lines 1140-1149), which the lane PRs update.

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
