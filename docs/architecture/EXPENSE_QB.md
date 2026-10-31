# Expense's QuickBooks lane

A fully signed-off expense becomes one QuickBooks entry: a Bill to the reimbursee's
Vendor for a reimbursement, otherwise a Purchase from the organisation's payment
account. The app looks for a matching entry first and creates one only when nothing
matches and the books allow it. It tries right after the expense commits, and the
daily `GET /api/cron/qbo-posting` run catches up whatever is left.

This file describes the shape of the code. The rules a change must not violate are
in `docs/rules/expenses.md` and under *The books are finance's* in
`docs/rules/principles.md`. The package pattern this lane follows (host injection,
own database, in-process crossings, no hosted machine route) is in
`docs/architecture/COMPONENT_ARCHITECTURE.md`. Operator steps for consent and the
per-environment deploy checklist are in `packages/quickbooks/README.md`.

---

## Where the code is

| Code | What it holds |
|---|---|
| `packages/quickbooks/src/client.ts` | The client: readers and the one create request |
| `packages/quickbooks/src/write.ts` | `findOrCreate`, `findOrCreateInKindJournal`, `createVendor`; the closed-books gate |
| `packages/quickbooks/src/match.ts` | `findMatch`: pure, no reads or writes |
| `packages/quickbooks/src/guard.ts` | Which company a deployment may reach |
| `packages/expense/src/lib/expense-qb-processor.ts` | Account resolution, allocation, the outbox commit, stranded recovery, finance's retry |
| `packages/expense/src/qb-write.ts` | Composes the entry from rows the outbound gateway passed |
| `packages/expense/src/lib/expense-qb-poster.ts` | Claim, call, settle; the drain and the orphan sweep |
| `packages/expense/src/lib/expense-qb-drift.ts` | The drift check |
| `packages/expense/src/services/qbMatchService.ts` | Claims, exclusions, finance's match and skip |
| `packages/expense/src/services/reimburseeVendorService.ts` | Linking a reimbursee to a Vendor |
| `packages/expense/src/services/reimbursementStatus.ts` | When a reimbursement was paid |
| `checkin-app/src/lib/expense/configure.ts` | Binds the expense ports |
| `checkin-app/src/lib/quickbooks/client.ts` | checkin's one guarded client, `getQuickBooks()` |

Expense never imports checkin. It keeps its data in its own database,
`EXPENSE_DATABASE_URL`, and reaches QuickBooks through the ports below, which
`configureRuntime` binds at boot without touching a database or the network.

| Port (`quickbooks.*`) | Bound to | Unbound or off |
|---|---|---|
| `reader` | Windowed and by-id reads on the guarded client | Throws `QuickBooksNotConnectedError`, a 503, so "off" never reads as "no entries" |
| `refs` | The `EXPENSE_PAYMENT` role and the reimbursee's Vendor | Null, so nothing is a candidate |
| `vendors` | Finance's Vendor search, verify and create | Null |
| `posting` | The client, the payment account and its payment type, resolved on each call | Null, and a post or a drain answers `unbound` |

`posting` answers null when finance has not set the `EXPENSE_PAYMENT` account, when
QuickBooks is off, or when that account is neither Bank nor Credit Card; the last
case emails finance. A Credit Card account posts as `CreditCard` and a Bank account
as `Cash`.

---

## From signed-off expense to outbox

`checkAndProcessExpense` does nothing while the reimbursee is unknown or a line has
an unfilled sign-off seat. Past that check, each line must resolve to exactly one
account:

1. An account finance set by hand on a held line wins.
2. A part-numbered inventory line is looked up in the catalog and matched against
   the `AccountMapping` rules, where `*` is a wildcard and a rule naming the exact
   item beats the others. Catalog inputs are snapshotted on the line, so a later
   catalog edit cannot move the account.
3. Any other line needs a hand-set account.

A line that resolves to no account or to several raises an `ExpenseHold`
(`NO_MATCH`, `MULTIPLE_MATCHES`, `NO_PART_NUMBER`, `NON_INVENTORY`) and the expense
moves to `qb_on_hold`.

