# Duplicate receipts: one group, one decision, checked again before posting

Design for #2516. Research and design only; no app code changes here. The
one-time cutover and the PR plan are in `2516_RECEIPT_DUPLICATES-migration.md`.

## Problem

People send the same purchase in more than once. They upload the photo and
then forward the emailed copy, a second household member uploads the same
receipt, or someone re-uploads after a rejection. If two copies are
finalized, the organisation pays or books that purchase twice.

The app does try to catch this. It looks for an earlier receipt with the same
file, or with the same vendor, date and total, or the same vendor and order or
receipt number. When it finds one, it holds the new receipt for finance. Four
habits of that check let copies through anyway:

1. **It remembers one earlier match, not all of them.** With three copies,
   finance compares the third with one of the other two and never sees the
   other.
2. **It counts dead receipts as matches.** A copy can be held against a
   receipt that was already thrown away or rejected. Finance sees "the
   original is discarded", clears the copy, and the copy goes through beside
   a live twin it was never shown.
3. **A cleared receipt is never checked again.** Once finance says "not a
   duplicate", that receipt is exempt from the check for good, even against a
   copy that arrives next week.
4. **Only the later copy is held.** The earlier one carries no mark, so finance
   can approve both, each on its own screen.

Each decision looks right where it is made. Together they finalize two copies.
#2515's tests show all four, with three copies of one purchase.

A small team owns this. Finance and the Board are a handful of people, so any
extra cross-check or second sign-off lands on the same people who made the
first decision. A fix that adds steps buys nothing.

## Objective

- Every copy of a purchase is caught before it is finalized, whatever state
  the earlier copy is in: open, finalized or rejected.
- Finance sees every copy together and decides once. The decision covers the
  whole group and is remembered, so the same pair is never asked about again.
- A copy that matches a rejected receipt is marked so finance looks harder.
- One more check runs at QuickBooks posting, inside the finance queue that
  already exists, for anything the receipt check missed.
- No new receipt states, no new sign-off seats.

## Executive summary

| Who | What changes | What stays |
| --- | --- | --- |
| Finance | The Duplicates tab shows one row per **group** of matching receipts. The compare panel shows every member side by side, each with its state and why it matched. Three actions: **Different purchases**, **Keep this one** (discards the other open copies in the same act) and **Discard**. A group with a rejected member says so in red and asks for a note to clear it. | Finance decides, as today. The conflict rule applies to every receipt in the group, as it already does for discard. |
| Submitter | When every match is their own earlier upload, they see "You already sent this receipt on 3 Oct" and can withdraw the new copy, which they can already do today. A match on someone else's receipt shows only "Finance will check this for a possible duplicate". | Nobody's receipt is refused automatically. |
| QuickBooks posting | An expense whose vendor, date and total match another expense, with no decision saying they differ, is held with the reason "Possible duplicate of the Home Depot expense of 3 Oct" in the QuickBooks tab of Finance review. | The posting queue, tabs and counts are #2481's; this adds one reason. |
| States | None added. `duplicate_flagged` is reused for every member that reaches the check. One expense transition is proposed for a duplicate found only at posting (Q9). | The receipt machine's states and guard order. |

What it costs: one small table of decisions, one read-time query in place of
the stored single suspect, a group compare panel, one derived expense reason
and, depending on Q9, one expense transition. About seven small PRs, test
first (see the migration file).

---

## Rules this relies on

From `docs/rules/expenses.md`:

- Nobody takes a step on a receipt they are conflicted on: uploader, their
  household, or the person reimbursed. Clearing or discarding a duplicate is
  such a step. [Decision — *Ethics Policy, Art. III §III.5*]
- Approval stays with FINANCE. A submitter sees only their own receipts,
  without other people's details. [Decision — owner]

Stated for this work but not yet in `docs/rules/`:

- A receipt that looks like a duplicate goes to a person to decide. It is
  never refused automatically, and the file hash is deliberately not unique.
  (1265 §2 and §11, restated in #2516.)
- @thpr, for this design:
  - "We need to catch the 'usual stuff' (duplicates, regardless of whether
    the previous one was approved)."
  - "We should be checking against rejected, since if it was rejected once we
    should check more carefully the second time."
  - "We need to recognize we are a small team, so lots of duplicate
    cross-checking and approvals is silly — it ends up with the same people."

§9 lists the rules this design would establish.
Everything else that would need a rule is an open question (§10).

---

## 1. What the app does today

The check runs every time a receipt enters the pipeline: upload, OCR
complete, submitter confirm, resubmit, finance approve, clear, restart and
import. It runs first, before the arithmetic, submitter and finance checks,
so a receipt matched as a duplicate never gets further.

It tries four tests in order and stops at the first hit:

| Tier | Match | Normalisation | Where |
| --- | --- | --- | --- |
| File | SHA-256 of the uploaded bytes, the earliest same-file receipt in the org | none | stored at insert under an advisory lock on (org, hash) |
| Composite | retailer + receipt date + total | retailer case- and space-folded (#2561); date and total exact | queried on each run |
| Order number | retailer + order number | retailer folded; number exact | queried on each run |
| Receipt number | retailer + receipt number | retailer folded; number exact | queried on each run |

Org-wide, any uploader. No date window, no amount tolerance, no fuzzy vendor
match (#2558 is the future fuzzy one). A field-tier hit is skipped while
retailer, date or total is missing; the file tier still applies.

The four failure habits from the Problem section, in code terms:

- **One suspect.** The receipt stores one `duplicateSuspectReceiptId`. The
  field tiers use `LIMIT 1` with no ordering, so with several earlier copies
  the one chosen can differ from run to run.
- **Dead suspects.** No state filter. The only exclusion is a mailed body
  discarded as a copy of an attachment in the same message.
- **No re-check.** `duplicateFlagClearedAt` exempts the receipt from every
  future check. Clearing or discarding a suspect does not re-check receipts
  held against it.
- **Later copy only.** The match looks at other receipts but the flag is set
  only on the receipt being run. Its earlier twin can still be approved.

Two decisions exist on a held receipt: **clear** (finance; re-runs the
pipeline and exempts it) and **discard** (finance, or its own submitter).
Discarding a suspected original under finance access logs the discard on
each receipt held against it, but does not re-check them.

Downstream, a finalized receipt becomes an expense, which posts to
QuickBooks. Posting has no duplicate check; QuickBooks matching has a
`QB_DUPLICATE_TO_VOID` review, but that is about two app records claiming one
QuickBooks entry, not two receipts for one purchase.

---

## 2. What the rest of the industry does

The full research, with sources, is in §11. In short:

- **Matching is tiered.** An exact key is the strongest signal (Coupa
  refuses a supplier invoice number already used). Next is an exact
  multi-field match on amount, date and vendor or type, raised as a warning
  (Expensify, Concur, AppZen). Image and fuzzy matching are paid tiers or
  add-ons. Our four tiers already cover the first two levels.
- **Warn and route to a person is the default.** Blocking is rare: AP intake
  on an exact invoice number (Coupa), or Ramp's optional out-of-policy mode.
  This matches our rule that a duplicate is never refused automatically.
- **Matches are listed, not singled out.** Expensify's "Review duplicates"
  lists every match and lets the reviewer keep one or keep all. We store one
  suspect.
- **Comparison is wide.** Ramp says "all prior submissions"; AppZen compares
  across every employee, report and time. No vendor documents whether rejected
  or deleted items are left out, so treating rejected ones as a stronger flag
  is our own call (per @thpr), not copied from anyone.
- **Remembering a "not a duplicate" decision per pair is not documented by any
  major vendor.** Ramp's dismissal is final for that flag. Our pairwise memory
  is an addition, justified by the small-team requirement, not by industry.
- **Small business vs enterprise.** Self-serve tools ship one fixed rule set
  (Expensify, Ramp); enterprise suites add switchable audit rules and AI
  add-ons (Concur Verify and Detect, Coupa SpendGuard, AppZen). A fixed rule
  set fits us.
- **A check at payment** is claimed by Concur Detect (Oversight), AppZen and
  BILL, but none documents how. Most detection happens at submission.

---

## 3. Matching

### 3.1 Tiers

The tiers stay as they are. Each hit carries **why** it matched, which the
compare panel shows beside each member:

| Tier | Label in the compare | Strength |
| --- | --- | --- |
| Same file | "Same file" | Strong: almost always the same purchase |
| Same vendor and order number | "Same order number" | Strong |
| Same vendor and receipt number | "Same receipt number" | Strong |
| Same vendor, date and total | "Same vendor, date and total" | Medium: two equal purchases on one day are possible |
| Fuzzy vendor, same date and total (#2558, later) | "Similar vendor, same date and total" | Weak; see Q5 |

All tiers are evaluated, not just the first that hits, so a receipt can match
member A by file and member B by fields. Every hit joins the group.

### 3.2 Normalisation

- **Retailer:** case-folded, trimmed, inner spaces collapsed. Decided and
  shipped in #2561. Fuzzy matching is #2558 and is not part of this design's
  first PRs.
- **Date:** stored as free text, and the receipt editor writes free text, so
  `10/01/2026` and `2026-10-01` don't match. Proposed: compare parsed
  calendar dates and make the editor a date input. Q3.
- **Order and receipt numbers:** compared exactly today. Proposed: fold case,
  drop spaces and a leading `#`, the same treatment #2561 gave the retailer.
  Q3.
- **Total:** exact cents, same currency. No tolerance. Q4.

### 3.3 Windows

No date window and no lookback limit. The org's volume is small enough to
compare against every receipt it has ever had, and a narrower window only
adds a way to miss. A "within N days" tier is Q4.

---

## 4. What a receipt is compared against

Every other receipt in the org, in any state, except a mailed body discarded
as a copy of its own message's attachment (it was never a separate
submission). What each state contributes:

| Other receipt's state | Raises a flag? | Shown in the group? | Label |
| --- | --- | --- | --- |
| Open (any non-terminal state, including `duplicate_flagged`) | Yes | Yes | its state, e.g. "Waiting for finance review" |
| `receipt_finalized` | Yes | Yes | "Finalized" and, if pushed, "Sent to expenses" |
| `rejected` | Yes, **marked stronger** | Yes, first, in red, with the rejection note | "Rejected on 2 Oct: <note>" |
| `discarded` | **No** on its own (Q1) | Yes, greyed, when the group exists for another reason | "Discarded on 2 Oct by <name>" |

Why discarded doesn't raise a flag on its own (recommended in Q1): a
discarded receipt will never be paid, and the risk being guarded is paying
twice. A copy of a discarded receipt is either a resend of something thrown
away by mistake (no risk) or a copy of a live receipt, which matches that live
receipt directly. Scenario 3 of #2516 (C re-uploads discarded B's file) is
caught because C's fields also match live A.

Why rejected does (per @thpr): a rejected receipt was refused for a reason,
and the same purchase coming back is the case where that reason most needs
re-reading. The flag says so and shows the note.

---

## 5. The group, and how it is shown

### 5.1 Computed when read, not stored

The group is computed from the data each time it is needed: every receipt
that matches this one on any tier, minus the pairs a person has decided are
different purchases (§6.2). Matching is symmetric, so A is in B's group and B
in A's, and the group is closed transitively: if C matches B and B matches A,
all three are one group even when C and A share no field (a copy of a copy).
Members are ordered by upload time, so the order never shifts.

This replaces the single stored suspect, and with it habits 1 and 2: there is
no one suspect to be dead or to be the wrong one. The file-hash insert lock
stays; it still makes the second of two simultaneous identical uploads see the
first.

### 5.2 Every member is held, lazily

Habit 4 (only the later copy is held) is closed without forcing anyone's
receipt into a new state. Every path to `receipt_finalized` passes through the
pipeline, and the duplicate guard runs first. With symmetric matching, an
earlier open copy A meets the guard the next time it moves (submitter
confirms, finance approves), finds B, and becomes `duplicate_flagged` too.
So no member of an undecided group can finalize.

Until then A stays where it is, in submitter or finance review, and carries a
badge: "Possible duplicate: in a group of 3". Finance can decide the group
from A's page or from the Duplicates tab.

A member that was **already finalized** before the copy arrived can't be held
on the receipt side; it is a terminal state. That case is what the posting
re-check (§7) is for.

### 5.3 The compare panel

#2549's two-way compare becomes N-way. The receipt being viewed is the left
column; every other member follows, in upload order, rejected first. Each
column shows the file, vendor, date, numbers, totals, lines, state, uploader
(finance view only) and the tier labels that tie it to the group. On a phone
the columns stack, as #2549's do.

### 5.4 The queue

The Duplicates tab in Finance review (#2481's Receipts group) shows one row
per group, not per receipt: vendor, date, total, member count, "includes a
rejected receipt" when it does, and how long the oldest held member has
waited. Its count is groups waiting.

---

## 6. Deciding

### 6.1 Who

FINANCE, as today, and no new seat. The person deciding must not be
conflicted on **any** member of the group, the rule discard already applies to
receipts held against the one discarded. When every FINANCE holder is
conflicted, the group waits: the same fall-back as any other receipt decision
today, and not changed here.

The submitter's part is small and uses a right they already have: when every
other member is their own receipt, they see which one and can withdraw the
new copy (their own discard). When any member belongs to someone else, they
see only that finance will check it, and nothing about the other receipt
(Q6).

### 6.2 The decisions

One act decides the whole group:

| Action | What it does | Required |
| --- | --- | --- |
| **Different purchases** | Records, for every pair in the group, that they are different purchases. Every held member re-runs the pipeline and carries on to arithmetic, submitter and finance checks. | A note, only when the group has a rejected member (Q7) |
| **Keep this one** | Discards every other *open* member and records each as a copy of the kept one. The kept receipt then has no undecided live match, so it leaves the hold and re-runs the pipeline. Finalized and rejected members are left as they are. | Nothing; picking the keeper is the decision |
| **Discard** | Discards this receipt only, as today. The rest of the group is recomputed. | Nothing |

Keep this one replaces today's two-step "discard the original, then clear the
copy", which is the path that left #2516's scenario 2 holding two live
copies.

"Keep this one" is offered only on an open member. If the group already has a
finalized member, the panel says so at the top ("A finalized copy exists:
keep it and discard this one?") and the one-click choice is Discard.

### 6.3 Remembered as pairs

A decision is stored per pair of receipts: `(receipt, other receipt, kind,
by, at, note)`, kind being *different* or *copy of*. The check drops a match
only when that pair has a *different* decision. A new copy C arriving later
has no decision with A or B, so it is held and shown beside both: habit 3 is
closed, and the same pair is never asked about twice, which is the
small-team requirement.

`duplicateFlagClearedAt` stops being an exemption. It can stay as a
timestamp for the log until a later cleanup drops it.

### 6.4 Re-checks after a decision

A discard or a decision changes the group, so every other open member's
group is recomputed in the same transaction. A member left with no undecided
match re-runs its pipeline; one still matching stays held, and the panel shows
what's left. This is the re-check #2516 asks for, and it replaces the
"suspected original discarded" log line with an actual re-evaluation.

---

## 7. The re-check at QuickBooks posting

The receipt-side check covers receipts. Three cases slip past it:

- a pair where both were finalized before this design shipped;
- a finalized member that predates its copy (§5.2), when the copy is cleared
  as different by mistake, or a receipt is edited after finalizing;
- whatever the next change to the receipt side breaks.

Posting is the last point before money is booked. Concur Detect, AppZen and
BILL all claim a pre-payment check (§11), though none documents how it works.
Here it is one derived reason in #2481's model, not a new step:

- **The condition.** The expense is waiting to post, and another expense in
  the org (any state except rejected) has the same vendor key, receipt date and
  total, or the same vendor key and receipt number, and no pair decision says
  they differ.
- **The reason.** QuickBooks tab: "Possible duplicate of the Home Depot
  expense of 3 Oct ($84.12)". While it holds, the outbox skips the expense,
  the same way an unknown reimbursee holds it today.
- **Deciding.** On the expense page, side by side with the other expense:
  **Different purchases** (records the pair; the next drain posts it) or
  **Duplicate, don't post** (Q9).
- **No double asking.** A pair already decided *different* on the receipt
  side counts as decided here. The receipt push carries the receipt's
  decided-different receipt ids, and the expense side reads them, so the
  receipt library is never imported by the expense library.

Counts: in a normal week this reason should be zero. Each one that shows up is
a sign the receipt-side check missed something.

---

## 8. States

No receipt state is added. Every change maps onto what exists:

| Change | Receipt machine | Expense machine |
| --- | --- | --- |
| Symmetric match, group, lazy hold | `uploaded`/`flow_error` → `duplicate_flagged` via the existing `isDuplicate` guard | none |
| Different purchases | existing `DUPLICATE_CLEARED`, `duplicate_flagged` → `uploaded` | none |
| Keep this one | existing `DISCARD` on each other open member; the kept member takes `DUPLICATE_CLEARED` if it was held | none |
| Re-check after a decision | existing `RUN_PIPELINE` on each affected open member | none |
| Badge on an open earlier copy | none: a read-time marker | none |
| Posting hold | none | none: a derived reason, the outbox skips it, as with an unknown reimbursee |
| Duplicate found only at posting | none | **Q9**: either a new `DUPLICATE_WITHDRAWN` event from `qb_pending`/`qb_on_hold` to the existing `rejected`, or reuse of `qb_skipped` |

The one possible addition is that expense transition. Today an expense waiting
to post has no way out except posting, so a duplicate found there could only
be voided in QuickBooks after the fact. One event into a state that already
exists is the smallest change that lets finance stop it.

New data: one table of pair decisions (§6.3). Nothing else.

---

## 9. Rules this design establishes

If @thpr accepts them. Each traces to the sources above; anything that
doesn't is in §10.

- A receipt that matches another receipt is held for finance, never refused
  automatically. [Decision — owner]
- A receipt is checked against every receipt in the org that could still be,
  or already was, paid: open, finalized and rejected. A match on a rejected
  receipt is shown as such. [Decision — owner]
- Finance decides a group of matching receipts once, and the decision is
  remembered per pair. Nobody decides a group in which they are conflicted on
  any member. [Decision — owner; conflict part from the existing receipts rule]
- An expense is not posted to QuickBooks while it matches another expense and
  no decision says they differ. [Decision — owner]

---

## 10. Open questions for @thpr

Numbered as fixed IDs; a settled one is struck, not renumbered.

| ID | Question | Options | Recommendation |
| --- | --- | --- | --- |
| Q1 | Does a **discarded** receipt raise a flag? | (a) No on its own; shown in the group when one exists. (b) Yes, like any other. (c) Ignored entirely. | **(a).** A discarded receipt is never paid; a copy of a live receipt matches that receipt directly. (b) floods the queue with resends of mistakes; (c) hides context finance wants. |
| Q2 | How much **stronger** is a match on a rejected receipt? | (a) Red label, listed first, rejection note shown, and a note required to clear. (b) Label only. (c) Route it to whoever rejected the first. | **(a).** It's the "check more carefully" @thpr asked for at the cost of one sentence. (c) adds a seat on a team where it's the same people. |
| Q3 | **Normalise dates and numbers?** | (a) Compare parsed dates; fold case, spaces and a leading `#` in order and receipt numbers; make the editor's date a date input. (b) Dates only. (c) Neither. | **(a).** The same purchase typed two ways is the most common miss after vendor drift, and this is the same treatment #2561 gave the retailer. |
| Q4 | A **window or tolerance** tier ("same vendor and total within N days", or totals within N cents)? | (a) Not now; revisit with #2558's data. (b) Add as a weak "possible duplicate" tier. | **(a).** Each widening adds false flags for a small team; ship the exact tiers with groups first and see what's still missed. |
| Q5 | When #2558's **fuzzy vendor** match lands, is a fuzzy hit flagged like an exact one? | (a) Same hold, weaker label. (b) A badge on the receipt but no hold. | **(a).** One kind of hold keeps the queue simple; the label tells finance how hard to look. |
| Q6 | May a **submitter withdraw** their own repeat upload when every match is theirs? | (a) Yes, with the match shown; others' receipts never shown. (b) Finance only. | **(a).** It's an existing right (submitters discard their own receipts) and takes the most common case off finance's desk. |
| Q7 | When is a **note required** to say "different purchases"? | (a) Only when the group has a rejected member. (b) Always. (c) Never. | **(a).** Ties the extra effort to the case @thpr singled out. |
| Q8 | **Posting re-check**: build it? | (a) Yes, as a derived QuickBooks-tab reason (§7). (b) No; trust the receipt check. | **(a).** It costs one reason and catches the finalized-before-copy case and the old pairs. |
| Q9 | A duplicate found **only at posting**: how does finance stop it? | (a) New `DUPLICATE_WITHDRAWN` event to the existing `rejected`, with a note naming the other expense. (b) Reuse `qb_skipped` ("not posted"). (c) Leave it posted and void in QuickBooks. | **(a).** (b) means "already booked in QuickBooks" for backfill, and reusing it would blur that; (c) books it first and undoes it later. |
| Q10 | **Existing cleared receipts** at cutover: what do they become? | (a) A *different* decision against their recorded suspect only, then re-checked like any other. (b) Re-check everything with no carry-over. (c) Keep the blanket exemption for old rows. | **(a).** Keeps what finance actually decided and nothing more. |
| Q11 | **Already-finalized groups** at cutover? | (a) A one-time list for finance, no state change. (b) Let the posting re-check find the unposted ones; ignore the posted ones. | **(a)**, plus (b) for free. Posted pairs can only be fixed in QuickBooks, and finance should know they exist. |

---

## 11. Industry research

Researched 2026-10-25. "Official" means the vendor's own help docs or product
pages; anything else is marked **unverified**. Vendors publish little about
their matching. Where a page is silent, the gap is stated, not filled in.

### Expense tools

- **Expensify** (Collect and Control plans). Official.
  - Matches amount, currency and date. With a scanned receipt it also uses
    merchant, order or invoice number, card last four and merchant ZIP "to
    reduce false positives". Hotels match on stay dates; invoices on any
    date up to the due date.
  - The expense is held with a "Potential duplicate" label. "Review
    duplicates" lists the matches. The submitter or approver picks **Keep
    all** (removes the hold) or **Keep selected** (discards the rest and
    merges differing field values). Its assistant can dismiss obvious
    non-duplicates and leaves a note.
  - Not documented: which other expenses (users, states) are compared, and
    whether Keep all is remembered.
  - https://help.expensify.com/articles/new-expensify/reports-and-expenses/Duplicate-Detection
- **SAP Concur.** Unverified: from SAP Concur staff and moderators on its
  forum, not product docs.
  - The base "Duplicate Transaction Check" audit rule is an exact match on
    expense type, date and amount, raised as a warning. Admins switch it on.
  - It misses a card slip plus an itemized receipt, or a different exchange
    rate. Whether it checks across employees went unanswered.
  - Official: enterprise add-ons Verify (AI review of every report) and
    Detect by Oversight (pre-payment checks and post-payment analysis).
  - https://community.concur.com/t5/Concur-Expense/How-well-does-the-flag-for-duplicate-expenses-catch-duplicate/m-p/58938 ;
    https://www.sap.com/use-cases/automate-expense-audits
- **Ramp** (Plus plan). Official.
  - A "Receipt Previously Used" policy flag fires on upload. The admin makes
    it a warning (still auto-approves) or out of policy (needs a reason and
    adds the manager to approval). Dismissing it is final.
  - https://support.ramp.com/hc/en-us/articles/20804476914707-Automatically-flag-transactions-with-policy-flags
  - Unverified (an explainer page, not help docs): compares image, amount,
    date and vendor against "all prior reimbursement submissions", with fuzzy
    vendor checks. https://ramp.com/answers/reimbursement-compliance/duplicate-reimbursement-claims-detected
- **Brex.** Its flagged-expenses page (risk rules, an anomaly model, admin
  review) doesn't name duplicates as a reason. Nothing duplicate-specific
  found. https://www.brex.com/support/flagged-expenses
- **Navan.** Only a generic glossary page; nothing about its own product.
  Unverified.

### AP tools

- **BILL.** Official product pages say it "will warn you" about a duplicate
  invoice and "flags potential duplicate payments". Its API allows duplicate
  invoice numbers, so it is not a hard rule. Whether it re-checks at payment
  is unverified.
  https://www.bill.com/learning/duplicate-payments ;
  https://developer.bill.com/changelog/2024-05-20-updating-bills-with-duplicate-invoice-numbers
- **Coupa.** Official: a supplier invoice whose number was already used for
  that supplier is refused at intake. Its blog calls the traditional check
  an exact match on supplier, invoice id, date and amount, and sells an AI
  add-on (SpendGuard) for near-duplicates; the blog quote is from a search
  snippet (the page refused the fetch). No tolerance settings documented.
  https://compass.coupa.com/en-us/products/product-documentation/supplier-resources/for-suppliers/integration-resources/cxml-error-handling/invoice-already-used
- **Tipalti.** A product page shows a "Possible duplicate found" notice;
  fields, timing and whether it blocks are not documented.
  https://tipalti.com/accounts-payable-software/finance-ai

### Audit vendors and practice guides (vendor content)

- **AppZen** compares receipt images across all employees. When images
  differ it falls back to merchant, date and total across reports and over
  time, and sends matches to an auditor.
  https://www.appzen.com/blog/duplicate-receipts
- **Stampli** recommends staged checks: exact (vendor, invoice number,
  amount), then relaxed (vendor and amount within a date window), then fuzzy
  vendor, noting that looser tiers raise false flags on recurring invoices.
  https://www.stampli.com/resources/duplicate-anomaly-detection-analytics/
- **Corpay** recommends normalising invoice numbers (INV-5521 and 5521).
  https://www.corpay.com/en-AU/resources/blog/duplicate-payment-detection
- IOFM and ACFE guidance: not found in a quick search.

### What could not be verified

BILL's and Tipalti's behaviour at payment; Navan and Brex specifics; Coupa
tolerance settings; and whether any vendor leaves rejected or deleted items
out of the comparison.

---

## Appendix: #2516's failure modes, and where each is fixed

| Failure | Fix | Section |
| --- | --- | --- |
| One suspect only | Group computed at read time, every tier, every member | §5.1 |
| Matches against dead copies | Discarded never raises a flag alone; rejected raises a stronger one; both labelled | §4 |
| No re-check after clear or discard | Pairwise decisions replace the blanket exemption; every decision re-checks the rest of the group | §6.3, §6.4 |
| Only the later copy is flagged | Symmetric match; every open member meets the guard before it can finalize; finalized members caught at posting | §5.2, §7 |
| Nondeterministic suspect | Members ordered by upload time; no single suspect | §5.1 |

## Appendix: alternatives considered

- **Store a set of suspects per receipt** instead of computing the group.
  Rejected: the set goes stale the moment another member changes state, which
  is habit 2 again. Computing it costs one indexed query per view.
- **Force the earlier copy into `duplicate_flagged` the moment a copy
  arrives.** Rejected: it moves a receipt out from under its submitter or
  finance mid-review. The lazy hold (§5.2) reaches the same guarantee, since
  nothing finalizes without passing the guard.
- **A second sign-off for clearing a match on a rejected receipt.** Rejected
  per @thpr's small-team point; a required note gives the second look without
  a second person.
- **A unique constraint on the file hash.** Rejected long ago (1265 §2): it
  would refuse the upload instead of letting a person decide.
