# Cutover: protecting budget buckets at the source

This file holds the one-time part of `BUCKET_PROTECTION.md`: the order of the
PRs, how each proves itself, where its rules land, and the questions still
open. Everything here stops being true once the last PR merges. The last step
is "extract the rules, delete both files".

## Where it stands

- The owner ruled on 2026-11-15: refuse to archive a bucket unfinished work
  depends on; keep the copy of QuickBooks' lists current so inactive entries
  never appear in a picker; detect and alert when a Class in use goes inactive.
- Already merged and built on: a bucket's Class can be changed but not cleared;
  the copy of QuickBooks' lists with its daily refresh, Update now and the
  `quickbooks-list-stale` refusal; the picks row on System Status.
- Nothing in this design is built yet.

## Before PR 3 ships

The first check after PR 3 reports every bucket archived before PR 1 with work
still in it, and every live bucket whose Class is already inactive. Each sends
one email. Tell finance to expect them on the first run.

## Order

Each PR ships its own `docs/rules/` lines. None touches
`checkin-app/src/security/` or `middleware.ts`: no route is added, no response
field changes, and the refusals use the existing error envelope.

| PR | What | Depends on |
|---|---|---|
| 1. Archive refusal | `unfinishedBucketUses` in expense, bulk-donation and income; `archiveBudgetOwner` refuses; rule 1 into `expenses.md` | none |
| 2. Active-only pickers and saves | the eight pickers; `accountTypeRefusal` inactive case; Class check on bucket create, change and restore; rules 2 and 3 into `expenses.md` and `revenue.md` | none |
| 3. Detection and alert | `checkBucketClasses` after each refresh; the email template; the System Status row; rule 4 into `revenue.md` | PR 1 (its reads) |

PR 1 and PR 2 can run in parallel; they touch different files except
`budgetOwners.ts`, where PR 1 edits `archiveBudgetOwner` and PR 2 edits
create and update. Whichever merges second rebases.

## How each PR proves itself

- **PR 1.** Each library's read (Vitest): a closed expense, a booked gift, a
  deposited disbursement and a posted Benevity row are not counted; an open one
  of each is; a part map and an item mapping are; a comment rule is not. Host
  (Jest, `budgetOwners.test.ts`): archive refused with every kind named and
  nothing written; archive of an unused bucket audited as today; an unreadable
  library refuses with 503. Flow test in `budget-owners.flow.test.ts`: map a
  store item to a new bucket, archive is refused, unmap it, archive succeeds.
  Red on main: the refusal tests fail on assertions.
- **PR 2.** Component tests for each picker: an inactive entry is not offered,
  a stored inactive value shows the warning and the Update now button.
  `accountTypeRefusal`: an inactive account is refused with the stale-list code.
  `budgetOwners.test.ts`: create, Class change and restore refuse an inactive or
  missing Class; a restore that also sets an active Class succeeds; a rename of
  a bucket whose Class is inactive succeeds.
- **PR 3.** Unit tests for `checkBucketClasses`: a newly inactive Class records
  and emails once; a second run sends nothing; reactivation records the clear;
  inactive again emails again; an archived bucket with work is reported; a
  failed refresh runs no check. The System Status row: green, red with lines,
  "Not checked" on an empty copy, and no QuickBooks call. The email template is
  covered by the template registry's own test.

No PR needs a new browser spec. The flow-test server has no QuickBooks, so PR 3
proves itself in unit tests against a seeded copy.

## Open questions for the coordinator

- **BP-1.** A saved inactive pick: this design shows it as a warning beside the
  picker, not as a choice. Is a warning line "appearing in a picklist" in the
  owner's sense? Default: no, the warning stays.
- **BP-2.** Bucket pickers (expense lines, gifts, items, part maps) still list a
  live bucket whose Class is inactive, because the alert asks finance to fix
  the one Class rather than every assignment. Should they mark or hide such a
  bucket too? Default: no change in this work.

## Where the rules land

| Rule in the design | Destination |
|---|---|
| 1. Archive refused while unfinished work points at the bucket | `docs/rules/expenses.md`, "Budget buckets", replacing "archives buckets" in the first line with the narrower rule |
| 2. Pickers list only active entries | `docs/rules/revenue.md`, beside the copy's refresh rule |
| 3. Saves refuse an inactive Class or account | `docs/rules/expenses.md`, "Budget buckets" (create, change, restore); `docs/rules/revenue.md` (accounts) |
| 4. Check after each refresh, alert once | `docs/rules/revenue.md`, beside the copy's refresh rule |

## Last step

Extract the rules above into their files, then delete `BUCKET_PROTECTION.md`
and this file.
