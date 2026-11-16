# Protecting budget buckets at the source

## Problem

Every income, donation, expense and gift-of-goods line that books to a budget
bucket books with that bucket's QuickBooks Class. Two things can make a bucket
unusable after work has already been pointed at it:

- **Finance archives the bucket** while open expenses, donations not yet
  deposited, gifts of goods not yet booked, or store items still point at it.
  The app archives it without asking. The work then waits, or fails to post,
  and finance only learns of it when posting stops.
- **Someone makes the bucket's Class inactive inside QuickBooks.** The app's
  copy of QuickBooks' lists picks that up at its next refresh, but nothing
  compares it with the buckets. The Class still shows, marked inactive, in the
  bucket pickers, and the bucket keeps taking lines until posting fails on it.

In both cases the money is held at the end of the pipe, where it is hardest to
fix, instead of being refused at the moment the bucket became unusable.

## Objective

A bucket nothing unfinished depends on archives as it does today. A bucket that
still has unfinished work is refused, and the refusal says what to move first.
No picker ever offers an inactive QuickBooks Class or account, and no save
accepts one. When a bucket's Class goes inactive in QuickBooks, finance gets one
alert and a System Status row before anything posts to it. Posting keeps
holding as the backstop.

## Executive summary

- **Finance:** Archive on the Budgets page is refused while anything unfinished
  points at the bucket. The message lists each kind, with a count and the page
  where finance moves it. Pickers list only active Classes and accounts. A
  saved pick that has since gone inactive shows as a warning beside the picker,
  never as a choice. Finance gets one email when a bucket's Class goes inactive
  in QuickBooks, and another if it happens again after being fixed.
- **The Board and sysadmins:** System Status gets one row, "Budget buckets:
  QuickBooks Classes", red while any live bucket's Class is inactive or missing
  from the copy, or any archived bucket still has unfinished work.
- **Posting:** no change. Each lane still holds a line whose bucket is archived
  or has no usable Class.
- **Not changing:** restoring a bucket, the rule that a Class can be changed but
  not cleared, the daily refresh and "Update now", and income's own alert at
  posting for items in an unusable bucket.
- **Cost:** one read per library, one check in the host, one email template, one
  System Status row. No schema change, no new route, no infra change.

## Decisions

The coordinator settled these on 2026-11-15. The BP IDs stay stable so later
threads can cite them.

- **BP-1.** A saved pick the copy shows as inactive or no longer holds is shown
  as a warning beside the picker, never as a choice in it. A warning is not a
  choice, so it keeps the rule that an inactive entry never appears in a
  picklist.
- **BP-2.** Bucket pickers (expense lines, gifts, items, part maps) keep listing
  a live bucket whose Class is inactive. The alert asks finance to fix the one
  Class rather than every assignment, and posting holds the lines meanwhile.
- **BP-3.** A line assigned in the moment between an archive's check and its
  commit may reach the just-archived bucket. This is an accepted limit (§3).

## Rules this design establishes

1. Finance archives a bucket only when nothing unfinished points at it: an open
   expense line, a giving-platform gift not yet deposited, a gift of goods not
   yet booked, a donated line waiting for capital review, a store item mapped to
   it, or a part mapped to it for future receipts. The refusal names each kind,
   how many, and where finance moves them.  [Decision — owner]
2. Every QuickBooks Class and account picker lists only entries the app's copy
   of QuickBooks' lists shows as active. A saved pick the copy shows as inactive
   or no longer holds is shown as a warning, not offered as a choice.
   [Decision — owner]
3. A save refuses a Class or account the copy shows as inactive, the same way it
   refuses one the copy lacks. This covers creating a bucket, changing its
   Class and restoring it.  [Decision — owner]
4. After each refresh of the copy, the app checks every live bucket's Class, and
   every archived bucket that still has unfinished work. It alerts finance once
   for each bucket and problem, shows them on System Status, and alerts again if
   a problem comes back after it cleared.  [Decision — owner]

## Rules this relies on or changes

- `docs/rules/expenses.md`, "Budget buckets": finance creates, renames and
  archives buckets; archiving keeps the row. Rule 1 narrows when finance may
  archive.
- `docs/rules/expenses.md`: a bucket is created with its class, which can be
  changed but not cleared. Rule 3 adds that the Class must be active.
- `docs/rules/expenses.md`: finance may restore an archived bucket, and it comes
  back with its class. Rule 3 adds that its Class must be active, or the same
  save picks an active one.
- `docs/rules/revenue.md`: the copy of QuickBooks' lists refreshes once a day and
  on "Update now", and is used at any age. Rule 4 runs after each refresh.
- `docs/rules/revenue.md`: an item can be assigned only to a live bucket with an
  active Class, checked against the copy. Unchanged; rule 3 extends the same
  check to the bucket itself.
- `docs/rules/revenue.md`: when a run finds an assigned bucket unusable, income
  alerts finance once and holds the payout. Unchanged. Income's alert is about
  items at posting; rule 4's is about the bucket at refresh. A bucket can trigger
  both.
