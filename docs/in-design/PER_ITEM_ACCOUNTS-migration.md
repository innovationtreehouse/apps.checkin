# Cutover: per-item accounts

The one-time part of `PER_ITEM_ACCOUNTS.md`: where things stand, how existing
settings carry over, and the build order. Everything here stops being true once
the last PR merges. Its last step is "extract the rules, delete both files".

## Where it stands

- Designed. PIA-1 to PIA-9 are open (design, "Waiting on the owner").
- Giving-platform gifts have booked on the single books-map accounts since
  income took over their deposits. The account rules still pick one rule per
  gift, and a finished batch's items still carry the rule's account *name*, but
  the hand-over drops it: `packages/bulk-donation/src/lib/deposit-handover.ts`
  builds lines from `ROLE[item.type]` alone, income's expected-deposit line has
  no account field (`packages/income/src/lib/intake.ts`), and income resolves
  every line through the role (`packages/income/src/lib/outbox.ts`). PR 2 below
  restores per-rule accounts.
- Deposits already created in QuickBooks on the single account stay as they are.
  The app never edits the books; finance reclasses any it wants moved by hand.

## Existing settings

No stored row is rewritten, and no script moves data.

| Setting | Today | After |
|---|---|---|
| Books-map role accounts | One per role | Unchanged; each is the default. A role account that fails the new type check stops its lane and alerts finance (PR 1); finance re-picks it. |
| Giving-platform account rules | Three account *names* per rule | Names kept, read-only. Two new nullable id columns, empty. A rule with no id books on the role until finance picks one. |
| Income items | Bucket per variant | New nullable account id, empty. Every item books on the role until finance sets one. |
| Expense account rules | Account id per rule | Unchanged. Gifts of goods start reading them (PR 5), so any rule matching a donated part moves that part's future journal lines. Finance should review rules with a `*` part before PR 5 ships. |
| Fees role and rule fees column | In use | Stop being read once fees reduce income (PR 3); values stay until a decommission the owner schedules (PIA-7). |

Expand only: every schema change is an added nullable column, safe against the
previous release still serving traffic.

## Build plan

One PR per row, each based on `main`, none stacked. Each one carries the rule
lines it establishes into `docs/rules/` and updates the books-map table in
`docs/ops/quickbooks-go-live.md` step 5.

| PR | Kind | What | Waits on |
|---|---|---|---|
| B | Boundary only | Registry and classification changes the new fields need: the account id on `IncomeItemView` and `IncomeItemCategory` responses, the id columns on `AccountMap` responses, and any new picker route. Schema `@sensitivity` annotations ride along. | Nothing |
| 1 | Code | Account types per role in `@checkin/quickbooks`; books-map save refuses a wrong type; System Status and the lane checks flag a stored one; pickers filter by type. | PIA-9 |
| 2 | Code | Giving-platform account ids: id columns and pickers on `/donations/account-map`; ids written onto batch items at finish; optional account id on income's expected-deposit line, type-checked on intake; lines grouped by kind, account and bucket. Restores per-rule accounts. | B, 1 |
| 3 | Code | Giving-platform fees reduce income: per-row split at batch finish, fee parts on each amount item, fees role and column no longer read. | 2, PIA-1 to PIA-4, PIA-6, PIA-7 |
| 4 | Code | Online-store sales per item: account on income items, `/income/items` picker, deposit lines grouped by account and bucket. Fee split too if PIA-5 is yes. | B, 1, PIA-5 |
| 5 | Code | Gifts of goods per part: port from bulk-donation to expense's rule matcher, bound by the host; debit lines take the rule's account or fall to the role. | 1, PIA-8 |
| 6 | Decommission | Drop the fees role(s) and the rule fees column, if and when the owner schedules it. Boundary entries for removed fields only, under the decommission exception. | 3 (and 4), owner |

PR 2 is the regression fix and should not wait on the fee questions.

## Last step

Extract the rule lines in design §9 that are not already in `docs/rules/`,
delete both files.
