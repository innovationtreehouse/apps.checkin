# A saved copy of the QuickBooks account and Class lists

## Problem

Finance decides where money is booked: which account a role, rule or store item
books to, and which Class a budget bucket carries. Every save checks the pick
against QuickBooks as it happens, so that an account of the wrong type is
refused. When QuickBooks can't be reached, all of those saves fail, even an edit
that never touches the account, such as renaming an expense account entry. The
pickers come up blank for the same reason.

The lists behind these checks change only a few times a year. Even so, every
QuickBooks outage locks finance out of half its setup screens, because the app
re-reads data that has almost certainly not changed.

## Objective

Finance's setup screens keep working while QuickBooks is down. Every pick is
still checked against QuickBooks' own account types and Classes. The check uses
a saved copy of those lists, refreshed once a day, and finance can refresh it
straight away after changing something in QuickBooks.

## Executive summary

- **Finance:** the pickers, and saves on the following screens, work during an
  outage: the Books map, budgets, expense accounts and rules, held expense
  lines, gift-of-goods lines, the donation account map and income items. After
  changing something in QuickBooks, finance presses "Update now". The button
  sits on the Books map and beside every QuickBooks picker. A pick the copy
  doesn't hold is refused, and the refusal offers the button right there.
- **The Board:** may press "Update now" as well.
- **Posting:** no change. The daily run still reads QuickBooks live.
- **Sysadmins and the Board:** System Status gets one new row showing when the
  lists were last refreshed. It turns red after two days without a refresh.
- **Not changing:** finance still picks every mapping one at a time, vendors
  are still searched live, and nothing is booked from the copy.
- **Cost:** one table, one step at the start of the daily `qbo-posting` run, two
  routes and one shared button. No new cron job and no infra change.

## Decisions

These were open questions. The owner ruled on all of them on 2026-11-13. The QL
IDs stay stable so later threads can cite them.

- **QL-1.** The app keeps a read-only copy of QuickBooks' account and Class
  lists for its pickers and checks. Finance still picks every mapping one at a
  time. The vendor list is never copied.  [Decision — owner]
- **QL-2.** Pickers and the checks run on a save read only the copy. If the
  copy doesn't hold the account or Class, or holds it under a type the save
  doesn't accept, the save is refused with a pointer to "Update now". A save
  never reads QuickBooks.  [Decision — owner]
- **QL-3.** The copy is used however old it is. A System Status row turns red
  after two days without a successful refresh.  [Decision — owner]
- **QL-4.** Finance or the Board may press "Update now".  [Decision — owner]
- **QL-5.** There is one shared "Update now" button. It appears on the Books map
  and beside every QuickBooks picker, and the refusal for a missing entry offers
  it in the same place.  [Decision — owner]
- **QL-6.** The daily posting runs and System Status's existing QuickBooks rows
  keep reading QuickBooks live.  [Decision — owner]

## Rules this relies on or changes

These changes are extracted into `docs/rules/` when the copy ships (PR 2 below).

**`docs/rules/expenses.md`, the deliberate limit on bulk imports.** It becomes:

> - An expense line's account comes from finance's own mapping rules and account
>   list, which finance keeps by hand. Finance picks the accounts on that list,
>   Classes and the books map's accounts one at a time. The app keeps a
>   read-only copy of QuickBooks' account and Class lists to offer and check
>   those picks, and never creates a mapping from it. It never copies the vendor
>   list, and never matches vendor names on its own.
>   [Decision — deliberate limit]

**`docs/rules/revenue.md`, account types.** The words "reading the type from
QuickBooks, and refuse the save while QuickBooks can't be read" become:

> reading the type from the app's copy of QuickBooks' account list. A save
> whose account the copy doesn't list is refused until finance or the Board
> updates the copy; the save itself never reads QuickBooks.

**`docs/rules/revenue.md`, bucket assignment.** "While the books can't be
reached to check, the assignment is refused" becomes:

> The Class is checked against the app's copy of QuickBooks' Class list; a
> Class the copy doesn't show as active is refused until the copy is updated.

**`docs/rules/revenue.md`, a new line beside the books map rules:**

