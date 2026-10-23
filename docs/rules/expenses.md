# Expenses

Rules for money the Treehouse spends: receipts, expenses, budget buckets, who
signs off on spending, and how expenses reach the books.

Income and donation rules are in `revenue.md`.

Goods received into stock are covered in `inventory.md`.

A few terms used throughout:

- **Finance** means anyone holding the finance role in the app.
- **Household** means the person's household as the app records it.
- An **expense** is the app's record of one receipt's spending, split into
  **lines**, one per item.
- A **budget bucket** is the accounting category a line is charged to, such as a
  program's budget or an org-level one like Facility.

---

## Policy

- Spending sign-off is governed by the *Financial Policy, Arts. IX and XII*
  and the *Procurement Policy, Art. IV*.

---

## Assumptions

Things the app takes as true because they are handled outside it.

- Finance pays reimbursements in the accounting system. The app records what is
  owed and reads the payment back; it never pays anyone.

- The Board appoints only adults as program treasurers, as corporate policy
  requires.

- The Treasurer enforces the limits on a signed note in place of a receipt
  outside the app. The app does not model notes in lieu of receipts.

---

## Procedure

### Who may see and do what

- Being on the Board is enough to view receipt and expense data, and to edit it
  where the app allows an edit.
  [Decision — owner]

- An adult member or a staff/role holder may submit a receipt and view, edit,
  and fetch their own receipts. An adult member is a person whose session age
  band is adult and whose household membership is ACTIVE. A role holder or a
  Treehouse staff account is admitted whatever their recorded age or membership.
  A signed-in adult with no ACTIVE membership is refused, and so is a youth or a
  person of unknown age without a role, because a self-declared age alone is not
  proof of adulthood. No background check is needed. The submitter sees only
  their own receipts, without donor or reimbursee names, and approval stays with
  FINANCE, so the audience exposes no other person's data and moves no money on
  its own. The same audience may reach an expense sign-off for the submitter
  seat, since that seat is filled from the receipt. Widening it to any signed-in
  adult, narrowing it to the catalog audience, or adding a background-check leg
  is a decision on the record.
  [Decision — owner]

- Only the person who paid is reimbursed: the adult who uploaded the receipt
  and said they paid for it themselves.
  [Decision]

- Only finance approves and rejects receipts, imports old ones, and changes
  receipt settings.
  [Decision — *Principle: least privilege*]

- Only finance and the Board see every expense. A program's leader and
  treasurers see only the lines in their program's bucket.
  [Decision — *Principle: least privilege*]

### Receipts

- Nobody takes a step on a receipt they are conflicted on if they could use it
  to their own benefit or to hide or clear their own spending. A person is
  conflicted when they, or someone in their household, uploaded the receipt or
  is reimbursed for it. A conflicted person may not approve a line or raise an
  exception on it, sign any sign-off seat, or record Board authorization.
  Classifying a purchase that is already signed off is bookkeeping, and any
  finance holder may do it: the capital or non-capital designation, the
  depreciation cycle and owner bucket, the account set on a mapping hold, and
  resubmitting a held expense. Until a receipt is finalized, its submitter may
  correct its tax and date; a receipt whose tax or date its submitter corrected
  goes to finance review.
  [Decision — *Policy: Ethics Policy, Art. III §III.5*]

- A conflicted person also may not reject a receipt, change its tax or date as
  finance, name the person reimbursed, or check off its flags. A Board member
  standing in for someone is reviewed by someone outside the households of
  everyone who signed.
  [Decision — *Policy: Ethics Policy, Art. III §III.5*]

- A person conflicted on an expense may not choose which QuickBooks entry it is
  matched to. The app does not refuse this yet: any finance holder can make the
  match.
  [Short of policy — *Policy: Ethics Policy, Art. III §III.5*]

- Excluding a QuickBooks entry from matching can hide spending, but no conflict
  check can refuse it, because a QuickBooks entry names no person. Every
  exclusion records who made it and why, so it stays visible.
  [Decision — *Policy: Ethics Policy, Art. III §III.5*]

- Finance writes a reason when approving a receipt held for tax review.
  [Decision]

- A receipt that looks like a duplicate goes to finance to decide; it is never
  refused automatically.
  [Decision — deliberate limit]

- A gift of goods (an in-kind receipt) names its donor, is never reimbursed, and
  needs no spending sign-off.
  [Decision]

- Finance may record old receipts for purchases already in the books. Doing so
  never reimburses anyone and never books anything a second time.
  [Decision]

- A finalized receipt is read-only.
  [Decision]

### Budget buckets

- A budget bucket is an accounting bucket, not a person. Finance creates,
  renames and archives buckets and maps each to a class in the accounting
  system. Archiving keeps the row, because finance records point at it.
  [Decision]

