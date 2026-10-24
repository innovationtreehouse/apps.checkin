# One finance exception queue, decided on the record

Design for #2481. Theme 1 of the receipt-flow conversion audit
(`docs/in-design/receipt-flow-conversion-audit.md`, branch
`claude/receipt-flow-conversion-audit-85f095`).

## Summary

Finance gets one queue: the receipt review screen at `/receipts/review`. Today's
expense flags table (`/expense/flags`) and Account holds screen
(`/expense/holds`) go away. Every row in the queue is a record waiting on
finance, shown with its vendor, amount and a plain-word reason. Opening the row
opens the record, which says why it is waiting, marks the field the reason is
about, and has the action on the same page. When the action clears the last
reason the viewer can act on, the page returns to the queue.

Most of the twelve flag kinds go away, because each one repeats a condition the
expense already holds: a missing reimbursee, an unrecorded Board approval, a
QuickBooks post that ran out of retries. The queue reads those conditions
directly, so fixing the condition is what takes the row out of the queue; there
is no second act of checking it off. Four kinds stay as stored reviews, because
each one asks for a judgment that no fix records: a Board member stood in for
someone, QuickBooks shows a posted entry that has since changed, a closed
expense never posted, and a duplicate entry needs voiding. Those are decided on
the expense page with a note.

Board items get a Board tab on the same screen. The Board's approval of a large
purchase is one decision recorded in one place, the Record Board authorization
panel on the expense, and the `THRESHOLD_CROSSED` flag that duplicated it goes.

One schema change: the `capital_equipment_unit_cents` setting column is dropped (3.7). The work ships as two boundary PRs and five
feature PRs, in the order under "Rollout".

## What finance works from today

| Screen | What it holds | Where the decision is made |
| --- | --- | --- |
| `/receipts/review` (receipt library) | Receipts in finance review, duplicates, totals off, unreadable, errors; #2466 adds the other states, "Not delivered", and per-tab counts | Receipt detail page; returns to the queue after a decision (#2447 marks the field and words the reasons) |
| `/expense/flags` (expense library) | Open `ExpenseFlag` rows for FINANCE and BOARD: raw kind code, expense id, detail, date, Check off | The table itself, with an empty body (3.4); `REIMBURSEE_UNKNOWN` refuses check-off and the fix is elsewhere (3.10) |
| `/expense/holds` | Pending `ExpenseHold` rows (account mapping): raw reason, Set account, Resubmit | The holds screen; Set account on a no-match line does nothing (3.20) |
| `/expense/expenses?view=…` | Assign ownership, resolve ownership, exceptions, capital review, depreciation, QB pending | Expense detail page; reloads in place after a decision (3.12) |
| `/expense/expenses/[id]` | Retry QuickBooks post, Set reimbursee, Record Board authorization, open flags as text with a link back to `/expense/flags` | Here, except the flag the fix answers |
| Receiving › Apply failed (workflow-mapping) | Receipts whose apply failed, including the expense leg | Receipt page in receiving; inventory managers only |

The Inventory2 prototype had no flags table. Finance decided receipts in the
receipt app's `financial_review` queue and decided expenses on the expense
detail page, reached from filtered views of the expense list
(`/expenses?view=assign_ownership` and so on). The detail page showed the
reasons, offered the actions in place, and sent the user back to the view after
the decision. Account holds had their own page with plain-word reasons, the
no-match lookup context, the matched rules, and a Resubmit that stayed disabled
until every no-part-number line had an account.

## Where the flags came from, and what each one is for

The flags come from GC-FIN-CONTROL (`docs/backlog/TOPDOWN.md`) and §"Flag /
checkoff / audit" of `docs/in-design/1272_EXPENSE_QB_INTEGRATION.md`. The model
there is that the app does not enforce approval tiers; it puts a question in
front of the right human, who checks it off, and the audit log proves it. The
same section expects about one or two of each kind a year and asks for the
machinery to stay thin.

