# Finance and payments

Fees, refunds, payment plans and reconciliation, plus money coming in through
online-store payouts (Income) and donations (Donations).

---

## Policy

### Fees are fees

- Membership and program fees are fees, not charitable donations. They cannot be
  paid through any form of giving that forbids the giver a benefit in return.
  — *Membership Policy, Art. XI; Sponsored Program Policy, Art. VI §VI.2*

### Refunds

- A denied applicant's membership fee is refunded. Otherwise nothing is refunded
  once membership or program participation is approved, absent an extreme
  circumstance. — *Membership Policy, Art. XII*

- Dismissal from membership is without refund. — *Definitions Policy, Art. III,
  "Dismiss from Membership"*

### Vendors

- Payment processors must be PCI DSS compliant; storage and SaaS vendors must be
  SOC 2 and ISO 27001 compliant. — *Definitions Policy, Art. III, "Suitably
  Secure Electronic Means"*

### Gifts

- Only the donor's own instructions restrict a gift, and they are kept. A
  restriction given in conversation needs the donor's written confirmation.
  — *Financial Policy, Art. VI §VI.2*

---

## Assumptions

Things the app takes as true because they are handled outside it.

- Card payments are taken by an outside payment processor, which carries the
  card-security obligations. The app never sees, stores or sends a card number;
  it learns that a payment was made from the processor's notice and records the
  order, not the card.

- Refunds are issued outside the app, in the store and the books. The app learns
  of a reversal afterwards and is never responsible for issuing one.

- Payment plans are agreed within the limits policy sets, and their schedule,
  amounts and completion are kept in the books. The app records only that a plan
  was approved.

- Scholarship totals, and the cap on fees waived without board approval, are
  managed in the program budget.

- Program budgets are handled outside the app: their approval, the
  conflict-of-interest rule on that vote, and the requirement that program money
  flows through the Treehouse.

- The giving platform sends each batch of gifts whole. A gift that turns up
  after its batch is finished is rare, and finance books it by hand.

- Gifts of goods received before the app started recording them stay in
  the books only.

---

## Procedure

### Ownership

- Apart from the payment-plan read below, Finance Ops belongs to the board alone,
  and the board approves payment plans.  [Unsettled — which superuser]

- Only the board and finance read membership and program payment plans.  [Decision — owner]

- The store is the source of truth for what was paid. The app records no
  payment fact of its own.  [Decision]

- Nobody decides a scholarship or payment plan for their own household.  [Decision — *Policy: Ethics Policy, Art. III §III.5*]

- A financial control flags something for a person to sign off, and the sign-off
  is recorded. It never decides on its own.  [Decision — *Principle: accountability*]

- A program's price is set on the program. When one run needs a different
  price, it is set on that run, never through a code people pass around. The
  store runs early-bird and sliding rates; the app does not model them.  [Decision — deliberate limit]

- The volunteer membership rate is the exception: it is a code, and anyone
  holding it can redeem it. A household that used it without being entitled is
  caught afterwards, by reconciliation.  [Decision — deliberate limit]

### Reconciliation

- The amount charged is the amount owed less any discount, so a charge below the
  amount owed is expected and is never a mismatch.  [Decision]

- Nothing waits for a payment notification. Reconciliation reads what the store
  says was paid and finishes anything a notification missed, so a lost
  notification delays an activation but never loses it, and recovery never waits
  on someone noticing.  [Decision — deliberate limit]

- A refund, chargeback or cancellation seen at the store must be reflected in
  membership and enrollment. The app raises it for the board to handle, and apart
  from the refund case below it undoes nothing by itself.
  [Decision — *Principle: people decide about people*]

- When the store's refund notice says a program refund put seats back on sale,
  the app removes the enrollment of each person the refund identifies: everyone
  on the order when it returns every seat the order bought, or the person named
  on a fully refunded order line. Returned seats the app can't tie to a person
  are taken off sale, and the board decides who leaves. Any other refund,
  including one of reserved seats or one the daily reconciliation found rather
  than the refund notice, is only raised for the board. Every refund is raised
  for the board to settle the money.  [Decision]

- A refund removes only the people it refunds. A sibling on the same order
  stays enrolled.  [Decision]

- A refund, chargeback or cancellation on a withdrawn person's order is raised
  against their withdrawn enrollment, which stays. A refund that puts back a seat
  the order identifies as theirs removes nobody and the seat stays on sale, unless
  the withdrawal had already put that seat back, in which case the extra one is
  taken off sale. A returned seat the order cannot tie to anyone is taken off sale
  like any other, even when one of the order's people has withdrawn.  [Decision]