With no holds, one transaction re-reads the sign-offs under the expense lock,
writes each line's tax, shipping and discount share and its `resolvedQbAccount`,
creates the `ExpenseEvent` row, and moves the expense from `qb_pending` to
`qb_complete`. The outbox row carries no data: it says "this expense may post", and
the poster reads the expense and its lines. `@@unique([orgId, expenseId])` makes a
concurrent run harmless.

The value in `resolvedQbAccount` goes out as a QuickBooks account id, and the client
refuses a non-numeric one, so a mapping holding anything else fails the post.

A `qb_complete` expense has reached the outbox, which doesn't mean it has reached
QuickBooks. `qbMatchState` tracks that. An expense flagged `backfill` was already
booked by hand, so it lands on `qb_skipped` with no outbox row.

---

## What gets written

`composeWrite` builds one entry per expense with one line per expense line. Each
line carries its price plus its allocated tax and shipping, less its allocated
discount, plus its own account and its bucket's Class. A reimbursement with no
linked Vendor goes to `AMBIGUOUS`. A line whose bucket has no Class leaves the state
unchanged and is retried on each run; the queue shows it as `QB_NO_CLASS`.

The poster passes the rows through the outbound gateway (surface
`quickbooks.create`) first, so `composeWrite` sees only the tiers that surface
declares. A field it needs that did not pass fails the post.

**The writer.** `QuickBooksClient` has one private `post`, reached through two
symbol-keyed methods that `packages/quickbooks/src/internal.ts` keeps off the
package's main entry.

| Path | Creates | Limits |
|---|---|---|
| `findOrCreate` | `Purchase`, `Bill`, `Deposit` | Listed fields only, so no `Id` or `SyncToken` can be sent. A Purchase is `Cash` or `CreditCard`; a Check is refused before the request |
| `createVendor` | `Vendor` | `DisplayName` only. A name a Customer holds becomes `<name> (Vendor)`, and an existing Vendor of that name is returned rather than created |
| `findOrCreateInKindJournal` | One gift's `JournalEntry` | Credits only in-kind income, debits only in-kind expense or fixed assets, balanced, positive amounts, matched by key alone |

Expense uses `Purchase`, `Bill` and `Vendor`. Income uses `Deposit`, and in-kind
uses the journal path. Nothing can update, delete, void or pay.

**The key.** `qbKey("expense", expenseId)` goes out as QuickBooks' `requestid` and
into the entry's `PrivateNote` as `[checkin:<key>]`. QuickBooks' own dedup window is
short, so the note is what makes a retry days later safe.

---

## Match before create

For one expense, `findOrCreate` reads entries of the right type in a window of seven
days either side of the receipt date. A Purchase candidate must have the exact
amount and the payment account; a Bill candidate must have the exact amount and the
Vendor. Entries already claimed or excluded are dropped.

| Read finds | Result | `qbMatchState` |
|---|---|---|
| One entry with this expense's key that fits and is free | Link it | `CREATED` |
| This key on an entry that doesn't fit, or beside another key, or on several entries | A person decides | `AMBIGUOUS` |
| One hand-booked entry that fits, and nothing else | Link it | `MATCHED` |
| Any other set of fitting entries | A person decides | `AMBIGUOUS` |
| Nothing | The gate below | |

**The gate.** Nothing dated on or before `closedThrough` is created. `closedThrough`
is the books closing date read from QuickBooks or, with none set, the day before
`ExpenseOrgSettings.qbPostingOnAt`. Only an expense submitted after that switch-on,
or one finance asked to book, may be created. The first drain with `posting` bound
stamps the switch-on once and never moves it, so a post that runs before then can
only match. An unreadable closing date, or neither date, creates nothing. The client
re-reads the closing date just before the create, and a create QuickBooks refuses
with fault 6210 counts as closed.

**Claims.** `ExpenseQbClaim` is unique on org, entity and QuickBooks id, because
those ids are unique per entity only. A claim covers expenses and lines alike, so
two records never hold one entry. `ExpenseQbMatchExclusion` is unique on org and id
with no entity, so an exclusion drops that id for both Purchases and Bills.

### Match states