Since then the app gained real enforcement for most of those questions. Sign-off
seats hold a line until independent people sign; the Board-review total holds a
purchase until the Board's approval is recorded; the reimbursee hold stops
posting until finance names the person paid; receipt finance review holds tax
and date questions before a receipt ever reaches expense. A flag raised beside
one of those holds asks the same question twice, and checking it off records
nothing the hold doesn't. That is the root of 3.6, 3.9 and 3.10.

So the test for each kind is: what governance need does it serve, and is that
need already met by a decision recorded elsewhere?

## Design

### 1. A queue item is a condition on the record

Each queue row is computed from the record's own state when the queue is read.
For example, an expense is in the "Reimbursee to name" reason exactly while
`reimburseeUnknown(expense)` is true and the expense is open. Finance clears the
reason by doing the thing (setting the reimbursee); nothing else needs closing.

This replaces raising a flag row at one moment and checking it off later, which
let the two drift apart: a retry that succeeds leaves `QB_POST_FAILED` open
(3.9), and a check-off of `THRESHOLD_CROSSED` leaves the expense held (3.6).

A stored row is kept only where the decision is a judgment with nothing else to
record it. Those four kinds keep their `ExpenseFlag` rows, renamed "reviews" in
every screen, and are decided on the expense page with a note.

### 2. Fate of each flag kind