- `docs/rules/revenue.md`: a gift of goods in an archived or Class-less bucket
  waits in finance's queue and the app never reassigns it. Unchanged. Rule 1
  stops new cases; rule 4 reports old ones.

## Design

### 1. What points at a bucket

A bucket is `BudgetOwner` in the checkin database. Each library stores its id in
its own database, with no foreign key, so only the library can say what still
points at it.

| Library | Where | What it is | Counts as unfinished |
|---|---|---|---|
| expense | `ExpenseLineItem.ownerId` | A receipt line charged to the bucket | When its expense is not in `CLOSED_STATES` (`qb_complete`, `qb_skipped`, `rejected`). Covers approvals, sign-off, capital review and posting |
| expense | `DonatedCapitalLine.budgetOwnerId` | A donated line in capital review | While `reviewedAt` is null |
| expense | `PartOwnerMap.ownerId` | A part mapped to the bucket for future receipts | Always: it routes new lines to the bucket |
| bulk-donation | `Transaction.ownerId` | A giving-platform gift's bucket | Until its disbursement is handed to income |
| bulk-donation | `InKindDonation.budgetOwnerId`, `ManualInKindDonation.budgetOwnerId` | A gift of goods' bucket | Until the gift is booked, refused or returned |
| bulk-donation | `TransactionCommentRule.ownerId` | A rule giving future gifts with this comment the bucket | No: the upload already skips a rule whose bucket is archived |
| income | `IncomeItemCategory.budgetOwnerId` | A store item's bucket | Always: it routes new sales to the bucket |
| income | `PayoutReconciliation.expected` lines with `budgetOwnerId` | A Benevity deposit handed to income | While its status is not `POSTED`, `MATCHED` or `RESOLVED` |
| checkin | `BudgetOwnerTreasurer`, `BudgetOwner.ownerId` | The bucket's approvers | No: they come back with the bucket on restore |
| any | Audit logs | History | No |

"Until handed to income" and "while not posted" together cover a Benevity gift
from upload to deposit, so a due Benevity line is counted in exactly one place
at any moment.

Each library exports one read beside `misTypedQuickBooksPicks`:

```ts
/** What in this library still needs bucket `id`, one line per kind, in finance's words; empty when nothing does. */
export function unfinishedBucketUses(id: number): Promise<BucketUse[]>;

interface BucketUse { what: string; count: number; where: string }
```

`what` is plain words ("open expense lines"), `where` is the page finance moves
them from ("Expenses › Approvals"). The host joins the three results.

### 2. The archive refusal

`archiveBudgetOwner` (`checkin-app/src/lib/finance/budgetOwners.ts`) calls the
three reads before it archives. If any returns a line, it refuses with 409 and
writes nothing:

> This bucket still has unfinished work. Move it to another bucket first:
> 3 open expense lines (Expenses › Approvals); 1 gift of goods not yet booked
> (Gifts of goods › Queue); 4 store items (Income › Items).

The message is the existing `error` string, so no response shape changes. The
Budgets page already shows a failed archive's message under "Bucket not
archived". An already-archived bucket answers as today, with no reads.

If a library can't be read, the archive is refused with 503, "Can't check what
still uses this bucket; try again." Archiving is rare and never urgent, so it
fails closed.

### 3. A race between archive and a new line

Each library checks that a bucket is live when it assigns it, by reading the
host's bucket list, then writes in its own database. Two databases can't share a
lock, so a line assigned in the moment between the archive's reads and its
commit can land in a just-archived bucket.

The design accepts this window rather than building a cross-database lock:

- It needs two finance actions within milliseconds of each other on the same
  bucket, one of them an archive.
- The check in §5 finds an archived bucket with unfinished work at the next
  refresh, alerts finance and shows it on System Status.
- Posting still holds the line, as today.

Finance's fix is the same as for any such line: restore the bucket, or move the
line.

### 4. Active-only pickers and saves

The copy already stores each entry's `active` flag
(`checkin-app/src/lib/finance/quickBooksLists.ts`). The Class list query asks
QuickBooks for active and inactive Classes, so a Class deleted in QuickBooks,
which QuickBooks keeps as inactive, reaches the copy as inactive. A Class or
account that disappears from QuickBooks altogether is simply missing from the
copy. Both are "not active" below.

How often it refreshes does not change: first step of the daily `qbo-posting`
run, and "Update now" for finance or the Board.

**Pickers.** Each picker lists only active entries of the types it takes. Where
the stored value is inactive or missing, the picker shows it as a warning line,
"<name> is inactive in QuickBooks. Pick an active one.", with the shared Update
now button, and leaves the select on its placeholder. Today several pickers add
the stored value as an "(inactive)" option; that option goes.

