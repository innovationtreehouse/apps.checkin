# A saved copy of the QuickBooks account and Class lists

## Open questions for the owner

Each has a recommendation. The design below assumes the recommended answer;
where another answer changes it, the question says how.

**QL-1. May the app keep a copy of the chart of accounts and the Class list?**
`docs/rules/expenses.md` has a deliberate limit: the app never imports the chart
of accounts, the Class list or the vendor list in bulk. A saved copy is a bulk
import of the first two.

- **(a) Narrow the limit (recommended).** The app keeps a read-only copy of the
  account and Class lists to fill pickers and check picks. Every mapping is still
  picked by finance, one at a time; the vendor list is never copied; vendor names
  are never matched.
- **(b) Keep the limit.** Nothing here is built. Only the planned interim fix
  ships (the account-type check runs only when the account changes), so an edit
  that changes an account still fails while QuickBooks is down.

**QL-2. What happens when finance picks an account or Class the copy doesn't have?**
This is the normal case right after finance creates one in QuickBooks.

- **(a) Read QuickBooks once, refresh the copy, then decide (recommended).** Finance
  never has to press anything after adding an account; only an outage on top of a
  new account refuses the save, with a message saying so.
- **(b) Refuse, and tell finance to press "Update now".** No live read on any edit,
  ever. Simpler to reason about, one more step for finance.

**QL-3. Does a copy get too old to use?**

- **(a) Use it at any age; System Status turns red after two days without a
  successful refresh (recommended).** An outage never blocks an edit. The risk is
  an account whose type finance changed in QuickBooks during a long outage; the
  existing "account types" row on System Status already flags a stored account
  that later reads as another type.
- **(b) Refuse edits once the copy is older than N days.** Name N.

**QL-4. Who may press "Update now"?**

- **(a) Finance (recommended).** The same role that edits the books map.
- **(b) Finance or the Board.** A refresh changes nothing in the books, so this is
  harmless; it only matters if the Board also works the pickers.

**QL-5. Where does the button sit?**

- **(a) On the Books map screen only (recommended).** Every refusal that names a
  missing or wrongly typed account says to update the lists there.
- **(b) Also on each picker screen** (expense accounts and rules, the donation
  account map, income items). Four more placements of one button.

**QL-6. Do the daily posting runs keep reading QuickBooks live?**

- **(a) Yes (recommended).** Posting needs QuickBooks up anyway, so a live read
  costs no availability, and it books against the freshest types.
- **(b) Read the copy too.** Saves a few calls per run; books against a list up to
  a day old.

---

## Problem

Finance sets up where money is booked: which account a role, rule or store item
books to, and which Class a budget bucket carries. Each save checks the pick
against QuickBooks at that moment, to refuse an account of the wrong type. When
QuickBooks can't be reached, every such save fails, including edits that don't
touch the account at all, such as renaming an expense account entry. The pickers
themselves are blank for the same reason.

Those lists change a few times a year. Finance loses the use of half its setup
screens during every QuickBooks outage to re-read data that almost never moves.

## Objective

Finance's setup screens work while QuickBooks is down. Picks are still checked
against QuickBooks' own account types and Classes, using a copy at most a day
old, or newer when finance asks.

## Executive summary

- **Finance:** pickers and saves on the Books map, expense accounts and rules,
  held expense lines, gift-of-goods lines, the donation account map and income
  items work during an outage. After changing something in QuickBooks, finance
  presses "Update now" on the Books map, or simply picks the new account: a miss
  reads QuickBooks once (QL-2).
- **Posting:** unchanged. The daily run still reads QuickBooks live (QL-6).
- **Sysadmins and the Board:** System Status gains one row saying when the lists
  were last refreshed.
- **Unchanged:** finance still picks every mapping one at a time; vendors are
  still searched live; nothing is booked from the copy.
- **Cost:** one table, one step at the head of the daily `qbo-posting` run, two
  routes and a button. No new cron and no infra change.

## Rules this relies on or changes

Changes, if QL-1 is answered (a):

- `docs/rules/expenses.md`, the deliberate limit on bulk imports. Proposed text:
  "An expense line's account comes from finance's own mapping rules and account
  list, which finance keeps by hand. Finance picks the accounts on that list,
  Classes and the books map's accounts one at a time. The app keeps a read-only
  copy of QuickBooks' account and Class lists to offer and check those picks, and
  never creates a mapping from it. It never copies the vendor list and never
  matches vendor names on its own. [Decision — deliberate limit]"
- `docs/rules/revenue.md`, account types: "refuse the save while QuickBooks can't
  be read" becomes "check the type against the app's copy of the account list;
  an account the copy lacks is read from QuickBooks, and the save is refused only
  while QuickBooks can't be read".
- `docs/rules/revenue.md`, bucket assignment: "While the books can't be reached to
  check, the assignment is refused" becomes the same wording for Classes.

Relies on, unchanged:

- `docs/rules/revenue.md`: a stored account that later reads as another type is
  flagged on System Status and never rewritten. The copy doesn't change this.
- `docs/rules/revenue.md`: while Classes can't be read, a payout with a sale
  assigned to a bucket waits. That is a posting-time check and stays live.
- `docs/conventions.md`, "A shared helper has one home" and "One process, one
  implementation": every account check already routes through one host function,
  so the change lands there once.

## Design

### 1. Which lists, and who reads them

Two lists are read live and change rarely: **accounts** and **Classes**. Both are
read in full by `QuickBooksClient.accounts()` and `classes()`
(`packages/quickbooks/src/client.ts:460`, `:464`).

Edit-time readers, which move to the copy:

| Reader | What it does | Path to QuickBooks |
|---|---|---|
| `listQuickBooksAccounts` `checkin-app/src/lib/finance/booksMap.ts:98` | The account picker (`GET /api/books-map/quickbooks-accounts`) and the one source for every account check below | `qb.accounts()` |
| `setBooksMapAccount` `checkin-app/src/lib/finance/booksMap.ts:50` | Books map role save | `listQuickBooksAccounts` |
| `refuseWrongType` `packages/expense/src/lib/account-types.ts:18` | Expense account list create/update (`routes/finance.ts:165`, `:180`, the PR3070-F03 path via `refuseListType` at `:85`), account rules (`:95`, `:119`), held line account (`services/holdService.ts:31`) | port `quickBooksAccounts` (`checkin-app/src/lib/components/ports.ts:50`) → `listQuickBooksAccounts` |
| `refuseWrongTypes` `packages/bulk-donation/src/routes/rules.ts:36` | Donation account map create/update | same port |
| `packages/bulk-donation/src/lib/in-kind-resolve.ts:248` | Account finance sets on a gift-of-goods line | same port |
| `setItemCategory` `packages/income/src/routes.ts:125` | Income item's account | same port |
| `listQuickBooksClasses` `checkin-app/src/lib/finance/budgetOwners.ts:44` | The Class picker for buckets (`GET /api/budget-owners/quickbooks-classes`) | `qb.classes()` |
| `setCategory` `packages/income/src/services/itemCategoryService.ts:78` | Income item assigned to a bucket: is its Class active? | `classSource.activeClassIds` (`checkin-app/src/lib/income/configure.ts:140`) |

Posting-time and health readers, which stay live (QL-6):

| Reader | Why live |
|---|---|
| `resolvePosting` `checkin-app/src/lib/expense/configure.ts:228` | Payment account type at posting; posting needs QuickBooks up anyway |
| `chartOfAccounts` `packages/bulk-donation/src/lib/in-kind-poster.ts:126` | Gift-of-goods account types, once per run |
| `bucketState` `packages/income/src/lib/buckets.ts:25` | Active Classes at posting; shares `activeClassIds` with `setCategory`, so the income config gains a second, copy-backed reader for edits |
| `accountTypesCheck` `checkin-app/src/lib/quickbooks/health.ts:47` | System Status reports what QuickBooks says now |

Not cached:

- **Vendors** (`vendorsMatching`, `vendorById`, `vendorNamed`, client.ts:484–497):
  the app creates vendors itself, finance searches by text, and the list grows
  continually. The rule against copying it stays.
- **Customers** (`customerNamed`, client.ts:500): read only while creating a
  vendor, inside posting.
- **The closing date** (`bookCloseDate`, client.ts:419): a single setting read at
  posting, where a stale value could book into a closed period.

### 2. Where the copy lives

In the checkin database, beside the books map it serves. One new table, one row
per list, replaced whole on each refresh:

```prisma
/// The app's read-only copy of one QuickBooks list, replaced whole by each refresh.
model QuickBooksList {
  /// "account" or "class".
  /// @sensitivity:internal
  list        String   @id
  /// The list as QuickBooks returned it, trimmed to { id, name, accountType?, active }.
  /// @sensitivity:internal
  entries     Json
  /// @sensitivity:internal
  refreshedAt DateTime
}
```

- The lists hold hundreds of entries at most, and every reader takes the whole
  list and filters in memory, so a JSON row per list is enough. A row per entry
  would add nothing a reader uses.
- No `orgId`: the books map it serves has none.
- No record of who refreshed. A refresh changes nothing in the books; the route
  logs the caller.
- The migration only creates the table. It is safe against the old code still
  serving, and there is nothing to backfill: an empty copy behaves as a miss
  (§4), which is today's behaviour.
- `CHECKIN_ENV=local` keeps returning the stand-in lists
  (`LOCAL_QUICKBOOKS_ACCOUNTS`, `LOCAL_QUICKBOOKS_CLASSES`) without touching the
  table, as now.

### 3. Refresh

One host function, `refreshQuickBooksLists()`, reads `accounts()` and `classes()`
and replaces both rows in one transaction. A failure leaves the old copy in place.