| Kind | Raised today | Fate | Queue tab and reason shown | Decided on | Action |
| --- | --- | --- | --- | --- | --- |
| `TAX_ATTACHED` | At intake, any tax above zero; #2479 narrows it to tax the receipt's settings hold for review that no receipt approval covers | Goes away where receipt finance review decided it. The remainder, after #2479, becomes a derived reason | Expenses: "Tax $12.40 not reviewed on the receipt" | Expense page; tax marked in the money block (theme 3 restores the field, 3.11) | Approve tax, note optional, matching receipt approval after #2465 |
| `THRESHOLD_CROSSED` | At intake, total at or over the Board-review total | Goes away; repeats the Board-approval hold (3.6) | Board: "Board approval of a $2,340.00 purchase not recorded" (derived from `needsBoardApproval`) | Expense page, Board authorization panel | Record Board authorization (text required, as today) |
| `CAPITAL_EQUIPMENT` | At intake, a unit price at or over `capitalEquipmentUnitCents` | **Decided: removed** (3.7). Capital review, where finance designates each line, is the only capital check, using `classifyCapital`'s two thresholds. The `capitalEquipmentUnitCents` setting goes with it | Expenses: "Capital review" | Expense page, Capital review panel | Submit capital review |
| `MISSING_RECEIPT` | Never (no caller) | **Decided: removed** (3.8). Every expense comes from a receipt, and the Treasurer handles notes in lieu of receipts outside the app (`docs/rules/expenses.md`, Assumptions) | none | none | none |
| `NON_EVERYDAY` | Never (no caller) | **Decided: removed** (3.8). It is left over from the retired "not Everyday" mark (#2437, #2440, #2441). The amounts decide Everyday, and a non-Everyday card charge already takes a Board seat | none | none | none |
| `COI`, "held" variants | A sign-off leaves a seat no one without a conflict can fill | Goes away as a row; becomes a derived reason from `blockedSeats` | Board: "No Board member without a conflict can sign; held" | Expense page, sign-off column | None in the app; see open question 4 |
| `COI`, "stood in" variants | A Board member took the Treasurer seat, or recorded the Board authorization, because no FINANCE holder could | Stays as a stored review | Board: "A Board member stood in for the Treasurer; review it" | Expense page, Reviews panel | Mark reviewed, note required; refused to signers and their households (as today) |
| `REIMBURSEE_UNKNOWN` | At intake, a reimbursement with no Person | Goes away; becomes a derived reason (3.10) | Expenses: "Reimbursee to name" | Expense page, Reimbursee panel, reimbursee marked | Set reimbursee; the reason clears in the same act |
| `QB_POST_FAILED`, retries exhausted | Fifth failed post (`NEEDS_FINANCE`) | Goes away as a row; derived from `qbMatchState = NEEDS_FINANCE` (3.9) | QuickBooks: "Posting failed 5 times: {last error, plain words}" | Expense page, QuickBooks panel | Retry; success clears it, a refusal shows as a red chip that stays open |
| `QB_POST_FAILED`, duplicate to void | The app posted an entry another record already claims | Stays as a stored review | QuickBooks: "Duplicate entry in QuickBooks needs voiding" | Expense page, Reviews panel | "I voided it", note required (which entry, when) |
| `QB_OVER_CAP` | Over the per-expense or per-run posting cap ($25,000) | Becomes a read-only note: an audit row and a line in the QuickBooks panel. Nothing waits on finance; the drain posts it alone, and a purchase that size already needed the Board's approval | none | none | none |
| `QB_DRIFT` | The daily check finds a posted entry changed in QuickBooks | Stays as a stored review; it is the one control that catches spending changed outside the app | QuickBooks: "Changed in QuickBooks after posting: amount, account" | Expense page, Reviews panel, with the stored and current values side by side | Accept the change, note required. A later change reopens it, as today |
| `QB_NO_CLASS` | A line's bucket has no QuickBooks Class | Goes away as a row; derived while the expense is postable and stopped for a missing Class | QuickBooks: "Budget bucket Facility has no QuickBooks class" | Expense page links to the bucket's Class setting | Set the Class; the next drain posts and the reason clears |
| `QB_POST_HELD` | A closed expense still held from posting | Stays as a stored review: a closed expense takes no further sign-off, so only a judgment can settle it | QuickBooks: "Closed but not posted: a line is missing a sign-off" | Expense page, Reviews panel | Mark handled, note required (for example, "entered by hand in QuickBooks") |

After this, `FLAG_KINDS` holds four kinds: `COI`, `QB_POST_FAILED`,
`QB_DRIFT` and `QB_POST_HELD`. Intake raises none. `COI` is raised only by
the stand-in paths, and `QB_POST_FAILED` only by the duplicate path. The
retired kinds' old rows stay in the table as history and are no longer listed.

### 3. The queue

`/receipts/review` stays the URL. The nav label becomes "Finance review", and
the screen keeps #2466's receipt tabs, its "Other states" picker and its counts.
Four expense tabs follow the receipt tabs:

| Tab | Reasons | Who acts |
| --- | --- | --- |
| Expenses | Bucket to assign; bucket unknown; exception raised by a budget owner; capital review; depreciation cycle; reimbursee to name; tax not reviewed; failed intake (below) | FINANCE |
| Account holds | One row per held expense: "2 lines have no account rule" | FINANCE |
| QuickBooks | Posting failed after retries; duplicate to void; changed in QuickBooks; closed but not posted; bucket has no Class | FINANCE |
| Board | Board approval not recorded; held, no conflict-free signer; Board member stood in, to review | Board, and FINANCE for recording the authorization |

The receipt library can't import the expense library (library boundary rule,
`scripts/check-library-boundaries.mjs`), so the host composes the screen. The
receipt review page takes a list of extra tabs from the host. Each tab has a
value, a label, a count and a body, and the host fills them from the expense
library's queue component. The receipt page keeps owning `?queue=`, so an
expense row opened from the QuickBooks tab returns to `?queue=qb`.

Every expense row shows the same columns: date, vendor, amount, the reason in
plain words, and how long it has waited. No row shows a kind code, a state
name or an id (3.5). An expense with two reasons shows one row per tab it
belongs to, with both reasons when they share a tab.

The expense list's finance views (`assign_ownership`, `resolve_ownership`,
`owner_exception`, `capital_review`, `set_depreciation_cycle`) fold into the
Expenses tab. The list itself stays at `/expense/expenses` for browsing, with
its views; the owner-approval view stays where budget owners use it.

### 4. The decision on the record

The expense detail page gains what the receipt detail page has had since #2447:

- **A reasons alert at the top**: "Waiting on finance:" or "Waiting on the
  Board:", one line per open reason in plain words. Each line names the panel
  that answers it, and the Reviews panel replaces today's "Open flags" box with
  its link back to `/expense/flags` (3.1).
