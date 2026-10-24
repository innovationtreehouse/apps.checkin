# One finance exception queue, decided on the record

Design for #2481, theme 1 of the receipt-flow conversion audit. Numbers such as
3.6 are that audit's finding numbers; the table at the end of this doc quotes
each finding it resolves.

## Summary

Finance gets one queue, a new host screen at `/finance/review` that replaces
the receipt review screen at `/receipts/review`. Today's
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
is no second act of checking it off. Three kinds stay as stored reviews, because
each one asks for a judgment that no fix records: QuickBooks shows a posted
entry that has since changed, a closed expense never posted, and a duplicate
entry needs voiding. Those are decided on
the expense page with a note.

Board items get a Board tab on the same screen. The Board's approval of a large
purchase is one decision recorded in one place, the Record Board authorization
panel on the expense, and the `THRESHOLD_CROSSED` flag that duplicated it goes.

Three schema changes, all small: the expense side stores the receipt's tax
review and its own tax approval (§9), and the `capital_equipment_unit_cents`
setting column is dropped (3.7). The work ships as two boundary PRs and five
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
record it. Those three kinds keep their `ExpenseFlag` rows, renamed "reviews" in
every screen, and are decided on the expense page with a note.

### 2. Fate of each flag kind

| Kind | Raised today | Fate | Queue tab and reason shown | Decided on | Action |
| --- | --- | --- | --- | --- | --- |
| `TAX_ATTACHED` | At intake, any tax above zero; #2479 narrows it to tax the receipt's settings hold for review that no receipt approval covers | Goes away where receipt finance review decided it. The remainder, after #2479, becomes a derived reason | Expenses: "Tax $12.40 not reviewed on the receipt" | Expense page; tax marked in the money block (theme 3 restores the field, 3.11) | Approve tax, note optional, matching receipt approval after #2465 |
| `THRESHOLD_CROSSED` | At intake, total at or over the Board-review total | Goes away; repeats the Board-approval hold (3.6) | Board: "Board approval of a $2,340.00 purchase not recorded" (derived from `needsBoardApproval`) | Expense page, Board authorization panel | Record Board authorization (text required, as today) |
| `CAPITAL_EQUIPMENT` | At intake, a unit price at or over `capitalEquipmentUnitCents` | **Decided: removed** (3.7). Capital review, where finance designates each line, is the only capital check, using `classifyCapital`'s two thresholds. The `capitalEquipmentUnitCents` setting goes with it | Expenses: "Capital review" | Expense page, Capital review panel | Submit capital review |
| `MISSING_RECEIPT` | Never (no caller) | **Decided: removed** (3.8). Every expense comes from a receipt, and the Treasurer handles notes in lieu of receipts outside the app (`docs/rules/expenses.md`, Assumptions) | none | none | none |
| `NON_EVERYDAY` | Never (no caller) | **Decided: removed** (3.8). It is left over from the retired "not Everyday" mark (#2437, #2440, #2441). The amounts decide Everyday, and a non-Everyday card charge already takes a Board seat | none | none | none |
| `COI`, "held" variants | A sign-off leaves a seat no one without a conflict can fill | Goes away as a row; becomes a derived reason from `blockedSeats` | Board: "No Board member without a conflict can sign; held" | Expense page, sign-off column | None in the app (decided; it probably can't happen) |
| `COI`, "stood in" variants | A Board member took the Treasurer seat, or recorded the Board authorization, because no FINANCE holder could | Goes away (decided). The audit log records the stand-in; there is no stored review and no note | none | none | none |
| `REIMBURSEE_UNKNOWN` | At intake, a reimbursement with no Person | Goes away; becomes a derived reason (3.10) | Expenses: "Reimbursee to name" | Expense page, Reimbursee panel, reimbursee marked | Set reimbursee; the reason clears in the same act |
| `QB_POST_FAILED`, retries exhausted | Fifth failed post (`NEEDS_FINANCE`) | Goes away as a row; derived from `qbMatchState = NEEDS_FINANCE` (3.9) | QuickBooks: "Posting failed 5 times: {last error, plain words}" | Expense page, QuickBooks panel | Retry; success clears it, a refusal shows as a red chip that stays open |
| `QB_POST_FAILED`, duplicate to void | The app posted an entry another record already claims | Stays as a stored review, under its own kind `QB_DUPLICATE_TO_VOID` (§9) | QuickBooks: "Duplicate entry in QuickBooks needs voiding" | Expense page, Reviews panel | "I voided it", with a required note saying what finance did (which entry, when); the server refuses a blank one |
| `QB_OVER_CAP` | Over the per-expense or per-run posting cap ($25,000) | **Decided: removed, and the dollar cap is dropped.** The cap was an engineering constant (#2103, #2150) with no policy behind it, and a purchase that size already needs the Board's approval. The count limits stay | none | none | none |
| `QB_DRIFT` | The daily check finds a posted entry changed in QuickBooks | Stays as a stored review; it is the one control that catches spending changed outside the app | QuickBooks: "Changed in QuickBooks after posting: amount, account" | Expense page, Reviews panel, with the stored and current values side by side | Accept the change, with a required note saying what finance did; the server refuses a blank one. A later change reopens it, as today |
| `QB_NO_CLASS` | A line's bucket has no QuickBooks Class | Goes away as a row; derived while the expense is postable and stopped for a missing Class | QuickBooks: "Budget bucket Facility has no QuickBooks class" | Expense page links to the bucket's Class setting | Set the Class; the next drain posts and the reason clears |
| `QB_POST_HELD` | A closed expense still held from posting | Stays as a stored review: a closed expense takes no further sign-off, so only a judgment can settle it | QuickBooks: "Closed but not posted: a line is missing a sign-off" | Expense page, Reviews panel | Mark handled, with a required note saying what finance did (for example, "entered by hand in QuickBooks"); the server refuses a blank one |

After this, `FLAG_KINDS` holds three kinds: `QB_DUPLICATE_TO_VOID`,
`QB_DRIFT` and `QB_POST_HELD`. Intake raises none, and nothing raises `COI`.
The kept duplicate variant gets a kind of its own because `ExpenseFlag` is
unique on (expense, kind): an exhausted `QB_POST_FAILED` row would otherwise
read as a duplicate to void. `COI` and `QB_POST_FAILED` join the retired
kinds, and §9 says how their open rows are moved or closed.

### 3. The queue

The queue moves to `/finance/review`, labelled "Finance review" in the nav
(decided). It holds about ten tabs, which is too many for one row, so this
section starts with how a person moves through them and then lists what each
tab holds.

#### How a finance holder works the queue

The tabs sit in three labelled groups, one row each:

| Group | Tabs | Shown to |
| --- | --- | --- |
| Receipts | Finance review, Duplicates, Totals off, Unreadable, Errors, and a "More" picker for #2466's other states, "Not delivered" among them | FINANCE and Board |
| Expenses | Expenses, To sign, Account holds, QuickBooks | FINANCE and Board |
| Board | Board | FINANCE and Board |

Each tab shows a green count of the items this viewer can act on (§7). A tab
with nothing for the viewer is dimmed, not hidden, so the layout never shifts
under them.

1. **One number in the nav.** The "Finance review" link carries one green pill,
   the total across every tab. That number is the whole job.
2. **They land where the work is.** Opening `/finance/review` with no `?queue=`
   selects the first tab, in the order above, that has something for this
   viewer. If nothing waits anywhere, it opens Finance review and says
   "Nothing waiting on you."
3. **The loop.** They open a row, decide on the record, and come back to the
   same tab with the list and every count refreshed (§4). If the record still
   has another reason for them, for example an expense with both a QuickBooks
   failure and a reimbursee to name, they stay on the page and its reasons
   alert lists what is left.
4. **A tab that empties points onward.** When the last row goes, the tab says
   so and names the next tab with work: "Nothing left here. Next: QuickBooks
   (2)." They never hunt for what is left; following "Next" walks every tab
   that needs them and ends at "Nothing waiting on you."
5. **A busy tab splits by reason.** A tab whose rows carry more than one reason
   shows a chip per reason above the list, each with its count ("Bucket to
   assign 3", "Capital review 1"), and the list sorts by reason, oldest first.
   A chip filters the list; the selected chip rides in the URL, so returning
   from a record keeps it. This matters most for the Expenses tab, which
   also holds the expense list's finance views.

A Board member without the finance role sees all three groups, because the
Board reads receipt and expense data. Their green counts are the Board
signatures they may give (Board tab, below); nothing else in the queue waits
on a Board member. They land on the Board tab when it has items.

For example, a finance holder sees 6 on the nav pill and opens it. Finance
review has 2 receipts, so the page opens there. They approve both and come back
to an empty tab that offers "Next: Expenses (3)". The Expenses tab shows chips
"Reimbursee to name 1" and "Capital review 2". They name the reimbursee, submit
one capital review, and leave the other for later. The tab now shows 1, and
"Next: QuickBooks (1)" takes them to a failed post, which they retry. The
pill shows 1, the capital review they left.

#### What each tab holds

The Receipts tabs are #2466's, unchanged. The Expenses and Board groups hold:

| Tab | Reasons | Who acts |
| --- | --- | --- |
| Expenses | Bucket to assign; bucket unknown; exception raised by a budget owner; capital review; depreciation cycle; reimbursee to name; tax not reviewed; failed intake (below) | FINANCE |
| To sign | Lines waiting for a Treasurer signature the viewer can give, with Approve All. The signing act is #2503's; this design places the tab and counts it | FINANCE (the Treasurer seat) |
| Account holds | One row per held expense: "2 lines have no account rule" | FINANCE |
| QuickBooks | Posting failed after retries; duplicate to void; changed in QuickBooks; closed but not posted; bucket has no Class; waiting for a match (`AMBIGUOUS`, below) | FINANCE |
| Board | Board approval not recorded; held, no conflict-free signer; Board signature to give (a purchase of $2,000 or more, a reimbursement to a non-member, a conflicted Treasurer's seat; the act is #2503's) | Board for signatures, and FINANCE for recording the authorization |

Recording the Board's approval is finance's job (decided): FINANCE records what
the Board decided. "Board approval not recorded" counts green only for a
FINANCE holder without a conflict. Board members see the item in the Board tab
but get no action count for it. The rules still let a Board member record it
when no FINANCE holder without a conflict can, and the Record Board
authorization panel stays open to them in that case, without a count.

The receipt library can't import the expense library (library boundary rule,
`scripts/check-library-boundaries.mjs`), so the host owns the screen. Each
library exports its tabs: a value, a label, a count and a body component. The
host page lays them out and owns `?queue=`, so an expense row opened from the
QuickBooks tab returns to `/finance/review?queue=qb`.

The old paths are renamed outright, with no redirects. `/receipts/review`,
`/expense/flags` and `/expense/holds` are deleted, along with their
`pageRegistry` entries, and every link to them points at the new screen.
`/receipts/review/[id]` folds into `/receipts/[id]`. A detail page opened from
the queue carries `?queue=`, and that, not the path, is what makes it return to
the queue after a decision. The expense page at `/expense/expenses/[id]` works
the same way. In the receipt library, #2466's `reviewHref` and
`reviewDetailHref` take the queue's base path from the host instead of
hardcoding `/receipts/review`.

Every expense row shows the same columns: date, vendor, amount, the reason in
plain words, and how long it has waited. No row shows a kind code, a state
name or an id (3.5). An expense with two reasons shows one row per tab it
belongs to, with both reasons when they share a tab.

The expense list's finance views (`assign_ownership`, `resolve_ownership`,
`owner_exception`, `capital_review`, `set_depreciation_cycle`) fold into the
Expenses tab (decided). The list itself stays at `/expense/expenses` for
browsing, with its views; the owner-approval view stays where budget owners
use it.

#### Where it sits in the sidebar

Today's Expense Ops and Receipt Review sidebar sections merge into one
Finance section, shown to FINANCE and Board (decided):

```
Finance
├─ Finance review     🟢 the one pill (all finance work)
├─ Expenses           (browse list, /expense/expenses)
├─ Flow status        (/receipt-flow, from #2502)
├─ Account Mapping · QuickBooks Accounts · Part Buckets · Capital Seed
├─ Budgets
├─ Incoming receipt queue   (FINANCE only)
└─ Settings › Expense · Receipt
```

- The sections in `checkin-app/src/lib/nav/sections/expenseOps.ts` and
  `receiptReview.ts` become one Finance section, and their `AppFrame` entries
  become one. The old section names are renamed outright, with no redirects,
  as with the deleted paths.
- #2502 puts Flow status under Receipt Review, and under Inventory for
  inventory managers. Inventory keeps its link; the Receipt Review one moves
  into Finance.
- #2500 adds a green "actionable" pill on Expense Ops › Expenses. That pill
  goes, because Finance review counts the same work, so no two pills ever
  count the same items. Finance review's pill is the only green one in the
  section.

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
  | Raise exception, reject exception | Required |
  | Record Board authorization | Required (it is the authorization text) |
  | Mark a review reviewed or handled (the three kept kinds) | Required (decided): each is a finance to-do, and the note says what finance did. The server refuses a blank one |
  | Approve tax on an expense | Optional |
  | Set account, Retry, Resubmit, Set reimbursee, capital review | None; the audit row records who and when |

- **Return to the queue** (3.12). When the page was opened from the queue
  (`?queue=` present) and an action leaves the viewer with no reason they can
  act on, the page goes back to that tab and chip, the way receipt detail does.
  A partial decision, such as one line of three, or a record with another
  reason left for this viewer, reloads in place with the reasons alert
  updated. A page opened from elsewhere always reloads in place.
- **Posts waiting for a match** (decided: in this rollout). The drain parks an
  expense in `AMBIGUOUS` when it can't post on its own. It shows in the
  QuickBooks tab, and the expense page's QuickBooks panel answers it:
  - "Several QuickBooks entries match; pick one." The panel lists the
    candidates from `GET /api/expense/expenses/[id]/qb-candidates`, and
    picking one calls `POST /api/expense/expenses/[id]/qb-match`. An entry that
    belongs to nothing can be excluded with a required reason, through the
    existing `POST /api/expense/qb-exclusions`.
  - "The reimbursee has no QuickBooks vendor yet; link one." For a
    reimbursement whose reimbursee has no linked vendor, the reason points to
    the vendor link in the Reimbursee panel. Linking the vendor already
    re-queues the person's waiting reimbursements
    (`reimburseeVendorService`), so the reason clears when the next drain
    posts.

  The "not sent" messages at the top of the page gain `AMBIGUOUS` beside the
  three states they cover today. These routes exist and are registered, the
  candidates response as `ExpenseQbCandidateView`, so no server or registry
  work is needed.

### 5. Account holds on the expense page

Holds move onto the expense page as an Account holds panel, and `/expense/holds`
goes. The queue's Account holds tab lists the held expenses.

- **3.20**: the processor uses a line's `manualQbAccount` whatever the hold
  reason, not only for lines with no part number. `docs/rules/expenses.md`
  already lets any finance holder set "the account set on a mapping hold", so
  this is the rule working as written. A rule added later doesn't override an
  account finance set by hand on that line.
- **3.21**: each held line shows its reason in words ("No account rule matches",
  "Several account rules match", "No part number; pick an account", and for
  #2484's `NON_INVENTORY`, "Not stock; pick an account"). A no-match
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
Expense events and Provisional items screens are not restored (decided). They
were integration screens for separate prototype apps exchanging messages; in
one app, a receipt that failed to become an expense is an Expenses-tab row, and
#2502's status page shows counts by state.

### 7. Counts

- **Receipt tabs**: #2466's `GET /api/receipts/queue-counts`, made conflict-aware
  for FINANCE by #2462's `countAwaitingFinance`. No change.
- **Expense tabs**: a new `GET /api/expense/finance-queue/counts` returns
  `{ expenses, toSign, accountHolds, quickbooks, board }`, each as
  `{ actionable, total, byReason }`, where `byReason` holds the actionable
  count per reason for the chips. "Actionable" leaves out records the viewer is
  conflicted on, using the same `conflictedParties` predicate the refusals use.
  For To sign it counts only the lines whose Treasurer seat this viewer may
  sign, and for the Board tab only the Board signatures this viewer may give
  and the Board authorizations a FINANCE viewer may record. Both feed the one
  Finance review pill. The tab badges use
  #2466's `queueBadge`: green for actionable, gray for the rest. The same
  counts pick the landing tab and the "Next" tab (§3), and give each reason
  chip its number.
- **Nav**: the Expense Ops "Holds" and "Flags" pills go. The "Finance review"
  link carries one green pill, the receipt and expense actionable counts added,
  through `/api/nav/todo-counts` as #2462 does for receipts. A Board-only
  viewer's pill counts only the Board signatures they may give (3.26).
- Every action on either detail page fires `nav-counts-mutated`, so tab and nav
  counts refresh without a reload.

### 8. Screens, routes and the security registry

| Item | Change |
| --- | --- |
| `/receipts/review`, `/receipts/review/[id]` pages and `pageRegistry` entry | Removed; replaced by `/finance/review` and `/receipts/[id]?queue=…`. No redirect |
| `/expense/flags` page, `pages/flags.tsx`, `pageRegistry` entry | Removed; no redirect |
| `/expense/holds` page, `pages/holds.tsx`, `pageRegistry` entry | Removed; no redirect |
| `GET /api/expense/flags` | Removed, in a later release than the page, so open tabs running old code keep working through the deploy |
| `POST /api/expense/flags/[id]/check-off` | Kept; called from the expense page's Reviews panel. The service refuses the retired kinds and a blank note |
| `GET /api/expense/expense-holds` | Removed with the holds page. Set account and Resubmit stay and are called from the expense page |
| `GET /api/expense/finance-queue?tab=…`, `GET /api/expense/finance-queue/counts` | New; `finance-or-board`. Rows are a synthetic `FinanceQueueRow` (vendor, date, amount, currency, reason codes, waiting since, expense id for the link) |
| `GET /api/expense/expenses/[id]` | Gains `reasons` (the open queue reasons) and the three review kinds in place of `flags` |
| Expense nav counts (`expenseOpsCounts`, served through `/api/nav/todo-counts`) | `holds` and `openFlags` go when the nav pill moves to the new counts, in step 5 |
| `GET /api/expense/counts` (`ExpenseCounts`) | Its `expense_holds` field goes once nothing reads it. Removing one field is not a whole-entry removal, so it needs its own boundary PR (step 7) |

Every registry change ships in its own PR, before the route PR, on `main` and
not stacked (AGENTS.md, "Boundary isolation rule"). The new routes need a
registry PR with the `FinanceQueueRow` synthetic classification before the
feature PR that mounts them. The shape change to the detail response needs
its new field classified in the same boundary PR. Removing the
two GET routes is a decommission: the registry entries go with the route files,
under the decommission exception, once nothing calls them.

### 9. Data and migrations

**Flag rows.** `ExpenseFlag` keeps its columns. A query filters every list and
count to the three kept kinds. Open rows of the retired kinds need a data
migration, because the kept duplicate variant used to share a kind with a
retired one:

- An open `QB_POST_FAILED` row whose detail says the entry "needs voiding" is
  re-kinded to `QB_DUPLICATE_TO_VOID`.
- Every other open row of a retired kind (every `COI` row, held or stand-in; exhausted
  `QB_POST_FAILED`, `TAX_ATTACHED`, `THRESHOLD_CROSSED`, `CAPITAL_EQUIPMENT`,
  `REIMBURSEE_UNKNOWN`, `QB_NO_CLASS`, `QB_OVER_CAP`) is closed with no
  closer: `checkedOffAt` is set, `checkedOffByUserId` and
  `checkedOffByUsername` stay null (no system account stands in), and the note
  says why: "retired: the queue now reads this from the expense". The condition behind it, if it still holds, shows as a derived
  reason.

The re-kind is safe against the unique constraint, because no row of the new
kind exists before it runs. It ships in step 5's release. Old code still
serving during that deploy's drain window can raise a row under an old kind, so
the same SQL, written to be idempotent, runs again in step 7's release.

**Tax review.** The derived tax reason needs three things expense doesn't store
today:

- the tax amount the receipt's finance approval covered, and
- whether the receipt's settings held its tax for review (`taxReviewRequired`).
  #2479 reads both from the intake payload; they need columns on
  `expense_receipt_reviews` so the reason can be computed after intake. That
  is #2479's change to make, and the reviewer has asked for it there.
- Finance's tax approval on the expense itself. A new table,
  `expense_tax_approvals` (expense, tax amount approved, approver, optional
  note, time), keeps it beside the expense, following #2464's reason for
  sibling tables: routes that return `Expense` rows don't start carrying the
  note.

Both are expand-only: added columns that are nullable, and a new table that old
code never reads.

**Capital setting.** `capital_equipment_unit_cents` is dropped from the expense
settings in two releases (step 8).

The other derived reasons read columns that exist: `qbMatchState`,
`reimburseePersonId`, `boardAuthorization`, expense state, approvals, holds,
`ReceivedExpensePayload.status`. The two open expense migrations (#2441, #2402)
touch other columns and aren't affected.

## Rollout

Each PR is based on `main`. None is stacked on another's branch.

1. **Prerequisites merge first**: #2466 and #2468 (receipt tabs and counts),
   #2462 (conflict-aware counts), #2464 and #2479 (tax approval carried to
   expense, with #2479 storing the approved tax amount and
   `taxReviewRequired`), #2465.
2. **Registry PR A** (boundary only): `finance-queue` and `finance-queue/counts`
   entries, `FinanceQueueRow`, and the new `reasons` field.
3. **Expense detail PR** (3.1, 3.4, 3.9, 3.10, 3.12, 3.16): the derived-reason
   service, the reasons alert and field marks, the Reviews panel, required notes,
   return to the queue, and Retry and Set reimbursee clearing their reasons.
   The `expense_tax_approvals` table and Approve tax ship here, and so does the
   QuickBooks panel's match picker and vendor pointer for `AMBIGUOUS` posts
   (§4). Until step 5
   gives finance the queue tabs, `/expense/flags` stays finance's list, so this
   step keeps raising every kind. Its fixes close the matching row in the same
   act: a successful retry closes `QB_POST_FAILED`, and recording the Board's
   authorization closes `THRESHOLD_CROSSED`, as Set reimbursee already closes
   `REIMBURSEE_UNKNOWN`. `MISSING_RECEIPT` and `NON_EVERYDAY`
   (3.8) leave `FLAG_KINDS` and `FLAG_AUDIENCE` in
   `packages/expense/src/lib/flags.ts`, with the "raised by hand" sentence in
   `detectIntakeFlags`'s comment and the kind list in the `ExpenseFlag` comment
   in `packages/expense/prisma/schema.prisma`. Neither kind has a label to
   remove, and no row of either exists, because nothing ever raised one.
4. **Account holds PR** (3.20, 3.21, 3.22): the panel on the expense page, the
   processor honouring a manual account on every hold reason, and the Resubmit
   gate.
5. **Queue PR** (1.7, 3.3, 3.5, 3.6, 3.27, 2.9 link): the finance-queue routes,
   the host page at `/finance/review` with the receipt and expense tabs, failed
   intake, the Apply failed link, counts and the nav pill. The old review,
   Flags and Holds pages are deleted and their links repointed. In the same
   PR, intake stops raising `TAX_ATTACHED`, `THRESHOLD_CROSSED`,
   `CAPITAL_EQUIPMENT` and `REIMBURSEE_UNKNOWN`; the drain stops raising
   `QB_NO_CLASS` and exhausted `QB_POST_FAILED`; the sign-off
   paths stop raising `COI`, leaving the stand-in in the audit log only; the
   duplicate path raises `QB_DUPLICATE_TO_VOID`; and the
   §9 data migration runs. The drain's dollar cap goes in the same PR:
   `MAX_CREATE_CENTS_PER_RUN`, the per-expense check in `claimForPost`, the
   per-run cents total and run-alone slot in the drain (`allowOverCap`), and
   `QB_OVER_CAP` from `FLAG_KINDS` and `FLAG_AUDIENCE`
   (`packages/expense/src/lib/expense-qb-poster.ts`, `lib/flags.ts`). The count
   limits stay: `MAX_CREATES_PER_RUN` (25), `MAX_CREATES_PER_DAY` (50) and
   `MAX_POST_ATTEMPTS` (5). Finance is never without a list: the flags stop in
   the release that brings the tabs. The QuickBooks tab lists `AMBIGUOUS`
   posts. The sidebar's Expense Ops and Receipt
   Review sections become the one Finance section (§3), and #2500's pill on
   Expenses goes. The To sign tab and the Board-signature reason arrive here,
   and #2500's QB-pending count for the Treasurer and Board seats moves into the
   queue counts, so no seat is counted twice. The signing act itself ships
   with #2503.
6. **Receiving Retry PR** (2.9): Retry on each Apply failed row. It's independent
   of the rest and can go any time.
7. **Registry PR B** (decommission), one release after step 5 is live: remove
   `GET /api/expense/flags` and `GET /api/expense/expense-holds` with their
   route files. A separate boundary PR in the same release drops
   `expense_holds` from `ExpenseCounts`. The §9 re-kind and close SQL runs
   again here, closing any leftover rows the same way: no closer, and the
   note saying why.
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
- Three questions are recorded as reviews with a required note: a duplicate
  QuickBooks entry to void, an entry changed in QuickBooks after posting, and
  a closed expense that never posted.

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
| 3.16 | Override comment required only on the server | There is no FINANCE override (decided on #2503). Raise exception and reject exception show a required mark, with Confirm disabled while blank (§4) | step 3 |
| 3.20 | Set account on no-match lines does nothing | Processor honours a manual account on every hold reason (§5) | step 4 |
| 3.21 | Holds lost lookup context and rule list; raw reason | Plain reasons, lookup context, matched rules listed (§5) | step 4 |
| 3.22 | Resubmit not disabled while a line lacks an account | Disabled with the reason shown (§5) | step 4 |
| 3.27 | Failed intake invisible to finance | Failed payloads are Expenses-tab rows; Expense events and Provisional items screens not restored (decided, §6) | step 5 |

## Open questions

No open questions remain.