**Daily.** The first step of the existing daily `qbo-posting` run
(`checkin-app/src/app/api/cron/qbo-posting/route.ts`), isolated like every other
step: a failure is recorded on the run as `lists` and the lanes still run. The
infra repo already schedules that run, so nothing there changes. Running first
means the posting lanes and the copy see the same QuickBooks state each morning.

**Update now.** A button on the Books map screen (`/books-map`, QL-5), beside a
line reading "QuickBooks lists as of <time>". It calls
`POST /api/books-map/quickbooks-lists/refresh`, finance only (QL-4), which runs
the same function and answers with the new time and counts, or with the
connection error in the existing 503 wording. The screen reads the time from
`GET /api/books-map/quickbooks-lists`.

**On a miss** (QL-2): a check whose account or Class the copy lacks calls the same
function once, then checks again. A burst of misses doesn't read QuickBooks once
each: concurrent misses share one in-flight refresh.

### 4. During an outage, and when the copy is old

| Situation | Picker | Save of an account or Class the copy has | Save of one the copy lacks |
|---|---|---|---|
| QuickBooks up | Copy | Checked against the copy | Live read refreshes the copy, then checked |
| QuickBooks down | Copy | Checked against the copy | Refused, 503: "That account isn't in the app's copy of QuickBooks' list and QuickBooks can't be read to check it. Try again shortly." |
| Copy empty (new install, or never refreshed) | Live read, as today | Live read, as today | Live read, as today |
| Copy older than two days | Copy, with its date shown | As above | As above |

The type check itself (`accountTypeRefusal`, `packages/quickbooks/src/accountTypes.ts:52`)
is unchanged; only where its list comes from changes.

Stale copy (QL-3): the copy is used at any age. System Status gains a row,
"QuickBooks lists", green with "Refreshed <time>" and red after two days without a
successful refresh. A stored account whose type changed during an outage is
still caught by the existing account-types row, which reads QuickBooks live.

The planned interim fix, running the account-type check only when the account
changes, stays correct under this design and is still worth landing first: it
also skips the copy for edits that don't touch the account.

### 5. Security boundary

Two new routes, so two registry entries, which ship in their own boundary PR
before the route PR (`AGENTS.md`, boundary isolation rule):

| Entry | Authorize | Returns | View |
|---|---|---|---|
| `GET /api/books-map/quickbooks-lists` | `finance-or-board` | `QuickBooksListsStatus` | `FINANCE_OR_BOARD_VIEW` |
| `POST /api/books-map/quickbooks-lists/refresh` | `finance` (QL-4 (b): `finance-or-board`) | `QuickBooksListsStatus` | `FINANCE_VIEW` |

Both go in `checkin-app/src/security/registry/budgetOwner.ts`, beside the other
books-map routes.

One new synthetic classification in
`checkin-app/src/security/budgetOwnerSyntheticClassifications.ts`:

```ts
QuickBooksListsStatus: {
  list: "internal",
  refreshedAt: "internal",
  entries: "internal",   // a count, not the list
},
```

Not boundary changes:

- The new table's `@sensitivity:internal` annotations, which are new fields, not a
  re-tier. They ship with the table.
- `QuickBooksAccountOption` and `QuickBooksClassOption` keep their shape; the
  pickers return the same fields from the copy.

### 6. PRs, in order

Each is based on `main`; none is stacked.

1. **Boundary:** the two registry entries and `QuickBooksListsStatus`. Inert until
   the routes exist. Can open at once.
2. **The copy:** the table and migration, `refreshQuickBooksLists`, the daily step
   in `qbo-posting`, the miss refresh, and the switch of `listQuickBooksAccounts`,
   `listQuickBooksClasses` and income's edit-time Class check to the copy. Carries
   the `docs/rules` edits above and deletes this doc. Independent of 1, so it can
   run in parallel.
3. **Update now:** the two routes, the Books map line and button, and the System
   Status row. After 1 and 2 merge.

If QL-1 is (b), none of these ships.

## Tests

- PR 2: unit tests for the miss path (copy lacks the id → one live read → check),
  the outage path (copy has it → no QuickBooks call; copy lacks it → 503), the
  empty-copy fallback, and concurrent misses sharing one read. One integration
  test that a refresh replaces both rows in one transaction and a failed read
  leaves them.
- PR 3: route tests for the role gate and the 503 wording; a flow test is not
  needed, as no flow-test server reaches QuickBooks.

## Alternatives considered

- **An in-memory cache per process.** Lost on every deploy and not shared between
  tasks, so it would be empty at exactly the moments an outage tends to follow.
- **A row per entry.** Lets a query find one account, which no reader does; costs
  a delete-and-insert per refresh instead of one update.
- **A new cron for the refresh.** Needs an infra change and a second secret for no
  gain over a step in the run that already reads QuickBooks daily.

## Appendix: provenance

- Audit finding PR3070-F03: every expense account list edit returns 503 during a
  QuickBooks outage, because the type check reads QuickBooks live even when the
  account doesn't change.
