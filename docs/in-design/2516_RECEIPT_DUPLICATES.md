# Duplicate receipts: one group, one decision

Design for #2516. Research and design only; no app code changes here. The
PR plan is in `2516_RECEIPT_DUPLICATES-migration.md`.

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
- No new receipt states, no new sign-off seats, and nothing added on the
  expense side.

## Executive summary

| Who | What changes | What stays |
| --- | --- | --- |
| Finance | The Duplicates tab shows one row per **group** of matching receipts. The compare panel shows every member side by side, each with its state and why it matched. Actions: **Not this one** per match, **Different purchases**, **Keep this one** (rejects the other open copies as copies of it, in the same act) and **Reject**. Finance never discards. A rejected member is labelled in red with its rejection reason. | Finance decides, as today. The conflict rule applies to every receipt in the group. |
| Submitter | When every match is their own earlier upload, they see "You already sent this receipt on 3 Oct" and can withdraw the new copy, which they can already do today. A match on someone else's receipt shows only "Finance will check this for a possible duplicate". | Nobody's receipt is refused automatically. |
| QuickBooks posting | Nothing. Every expense comes from a receipt that passed the duplicate check (§7). | Posting as it is. |
| States | No receipt state added. `duplicate_flagged` is reused for every member that reaches the check. The expense machine is untouched. | The receipt machine's states and guard order. |

What it costs: one small table of decisions, one read-time query in place of
the stored single suspect, a group compare panel, and reject edges for
finance. About eight small PRs, test first (see the migration file).

## Waiting on @thpr

One question is open. Everything else is decided or dropped; see the log in §10.