- A program bucket's approvers are the program's leader and its treasurers,
  derived and never stored. An org-level bucket has none.
  [Decision]

- A program treasurer is set by the board alone, because the role comes from the
  board-approved program budget. Nobody sets it on themself or anyone in their
  own household.
  [Decision — *Policy: Ethics Policy, Art. III §III.5*]

- Finance decides which bucket each line is charged to, before the program
  approver signs it.
  [Decision]

### Expenses

- Every expense starts from a receipt. Past spending with no receipt stays in
  the accounting system only; the app never imports it.
  [Decision — deliberate limit]

- Every expense that is not a reimbursement is treated as a Treehouse Card
  charge. The app records no payment method.
  [Decision — owner]

- The app flags an expense for review when it carries tax, crosses a dollar
  threshold, includes capital equipment, has no known person to reimburse, has a
  Board member standing in for someone, or fails to reach the books. Every
  check-off records who made it. A flag never holds money back by itself.
  [Decision — *Principle: accountability*]

### Spending sign-off

Each line of a reimbursement or card charge has three sign-off seats: the
submitter, a program approver (the program's leader or a Program Treasurer), and
the Treasurer.

- A reimbursement or card charge reaches the books only once each of its lines
  is signed by the submitter, a program approver, and the Treasurer — three
  different people from three different households.
  [Decision — *Policy: Financial Policy, Art. IX §IX.3*]

- A sign-off is judged when it is signed; a later change to the signer's
  household or role does not undo it.
  [Decision]

- "The Treasurer" is, for now, anyone holding the finance role. The app has no
  record of who holds the Treasurer office.
  [Decision — owner]

- A Treasurer with a conflict does not sign. For the Treasurer seat, a conflict
  is being — or sharing a household with — the submitter, the person reimbursed,
  or the line's Program Leader, or having approved the line as its program
  approver. Another finance holder without a conflict signs instead; if there is
  none, a Board member without a conflict takes the seat. This differs from the
  policy on purpose: the policy has the conflicted Treasurer sign and adds one
  or two Board members, where the app replaces the conflicted signer, because
  nobody decides on a receipt they are conflicted on.
  [Decision — *Policy: Financial Policy, Art. IX §IX.3; Ethics Policy, Art. III §III.5*]

- When every Program Leader and Program Treasurer of a line's program is
  conflicted or unavailable, a Board member without a conflict signs the
  program-approver seat. The policy names no one for this case; the app fills
  the gap rather than leave the line held for good.
  [Decision — owner]

- Reimbursing someone who is not a Treehouse Member takes a Board member in the
  program-approver seat. What counts is the person reimbursed, not whoever
  submitted the receipt, and a card charge is not a reimbursement.
  [Decision — *Policy: Financial Policy, Art. IX §IX.2*]

- Whoever named the person reimbursed does not sign as Treasurer on that
  expense. The policy does not ask for this.
  [Decision — deliberate limit]

- A card charge is Everyday when its total is under $500 and no single item
  costs more than $250. An item is one unit, so three $100 items are three items
  under the limit. Both amounts are settings: finance may lower them, and only
  the Board raises them above $500 and $250.
  [Decision — *Policy: Procurement Policy, Art. IV §IV.1; Financial Policy, Art. XII §XII.4*; owner]

- A purchase from a single-source vendor is never Everyday.
  [Decision — owner]

- Finance may mark any card charge as not Everyday. The mark is permanent: it
  only ever adds the need for Board authorization.
  [Decision — owner]

- A card charge that is not Everyday reaches the books only once the Treasurer
  records what the Board authorized, in words. A blank record does not count,
  and until it is made the charge is treated as not authorized. Once recorded,
  it is not changed.
  [Decision — *Policy: Financial Policy, Art. XII §XII.4*; *Principle: fail closed*]

- Recording the Board's authorization is the Treasurer's act, under the
  Treasurer conflict rule: a finance holder without a conflict records it, and
  if there is none, a Board member without a conflict.
  [Decision — owner]

- A line in an org-level bucket takes a Board member without a conflict as
  program approver.
  [Decision]

- When nobody eligible can sign a seat, a Board member without a conflict may
  sign in their place. On any one line that happens at most twice for a
  reimbursement and once for a card charge. A line that would need more is held
  for the Board to resolve.
  [Decision]

### Sending expenses to the books

The rules in *Principle: The books are finance's* apply throughout. These are
the parts specific to expenses.

- Every expense reaches the books charged to the budget it was spent from, so
  each program's spending can be read against its budget.
  [Decision]

- A reimbursement counts as paid only when the accounting system shows it fully
  paid, on the date of the last payment.
  [Decision]
