# Programs

Eligibility, enrollment, pricing, capacity, and scholarships.

---

## Policy

### What a program is and who runs it

- Every activity of the Treehouse operates as a sponsored program, unless it is
  coordinated and budgeted by the board directly, charges no fee, and has no
  specific group of participants. — *Sponsored Program Policy, Art. III §III.1*

- Every sponsored program has a program budget and a program leader identified
  in writing. — *Sponsored Program Policy, Art. III §III.2*

- A program leader is at least 23, is a member, and has passed the background
  check. — *Sponsored Program Policy, Art. IV*

- A program leader holds exclusive, non-transferable authority over their
  program. Programs do not create their own governance — committees, voting
  memberships, or budget authority — without written board authorisation, and
  the board may modify or terminate a program at its discretion. — *Sponsored
  Program Policy, Art. IX*

- A second adult volunteer is required when the program is not running alongside
  another program at the same facility or event. — *Sponsored Program Policy,
  Art. III §III.2*

- Every use of a facility has an agreed keyholder, agreed by both the program
  leader and the keyholder. — *Sponsored Program Policy, Art. III §III.3*

- The membership fee does not buy participation in a program that carries an
  application, a fee, or other restrictions. — *Membership Policy, Art. V;
  Definitions Policy, Art. III, "Member Family"*

### Fees and scholarships

- Program fees, before any scholarship adjustment, are equal for all members —
  including a board member enrolling their own family, who pays what everyone
  else pays. A fee may be assessed at several points across the program's life,
  and those assessments need not be equal to one another. — *Sponsored Program
  Policy, Art. VI §VI.2*

- Holding a role is not a reason to decide a matter that benefits your own
  family. — *Ethics Policy, Art. III §§III.2, III.5*

- A program fee is a fee, not a charitable donation. — *Sponsored Program
  Policy, Art. VI §VI.2*

- No more than 20% of total participant fees may be waived by scholarship
  without board approval. Externally designated scholarship funds do not count
  toward that limit, and where total fees are $20 or less per participant the
  limit rises to 50%. — *Sponsored Program Policy, Art. VII*

- A scholarship has a specific intent and is budgeted for in the program budget.
  — *Sponsored Program Policy, Art. VII*

- A program payment plan does not extend beyond the later of the program's end
  and 90 days from its start. — *Membership Policy, Art. XIII*

- A participant who completes a registration is responsible for paying for it.
  — *Sponsored Program Policy, Art. VIII*

### Youth participation

- Youth are enrolled in school — public, private, or home — unless they hold a
  high-school diploma or equivalent. — *Membership Policy, Art. IV*

- A program leader may require a parent or guardian to stay during a program,
  and may apply that to some families and not others. — *Sponsored Program
  Policy, Art. III §III.4*

---

## Assumptions

Things the app takes as true because they are handled outside it.

- Scholarship totals are tracked in the program budget, where the cap on waived
  fees and the board approval it triggers are applied.

- Payment-plan terms are agreed within the limits policy sets. The app records
  that a plan was approved, not its schedule.

---

## Procedure

### Eligibility

- Age eligibility is measured at the program's start date, not at registration.
  Both start and end dates are required.  [Decision]

- No program targets anyone over 25, and an age limit above that is refused.  [Decision]

- A declared adult clears any youth minimum and fails any youth maximum. Nothing
  verifies the claim. Checking a date of birth and telling a guardian were both
  considered and refused; a minor who declares themselves an adult is a risk
  taken knowingly.  [Decision — deliberate limit]

- A program leader is 23 or older, the floor belonging to the role rather than to
  adulthood. A program volunteer has no age floor at all — youth volunteer too.  [Decision — *Policy: Sponsored Program Policy, Art. IV*]

- Nothing checks that a program leader is a member who has passed a background
  check.  [Short of policy — *Policy: Sponsored Program Policy, Art. IV*]

- Nobody under 18 enrolls themselves, and nobody whose age is unknown does
  either; only a known adult may. The bar is the guardian-consent line and is
  separate from the ages a program targets. A youth is enrolled, and withdrawn,
  by their household lead.  [Decision — *Principle: fail closed*]

- Being refused for an unknown age is not a dead end. Someone with no age on file
  is asked to record one and may then enroll themselves; a brand-new adult is
  their own household lead and has nobody else to ask.  [Decision]

### Enrollment

- A program never enrolls beyond capacity, including on a simultaneous claim of
  the last seat. A confirmed admin override on another household is the one
  exception.  [Decision]

- Enrollment is done by the person, their household lead, the board, or a
  sysadmin — not by the program's lead.  [Decision — *Principle: least privilege*;
  superuser scope unsettled]

- The fee waiver applies only to an administrator acting on another household.
  Waiving a limit is a separate power from waiving a fee.  [Decision — *Policy: Sponsored Program Policy, Art. VI §VI.2; Ethics Policy, Art. III*]

- Unpaid enrollments are warned, then escalated to the board. Overdue is a
  classification, not an action.  [Decision — *Principle: people decide about people*]

- Enrolling in a public workshop takes no membership agreement, and a household
  that only ever enrolls in programs need give no mailing address.  [Decision]

- A household that cannot enroll — nobody eligible, or no valid emergency contact
  — is offered the way to fix it rather than a refusal.  [Decision]

- Registration signs someone in before intake begins, so whether an account
  exists is answered by signing in and never by a public reply.  [Decision — *Principle: no existence oracle*]

- Removing a paid enrollment returns nothing to sale. A person decides whether
  the freed seat goes back, and does it at the store.  [Decision — deliberate limit; *Principle: people decide about people*]