**Q14. When a new copy matches a receipt whose expense finance rejected, should the compare say so?**
Finance can reject an expense (by rejecting a budget owner's exception), which
ends it as rejected. Its receipt still reads "Finalized", because the receipt
side never hears what happened to the expense. So if the same purchase is
uploaded again, the compare shows the first copy as "Finalized", and the red
"Rejected" label from Q2 never appears.
- (a) Show it: the first copy reads "Finalized · expense rejected by finance:
  <reason>". The receipt side would need to hear the expense's outcome. The
  port it already uses for reimbursement status carries only the paid date
  today, so it would gain one field.
- (b) Leave it: finance still sees the match and decides; the label is just
  less informative in this one case.
- **Recommended: (a).** It's the "check more carefully the second time" case
  @thpr named, and costs one field on an existing port.

---

## Rules this relies on

From `docs/rules/expenses.md`:

- Nobody takes a step on a receipt they are conflicted on: uploader, their
  household, or the person reimbursed. Clearing or rejecting a duplicate is
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
  - On who discards: "A submitter discards, finance rejects. Board does
    neither. System can also discard in mail intake." And so: "that makes all
    discards innocent", "thus q1 becomes no flag".

§9 lists the rules this design would establish.
Everything else that would need a rule was an open question; see §10 and "Waiting on @thpr".

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
| Fuzzy vendor, same date and total (#2558, later) | "Similar vendor, same date and total" | Weak: same hold, weaker label (Q5, decided) |
| Same vendor and total, dates within 7 days (#2591, later) | "Same vendor and total, 2 days apart" | Weak; same hold, weaker label (Q13, decided) |

All tiers are evaluated, not just the first that hits, so a receipt can match
member A by file and member B by fields. Every hit joins the group.

### 3.2 Normalisation

- **Retailer:** case-folded, trimmed, inner spaces collapsed. Decided and
  shipped in #2561. Fuzzy matching is #2558 and is not part of this design's
  first PRs.
- **Date:** stored as text, compared exactly. #2566 (open) makes every date
  YYYY-MM-DD: the editor becomes a date picker, and an edit or import must
  send a real date in that format. The upload form and OCR already write it.
  Production holds no receipts yet, so there are no older formats to clean
  up, and once #2566 merges an exact comparison is enough. Nothing more is
  needed here.
- **Order and receipt numbers:** compared exactly today. Decided (Q3): fold
  case, drop spaces and a leading `#`, the same treatment #2561 gave the
  retailer.
- **Total:** exact cents, same currency. No tolerance (Q4, decided).

### 3.3 Windows

No lookback limit. The org's volume is small enough to compare against every
receipt it has ever had, and a narrower lookback only adds a way to miss.

The exact tiers have no date window: the dates must be equal. The industry
work points to a weak "similar date" tier. Expensify matches hotel stays on
check-in, check-out or transaction date, and invoices on any date up to the
due date; Stampli's relaxed tier is the same vendor and amount within a date
window (§11). The same purchase can carry two dates here too: an online order
confirmation and its shipping receipt, the date a card was charged and the
date on the slip, or an OCR misread. That tier is decided as ±7 days with a
weak label, and deferred past the first pass to #2591 (Q13). Amount tolerance is not added (Q4, decided).

---

## 4. What a receipt is compared against

Every other receipt in the org, in any state, except a mailed body discarded
as a copy of its own message's attachment (it was never a separate
submission). What each state contributes:

| Other receipt's state | Raises a flag? | Shown in the group? | Label |
| --- | --- | --- | --- |
| Open (any non-terminal state, including `duplicate_flagged`) | Yes | Yes | its state, e.g. "Waiting for finance review" |
| `receipt_finalized` | Yes | Yes | "Finalized" and, if pushed, "Sent to expenses" |
| `rejected` | Yes | Yes, labelled in red with its rejection reason | "Rejected on 2 Oct: <reason>" |
| `discarded` | **No** (Q1, decided) | Yes, greyed, when the group exists for another reason | "Withdrawn by its submitter on 2 Oct" or "Discarded at mail intake as a copy of its attachment" |

Why discarded raises no flag (decided, Q1): only a submitter discards a
receipt, withdrawing their own, and mail intake discards a body that copies
its own attachment. Finance refuses a receipt by rejecting it, and the Board
does neither (§9). So every discard is innocent, in @thpr's word, and refusal
always leaves a rejection behind, which is labelled. A copy of a live
receipt still matches that live receipt directly: scenario 3 of #2516 (C
re-uploads B's file after B is withdrawn) is caught because C's fields also
match live A.

Why rejected does (per @thpr): a rejected receipt was refused for a reason,
and the same purchase coming back is the case where that reason most needs
re-reading. The label says so, readably, and shows the reason (Q2, decided).
Nothing more: no reordering and no extra step to clear it.

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

A member that was **already finalized** before the copy arrived can't be
held; it is a terminal state. It doesn't need to be: the copy is open, so the
copy is held against it, and the group decision is made on the copy.

### 5.3 The compare panel

#2549's two-way compare becomes N-way. The receipt being viewed is the left
column; every other member follows, in upload order. Each
column shows the file, vendor, date, numbers, totals, lines, state, uploader
(finance view only) and the tier labels that tie it to the group. On a phone
the columns stack, as #2549's do.

With several matches the columns run off the side of the screen, and the two
finance actually needs to compare may be far apart. So each match's column
has a **Not this one** button, as in a shop's product compare:

- It records *different purchases* for the viewed receipt and that one match
  (§6.3), then the panel recomputes the group and redraws without that
  column. The rest close up, so the remaining suspects sit side by side.
- Dismissed matches collect in a strip above the columns: "Dismissed: Home
  Depot, 3 Oct · Undo". Undo deletes that pair decision, and the column
  returns. Undo is offered while the viewed receipt is still held; once it
  has moved on, the decision stands like any other.
- The same people may dismiss as may decide the group (§6.1). A submitter
  never sees another person's receipt, so never sees this button.
- A dismissed match can still be in the group through another member: if B
  is dismissed against A but C matches both, the group still holds all
  three, and B shows in C's view, not in A's.
- When the last match is dismissed, the receipt has no undecided match and
  leaves the hold, exactly as **Different purchases** does (§6.2).

### 5.4 The queue

The Duplicates tab in Finance review (#2481's Receipts group) shows one row
per group, not per receipt: vendor, date, total, member count, "includes a
rejected receipt" when it does, and how long the oldest held member has
waited. Its count is groups waiting.

### 5.5 When the group changes after the screen is drawn

Because the group is computed on read, the panel is a snapshot. Between
drawing it and finance clicking, a new copy can arrive, the submitter can
withdraw a member, or a second finance holder can decide the same group.
Each case is handled on the server, and the screen is only a convenience:

- **A decision names exactly what it covers.** The request carries the ids
  of the receipts the panel showed. A pair decision is written only for pairs
  of those ids, and **Keep this one** rejects only those ids. No decision
  can ever reach a receipt finance didn't see.
- **A new copy can't be cleared by an old screen.** Its own check runs after
  it is inserted, and no pair decision can name it yet, so it is held against
  every member it matches, whatever anyone clicks on a screen drawn before it
  existed. The worst a race can do is refuse a click, never let a copy
  through.
- **Group-wide actions check the group first.** **Different purchases** and
  **Keep this one** claim to settle the whole group, so the server
  recomputes the group under a lock in the same transaction (row locks on the
  members, as the expense outbox does on an expense). If it differs from the
  ids sent, because a member was added, changed state, or another holder
  decided a pair, nothing is written and the server answers 409. The panel
  shows a red chip that stays until dismissed, naming the change: "A new
  possible copy arrived after you opened this: Home Depot, 3 Oct, $84.12" or
  "Pat already decided this group". It redraws from the fresh group, with a
  "New" tag on any column that wasn't there before. This is the "Refresh and
  retry" pattern mail intake already uses, with the refresh done for the
  user.
- **Not this one isn't refused for a newcomer.** It decides one named pair,
  and a new arrival doesn't make that pair wrong. The response carries the
  fresh group, so the panel redraws with the new column tagged "New". It is
  refused (409, as above) only when that pair or either receipt changed
  underneath it.
- **The receipt's own state is checked as today.** Every step already moves
  a receipt only from the state it was read in, and answers 409 otherwise.
- **The panel refreshes itself when the tab regains focus**, so a screen
  left open over lunch is usually current before anyone clicks. This only
  saves a refusal; it isn't what keeps the data right.

---

## 6. Deciding

### 6.1 Who

FINANCE, as today, and no new seat. The person deciding must not be
conflicted on **any** member of the group. When every FINANCE holder is
conflicted, the group waits: the same fall-back as any other receipt decision
today, and not changed here.

The submitter's part is small and uses a right they already have: when every
other member is their own receipt, they see which one and can withdraw the
new copy (their own discard). When any member belongs to someone else, they
see only that finance will check it, and nothing about the other receipt
(Q6, decided).

### 6.2 The decisions

One act decides the whole group, or finance can work it a match at a time
with **Not this one** (§5.3):

| Action | What it does | Required |
| --- | --- | --- |
| **Not this one** (per match) | Records that the viewed receipt and that one match are different purchases. The group is recomputed and the panel redraws. When no undecided match is left, the receipt re-runs the pipeline. | Nothing |
| **Different purchases** | Dismisses every remaining match at once: records, for every pair in the group, that they are different purchases. Every held member re-runs the pipeline and carries on to arithmetic, submitter and finance checks. | Nothing |
| **Keep this one** | Rejects every other *open* member with the reason "Copy of <kept receipt>", and records each as a copy of the kept one. The kept receipt then has no undecided live match, so it leaves the hold and re-runs the pipeline. Finalized and rejected members are left as they are. | Nothing; picking the keeper is the decision |
| **Reject** | Rejects this receipt only, with a reason, as finance rejects any receipt. The rest of the group is recomputed. | The rejection reason, as today |

Keep this one replaces today's two-step "discard the original, then clear the
copy", which is the path that left #2516's scenario 2 holding two live
copies.

"Keep this one" is offered only on an open member. If the group already has a
finalized member, the panel says so at the top ("A finalized copy exists:
keep it and reject this one as a copy?") and the one-click choice is Reject,
with the reason filled in.

A receipt rejected as a copy is still a rejected receipt, so a later copy is
compared with it. Its label reads "Rejected as a copy of <kept receipt>".

### 6.3 Remembered as pairs

A decision is stored per pair of receipts: `(receipt, other receipt, kind,
by, at, note)`, kind being *different* or *copy of*. The check drops a match
only when that pair has a *different* decision. A new copy C arriving later
has no decision with A or B, so it is held and shown beside both: habit 3 is
closed, and the same pair is never asked about twice, which is the
small-team requirement.

`duplicateFlagClearedAt` stops being an exemption. Production holds no
receipts yet, so no existing clearance needs carrying over; the column and
`duplicateSuspectReceiptId` are dropped once no code reads them.

### 6.4 Re-checks after a decision

A withdrawal, a rejection or a decision changes the group, so every other open member's
group is recomputed in the same transaction. A member left with no undecided
match re-runs its pipeline; one still matching stays held, and the panel shows
what's left. This is the re-check #2516 asks for, and it replaces the
"suspected original discarded" log line with an actual re-evaluation.

---

## 7. No re-check at QuickBooks posting

The AP tools in §11 re-check at payment because invoices reach them through
several channels. Here every expense comes through one: a finalized receipt,
whose vendor, date, total and receipt number the expense keeps unchanged, and
a receipt can't change once it is sent to expenses. So two matching expenses
always come from two matching receipts, and the receipt check has already
compared those two, in both directions (§5.1), and seen a person decide them.
The only way both get through is finance saying *different purchases*. That
is a decision, not a miss.

A check at posting could therefore fire only if the receipt check has a bug,
and it would see less than that check does (an expense has no file hash).
The receipt check's tests are where that bug gets caught: #2515's tests
flipped to the decided behaviour, and the race tests in §5.5. A real
duplicate that still reached QuickBooks is voided there, as today. Decided:
Q8 and Q9 in §10.

---

## 8. States

No state is added, and the expense machine is untouched. Every change maps
onto what exists:

| Change | Receipt machine | Expense machine |
| --- | --- | --- |
| Symmetric match, group, lazy hold | `uploaded`/`flow_error` → `duplicate_flagged` via the existing `isDuplicate` guard | none |
| Different purchases | existing `DUPLICATE_CLEARED`, `duplicate_flagged` → `uploaded` | none |
| Keep this one, Reject | `REJECT` on each other open member. Today `REJECT` exists only from `financial_review`; with finance no longer discarding (§9), finance needs a `REJECT` edge from every open state where it discards today, `duplicate_flagged` among them. New edges into the existing `rejected`, no new state. The kept member takes `DUPLICATE_CLEARED` if it was held | none |
| Re-check after a decision | existing `RUN_PIPELINE` on each affected open member | none |
| Badge on an open earlier copy | none: a read-time marker | none |

New data: one table of pair decisions (§6.3). Nothing else.

---

## 9. Rules this design establishes

If @thpr accepts them. Each traces to the sources above; anything that
doesn't was an open question (§10, and "Waiting on @thpr").

- A receipt that matches another receipt is held for finance, never refused
  automatically. [Decision — owner]
- Only a receipt's submitter discards it, and mail intake discards a body
  that copies its own attachment. Finance refuses a receipt by rejecting it,
  with a reason. The Board neither discards nor rejects. A discarded receipt
  raises no duplicate flag. [Decision — owner]
- A receipt is checked against every receipt in the org that could still be,
  or already was, paid: open, finalized and rejected. A match on a rejected
  receipt is shown as such. [Decision — owner]
- Finance decides a group of matching receipts once, and the decision is
  remembered per pair. Nobody decides a group in which they are conflicted on
  any member. [Decision — owner; conflict part from the existing receipts rule]

---

## 10. Decisions log

IDs are fixed; the open ones are in "Waiting on @thpr" near the top.

| ID | Question | Outcome |
| --- | --- | --- |
| Q1 | Does a discarded receipt raise a flag? | **No.** Only a submitter or mail intake discards, so every discard is innocent; finance's refusals are rejections. A discarded receipt still shows, greyed, in a group that exists for another reason. |
| Q2 | How is a match on a rejected receipt shown? | A readable label, red is fine, with the rejection reason. Not listed first, no required note: "don't go overboard". |
| Q3 | Fold order and receipt numbers when comparing? | **Yes:** case, spaces and a leading `#`, as #2561 did for the retailer. Dates need nothing beyond #2566. |
| Q4 | An amount tolerance tier? | **Not now;** revisit with #2558's data. |
| Q5 | Is a fuzzy vendor hit held like an exact one? | **Yes,** same hold, weaker label. |
| Q6 | May a submitter withdraw their own repeat upload when every match is theirs? | **Yes,** with the match shown; another person's receipt is never shown. |
| Q7 | When is a note needed to say "different purchases"? | **Never** (follows from Q2). |
| Q8 | Re-check for duplicates at QuickBooks posting? | **No.** Every expense comes from a receipt that passed the duplicate check, so a hold at posting would only mean the receipt check had a bug (§7). |
| Q9 | How finance stops a duplicate found only at posting | **Goes away with Q8.** The expense side gains no state or transition. |
| Q10 | Existing cleared receipts at cutover | **Dropped:** production holds no receipts. |
| Q11 | Already-finalized groups at cutover | **Dropped:** production holds no receipts. |
| Q12 | A "hide for now" button besides Not this one? | **No:** "too much complexity". Not this one with Undo is the only dismiss. |
| Q13 | A weak similar-date tier? | **Yes,** ±7 days, weak label, not in the first pass: #2591. |

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
| Matches against dead copies | Discarded never raises a flag; rejected does, labelled in red with its reason | §4 |
| No re-check after clear or discard | Pairwise decisions replace the blanket exemption; every decision re-checks the rest of the group | §6.3, §6.4 |
| Only the later copy is flagged | Symmetric match; every open member meets the guard before it can finalize; a finalized member is matched by the open copy, which is held | §5.2 |
| Nondeterministic suspect | Members ordered by upload time; no single suspect | §5.1 |

## Appendix: alternatives considered

- **Store a set of suspects per receipt** instead of computing the group.
  Rejected: the set goes stale the moment another member changes state, which
  is habit 2 again. Computing it costs one indexed query per view.
- **Force the earlier copy into `duplicate_flagged` the moment a copy
  arrives.** Rejected: it moves a receipt out from under its submitter or
  finance mid-review. The lazy hold (§5.2) reaches the same guarantee, since
  nothing finalizes without passing the guard.
- **A second sign-off, or a required note, for clearing a match on a rejected
  receipt.** Rejected per @thpr: the label is enough ("don't go overboard"),
  and on a small team a second sign-off lands on the same people.
- **A unique constraint on the file hash.** Rejected long ago (1265 §2): it
  would refuse the upload instead of letting a person decide.