| `qbMatchState` | Means | What moves it |
|---|---|---|
| `UNMATCHED` | Not tried yet | The next post |
| `POSTING` | A post holds the claim, `qbClaimedAt` says since when | That post settling, or takeover after 10 minutes |
| `CREATED` | The app's own entry is linked | Terminal |
| `MATCHED` | A hand-booked entry is linked, with a baseline for drift | Terminal |
| `AMBIGUOUS` | Several candidates, or no Vendor | Finance |
| `UNBOOKED` | Not in QuickBooks, and the app may not create it | Finance |
| `BEFORE_LINE` | An older stored value, held exactly like `UNBOOKED` and never written | Finance |
| `POST_FAILED` | A post failed | The drain, up to five attempts |
| `NEEDS_FINANCE` | Posts kept failing, or the app may already have booked it and cannot tell | Finance |
| `SKIPPED` | Finance skipped it, with a reason | Terminal |
| `NOT_TEST_DATA`, `TEST_DATA_REFUSED` | Stopped by the test-data gate | Re-checked each run |

The test-data gate works by environment. Outside production only an `isTestData`
expense whose vendor name starts `TEST-` posts; production never posts an
`isTestData` expense.

---

## Running a post

`postExpenseToQb` holds no lock while it talks to QuickBooks. It has three steps:

1. **Claim.** Under the row lock it re-reads the outbox row, the reimbursee, the
   sign-off seats and the line approvals, builds the entry, and sets `POSTING`. A
   post that may create stamps `qbCreateAttemptedAt` the first time, and the stamp
   never moves. A hold makes the post wait; on a closed expense it also raises
   `QB_POST_HELD`, since only finance can clear that hold.
2. **Call.** If `qbCreateAttemptedAt` was already set, it first reads what QuickBooks
   created since then and keeps entries carrying this key, so it finds an entry even
   after finance re-dated it. Otherwise it goes straight to `findOrCreate`.
3. **Settle.** A new transaction applies the result only if the claim is still on
   the row. A post that lost its claim after creating an entry raises
   `QB_DUPLICATE_TO_VOID`, naming the entry.

A crash after QuickBooks accepts and before settle is therefore safe: the post that
takes over the stale claim finds the entry by key instead of creating a second one.

### The cron

`GET /api/cron/qbo-posting` answers only to `QBO_POSTING_CRON_SECRET`, runs daily,
and returns `{}`. Counts go to the log, and a failed step is recorded on the cron
run. Expense's step, `runExpenseQbPosting`, runs first, ahead of the donation
hand-over, in-kind and income, and each lane fails on its own. It has three parts,
each also failing on its own:

- `recoverStrandedQbExpenses`: expenses left in `qb_pending` or `qb_error` with no
  outbox row, at most 50.
- `drainExpenseOutbox`: every outboxed expense not yet in QuickBooks, oldest receipt
  first, then the orphan sweep.
- `checkQbDrift`: the drift check below.

Expense's non-QuickBooks catch-up, `runExpenseCatchUp` (intake replay and catalog
events), runs from `/api/cron/reconcile-shopify` instead.

### Limits

| Limit | Value | What happens |
|---|---|---|
| Entries created per drain | 25 | The run stops and logs; the rest wait |
| Entries created per UTC day | 50, counted from `qb_created` audit rows | Posts wait, finance's "book it" included |
| Failures in a row in one drain | 3 | The run stops, since QuickBooks is likely down |
| Failed attempts on one expense | 5 | `NEEDS_FINANCE` |
| Drift reads per run | 25 | The slice moves each UTC day, so every entry is checked in turn |

These caps count entries; nothing caps the total amount. Hitting a drain cap writes a
log line.

---

## What finance does

Finance works these from the one finance queue, which reads most reasons from the
expense's state.