> - The app's copy of QuickBooks' account and Class lists refreshes once a day,
>   and finance or the Board may refresh it at any time. It is used at any age;
>   System Status flags it after two days without a refresh.  [Decision — owner]

These rules stay as they are:

- `docs/rules/revenue.md`: a stored account that later reads as another type is
  flagged on System Status and never rewritten. That check stays live (QL-6).
- `docs/rules/revenue.md`: while Classes can't be read, a payout with a sale
  assigned to a bucket waits. That check happens at posting, so it stays live.
- `docs/conventions.md`, "A shared helper has one home" and "One process, one
  implementation": every account check already goes through one host function,
  so the change lands in one place.

## Design

### 1. Which lists, and who reads them

Two lists are read live and change rarely: **accounts** and **Classes**.
`QuickBooksClient.accounts()` and `classes()` read each one in full
(`packages/quickbooks/src/client.ts:460`, `:464`).

These readers run when finance saves, and they move to the copy:

| Reader | What it does | Path to QuickBooks |
|---|---|---|
| `listQuickBooksAccounts` `checkin-app/src/lib/finance/booksMap.ts:98` | The account picker (`GET /api/books-map/quickbooks-accounts`), and the single source for every account check below | `qb.accounts()` |
| `setBooksMapAccount` `checkin-app/src/lib/finance/booksMap.ts:50` | Saving a role on the Books map | `listQuickBooksAccounts` |
| `refuseWrongType` `packages/expense/src/lib/account-types.ts:18` | Expense account list create and update (`routes/finance.ts:165`, `:180`; the PR3070-F03 path goes through `refuseListType` at `:85`), account rules (`:95`, `:119`), a held line's account (`services/holdService.ts:31`) | port `quickBooksAccounts` (`checkin-app/src/lib/components/ports.ts:50`) → `listQuickBooksAccounts` |
| `refuseWrongTypes` `packages/bulk-donation/src/routes/rules.ts:36` | Donation account map create and update | same port |
| `packages/bulk-donation/src/lib/in-kind-resolve.ts:248` | The account finance sets on a gift-of-goods line | same port |
| `setItemCategory` `packages/income/src/routes.ts:125` | An income item's account | same port |
| `listQuickBooksClasses` `checkin-app/src/lib/finance/budgetOwners.ts:44` | The Class picker for buckets (`GET /api/budget-owners/quickbooks-classes`) | `qb.classes()` |
| `setCategory` `packages/income/src/services/itemCategoryService.ts:78` | Assigning an income item to a bucket: checks that the bucket's Class is active | `classSource.activeClassIds` (`checkin-app/src/lib/income/configure.ts:140`) |

These readers run at posting time or for System Status, and they stay live
(QL-6):

| Reader | Why it stays live |
|---|---|
| `resolvePosting` `checkin-app/src/lib/expense/configure.ts:228` | Reads the payment account's type when posting, and posting needs QuickBooks up anyway |
| `chartOfAccounts` `packages/bulk-donation/src/lib/in-kind-poster.ts:126` | Reads gift-of-goods account types once per run |
| `bucketState` `packages/income/src/lib/buckets.ts:25` | Reads active Classes when posting. It shares `activeClassIds` with `setCategory`, so income's config gets a second reader, backed by the copy, for edits |
| `accountTypesCheck` `checkin-app/src/lib/quickbooks/health.ts:47` | System Status reports what QuickBooks says now |

These lists are not cached:

- **Vendors** (`vendorsMatching`, `vendorById`, `vendorNamed`, client.ts:484–497):
  the app creates vendors itself, finance searches them by text, and the list
  keeps growing. The rule against copying it stays (QL-1).
- **Customers** (`customerNamed`, client.ts:500): read only while creating a
  vendor, which happens inside posting.
- **The closing date** (`bookCloseDate`, client.ts:419): a single setting read
  at posting, where a stale value could book into a closed period.

### 2. Where the copy lives

The copy lives in the checkin database, next to the books map it serves. One new
table holds one row per list, and each refresh replaces a row whole:

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

- Each list holds a few hundred entries at most, and every reader takes the
  whole list and filters it in memory. One JSON row per list is enough, because
  a row per entry would give the readers nothing they use.