| Picker | Lists |
|---|---|
| `checkin-app/src/app/budgets/page.tsx` | Classes, on create and edit |
| `checkin-app/src/app/books-map/page.tsx` | Classes and role accounts |
| `packages/expense/src/pages/qbAccounts.tsx` | Expense account list |
| `packages/expense/src/pages/accountMapping.tsx` | Expense account rules |
| `packages/expense/src/components/AccountHoldsPanel.tsx` | Held line's account |
| `packages/bulk-donation/src/pages/accountMap.tsx` | Donation account map |
| `packages/bulk-donation/src/pages/inKindQueue.tsx` | Gift-of-goods line's account |
| `packages/income/src/pages/items.tsx` | Income item's account |

The build greps every reader of the two list routes, so a picker missing
from this table is caught there.

**Saves.** A picker filter alone can be bypassed by the API, so each save checks
too:

- Accounts: `accountTypeRefusal` (`packages/quickbooks/src/accountTypes.ts`)
  gains an inactive case: "QuickBooks' list in the app shows <name> as
  inactive". `QboAccountSummary` gains `active`. Every account save already
  goes through this one function with the `quickbooks-list-stale` code, so the
  refusal and its Update now hint reach every page at once.
- Classes: `createBudgetOwner` and `updateBudgetOwner` check the new Class
  against the copy and refuse one that is missing or inactive, with the same
  code and hint. A restore (`archived: false`) checks the bucket's Class, unless
  the same save sets a new active one. Under `CHECKIN_ENV=local` they check the
  stand-in list.
- An edit that leaves the account or Class unchanged is not checked, as today.
  A bucket whose Class went inactive can still be renamed.

### 5. Detecting an inactive Class in use

One host function, `checkBucketClasses()`, runs at the end of
`refreshQuickBooksLists()` after the copy is written. So it runs after the daily
refresh and after every "Update now", with no change to either caller. A refresh
that fails runs no check, and the last results stand.

It reports two problems:

| Problem | Which buckets |
|---|---|
| Class inactive or missing in the copy | Every live bucket with a Class |
| Archived with unfinished work | Every archived bucket where a library's `unfinishedBucketUses` is non-empty |

A live bucket with no Class is not new here: its lines already wait, and finance
can only set a Class, not clear one.

**Alert once.** Each finding is a pair: bucket and problem. The check records a
new pair in checkin's `AuditLog` as `BUCKET_UNUSABLE` and a cleared one as
`BUCKET_USABLE`, both on `tableName: "BudgetOwner"`. It emails only for pairs it
just recorded, after the commit, so a failed send loses that one email and never
doubles it. This is income's `checkBuckets` pattern
(`packages/income/src/lib/buckets.ts`), with the host's audit log in place of
income's.

The email is a new template, `finance.bucketClassUnusable`, sent to the finance
alert address: bucket name, the problem in finance's words, and a link to the
Budgets page. A bucket whose Class went inactive gets: "<bucket>'s QuickBooks
Class <name> is inactive in QuickBooks. Lines in this bucket will wait until you
pick an active Class or reactivate it in QuickBooks."

**System Status.** One row, "Budget buckets: QuickBooks Classes", reads the
open pairs from the audit log, so it costs no QuickBooks or library call. It is
green with "Every live bucket's Class is active", red with one line per open
pair otherwise, and "Not checked: the QuickBooks lists have not been copied
yet" before the first refresh.

### 6. Edge cases

- **A Class reactivated in QuickBooks.** The next refresh sees it active, the
  check records `BUCKET_USABLE`, the row clears, and the Class reappears in
  pickers. Nothing else changes, because the bucket kept its Class. Finance
  presses Update now to see it at once.
- **A Class made inactive again later.** The pair was cleared, so it is new
  again: one more alert.
- **Finance picks a different active Class.** The bucket is live with an active
  Class. The next refresh, or the Update now beside the picker, clears the pair.
- **A bucket restored.** Its Class must be active (§4). It drops out of the
  "archived with unfinished work" problem at the next check.
- **A bucket archived with work still in it, by any route.** The next check
  reports it like any other archived bucket with unfinished work.
- **Two refreshes at once.** Each writes a whole copy. Both checks may find the
  same new pair; recording takes a transaction-level advisory lock on
  `bucket-class-check`, so only one records and emails it.
- **QuickBooks down.** The refresh fails, the check doesn't run, and the copy's
  own row turns red after two days. Saves and pickers keep using the copy.
- **A Class shared after a restore.** Not possible: no two buckets share a Class,
  and an archived bucket keeps its Class.

## Alternatives considered

- **Hold money lines after the fact.** What happens today. The owner ruled for
  refusing at the source instead.
- **A cross-database lock between archive and assignment.** Each library has its
  own database, so a lock would need a call to the host inside every
  assignment's transaction. The race needs two finance actions within
  milliseconds, and §5 reports the outcome, so the lock costs more than it
  saves.
- **A separate nightly job for the check.** The daily refresh already runs every
  day and is the only moment the copy changes, so a separate job would only
  re-read an unchanged copy.
- **Auto-moving lines out of an archived bucket.** The rules say the app never
  reassigns a line; finance decides.