- A request for a payment plan is never swept away for sitting too long.  [Decision]

### What a youth sees of money

- A youth is never shown a payment obligation, a payment action, or a payment
  status, whether their own or their household's. It is not disabled and not
  explained; it is absent. Their own enrollment awaiting payment reads as
  awaiting confirmation, which names no money, stays true if the household never
  pays, and puts the next action with somebody else.  [Decision]

- A youth may not settle a payment their household lead started, on their own
  enrollment or any other. There is no finish-the-checkout allowance for an
  enrollment that already exists.  [Decision]

- What a program costs stays public. A price is program information, not a
  payment situation; it carries no obligation, no state and no action, so a youth
  sees it like anyone else.  [Decision — deliberate limit]

- Someone whose age is unknown is treated the opposite way from a youth here.
  They may well be an adult, so nothing is hidden from them and they are asked
  for their age instead. Known youth, hide; unknown, ask.  [Decision]

### Pricing

- A failed discount degrades to undiscounted checkout, never an error.  [Decision — deliberate limit]

- A program priced on a tier with nothing wired to sell it is broken and is
  reported as such. A free tier has nothing to wire and is never reported, and a
  tier priced at zero is free — it is never sold, never reported, and never waits
  on a payment.  [Decision]

- Such a program takes no enrollment that would have to be paid for. The place is
  refused outright rather than admitted and left waiting on a payment that can
  never arrive. An administrator's comped place never reaches the store and is
  seated as normal; nobody else's confirmation makes the program sellable, so
  none is offered.  [Decision — *Principle: fail closed*]

> **Candidate, not settled — for owner ratification.** Member pricing requires
> the membership to cover the program's end date, not merely be active today.
> Falls back to status alone when the membership-year boundary is unset.
> (`checkin-app/src/lib/orgMembership.ts`)

### Capacity and scholarship holds

- A program has one capacity pool, with no separate member-priced pool. The
  number is how many people fit in the room, so a comped place takes one like any
  other.  [Decision]

- A request whose seat was never taken off sale is its own state, not an unpaid
  applicant — the family did nothing wrong when the store call failed. It waits
  in its own queue until a board member removes the seat by hand and confirms it,
  which records the hold and returns the request to the normal decision.  [Decision]

- The self-approval bar covers deciding a request, not repairing one. Confirming
  a hold somebody's failed store call never made benefits nobody.  [Decision — *Policy: Ethics Policy, Art. III §III.5*]

- A scholarship or payment-plan request takes its seat when requested, not when
  approved.  [Decision]

- A held seat is returned exactly once — by withdrawal, payment, or grace expiry
  — or consumed permanently by approval, and an approved seat is never credited
  back. This holds against a failed store call, not a crash mid-transition.  [Decision]

- A place granted while its seat is still held is the one drift repaired without
  a person: a sweep releases the seat and leaves the place. Every other
  off-diagram enrollment is reported and left alone, because repairing it would
  mean guessing which of two states the family is actually in.  [Decision — deliberate limit;
  *Principle: people decide about people*]

- Denying a request does not release the seat; the family may still pay for it.  [Decision]

- A denial starts the grace clock and sends nothing, so the board's own message
  has to state the deadline.  [Decision — deliberate limit]

- The grace period is a board setting. Unset means the feature is off.  [Decision — *Principle: fail closed*]

- A request whose seat hold failed waits for a board member to take the seat off
  sale by hand. It can still be approved or denied without one, deliberately: the
  queue offers each as a named override behind a confirmation that states the
  oversell risk. A failed store call is the organisation's fault, and stranding
  the family is the worse outcome.  [Decision — deliberate limit]

### Access to program information

- A program's catalogue entry is public; its roster is visible only to the people
  running it — its leader, its core volunteers, the board and sysadmins — and to
  people enrolled in it. The catalogue filters rather than gates: an anonymous
  caller reaches it and sees less, and is never told that a hidden members-only
  program exists.  [Decision — *Policy: Records Policy, Art. IV*]

- A members-only program is hidden by default and keeps that silence on its own
  page: an anonymous caller is told there is no such program; a signed-in caller
  who is not a member is told it exists and that it is members only. Signing in is
  what earns the reason for being turned away.  [Decision — *Principle: no existence oracle*]

- A program's leader may opt a members-only program into the public catalogue
  (publiclyVisible). Such a program is listed and its detail page shown to everyone,
  non-members included, so the offering can be understood; its roster stays hidden
  from non-enrolled callers, and enrollment is still refused to anyone whose
  membership is unsettled. Visibility and the right to join are separate.  [Decision]

- A program leader is defined by the program they lead, not by a role they hold.
  They reach the programs they lead and no others; the board and sysadmins reach
  all of them.  [Decision — superuser scope unsettled]

- A program announces to families only if its leader opts in, and only to those
  whose membership covers it. It fires on becoming both upcoming and open to
  enrollment — neither alone — and once in the program's life, so closing and
  reopening cannot send it again.  [Decision — deliberate limit]

- A program leader sees whether a participant has paid, never how. Method,
  scholarship, and payment plan are not theirs.  [Decision — *Principle: least privilege*]

- Only the board and sysadmins set a program's store variant.  [Decision — *Principle: least privilege*]

- A program's detail page shows which of the household is already enrolled and
  what the program limits, and hides the non-member price where the program is
  members only.  [Decision]

- Participant hours are hours logged by people enrolled in a program. Age says
  nothing about it.  [Decision]

- Cross-selling one program from another will not be built.  [Decision — deliberate limit]