| Action | Service | Effect |
|---|---|---|
| Pick a candidate | `matchExpenseToQb` | `MATCHED`; needs every sign-off |
| Book it | `bookExpenseToQb` | One post with creating allowed; still matches first and stops at the closing date |
| Retry | `retryQbPost` | Re-resolves accounts from the current mappings, resets the attempt count, posts once |
| Skip, with a reason | `skipExpenseQb` | `SKIPPED` for good; refused to a conflicted person |
| Exclude an entry, with a reason | `excludeQbTxn` | That id is never a candidate again |
| Link or create a Vendor | `reimburseeVendorService` | The reimbursee's Vendor is set; a same-name Vendor must be confirmed by picking it |
| Set an account on a held line | `setHeldLineAccount` | Clears the hold on resubmit |

Match and skip first look for the app's own entry when a create may have landed. If
it is there, the expense links to it as `CREATED` in place of the action.

Three questions have nothing else to record their answer, so they are flags closed
with a required note: `QB_DUPLICATE_TO_VOID`, `QB_DRIFT` and `QB_POST_HELD`.

---

## Checks after posting

**Drift.** `checkQbDrift` re-reads each `CREATED` and `MATCHED` entry through the
windowed reader around its receipt date. A created entry is compared with what the
app posted (amount, date, key, accounts, Vendor). A matched entry is compared with
its baseline, and the accounts on it are compared only when the baseline recorded
them, because they are finance's. Any difference, or a missing entry, raises
`QB_DRIFT` with what QuickBooks showed. The check only reads QuickBooks; its writes
are in the expense database, where it raises the flags and stores a baseline for a
matched entry that has none, raising nothing for that entry on that run.

**Orphan sweep.** `sweepExpenseQbStrays` reads the Purchases and Bills created since
the oldest create attempt in the last 30 days. An entry carrying an expense's key
that the expense does not hold raises `QB_DUPLICATE_TO_VOID`. A full page of 1,000
emails finance, because some entries went unchecked.

---

## Reading QuickBooks

Transaction reads are windowed: `purchasesBetween`, `billsBetween` and the others
take a date range of at most 93 days and refuse anything wider, so no reader can walk
the company's history. Past expenses with no receipt stay in QuickBooks and are only
ever matched against.

Four kinds of read have no date window: `createdSince`, one page by creation time;
by-id reads; `bookCloseDate`; and the reference lists of accounts, Classes and
Vendors.

**When a reimbursement was paid.** QuickBooks is the system of record, and receipt
asks through `ReimbursementStatus.forReceipts`. A Bill counts as paid when its
balance is 0 and it links BillPayments, on the latest payment's date. A backfilled
receipt's hand-booked Purchase counts as paid on its own date.

---

## The connection

checkin has one client, built in `checkin-app/src/lib/quickbooks/client.ts` and shared
by every library with a QuickBooks port. `getQuickBooks()` answers null while
QuickBooks is off, and rebuilds the client every minute.

**Tokens.** The app invokes the refresher Lambda (`QBO_REFRESHER_FN`,
`qbo-refresher-function/`) with `{ "action": "current" }` and keeps the access token
in memory until five minutes before expiry. The refresher alone holds the refresh
token and the client secret. The app holds neither, stores no token in a database or
file, and never refreshes; an expired token is an error for the caller to retry. The
app also checks that the refresher's answer names the configured company and the keys
this environment allows.

**Which company.** `assertQboTarget` decides from our own config, never from anything
QuickBooks returns:

| `CHECKIN_ENV` | Reaches |
|---|---|
| `prod` | The production API and `QBO_REALM_ID` |
| `dev` | The sandbox API, and only the realm in `QBO_SANDBOX_REALM_ALLOWED` |
| anything else, unset included | Nothing |

Off production, the token must come from Intuit's development keys
(`QBO_DEV_CLIENT_ID`), and production refuses those keys. Every sandbox write carries
a test marker and must not name the organisation; `assertPayloadMarked` checks the
final request body.

---

## The capital register

`CapitalAsset` is this app's record of fixed-asset numbers, and it stays in expense's
database. The poster sends no asset number to QuickBooks.

Setting a capital line's depreciation cycle mints one row per unit, numbered as the
highest existing `ITFA` number plus one; a line that already has rows mints none. A
donated capital line does the same through `donatedCapitalService`. Historical
numbers load through the finance seed route with `seeded: true`. A number already on
the register is skipped, and `(orgId, assetNumber)` is unique, which also settles two
mints racing for one number.