- **The field marked.** The tax amount, the total against the Board-review
  total, the reimbursee, a held line's account, a line's bucket. Theme 3 puts the
  missing money fields back on the page (3.11); this design marks them.
- **The action in place**, in the panel for that reason. Retry in the
  QuickBooks panel closes the QuickBooks reason (3.9). Set reimbursee closes the
  reimbursee reason (3.10). Record Board authorization closes the Board-approval
  reason (3.6).
- **A note wherever the server keeps one**, marked required where the server
  requires it, with Confirm disabled while it is blank (3.4, 3.16):

  | Action | Note |
  | --- | --- |
  | Approve a line outside one's own buckets (FINANCE override) | Required. The approvals response says per row whether the caller's approval is an override, so the page knows before Confirm |
  | Raise exception, reject exception | Required |
  | Record Board authorization | Required (it is the authorization text) |
  | Mark a review reviewed or handled (the four kept kinds) | Required; the server starts refusing a blank one |
  | Approve tax on an expense | Optional |
  | Set account, Retry, Resubmit, Set reimbursee, capital review | None; the audit row records who and when |

- **Return to the queue** (3.12). When the page was opened from the queue
  (`?queue=` present) and an action leaves the viewer with no reason they can
  act on, the page goes back to that tab, the way receipt detail does. A
  partial decision, such as one line of three, reloads in place. A page opened
  from elsewhere always reloads in place.

### 5. Account holds on the expense page

Holds move onto the expense page as an Account holds panel, and `/expense/holds`
goes. The queue's Account holds tab lists the held expenses.

- **3.20**: the processor uses a line's `manualQbAccount` whatever the hold
  reason, not only for lines with no part number. `docs/rules/expenses.md`
  already lets any finance holder set "the account set on a mapping hold", so
  this is the rule working as written. A rule added later doesn't override an
  account finance set by hand on that line.
- **3.21**: each held line shows its reason in words ("No account rule matches",
  "Several account rules match", "No part number; pick an account"). A no-match
  line shows the category, subcategory and part number it was looked up by. A
  several-match line lists the matching rules by name and account, not as JSON.
- **3.22**: Resubmit is disabled, with the reason shown beside it, while any held
  line has no account. Today's server refusal stays as the backstop.

### 6. Receiving's Apply failed, and failed intake

Apply failed stays in Receiving (2.9). Retrying an apply is an inventory
manager's act (`retry-apply` is registered `inventory-manager`), and most
failures are on the inventory leg. The finance queue links to it instead:
#2466's "Not delivered" tab gains a line, "3 receipts failed to apply in
receiving", linking to Receiving › Apply failed. Receiving restores the Retry
button on each failed row, as the prototype had it. #2475 already shows apply
failures as red chips that stay open (2.15).

A receipt whose expense leg failed is finance's concern, because the purchase
never reaches the books. 3.27 found that finance can no longer see these. The
Expenses tab lists each failed `ReceivedExpensePayload` as "Receipt didn't
become an expense: {failure reason}", linking to the receipt in receiving. The
Expense events and Provisional items screens are not restored here; see open
question 7.

### 7. Counts

- **Receipt tabs**: #2466's `GET /api/receipts/queue-counts`, made conflict-aware
  for FINANCE by #2462's `countAwaitingFinance`. No change.
- **Expense tabs**: a new `GET /api/expense/finance-queue/counts` returns
  `{ expenses, accountHolds, quickbooks, board }`, each as
  `{ actionable, total }`. "Actionable" leaves out records the viewer is
  conflicted on, using the same `conflictedParties` predicate the refusals use.
  For the Board tab it counts only items this viewer may act on: a COI review
  they didn't sign, or a Board authorization they may record. The tab badges use
  #2466's `queueBadge`: green for actionable, gray for the rest.
- **Nav**: the Expense Ops "Holds" and "Flags" pills go. The "Finance review"
  link carries one green pill, the receipt and expense actionable counts added,
  through `/api/nav/todo-counts` as #2462 does for receipts. A Board-only
  viewer sees a pill only for Board items they can act on (3.26).
