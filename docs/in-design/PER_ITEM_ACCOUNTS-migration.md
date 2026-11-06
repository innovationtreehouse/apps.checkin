# Cutover: per-item accounts

The one-time part of `PER_ITEM_ACCOUNTS.md`: where things stand, how existing
settings carry over, and the build order. Everything here stops being true once
the last PR merges. Its last step is "extract the rules, delete both files".

## Where it stands

- Designed. Every owner question, PIA-1 to PIA-11, is settled.
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
  - `packages/income/src/lib/outbox.ts`: `depositWrite` resolves every line's
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

No stored row is rewritten, and no script moves data. Because nothing defaults,
every area that gains a mapping holds until finance fills it in. That is the
point, and the go-live doc's step 5 gains the work.

| Setting | Today | After |
|---|---|---|
| Giving-platform account rules | Three account *names* per rule | Names kept, read-only. New nullable id columns, empty. A batch whose gift matches a rule without the id it needs holds until finance picks one. |
| Finished batches not yet handed over | Items carry names only | Can't be handed over with an account. They go to finance by the existing once-only email, to book by hand. |
| Income rows already handed over, not yet booked | Role-only lines | Go to finance: income no longer books a line without an account. |
| Income items | Bucket per variant | New nullable account id, empty. Every item is undecided until finance sets its account, so payouts hold until then. |
| Custom items | Book as general income on "Shopify: sales" | Book to the new "Shopify: custom items" account; hold while it is unset. |
| Expense account rules | Account id per rule | Unchanged. Gifts of goods start reading them (PR 5), so any rule matching a donated part, `*` rules included, decides that part's future journal lines. Finance should review `*` rules before PR 5 ships. |
| Gifts of goods not yet booked | Book on the in-kind roles | Each line needs a rule or a hand-set account; the gift holds until it has one. |
| Retired roles: Shopify sales, Benevity donations, employer matches and fees, in-kind expense, fixed assets | In use | Hidden and no longer read once their replacement ships, then removed (PR 6, "Removing retired settings" below). |
| Remaining role accounts | One per role | Unchanged. One that fails the new type check holds its lane and alerts finance (PR 2); finance re-picks it. |

Expand only until PR 6: every schema change before it adds a nullable column,
safe against the previous release still serving traffic.

Before this ships on an instance with real volume, count what will hold: items
without an account, rules without ids, in-kind parts no rule covers. Finance maps
them ahead of the switch so the first run after each PR books rather than holds.

## Build plan

One PR per row, each based on `main`, none stacked. Each one carries the rule
lines it establishes into `docs/rules/` and updates the books-map table and step 5
in `docs/ops/quickbooks-go-live.md`.

| PR | Kind | What | Waits on |
|---|---|---|---|
| 1 | Code | **Restore giving-platform accounts.** Nullable account-id columns on the account rules (annotated `@sensitivity` in the schema; the routes' registry entries are unchanged, so no boundary PR) and pickers for them on `/donations/account-map`. A batch finishes only when each gift's rule has the ids its amounts need; otherwise it holds on the holds screen. At finish each item takes its rule's id; the hand-over carries it on each line, grouped by kind, account and bucket. Income's expected line requires an account id and books to it. "Benevity: donations" and "employer matches" are no longer read and are hidden. If PR A has merged when it opens, the per-row fee split (design §5.2) ships here too, since it touches the same two functions. | Nothing |
| A | Code | **One allocator, largest fraction.** Move expense's `allocateAmount` to `@checkin/money`, switch it to largest fraction with the design's tie rule, and have income's Shopify charge split call it. Expense's allocation tests change their expected cents where the two rules differ. | Nothing |
| 2 | Code | **Account types** (design §7) in `@checkin/quickbooks`. Books-map save and every per-item picker refuse a wrong type and filter their lists; System Status and the lane checks flag a stored one. | Nothing |
| 3 | Code | **Fees reduce income,** if not already in PR 1: per-row split at batch finish through the shared allocator, each fee part netted into its amount item. "Benevity: fees" and the rule fees column are no longer read, and the books map, the account-rule screen and System Status hide them. | 1, A |
| 4a | Boundary only | The account id on the synthetic `IncomeItemView` classification, and any new picker route's registry entry. | Nothing |
| 4 | Code | **Online-store sales per item:** account on income items and its `/income/items` picker; an item is decided only with an account; deposit lines grouped by account and bucket; the new "Shopify: custom items" role; "Shopify: sales" no longer read and hidden. | 4a |
| 5a | Boundary only | The registry entry for setting an account on a held gift-of-goods line, if that needs a new route rather than a field on an existing one. | Nothing |
| 5 | Code | **Gifts of goods per part:** port from bulk-donation to expense's rule matcher, bound by the host; a nullable hand-set account on each gift line; a line no rule resolves holds the gift for finance to set. "In-kind expense" and "fixed assets" no longer read and hidden. | 5a |
| 6 | Decommission | Remove every retired role and the rule fees column, as below. | 1, 3, 4 and 5 deployed to production, and the precondition below |

## Removing retired settings

Two releases, so no running code ever reads something already gone.

**Release with each replacement PR: hide.** Once PR 1, 3, 4 or 5 ships, nothing
reads the roles it replaces, and no screen shows them. New expected deposits
carry account ids and no fee lines; new journal lines carry their own accounts.

**Precondition for PR 6,** checked in production by a read-only query in the
service's one-off task before PR 6 opens:

- No income row still waiting or open whose expected deposit has a line without
  an account id. Such a row came from a batch handed over before PR 1. Finance
  books or dismisses each one.
- No finished batch that income has not yet taken and whose items lack account
  ids or include a fee item. The re-send job raises these to finance; wait for
  finance to settle them.
- No gift of goods waiting to book from before PR 5.

**PR 6: remove.** One PR, all green:

- Remove `SHOPIFY_SALES`, `BENEVITY_DONATIONS`, `BENEVITY_MATCHES`,
  `BENEVITY_FEES`, `INKIND_EXPENSE` and `FIXED_ASSETS` from the books-map roles,
  their labels and the lanes' required roles.
- A checkin migration deletes those roles' rows from the books-map table. Their
  audit history stays.
- A bulk-donation migration drops the rule fees column, with its schema
  annotation, from the model and the regenerated classifications.
- Income keeps reading retired roles in the expected deposits it already
  stores, because posted rows keep their history. Intake refuses them on any new
  deposit. A short list of retired roles, beside the live ones, is what both
  checks read.
- Old batch payloads keep their names and fee items. They are history and are
  never handed over again.
- Run the rule 2 sweep from `docs/ops/DEPLOY_MIGRATION_ORDER_OF_OPERATIONS.md`
  for each role and the column: seed, scripts, tests, docs, the go-live doc's
  books-map table.

If the boundary check treats the column's removal from the classifications as a
boundary change outside the decommission exception, that part ships first as
its own boundary PR. Rule 3 still holds: nothing is dropped until the release
that stopped reading it has fully replaced the code that did.

## Last step

Extract the rule lines in design §9 that are not already in `docs/rules/`,
delete both files.
