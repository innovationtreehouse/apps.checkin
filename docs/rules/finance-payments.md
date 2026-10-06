# Finance and payments

Fees, refunds, payment plans, and reconciliation.

---

## Policy

### Fees are fees

- Membership and program fees are fees, not charitable donations, and cannot be
  paid by means of giving from which the payer must receive no benefit.
  — *Membership Policy, Art. XI; Sponsored Program Policy, Art. VI §VI.2*

- The board sets the cost of all memberships, and may discount for financial
  need, college students, partner organisations, service-program participants,
  and volunteers with no youth in any program. — *Membership Policy, Art. XI*

- Program fees before scholarship adjustment are equal for all members.
  — *Sponsored Program Policy, Art. VI §VI.2*

- A participant who completes a registration is responsible for paying for it.
  — *Sponsored Program Policy, Art. VIII*

### Refunds and plans

- The membership fee is refunded on denial of membership; an accepted offset for
  the background check is not. Otherwise no refund once membership or program
  participation is approved, absent an extreme circumstance. A program refund is
  the program leader's decision with board approval; a Treehouse-level refund is
  the board's alone. — *Membership Policy, Art. XII*

- Dismissal from membership is without refund. — *Definitions Policy, Art. III,
  "Dismiss from Membership"*

- A membership payment plan does not extend beyond the membership year it
  covers. A program payment plan does not extend beyond the later of the
  program's end and 90 days from its start. Late payment under a plan may lead
  to dismissal. — *Membership Policy, Art. XIII*

- No more than 20% of total participant fees may be waived by scholarship
  without board approval, rising to 50% where total fees are $20 or less per
  participant; externally designated scholarship funds are excluded from the
  count. — *Sponsored Program Policy, Art. VII*

### Program money

- Funds supporting a program flow through the Treehouse; anything else needs
  specific board approval. — *Sponsored Program Policy, Art. III §III.5*

- A program budget is approved by the board before any spending is committed.
  — *Sponsored Program Policy, Art. III §III.6*

- A program budget cannot be approved where a majority of the affirmative votes
  come from people with a conflict of interest with the program leader or
  program treasurer. — *Sponsored Program Policy, Art. III §III.7*

- Someone with a conflict of interest in a matter takes no part in deciding it,
  and the same person does not authorise, execute, and monitor a transaction.
  — *Ethics Policy, Art. III §III.5; Financial Policy, Art. III*

- Payment processors must be PCI DSS compliant; storage and SaaS vendors must be
  SOC 2 and ISO 27001 compliant. — *Definitions Policy, Art. III, "Suitably
  Secure Electronic Means"*

---

## Assumptions

Things the app takes as true because they are handled outside it.

- Refunds are issued outside the app, in the store and the books. The app sees a
  reversal after the fact; it never owes one.

- Payment-plan terms are agreed within the limits policy sets, and the books hold
  them. The app records that a plan was approved, never its schedule or its
  amounts.

- A plan finishing happens in the books too. When a family completes their
  instalments finance records it there; the app has no screen for marking a plan
  paid off, and was never meant to.

- Program budgets live outside the app — their approval, the conflict-of-interest
  rule on that vote, and the requirement that program funds flow through the
  Treehouse are all handled there.

---

## Procedure

### Ownership

- Finance Ops belongs to the board; sysadmins are excluded outright.  [Unsettled — which superuser]

- The store is the source of truth for what was paid. The local mirror is a copy
  that reconciliation reads; no payment fact is authored here.  [Decision]

- Nobody decides a scholarship or payment plan for their own household.  [Decision — *Policy: Ethics Policy, Art. III §III.5*]

- A financial control is a flag a person signs off, with the sign-off recorded.
  It is not a gate that decides on its own.  [Decision — *Principle: people decide about people*]

- Whether a payment goes to the real store, the test store, or a local stand-in
  is decided by which environment the app is told it is running in — never
  guessed from whether store credentials happen to be present.  [Decision — *Principle: fail closed*]