- Every action on either detail page fires `nav-counts-mutated`, so tab and nav
  counts refresh without a reload.

### 8. Screens, routes and the security registry

| Item | Change |
| --- | --- |
| `/expense/flags` page, `pages/flags.tsx`, `pageRegistry` entry | Removed; the path redirects to `/receipts/review?queue=expenses` |
| `/expense/holds` page, `pages/holds.tsx`, `pageRegistry` entry | Removed; redirects to `?queue=holds` |
| `GET /api/expense/flags` | Removed, in a later release than the page, so open tabs running old code keep working through the deploy |
| `POST /api/expense/flags/[id]/check-off` | Kept; called from the expense page's Reviews panel. The service refuses the retired kinds and a blank note |
| `GET /api/expense/expense-holds` | Removed with the holds page. Set account and Resubmit stay and are called from the expense page |
| `GET /api/expense/finance-queue?tab=…`, `GET /api/expense/finance-queue/counts` | New; `finance-or-board`. Rows are a synthetic `FinanceQueueRow` (vendor, date, amount, currency, reason codes, waiting since, expense id for the link) |
| `GET /api/expense/expenses/[id]/line-item-approvals` | Gains `overrideRequired` per row |
| `GET /api/expense/expenses/[id]` | Gains `reasons` (the open queue reasons) and the four review kinds in place of `flags` |
| `GET /api/expense/counts` | Drops `openFlags` and `holds` after the nav moves to the new counts |

Every registry change ships in its own PR, before the route PR, on `main` and
not stacked (AGENTS.md, "Boundary isolation rule"). The new routes need a
registry PR with the `FinanceQueueRow` synthetic classification before the
feature PR that mounts them. The shape changes to the detail and approvals
responses need their new fields classified in the same boundary PR. Removing the
two GET routes is a decommission: the registry entries go with the route files,
under the decommission exception, once nothing calls them.

### 9. Data and migrations

The only schema change is dropping `capital_equipment_unit_cents` from the expense settings (3.7). `ExpenseFlag` keeps its columns. The four kept kinds use
them as they do today, and the retired kinds' rows stay as history. A query
filters the list to the kept kinds, so old open rows of a retired kind drop out
of every screen and count the moment that code ships, with nothing to migrate.

The derived reasons read columns that exist: `qbMatchState`,
`reimburseePersonId`, `boardAuthorization`, expense state, approvals, holds,
`ReceivedExpensePayload.status`. The two open expense migrations (#2441, #2402)
touch other columns and aren't affected.

## Rollout

Each PR is based on `main`. None is stacked on another's branch.

1. **Prerequisites merge first**: #2466 and #2468 (receipt tabs and counts),
   #2462 (conflict-aware counts), #2464 and #2479 (tax approval carried to
   expense), #2465.
2. **Registry PR A** (boundary only): `finance-queue` and `finance-queue/counts`
   entries, `FinanceQueueRow`, and the new `reasons` and `overrideRequired`
   fields.
3. **Expense detail PR** (3.1, 3.4, 3.9, 3.10, 3.12, 3.16): the derived-reason
   service, the reasons alert and field marks, the Reviews panel, required notes,
   return to the queue, and Retry and Set reimbursee clearing their reasons.
   Intake stops raising `THRESHOLD_CROSSED`, `CAPITAL_EQUIPMENT` and
   `REIMBURSEE_UNKNOWN`, and the drain stops raising `QB_NO_CLASS`, exhausted
   `QB_POST_FAILED` and `QB_OVER_CAP`. `TAX_ATTACHED` becomes a derived reason
   built on #2479's `taxNeedsFinance`. `MISSING_RECEIPT` and `NON_EVERYDAY`
   (3.8) leave `FLAG_KINDS` and `FLAG_AUDIENCE` in
   `packages/expense/src/lib/flags.ts`, with the "raised by hand" sentence in
   `detectIntakeFlags`'s comment and the kind list in the `ExpenseFlag` comment
   in `packages/expense/prisma/schema.prisma`. Neither kind has a label to
   remove, and no row of either exists, because nothing ever raised one.