- The store decides what a discount comes to; the app decides who may use one and
  until when. An order carrying the right item is correct whatever it totals.  [Decision — deliberate limit]

- Reconciliation covers only what the app sells, memberships and programs;
  donations and merchandise pass through untouched.  [Decision]

- A program order enrolls anyone only when it is paid and not refunded, voided
  or cancelled, is for that program (reserved seats count), and buys a seat for
  every person it would enroll. The same test applies however the payment
  arrives. An order that falls short enrolls nobody, because it cannot say who
  it was for, and is raised for the board. A seat an order paid for an earlier
  enrollment is spent, whether that person is still enrolled or has since left,
  so a later enrollment needs its own payment. An order seen again with every
  seat spent enrolls nobody and is not raised, because it carries no new
  money.  [Decision]

- A program order edited at the store, after it enrolled people, to pay for
  fewer seats than the people still enrolled on it is raised for the board. The
  app removes nobody, because the order cannot say whose seat it dropped.
  [Decision — *Principle: people decide about people*]

- A membership order edited at the store, after it activated a membership, to
  drop the membership item is raised for the board. Its total is never compared
  with the fee, and the membership stays as it is.
  [Decision — *Principle: people decide about people*]

- A paid program order with seats no waiting enrollment uses is raised for the
  board, which settles the money and the seat; the app changes neither. That
  covers a child who was comped, approved, withdrew, expired or already paid,
  and an order that bought extra.  [Decision — *Principle: people decide about people*]

- A second payment for a child already enrolled is flagged for review, never
  blocked. Payments are matched child by child, so siblings paid for on separate
  orders are never flagged.  [Decision]

- There is no fee ledger. What a family owes and has paid for a program comes from
  the enrollment itself and the store order behind it, never from a separate
  record of charges and payments.  [Decision — deliberate limit]

- A store order enrolls only children in the buying household, shown by the
  checkout link the app made for that household when it sent them to the store.
  Any other order, including one without such a link, enrolls nobody and is
  raised for the board.  [Decision — *Principle: fail closed*]

- Reconciliation problems are raised in Finance Ops, not under membership or
  programs, because one payment can cover both.  [Decision]

- The board can make the app catch up with the store, but cannot use that to
  replay history.  [Decision — deliberate limit]

- An activation's payment basis is one of paid, free, comped or scholarship; an
  activation with none is reported as a gap.  [Decision — *Principle: accountability*]

- Money paid against a blocked application is owed back as a refund; it never
  counts as paying for the application.  [Decision]

### Requests and communication

- An applicant gets exactly one automatic message about a request, the
  acknowledgement that it arrived. Non-payment notices are separate. The
  acknowledgement never suggests the matter is closed or that nothing more is
  needed, because the amount, the schedule and any discount are still to be
  agreed. Finance settles those with the board and writes to the family itself.
  The app never learns those terms, so it cannot speak for them.  [Decision — *Principle: people decide about people*]

- The app does record which kind of help a household asked for, chosen when
  they send the request: a reduced amount, more time, or "not sure". The review
  team sees it. The terms stay out of the app but the *ask* does not, because
  leading with a comp for a family who only needed more time does its own harm.
  "Not sure" is a real answer; nobody owes the board a diagnosis of their own
  finances to ask for help. The acknowledgement does not name the ask, because
  naming it would start to sound like an answer.  [Decision]

- Submitting a request for a scholarship or payment plan does not settle the fee
  it concerns. The membership stays unactivated and the enrollment unconfirmed
  until finance approves the request.  [Decision]

- A household can tell a balance it can pay from one waiting on finance, which
  is not theirs to act on.  [Decision]

- A request for something that starts after the next membership year is marked
  as such, never hidden or filtered out.  [Decision — deliberate limit]

- Removal for non-payment is a person's decision. Automatic non-payment notices
  warn the household and escalate to the board; they never remove anyone.  [Decision — *Principle: people decide about people*]

- The one removal that happens on its own follows a *denied* scholarship or
  payment-plan request: when the grace period the board set runs out, the
  enrollment ends and the held seat is released. Nothing is sent when it happens,
  so the board's denial must state the deadline.  [Decision — *Principle: fail closed*]

### Income

Income checks each online-store payout against the deposits in the books.

- Finance and the board can see income. Only finance matches payouts and settles
  problems.  [Decision]

- Every payout must match one deposit in the books. Finance settles any the app
  can't match and records why.  [Decision]

