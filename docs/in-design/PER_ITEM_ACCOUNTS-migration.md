# Cutover: per-item accounts

The one-time part of `PER_ITEM_ACCOUNTS.md`: where things stand, how existing
settings carry over, and the build order. Everything here stops being true once
the last PR merges. Its last step is "extract the rules, delete both files".

## Where it stands

- Designed. PIA-1 (proportional) and PIA-2 (blank is zero; a fees-only row goes
  to finance) are settled. PIA-3 to PIA-9 are open (design, "Waiting on the
  owner").
- **Giving-platform gifts have lost their per-rule accounts.** PR 1 below
  restores them. The trace, on `main` at the time of writing:
  - `packages/bulk-donation/src/lib/disbursement-processor.ts`: when a batch
    finishes, each gift is matched to exactly one account rule, and the rule's
    donation, match and fees account names are written onto the batch's items.
    This still works.
  - `packages/bulk-donation/src/lib/deposit-handover.ts`: `expectedDeposit`
    builds the lines income gets with a fixed role per kind
    (`BENEVITY_DONATIONS`, `BENEVITY_MATCHES`, `BENEVITY_FEES`). It groups by
    kind and bucket and never reads the item's account.
  - `packages/income/src/lib/intake.ts`: an expected-deposit line is a role,
    bucket, amount and description, with no account field, so nothing could
    carry one.
  - `packages/income/src/lib/outbox.ts`: `buildDeposit` resolves every line's
    account from the role's books-map account.

  The result: every gift books to "Benevity: donations", every match to
  "Benevity: employer matches" and every fee to "Benevity: fees", whatever the
  rules say. The rules now only hold a batch whose gifts match no rule or
  several.
- **How it was lost,** over three PRs:
  - #2174 built donation's own QuickBooks lane, which booked each item to its
    rule's account (looked up by name) and grouped lines by kind, account and
    Class.
  - #2630 handed the deposits to income. Lines carried the rule's account name,
    but income used it only while the line's role had no account; once finance
    set the role, the role won.
  - #2653 retired donation's lane and the environment fallbacks, and removed the
    account name from the expected line, the hand-over and income.
- **Production impact: unverified.** As far as the coordinator knows, production
  has no QuickBooks realm set, so no giving-platform deposit has posted there
  and nothing should have booked to the wrong account. Nobody has checked
  production to confirm it. If any did post, those deposits stay as they are:
  the app never edits the books, and finance reclasses by hand.

## Existing settings

No stored row is rewritten, and no script moves data.

| Setting | Today | After |
|---|---|---|
| Books-map role accounts | One per role | Unchanged; each is the default. A role account that fails the new type check stops its lane and alerts finance (PR 2); finance re-picks it. |
| Giving-platform account rules | Three account *names* per rule | Names kept, read-only. New nullable id columns, empty. A rule with no id books on the role until finance picks one. |
| Finished batches not yet booked | Items carry names only | Book on the role. Finance can dismiss and book by hand any it wants on a rule's account. |
| Income items | Bucket per variant | New nullable account id, empty. Every item books on the role until finance sets one. |
| Expense account rules | Account id per rule | Unchanged. Gifts of goods start reading them (PR 5), so any rule matching a donated part moves that part's future journal lines. Finance should review rules with a `*` part before PR 5 ships. |
| Fees role and rule fees column | In use | Stop being read once fees reduce income; values stay until a decommission the owner schedules (PIA-7). |

Expand only: every schema change is an added nullable column, safe against the
previous release still serving traffic.

## Build plan

One PR per row, each based on `main`, none stacked. Each one carries the rule
lines it establishes into `docs/rules/` and updates the books-map table in
`docs/ops/quickbooks-go-live.md` step 5.

| PR | Kind | What | Waits on |
|---|---|---|---|
| 1 | Code | **Restore giving-platform accounts.** Nullable account-id columns on the account rules (annotated `@sensitivity` in the schema; the routes' registry entries are unchanged, so no boundary PR) and pickers for them on `/donations/account-map`. At batch finish each item also takes its rule's id. The hand-over carries it on each line, grouped by kind, account and bucket. Income's expected line gains an optional account id that it uses in place of the role; the role is the fallback. If PIA-3, PIA-4 and PIA-6 are answered before it opens, the per-row fee split (design §5.2) ships here too, since it touches the same two functions. | Nothing |
| 2 | Code | Account types per role in `@checkin/quickbooks`. Books-map save refuses a wrong type; System Status and the lane checks flag a stored one; every override is checked against its role; pickers filter by type. | PIA-9 |
| 3 | Code | Giving-platform fees reduce income, if not already in PR 1: per-row split at batch finish, fee parts on each amount item, fees role and column no longer read. | 1, PIA-3, PIA-4, PIA-6, PIA-7 |
| 4a | Boundary only | The account id on the synthetic `IncomeItemView` classification, and any new picker route's registry entry. | Nothing |
| 4 | Code | Online-store sales per item: account on income items, `/income/items` picker, deposit lines grouped by account and bucket. Fee split too if PIA-5 is yes. | 4a, PIA-5 |
| 5 | Code | Gifts of goods per part: port from bulk-donation to expense's rule matcher, bound by the host; debit lines take the rule's account or fall to the role. | PIA-8 |
| 6 | Decommission | Drop the fees role(s) and the rule fees column, if and when the owner schedules it. Boundary entries for removed fields only, under the decommission exception. | 3 (and 4), owner |

PR 2 can land in any order with the others; an override saved before it lands is
checked from then on.

## Last step

Extract the rule lines in design §9 that are not already in `docs/rules/`,
delete both files.