4. **Account holds PR** (3.20, 3.21, 3.22): the panel on the expense page, the
   processor honouring a manual account on every hold reason, and the Resubmit
   gate.
5. **Queue PR** (1.7, 3.3, 3.5, 3.6, 3.27, 2.9 link): the finance-queue routes,
   the host composition of `/receipts/review`, the four expense tabs, failed
   intake, the Apply failed link, counts and the nav pill. The Flags and Holds
   pages become redirects.
6. **Receiving Retry PR** (2.9): Retry on each Apply failed row. It's independent
   of the rest and can go any time.
7. **Registry PR B** (decommission), one release after step 5 is live: remove
   `GET /api/expense/flags` and `GET /api/expense/expense-holds` with their
   route files, and drop `openFlags` and `holds` from `/api/expense/counts`.
8. **Capital setting removal** (3.7), in two releases. Expand-and-contract, as
   #2441 did for the "not Everyday" marks
   (`docs/ops/DEPLOY_MIGRATION_ORDER_OF_OPERATIONS.md`):
   - Release 1, with step 3: stop reading and writing `capitalEquipmentUnitCents`.
     Remove it from `ExpenseSettings`, `THRESHOLD_RULES`, the settings schema
     and the Settings page, and mark the field `@ignore` in
     `packages/expense/prisma/schema.prisma`. Bulk donation's `largeValueCents`
     (`checkin-app/src/lib/bulkDonation/configure.ts`) reads the same setting, so
     it moves to `capitalLineItemThresholdCents`. That threshold compares with
     `>` where the old one used `>=`, and finance may switch it off, so the
     bulk-donation behaviour at exactly the threshold, and when it's off, has to
     be checked in that PR. The classification in
     `security/generated/expense-classifications.ts` is regenerated, so the
     settings route returns one field fewer.
   - Release 2, once release 1 is live in prod: a migration dropping
     `capital_equipment_unit_cents` from `org_settings` (`ExpenseOrgSettings`), wrapped in
     `BEGIN;`/`COMMIT;`. The column has a default, so release 1's inserts don't
     need it during the drain window.

Rolling deploys are safe at each step: the column drop waits a release behind the code that stops reading it, and the
GET routes outlive the pages that called them by a release.

## Rules

At merge, `docs/rules/expenses.md` would gain these:

- Finance works one queue. A reason for finance or the Board to act is shown on
  the record it is about, and taking the action clears it.
- Setting the reimbursee, recording the Board's authorization, and a successful
  QuickBooks retry each close the question they answer; no separate check-off
  follows.
- Four questions are recorded as reviews with a required note: a Board member
  standing in, a duplicate QuickBooks entry to void, an entry changed in
  QuickBooks after posting, and a closed expense that never posted. Nobody who
  signed the expense, or shares a household with a signer, reviews a stand-in.

#2224 proposes "The app flags an expense for review when it carries tax, crosses
a dollar threshold, includes capital equipment, has no known person to
reimburse, has a Board member standing in for someone, or fails to reach the
books." Under this design, tax, threshold, capital and reimbursee are holds or
review states, not flags. If this design is accepted, that sentence should be
reworded before #2224 merges, along the lines of the third bullet above. The
session correcting #2224 should know.

## How each audit item is resolved