- The app books nothing dated on or before the closing date finance sets in the
  books. With no closing date set, it books nothing dated before income's posting
  was switched on, and when it cannot read the date it books nothing.  [Decision — owner; *Principle: fail closed*]

- The window for matching a giving-platform deposit, one to 30 days either side
  of its date, is a setting, seven by default. Finance or the board may change it
  in either direction. Each change is recorded.  [Decision — owner]

- How many deposits the app may create in one run, and how many dollars' worth for
  each deposit source, are settings. Finance may lower them; raising one takes the
  board. Each change is recorded.  [Decision — owner]

- Until income's posting is switched on, the app only matches. A payout it cannot
  match goes to finance, which has the app book it or skips it with a reason.  [Decision — owner]

- Posting switches on the first time the daily step posts, once and for good.
  Online-store payouts and giving-platform deposits each have their own switch-on.
  A payout the app first sees after that books on its own, matching first, however
  late it arrived.  [Decision — owner]

- The app never changes or deletes anything already in the books.  [Decision — deliberate limit]

- Sales are booked to the program or fund they belong to. Sales are booked as
  general Treehouse income only where finance chose that for the item, with one
  exception: a custom item, typed into an order with no store item behind it, books
  as general income without asking, because custom items are rare. A payout with a
  sale of any other item finance has not decided on waits until finance does, and
  the next run books it once finance decides.  [Decision — owner]

- Finance can decide on the app's program and membership items before their first
  sale. An item made by hand in the store can be decided on after its first sale.  [Decision — owner]

- An item can be assigned to a bucket only if the bucket is live and its Class is
  active in the books. While the books can't be reached to check, the assignment is
  refused. Choosing general income needs no check.  [Decision — owner]

- When a run finds an assigned bucket archived or without an active Class, it alerts
  finance once for that bucket and marks its items. A payout with a sale of those
  items waits, in whole, until finance restores the bucket or reassigns the items.
  The app never reassigns them. While Classes can't be read, a payout with a sale
  assigned to any bucket waits. This check is part of booking, so it doesn't run
  while posting is off or the closing date can't be read.  [Decision — owner]

- A payout with a sale whose items the app can't see waits too, and never books
  itself as general income. It books once the order's items arrive. The same goes
  for an order whose items add up to less than its subtotal, because some are
  missing. A sale with no order at all stays with finance, which books it by hand or dismisses it with a
  reason.  [Decision — owner]

- A payout or deposit that changes after it was matched goes back to finance.
  The app never matches it again on its own.  [Decision]

- A deposit finance excludes is never offered as a candidate or matched to a payout
  again. The one exception is a deposit the app itself created for a payout, which
  stays linked to that payout because it is that payout's own booking. An exclusion
  carries a reason and is not undone.  [Decision — *Principle: apply once*]

- Income's matching runs only in the daily jobs or on finance's request, never at
  app start.  [Decision]

- Store history reaches the app only through the mirror of the store's data. The
  app has no upload of store exports.  [Decision — deliberate limit]

- A change to an item's mapping applies to deposits created afterwards. It never
  rebooks a deposit already created.  [Decision]

- Income keeps no record of who bought.  [Decision — *Principle: least privilege*]

### Donations

Donations covers gifts through an outside giving platform (employee gifts and
employer matches, paid in batches) and gifts of goods (in-kind).

- Finance and the board can see donations, and finance manages them. The person
  who submits a receipt for a gift of goods records its donor, and can say it
  isn't a gift after all.  [Decision]

- Only finance and the board can see who gave.  [Decision — *Principle: least privilege*]

- Every view of finance records other than a person's own is recorded, each look
  at a donor included: who looked, which records, through which screen, and when,
  never what the records said.
  A person looking at their own receipts is not recorded, and neither is a
  count. Only the Board reads the record.  [Decision — owner]

- A view whose record cannot be written is refused, not served unrecorded.  [Decision — owner; *Principle: fail closed*]

- Looks at a donor from before the finance-view record began are not in it. They
  stay in the bulk-donation library's own event history, which keeps them, and
  are not copied across.  [Decision — owner]

- Donors are not linked to people or households in the app.  [Decision — deliberate limit]

- A gift of money goes to a program or fund, or is general Treehouse money. One
  that comes with no instructions from the donor is general money.  [Decision — *Policy: Financial Policy, Art. VI §VI.2*]

- Finance allocates each gift as the donor's instructions or policy direct. Once
  a gift of money is recorded, its allocation can't be changed in the app.  [Decision]

