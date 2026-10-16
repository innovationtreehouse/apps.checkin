# Finance and payments

Fees, refunds, payment plans, and reconciliation.

The file also covers money coming in through Shopify payouts (Income) and
donations (Donations).

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

### Gifts

- A gift is restricted only by the donor's own instructions, which are kept. A
  restriction the donor gives in conversation needs the donor's written
  confirmation. — *Financial Policy, Art. VI §VI.2*

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

- Benevity sends each batch of gifts whole, in one file. A gift that turns up
  after its batch is finished is rare, and finance books it by hand.

- Gifts of goods received before the app started recording them stay in
  QuickBooks only.

---

## Procedure

### Ownership

- Finance Ops belongs to the board; sysadmins are excluded outright.  [Unsettled — which superuser]

- Membership and program payment plans are read by the board and finance only;
  a sysadmin role alone does not admit.  [Decision — owner]

- The store is the source of truth for what was paid. The local mirror is a copy
  that reconciliation reads; no payment fact is authored here.  [Decision]

- Nobody decides a scholarship or payment plan for their own household.  [Decision — *Policy: Ethics Policy, Art. III §III.5*]

- Only finance, operations and inventory managers record in-kind gifts that
  arrive without a receipt, and every such gift names its donor. Only those three
  and the board read the gifts; only finance and the board read the donor.  [Decision — owner]

- An in-kind gift is recorded by someone outside the donor's household. A donor
  who shares a last name with anyone in a recorder's household counts as that
  recorder's household.  [Decision — owner; *Principle: fail closed*]

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
  reach membership and enrollment state. The app raises it for the board to work.
  Apart from the refund case below, it does not undo anything by itself.
  [Decision — *Principle: people decide about people*]

- When the store's refund notice says a program refund put seats back in stock,
  the app removes the enrollment of each child the refund identifies. A refund
  identifies a child when it returns every seat the order bought for the program,
  which removes every child on it, or when it fully refunds an order line that
  names the child. Until the sale ends, those seats stay on sale. Seats put back
  that the app can't tie to a child are taken back off sale, and those children
  stay flagged for the board to decide who leaves. A refund that returns nothing
  to stock, including a refund of reserved seats (which have no stock of their
  own in the store), is only raised for the board. So is a refund that the daily
  reconciliation finds rather than the refund notice. Every refund is raised for
  the board to settle the money.  [Decision]

- After a program's off-sale date, a refund that puts seats back in stock does not
  reopen the sale: the app takes every one of those seats back off sale. It still
  removes the children the refund identifies.  [Decision — owner]

- A refund removes only the children it refunds. A sibling on the same order
  stays enrolled.  [Decision]

- The store owns what a discount comes to; the app owns who may use one and until
  when. An order carrying the right item is correct whatever it totals — checking
  the total against a configured price drifts the moment the two disagree.  [Decision — deliberate limit]

- Only what the app sells reconciles: a membership, or a program. Donations and
  merchandise pass through untouched.  [Decision]

- A program order activates enrollment only when it is paid and not refunded,
  voided or cancelled, carries one of that program's own items — its public item
  or its hidden reserved-seat item, both counted as seats — and buys a seat for
  every person it would activate. The payment notification and reconciliation apply the
  one same check. An order that falls short activates nobody — it cannot say which
  of the household it was for — and is raised for the board.  [Decision]

- A paid program order with seats no pending enrollment uses — the child was
  comped, approved, withdrawn, expired or already paid, or the order bought extra
  — is raised for the board to review. The app does not adjust store inventory
  for it; the board settles the money and the seat.  [Decision — *Principle: people decide about people*]

- A second payment for a child already enrolled is flagged for review, never
  blocked. It is matched per child, so siblings paying on separate orders are
  never flagged.  [Decision]

- One program order pays for one household. An order naming people from more
  than one household enrolls nobody and is raised for the board.  [Decision]

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

- The app does record **which** of the two a household asked for — a reduced
  amount, more time, or an explicit "not sure" — chosen by the family when they
  send the request, shown on the review queue and in the review team's
  notification. The terms above stay out of the app; the *ask* does not, because
  the review team could not tell the two apart and opening with a comp for a
  family who only needed more time is its own harm. "Not sure" is a real answer:
  nobody owes the board a diagnosis of their own finances to ask for help. The
  acknowledgement to the family is unchanged and does not name the ask — they
  just chose it, and naming it would start to sound like an answer.  [Decision]

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

### Income

Income checks each Shopify payout against the deposits in QuickBooks.

- Finance and the board can see income. Only finance matches payouts and settles
  problems.  [Decision]

- Every payout must match one deposit in QuickBooks. Finance settles any the app
  can't match, and records why.  [Decision]

- Finance's own bookings come first. The app books only payouts newer than the
  last one finance booked by hand, and a payout nobody books is raised for
  finance.  [Decision]

- The app never changes or deletes anything already in QuickBooks.  [Decision — deliberate limit]

- Sales are booked to the program or fund they belong to. Sales finance hasn't
  assigned are booked as general Treehouse income.  [Decision]

- A payout or deposit that changes after it was matched goes back to finance.
  The app never matches it again on its own.  [Decision]

- Income keeps no record of who bought.  [Decision — *Principle: least privilege*]

### Donations

Donations covers gifts through Benevity (employee gifts and employer matches,
paid in batches) and gifts of goods (in-kind).

- Finance and the board can see donations, and finance manages them. The person
  who submits a receipt for a gift of goods records its donor, and can say it
  isn't a gift after all.  [Decision]

- Only finance and the board can see who gave. Each look at a Benevity donor is
  recorded.  [Decision — *Principle: least privilege*]

- Donors are not linked to people or households in the app.  [Decision — deliberate limit]

- Each gift goes to a program or fund, or is general Treehouse money. A gift
  that comes with no instructions from the donor is general money.  [Decision — *Policy: Financial Policy, Art. VI §VI.2*]

- Finance allocates each gift as the donor's instructions or policy direct. Once
  recorded, the allocation can't be changed in the app.  [Decision]

- A Benevity batch is finished only when every gift in it has a clear place in
  the books. The app never guesses, and a finished batch can't be changed.  [Decision]

- A gift of goods is handled as a donation, not as spending, even when it comes
  with a receipt. In the books it is both a donation received and an expense of
  the same value.  [Decision]

- A gift of goods recorded without a receipt must name its donor, and the goods
  go into inventory.  [Decision]

- A gift of goods still missing its donor is raised for finance. Once its money
  is recorded, the gift is never deleted.  [Decision]