| # | Finding | Resolution | Where |
| --- | --- | --- | --- |
| 1.4 | Finance-review reasons are raw codes; field not marked | Done for receipts by #2447. The expense page follows the same pattern (§4) | #2447; step 3 |
| 1.7 | No queue for several receipt states | #2466 adds them. The expense tabs join the same screen (§3) | #2466; step 5 |
| 2.9 | Apply failed lost its per-row Retry | Stays in Receiving with Retry restored; linked from the finance queue (§6) | steps 5, 6 |
| 2.15 | Apply failure is a self-closing orange toast | #2475 makes it a red chip that stays open. Expense actions follow the same rule | #2475; step 3 |
| 3.1 | Flags is a bare table away from the expense | Flags page goes. Reasons alert, field mark and action on the expense page (§4) | steps 3, 5 |
| 3.3 | Two finance queues | One screen, receipt and expense tabs (§3) | step 5 |
| 3.4 | Check-off never asks for the note | Kept reviews require a note, asked for on the page (§4) | step 3 |
| 3.5 | Raw kind code and expense id | Rows show date, vendor, amount, plain reason (§3) | step 5 |
| 3.6 | Board decision in two places | `THRESHOLD_CROSSED` goes; the Board-approval hold is the one Board tab item, recorded on the expense (§2) | steps 3, 5 |
| 3.7 | `CAPITAL_EQUIPMENT` and capital review use different thresholds and don't interact | Decided: the flag and `capitalEquipmentUnitCents` go; capital review is the only capital check (§2) | steps 3, 8 |
| 3.8 | `MISSING_RECEIPT` and `NON_EVERYDAY` are described as raised by hand, but nothing raises them | Decided: both kinds are removed (§2) | step 3 |
| 3.9 | QB flag and its fix apart; retry doesn't close it | Exhausted posts are derived from `qbMatchState`; Retry clears it (§2, §4) | step 3 |
| 3.10 | `REIMBURSEE_UNKNOWN` can't be checked off; fix elsewhere | Derived reason; Set reimbursee clears it in place (§2) | step 3 |
| 3.12 | Page reloads in place after the last decision | Returns to the queue tab it came from (§4) | step 3 |
| 3.16 | Override comment required only on the server | `overrideRequired` per row; required mark; Confirm disabled while blank (§4) | steps 2, 3 |
| 3.20 | Set account on no-match lines does nothing | Processor honours a manual account on every hold reason (§5) | step 4 |
| 3.21 | Holds lost lookup context and rule list; raw reason | Plain reasons, lookup context, matched rules listed (§5) | step 4 |
| 3.22 | Resubmit not disabled while a line lacks an account | Disabled with the reason shown (§5) | step 4 |
| 3.27 | Failed intake invisible to finance | Failed payloads are Expenses-tab rows; other two screens per open question 6 (§6) | step 5 |

## Open questions

1. **The URL and name.** The design keeps `/receipts/review` and renames the nav
   link "Finance review", so #2466's links and bookmarks hold. Would you rather
   have a host-level `/finance/review`, with `/receipts/review` redirecting?
2. **Expense finance views in the queue.** The design folds assign ownership,
   resolve ownership, exceptions, capital review and depreciation into the
   Expenses tab, because otherwise finance still works from two places. Your
   decision named only the flags. Do you want these folded too?
3. **Who records the Board's approval, and whose tab counts it.** The rules have
   a FINANCE holder without a conflict record it, and a Board member only when
   there is none. The design shows it in the Board tab to both, counted green
   for FINANCE and gray for the Board unless no FINANCE holder can record it.
   Is that right, or should Board members see it green as a prompt to take it to
   a meeting?
4. **A held expense no one can sign.** When every Board member is conflicted, the
   expense is held with no in-app way forward. The design shows it in the Board
   tab and offers no action. Is that what the Board wants, or should finance be
   able to close it with a note, as with a closed expense that never posted?
5. **Required notes on reviews.** Today a check-off note is optional on the
   server. The design makes it required for the four kept kinds, since the note
   is the record of the judgment. Agreed?
6. **Expense events and Provisional items (3.27).** The design restores failed
   intake only. Expense events shows the QuickBooks outbox, which the QuickBooks
   tab now covers. Provisional items belongs with the line (theme 3). Do you want
   either screen back as it was?
7. **`QB_OVER_CAP` as a note.** Nothing waits on finance once the drain posts an
   over-cap expense alone. Should finance still see each one in the QuickBooks
   tab, for awareness, until someone marks it seen?
8. **AMBIGUOUS posts.** When several QuickBooks entries could match, the expense
   waits in `AMBIGUOUS` for a manual match (`qb-candidates`, `qb-match`), and no
   screen calls those routes. That sits outside the twelve kinds, but it is
   finance's work. Should the QuickBooks tab list it, with a match picker on the
   expense page, in this work or in a follow-up?