- A program's price lives on the program. Where one run of it needs a different
  price, that is set against the run — not by issuing a code people pass around.
  Early-bird and sliding rates are the store's to run, not ours to model.  [Decision — deliberate limit]

- The volunteer membership rate is the exception, and it is a code. Anyone
  holding it can redeem it, entitled or not: checkout does not check. A household
  that used it without being a volunteer household is caught afterwards, when
  reconciliation compares who redeemed it against who was owed it.  [Decision — deliberate limit]

### Reconciliation

- Charged is owed minus discount, so a charge below the amount owed is expected,
  never a mismatch.  [Decision]

- Nothing waits on a payment notification arriving. Reconciliation reads what the
  store says was paid and finishes anything the notification missed, so a dropped
  one delays an activation rather than losing it. The delay is bounded by the
  mirror's catch-up cadence, never by someone noticing.  [Decision — deliberate limit]

- A reversal seen at the store — a refund, chargeback or cancellation — must
  reach membership and enrollment state. The app raises it for the board to work;
  it does not undo anything by itself.  [Decision — *Principle: people decide about people*]

- The store owns what a discount comes to; the app owns who may use one and until
  when. An order carrying the right item is correct whatever it totals — checking
  the total against a configured price drifts the moment the two disagree.  [Decision — deliberate limit]

- Only what the app sells reconciles: a membership, or a program. Donations and
  merchandise pass through untouched.  [Decision]

- A program order activates enrollment only when it is paid and not refunded,
  voided or cancelled, carries that program's own item, and buys a seat for every
  person it would activate. The payment notification and reconciliation apply the
  one same check. An order that falls short activates nobody — it cannot say which
  of the household it was for — and is raised for the board.  [Decision]

- An order that names someone outside the buyer's household is not checked
  against household ownership; the seat and item checks are the control.  [Decision — deliberate limit]

- There is no fee ledger. What a family owes and has paid for a program is the
  enrollment's own state and the store order behind it, never a separate record of
  charges and payments kept alongside.  [Decision — deliberate limit]

- Reconciliation problems surface on the finance board, where payments live. A
  payment crosses membership and programs, so neither of those views alone is the
  place to raise one.  [Decision]

- The board can force the mirror to catch up. It only ever catches up; replaying
  history is not reachable that way.  [Decision — deliberate limit]

- An activation's payment basis is paid, free, comped or scholarship; one with
  none is reported as a gap.  [Decision — *Principle: accountability*]

- Payment against a blocked application is a refund obligation, never a
  satisfied claim.  [Decision]

### Requests and communication

- Membership and program payment plans are separate queues, and store holds are
  a third. One list covering all of them was rejected.  [Decision — deliberate limit]

- An applicant gets exactly one automatic message about a request — the
  acknowledgement that it arrived. Non-payment notices are a separate stream.
  That acknowledgement never suggests the matter is closed or that nothing
  further is needed, because the amount, the schedule and any discount are still
  to be agreed — finance settles those with the board and writes to the family
  itself. The app never learns those terms, so it cannot speak for them.  [Decision — *Principle: people decide about people*]

- Submitting a request for a scholarship or a payment plan does not settle the
  fee it concerns. The membership stays unactivated and the enrollment stays
  unconfirmed until finance approves the request; until then the record waits
  where it is.  [Decision]

- A balance the household can pay looks different from one waiting on finance.
  The second is not theirs to act on.  [Decision]

- A request for something starting after the next membership year is marked as
  such, never hidden or filtered away.  [Decision — deliberate limit]

- Removal for non-payment is a human decision on an admin surface. The
  non-payment sweep warns the household and escalates to the board; it never
  removes anyone.  [Decision — *Principle: people decide about people*]

- The one removal that happens on its own follows a *denied* scholarship or
  payment-plan request: when the grace period the board set runs out, the
  enrollment goes and the held seat is released. Nothing is sent when it does, so
  the board's own message has to have stated the deadline.  [Decision — *Principle: fail closed*]