- The table has no `orgId`, because the books map it serves has none.
- It doesn't record who refreshed. A refresh changes nothing in the books, and
  the route logs who called it.
- The migration only creates the table. It is safe while old code is still
  serving. The table starts empty, and an empty copy refuses every save that
  needs it until the first refresh (§4). The first daily run fills it, and
  finance can fill it sooner with "Update now".
- With `CHECKIN_ENV=local`, the app keeps returning the stand-in lists
  (`LOCAL_QUICKBOOKS_ACCOUNTS`, `LOCAL_QUICKBOOKS_CLASSES`) and never touches
  the table, as it does now.

### 3. Refresh

One host function, `refreshQuickBooksLists()`, reads `accounts()` and
`classes()` and replaces both rows in one transaction. If anything fails, the
old copy stays as it was. Two refreshes at once are harmless: each one writes a
whole, consistent copy.

**Daily.** The refresh becomes the first step of the existing daily
`qbo-posting` run (`checkin-app/src/app/api/cron/qbo-posting/route.ts`), isolated
like every other step. If it fails, the run records the failure as `lists` and
the posting lanes still run. The infra repo already schedules this run, so
nothing changes there.

**Update now.** One shared button, `QuickBooksListsRefresh`, lives in
`@checkin/component-ui`, because every library page already takes its client
kit from there. The button shows "QuickBooks lists as of <time>" next to an
"Update now" control (QL-5). Pressing it calls
`POST /api/books-map/quickbooks-lists/refresh`, which Finance or the Board may
call (QL-4). That route runs the same refresh. On success it answers with the
new time and the entry counts. If QuickBooks can't be read, it answers with a
503 and the existing wording. After a successful refresh, the button tells its
page to reload that page's picker options. The time comes from
`GET /api/books-map/quickbooks-lists`.

The button sits on the Books map and beside each QuickBooks picker:

| Screen | Picker |
|---|---|
| `checkin-app/src/app/books-map/page.tsx:69`, `:70` | Class and account pickers (also the button's place at the top of the screen) |
| `checkin-app/src/app/budgets/page.tsx:81` | Bucket Class picker |
| `packages/expense/src/pages/qbAccounts.tsx:30` | Expense account list |
| `packages/expense/src/pages/accountMapping.tsx:72` | Expense account rules |
| `packages/expense/src/components/AccountHoldsPanel.tsx:99` | Held expense line's account |
| `packages/bulk-donation/src/pages/accountMap.tsx:60` | Donation account map |
| `packages/bulk-donation/src/pages/inKindQueue.tsx:203` | Gift-of-goods line's account |
| `packages/income/src/pages/items.tsx:57` | Income item's account |

### 4. A missing entry, an outage, and an old copy

Saves never read QuickBooks (QL-2), so these cases need no special branch:

| Situation | Picker | Save whose entry the copy holds, of an accepted type | Save whose entry the copy lacks, or holds under another type |
|---|---|---|---|
| QuickBooks up or down, copy at any age | Shows the copy and its date | Checked against the copy and saved | Refused (below) |
| Copy empty (before the first refresh) | Empty, with the button | (none) | Refused (below) |

**The refusal.** The save answers 400 with the code `quickbooks-list-stale`, and
the message names what is missing: "QuickBooks' list in the app doesn't have
that account" (or "lists it as <type>"), followed by "If you changed it in
QuickBooks, press Update now, then save again." Library services send it as
`ServiceError(400, …, "quickbooks-list-stale")`. Host routes send it as
`ApiResponseError(400, …, "quickbooks-list-stale")`. Both already turn the code
into `{ error, code }`. The client kit's fetch helper doesn't yet show
`code` to pages, so PR 3 adds that. A page that gets this code puts
`QuickBooksListsRefresh` beside the refusal message.

The type check itself (`accountTypeRefusal`,
`packages/quickbooks/src/accountTypes.ts:52`) keeps its logic. Only its
"no account" wording changes, to name the app's copy rather than QuickBooks.
Every refusal it returns carries the code, because a missing entry and a wrong
type can both come from an out-of-date copy.

**An old copy** (QL-3) is still used. A new System Status row, "QuickBooks
lists", is green with "Refreshed <time>". It turns red after two days without a
successful refresh. If finance changes a stored account's type in QuickBooks
during a long outage, the existing account-types row still catches it, because
that row reads QuickBooks live.

The planned interim fix, which runs the account-type check only when the
account changes, still holds under this design. It can land first: it also lets
edits that don't touch the account skip the copy.

### 5. Security boundary

Two new routes mean two new registry entries. They ship in their own boundary
PR, before the route PR (`AGENTS.md`, boundary isolation rule):

| Entry | Authorize | Returns | View |
|---|---|---|---|
| `GET /api/books-map/quickbooks-lists` | `finance-or-board` | `QuickBooksListsStatus` | `FINANCE_OR_BOARD_VIEW` |
| `POST /api/books-map/quickbooks-lists/refresh` | `finance-or-board` | `QuickBooksListsStatus` | `FINANCE_OR_BOARD_VIEW` |

Both go in `checkin-app/src/security/registry/budgetOwner.ts`, next to the other
books-map routes.

The boundary PR also adds one synthetic classification, in
`checkin-app/src/security/budgetOwnerSyntheticClassifications.ts`:

```ts
QuickBooksListsStatus: {
  list: "internal",
  refreshedAt: "internal",
  entries: "internal",   // a count, not the list
},
```

These are not boundary changes:

- The new table's `@sensitivity:internal` annotations. They cover new fields,
  not a re-tier of existing ones, so they ship with the table.
- `QuickBooksAccountOption` and `QuickBooksClassOption`, which keep their shape.
  The pickers return the same fields, read from the copy.
- The refusal's `code`. It is an error envelope, not a classified response.

### 6. PRs, in order

Every PR is based on `main`; none is stacked.

1. **Boundary:** the two registry entries and `QuickBooksListsStatus`. They do
   nothing until the routes exist, so this PR can open straight away.
2. **The copy:** the table and its migration, `refreshQuickBooksLists`, the
   daily step in `qbo-posting`, and the switch of `listQuickBooksAccounts`,
   `listQuickBooksClasses` and income's Class check on save over to the copy,
   with the `quickbooks-list-stale` refusal. It carries the `docs/rules` edits
   above and deletes this doc. It doesn't depend on PR 1, so the two can run in
   parallel. Until PR 3 lands, the refusal's text names "Update now" but no page
   shows the button yet. The daily run is the only refresh in that gap, so merge
   PR 3 soon after PR 2, or hold PR 2 until PR 3 is ready.
3. **Update now:** the two routes, the `QuickBooksListsRefresh` button in
   `@checkin/component-ui`, the client kit change that shows the refusal's
   `code`, the button on the Books map and the eight picker screens listed in
   §3, and the System Status row. It goes after PRs 1 and 2 merge.

## Tests

- PR 2: unit tests showing that a save whose entry is in the copy makes no
  QuickBooks call; that a missing entry, a wrong type and an empty copy are
  each refused with `quickbooks-list-stale` and make no QuickBooks call; and
  that posting readers still call QuickBooks. One integration test showing
  that a refresh replaces both rows in one transaction, and that a failed read
  leaves both rows as they were.
- PR 3: route tests for the Finance-or-Board gate and the 503 wording, and a
  component test showing that the button reloads its page's options and appears
  beside a `quickbooks-list-stale` refusal. No flow test is needed, because no
  flow-test server reaches QuickBooks.

## Alternatives considered

- **Reading QuickBooks live when the copy lacks an entry.** Finance wouldn't
  need the button after adding an account, but saves would depend on QuickBooks
  again whenever an entry is new. The owner chose an explicit refresh (QL-2).
- **An in-memory cache per process.** It is lost on every deploy and isn't
  shared between tasks, so it would be empty at exactly the moments an outage
  tends to follow.
- **A row per entry.** That lets a query find one account, which no reader
  does, and it costs a delete-and-insert per refresh instead of one update.
- **A new cron job for the refresh.** It needs an infra change and a second
  secret, and gains nothing over a step in the run that already reads
  QuickBooks every day.

## Appendix: provenance

- Audit finding PR3070-F03: during a QuickBooks outage, every edit to the
  expense account list returns 503. The type check reads QuickBooks live even
  when the edit doesn't change the account.