- A giving-platform gift is imported at most once per org.  [Decision — *Principle: apply once*]

- A giving-platform batch is finished only when every gift in it has a clear place in
  the books. The app never guesses, and a finished batch can't be changed.  [Decision]

- Every finished giving-platform batch must match one deposit in the books.
  Finance settles any the app can't match and records why. [Decision]

- A giving-platform gift with no disbursement date is refused at upload, with the
  rest of its file. A finished batch that can't be handed over for booking, because
  it has no date or nets to zero or less, goes to finance once by email to settle
  by hand. [Decision]

- A gift of goods is handled as a donation, not as spending, even when it comes
  with a receipt. In the books it is both a donation received and an expense of
  the same value, from one record, in one bucket.  [Decision]

- A gift of goods always goes to a budget bucket, never to general money, because
  its expense side carries the bucket's Class. Where the donor gave no
  instructions, finance chooses the bucket, which may be a part of the facility
  such as Facility or Shop.  [Decision — owner]

- Finance may change a gift of goods' bucket until the gift starts booking, and
  not after. A bucket that is archived or has no Class can't be assigned. A gift
  already in such a bucket waits in finance's queue, and the app never reassigns
  it.  [Decision — owner]

- Every gift of goods is accepted, refused or returned once before it books, by a
  finance holder, or by a Board member when every finance holder is conflicted
  with the uploader or recorder. A refused or returned gift never books, and its goods are
  adjusted out of stock by hand, never by the app.  [Decision — owner]

- Nobody decides a gift of goods that they or their household uploaded or
  recorded, or where they or their household is the donor. Donors aren't linked to
  people, so the person deciding confirms they are outside the donor's household,
  and that is recorded.  [Decision — owner; *Policy: Ethics Policy, Art. III §III.5*]

- The person accepting a gift of goods, with a receipt or without one, confirms the
  goods themselves exist and arrived, not only the receipt, and that is recorded.
  Refusing or returning a gift needs no such confirmation.  [Decision — owner decision AR-13, 2026-11-01]

- A gift of goods with a receipt books at the receipt's values. One without a
  receipt is valued by whoever accepts it; what operations enter is a suggestion.
  [Decision — owner]

- The accept screen warns about a donor surname shared with the decider's or the
  recorder's household, a large value and a donor replaced after recording. These
  never block a decision.  [Decision — *Principle: people decide about people*]

- A program bucket's approvers see the accepted gifts of goods in their bucket:
  what was given, its value and date, never the donor. They do not approve them.  [Decision — owner]

- Gifts of goods follow the closed-books rules in Income, with their own switch-on.
  A gift counts from when its money arrived or it was recorded.  [Decision — owner]

- The window for matching a gift of goods to finance's bookings, one to 30 days
  either side of its date, is a setting, seven by default. Finance or the board may
  change it in either direction. How many entries the app may create for gifts of
  goods in one run is a setting too: finance may lower it, and raising it takes the
  board. Each change is recorded. Gifts of goods have no daily or dollar limit.
  [Decision — owner]

- A gift of goods that keeps failing to book stops retrying and goes to finance,
  so it can't hold back newer gifts. When a run stops because several gifts in a
  row failed, finance is alerted.  [Decision]

- A gift of goods withdrawn after its money arrived is raised for finance, booked
  or not. Finance reverses it by hand only if it booked; the app changes nothing
  in the books. When finance settles a withdrawal, the donor's details are cleared
  and the gift and its money stay.  [Decision — owner]

- The app sends no donor letter for a gift of goods before it is accepted. A letter
  for a gift of goods describes the goods and states no value; a letter for a gift
  of money states its amount.  [Decision — owner]

- Only finance, operations and inventory managers record a gift of goods that
  arrives without a receipt. Only those three and the board see these gifts,
  apart from what a program's approvers see.  [Decision — owner]

- The person who records a gift of goods must be outside the donor's household.
  A donor who shares a last name with anyone in the recorder's household counts
  as part of that household. This covers a gift recorded without a receipt and a
  donor typed in on a receipt.  [Decision — owner, 2026-10-31; *Principle: fail closed*]

- Someone uploading a receipt may name themselves as the donor by choosing "I am
  the donor". The person who decides the gift is the independent check.
  [Decision — owner, 2026-11-01]

- A gift of goods recorded without a receipt must name its donor, and the goods
  go into inventory.  [Decision]

- A gift of goods still missing its donor is raised for finance. Once its money
  is recorded, the gift is never deleted.  [Decision]
