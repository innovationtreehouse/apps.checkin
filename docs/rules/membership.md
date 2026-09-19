# Membership

Application, background-check review, activation, dues, and renewal.

---

## Policy

### What membership is

- Membership belongs to a family, not an individual: everyone gains membership
  by being part of a member family, and the fee is per family per membership
  year. — *Membership Policy, Art. III §III.1*

- A member family is one household containing no more than two adults, with all
  youth being their children or dependents. — *Definitions Policy, Art. III,
  "Member Family"*

- The membership year runs 1 September to 31 August. One boundary applies to the
  whole organisation — membership is not a per-household anniversary running
  twelve months from the day a family joined. — *Definitions Policy, Art. III,
  "Membership Year"*

- A payment for a membership year may therefore buy less than twelve months, as
  when a family joins partway through one. — *Membership Policy, Art. XI*

- A family agrees in writing to the current membership agreement, separately for
  each membership year — a prior signature never carries over. Participation is
  not open to a family that has not. — *Membership Policy, Art. III §III.1*

- Members are responsible for keeping their information current within a
  membership year, including family composition, contact details, insurance, and
  emergency contacts. — *Membership Policy, Art. III §III.1*

- Nobody who has been dismissed from membership, or whose background check comes
  back without clear recognition of the individual, may be a member.
  — *Membership Policy, Art. IX*

### Deciding a matter you have an interest in

- A conflict of interest exists whenever someone is in a position to approve or
  influence an action that could benefit or harm themselves, their family by
  kinship — spouse, parents, guardians, children, siblings, grandparents,
  grandchildren, in-laws — or even a close friend. The appearance of one counts
  as much as the fact. — *Ethics Policy, Art. III §III.2*

- Someone with a conflict in a matter refrains from participating in any decision
  on that matter. A board member abstains from the vote; any other leader stays
  out of the decision entirely. There is no exception for seniority or for
  holding a privileged role. — *Ethics Policy, Art. III §III.5*

- A conflict is disclosed to the board in writing, before the person discharges
  any duty touching the matter. — *Ethics Policy, Art. III §III.3*

- The board may void any action taken by someone who participated despite a
  conflict. — *Ethics Policy, Art. III §III.5*

- The same person does not authorise, execute, and monitor a transaction.
  — *Financial Policy, Art. III*

### Background checks

- At least one adult in each family is checked; so is any other family member 18
  or over who will be present regularly. Third-party checks are not accepted.
  — *Membership Policy, Art. VI §VI.1*

- Every volunteer 18 or older is checked. The obligation attaches to the role,
  not only to the household. — *Volunteer Policy, Art. IV*

- No entry to a location, event, or program until the check completes. A family
  mid-application may still attend as a hosted visitor. — *Membership Policy,
  Art. VI §VI.1*

- A check is valid for 29 months, after which a new one is performed at the next
  renewal. The board may check more often, or shift the timing to line up with
  membership years. — *Membership Policy, Art. VI §VI.1*

- Reports are ordered, reviewed, and processed by at least two individuals who
  are independent of one another — not related — who have signed the key
  volunteer agreement and either serve on the board or are authorised in writing
  by it. — *Membership Policy, Art. VI §VI.2*

- Two clearances therefore means two distinct people. One reviewer cannot supply
  both, so the same person may not review an application twice, and a second
  reviewer related to the first does not count either. — *Membership Policy,
  Art. VI §VI.2*

- Every reviewer has signed the key volunteer agreement. — *Membership Policy,
  Art. VI §VI.2*

- The check itself and any criminal-history detail stay between the person
  checked, the authorised reviewers, and the board. — *Membership Policy,
  Art. VI §VI.2*

- A check may result in approval, a restriction on how the person may volunteer,
  or denial. — *Membership Policy, Art. VI §VI.2*

- Where the board treats an offence as disqualifying, objective supporting
  documentation is gathered, consistent with the obligation to document a
  denial. — *Membership Policy, Art. IX*

- A disqualified applicant receives the rights summary, a letter of
  disqualification, and a copy of the results, and may appeal in writing to a
  three-person committee kept as independent as possible from the original
  reviewers. — *Membership Policy, Art. VI §§VI.3–VI.4*

### Dues, refunds, and plans

- The board sets the cost of all memberships. The fee is a fee, not a charitable
  donation. — *Membership Policy, Art. XI*

- The board may discount the fee for financial need, college students, partner
  organisations, participants solely in service programs, and volunteers with no
  youth participating in any sponsored program. — *Membership Policy, Art. XI*

- The fee is refunded if the family is denied membership. An accepted offset for
  the cost of the background check is not refunded even then. Otherwise no
  refund is provided once membership is approved, absent an extreme circumstance
  approved by the board. — *Membership Policy, Art. XII*

- A membership payment plan does not extend beyond the membership year it
  covers. Late payment under a plan can lead to dismissal from membership.
  — *Membership Policy, Art. XIII*

### Member data

- Member information is shared on a need-to-know basis and is not sold.
  — *Records Policy, Art. IV; Art. V §V.1*

- A member may ask for inaccurate information to be corrected. — *Records
  Policy, Art. V §V.3*

- A member may ask for personal information to be deleted, except where it is
  legally required, needed for member safety, or a condition of the membership
  or program participation they wish to keep. — *Records Policy, Art. V §V.4*

---

## Assumptions

Things the app takes as true because they are handled outside it. They sit
between the two tiers because the Policy rules above rest on them and the
Procedure below is built on them.

- Every board member has signed the key volunteer agreement and is a designated
  background-check reviewer. Board membership alone therefore qualifies someone
  wherever a reviewer is required — the queue, the attestation, and the sensitive
  fields that go with it.

- A non-board reviewer was authorised in writing by the board before the reviewer
  role was granted. Granting the role is what represents that authorisation, so
  the assumption holds as long as granting it stays a deliberate act.

- Payment-plan terms are agreed within the limits policy sets. The app records
  that a plan was certified, not its schedule.

- Refunds are handled outside the app, including the one owed on denial of
  membership.

- A background check is cleared within days of being performed, so dating the
  clearance rather than the check itself is immaterial against a window measured
  in months. Board and sysadmin can correct the date on the rare occasion it is
  not.

- The background-check vendor has no API. A check is started through a hosted
  consent link and its result comes back by hand. That is the arrangement, not a
  stopgap waiting to be automated.

- A check that comes back with a restriction on how someone may volunteer is
  carried by the board, not the app. Reviewers record only approval or rejection,
  so a restricted volunteer is approved here and the restriction lives in the
  board's own arrangement with them. The assumption holds as long as the reviewers
  who read the report are the people who set that arrangement.

- Declining a scholarship or payment-plan request is a conversation between two
  people. Telling the family is the board's own act and happens outside the app.

- Both signing adults in a household are marked as household leads. The app
  records no relationship between members, so lead status and age are together
  what separate a spouse from an adult child. A household running with one lead
  and an unmarked spouse is indistinguishable from one with an adult child, and
  marking the spouse a lead is what restores the distinction.

---

## Procedure

### Application and review

- An intake note does not hold the application. It is shown to the reviewers,
  who read it while the family pays.
  (`checkin-app/src/lib/membership/external.ts`)  [Decision]

- An application in background-check review is the reviewers' work, not the
  board's. Board queues count blocked applications only.  [Decision]

- A single rejection blocks the application; approvals do not outweigh it.  [Decision]

- The background-check result is never stored. The record is that reviewers saw
  it and what they judged — stricter than the policy, which permits the board to
  hold it.  [Decision — *Policy: Membership Policy, Art. VI §VI.2*]

- A clearance is dated when the second reviewer clears it, and the validity
  window runs from that date.  [Decision]

- A household review covers one adult. Whoever approves first names the person
  whose report they read, and a later reviewer confirms that same person. A
  reviewer who believes the named person is wrong rejects, rather than naming
  someone else.  [Decision]

- An approval that named nobody counts toward nobody, including toward the adult a
  later reviewer names. Nothing records whose report it read, so counting it would
  date a clearance on one reviewer's reading and leave a row no worklist can tell
  from a real one. A review carrying one is reset by the board and re-reviewed by
  two.  [Decision — *Principle: fail closed*]

- A board override names the adult it covers. It cannot infer one: a blocked
  application never holds the second approval that would identify a subject, so
  an override naming nobody would date a clearance against no one.  [Decision]

- Every background-check decision and every payment certification records a
  written reason — wider than the policy, which requires documentation only for a
  disqualifying offence.  [Decision — *Policy: Membership Policy, Art. IX*]

- An abandoned application is archived, never destroyed, and restores to the
  status it held before.  [Decision — *Principle: decisions are reversible*]

- Pre-designating a household volunteer-only sets what it owes and nothing else
  — it does not skip review or open payment. The policy grants only the
  discounting power; the limit is ours.  [Decision — *Policy: Membership Policy, Art. XI*]

### Approving your own family

- Shared household is the app's test for a conflict — a workable proxy for the
  kinship, friendship and appearance tests policy states. Passing it is not a
  finding that no conflict exists.  [Decision — deliberate limit]

- No role is exempt from the bar, however senior. A case whose only eligible
  deciders are all in the subject's household cannot be decided until the board
  finds someone who is not.  [Decision — *Policy: Ethics Policy, Art. III §III.5*]

### Activation

- Nothing advances toward payment until the agreement is signed and the
  background check is handled — either a still-valid prior clearance or fresh
  consent on file.  [Decision — *Policy: Membership Policy, Art. III §III.1; Art. VI §VI.1*]

- From there payment and review run in parallel, and membership activates on
  whichever finishes last. Neither alone activates.  [Decision]

- Granting the coming year completes the payment step on a renewal already under
  way. It stamps no other gate.  [Decision]

- A denied household holds no authority anywhere in the app.  [Decision — *Principle: identity is not authorisation*]

- Denial locks every member of the household out of sign-in. Revocation does not
  — a former member keeps app access and loses facility privileges. Because the
  lockout reaches the whole household, denial is confirmed before it executes.  [Decision — *Principle: accountability*]

- A household containing a board member cannot be denied. The board role is
  removed in the app first, and that removal is a separate act from the denial.  [Decision — deliberate limit]

- The denied landing page says only that access is denied. No reason, no contact,
  no mention of membership, no way to sign out.  [Decision — deliberate limit; *Principle: no existence oracle*]

- A household may have no membership. Facts only a membership carries are then
  absent, not zero.  [Decision — *Principle: fail closed*]

### Dues

- Dues have two rates, standard and volunteer household. The designation changes
  what a household pays and nothing about its review.  [Decision]

- A volunteer designation matches on canonical email, so address variants cannot
  change what a family owes.  [Decision]

- The board can activate a household with no payment by certifying a payment
  plan.  [Decision — *Policy: Membership Policy, Art. XIII*]

- A board member declines a membership scholarship or payment-plan request in the
  app, and the decline sends nothing: the request clears and the household returns
  to owing its dues by the normal route. The decision is recorded; carrying it to
  the family is not the app's job.  [Decision — deliberate limit; *Principle: people decide about people*]

- A household that has settled its dues but is still waiting on its background
  check is a member for program pricing and for reaching members-only programs,
  and for nothing else. Mailing audiences, outreach, the store's member list,
  people search and payment-plan eligibility all continue to ask whether the
  membership is active. The narrowness is the rule: widening the shared question
  would hand every other benefit to a household that has not cleared.  [Decision]

- A background check that is later rejected does not unwind a program place
  already bought at the member price. The money is taken and the place is held;
  the board settles it with the family.  [Decision — *Principle: people decide about people*]

### Renewal

- A renewal needs a new background check unless a lead's is still valid at the
  boundary. Where the validity length is unset, no clearance counts as fresh and
  the compliance view reports nothing stale.  [Decision — *Policy: Membership Policy, Art. VI §VI.1*; *Principle: fail closed*]

- A membership stays active while its renewal is in progress.  [Decision]

- Coverage is what was bought, not what the calendar says. A household settled
  for the membership year now in effect — by joining, renewing, or a granted
  year — is covered to the boundary that closes the year; one that did not
  settle is covered only to the boundary that opened it, and reads as lapsed
  from that day. A membership with no dues recorded in the app has bought
  nothing it can see. Lapsing changes what the membership covers and nothing
  else: status does not move, and only a person revokes.  [Decision — *Policy: Membership Policy, Art. III §III.1; Art. XI*; *Principle: people decide about people*]

- Settling inside the renewal window buys the coming membership year — for a
  family joining (INITIAL) exactly as for one renewing. The derived valid-until,
  program-pricing coverage, and the renewal sweep's skip-test all read this one
  rule, so a family that joins in-window is covered through the following
  boundary and is not asked to renew for the year it just bought.  [Decision]

- A household is never told its background check has gone stale, because nothing
  acts on staleness between renewals. It is read inside a renewal, where it
  decides whether that renewal needs a fresh one.  [Decision — *Policy: Membership Policy, Art. VI §VI.1*]

- Membership intake requires a complete mailing address. Program registration
  deliberately does not.  [Decision]

- Treehouse accounts are not program families: no self-service member add, no
  membership grant. Only the member add is enforced server-side.  [Decision]

- An intake note is readable by the household's leads and the reviewers, not by
  its other members.  [Decision — *Policy: Membership Policy, Art. VI §VI.2; Records Policy, Art. IV*]

### Compliance

- Nobody is removed for falling out of compliance. The view reports and sends
  nothing, so a violation waits until a person looks.  [Decision — deliberate limit; *Principle: people decide about people*]

### Background checks for individual adults

- Activating a membership opens a background-check obligation for that
  household's program-attached adults and for its signing adults. It is surfaced
  for follow-up and gates nothing — chasing it is a conversation, not a refusal
  at the door.  [Decision — deliberate limit; *Policy: Volunteer Policy, Art. IV*]

- A signing adult whom the household's own review did not name is covered here
  rather than by that review, because a clearance covers only the adult who took
  the check. Otherwise the second parent on the application — often the one
  holding a key — belongs to no track at all.  [Decision — *Policy: Membership Policy, Art. VI §VI.1*]

- The obligation follows an active membership. Leads of households that only ever
  started an application, were denied or revoked, or were created by an import owe
  nothing: they never became members, and the annual sweep must not open a check on
  someone who did not apply.  [Decision — deliberate limit]

- The annual sweep judges age as of the membership-year boundary, which counts as
  inside it: turning 18 afterwards waits for the next sweep rather than firing on
  the birthday.  [Decision — deliberate limit]

- Activating a new membership judges age as of the activation instead, so someone
  who has just turned 18 is caught on joining rather than read as a minor until
  the next boundary comes round.  [Decision]

- Under 18 is never checked, a minor being ineligible for one. This covers the
  young adult mentors, who volunteer without one.  [Decision — *Policy: Volunteer Policy, Art. IV*]

- No date of birth and no over-25 declaration means the age is unknown. Such a
  person is neither checked nor counted as covered; they are set aside for
  someone to resolve.  [Decision — *Principle: fail closed*]

- A check covers the adult who took it. One person's clearance never satisfies
  another's.  [Decision]

- A background check for an adult child needs neither a sign-in of their own nor
  an email address in the app. The board or a household lead records that an
  external check exists and submits it for review, and consent is implicit in the
  subject having gone and taken it. The applicant-facing consent attestation is a
  household path and never this one.  [Decision]

### Individual agreement for adult children

- An adult child of a household lead signs their own membership agreement rather
  than being covered by the household's. A spouse does not: a spouse stays on the
  household agreement.  [Decision]

- Signing it needs a sign-in of their own, and the lead supplies an email address
  for them.  [Decision]

- It is signed again every membership year, as the household agreement is.
  [Decision — *Policy: Membership Policy, Art. III §III.1*]

- Age for this obligation is judged as of the day it is opened, because it opens
  when the person turns 18 — deliberately unlike the background-check rule above,
  which judges age at the membership-year boundary. The two populations therefore
  differ for anyone with a birthday between today and the next boundary, and
  aligning them would either ask a minor to sign or leave a new adult uncovered
  for up to a year.  [Decision]

- Opened automatically only for a household member who is not a lead, is aged 18
  to 25 with a date of birth on file, and is in a member household and attached to
  a program that is running or ended within the last year. A non-lead adult over 25
  is left out: at that age, not being a lead reads as a spouse the household has not
  marked, not as an adult child.  [Decision — deliberate limit]

- The one-year window is what stops the request repeating. An attachment is never
  cleared when a program ends, so without it someone who took a single class at 18
  would be asked again every year until they aged out. The window only bounds
  programs that carry an end date; one left undated reads as still running, and its
  members stay in the population.  [Decision — deliberate limit]

- Never opened for a household lead, who signs the household's agreement. An open
  individual agreement on a lead would take the place of the household one in the
  signing flow and stall the household's activation or renewal.  [Decision]

- The board may open one by hand for someone the automatic rule leaves out — not
  attached to a program, or over 25 — but never for a lead, and never for someone
  whose age is unknown.  [Decision]

- It gates nothing. An unsigned individual agreement never blocks participation,
  check-in, or the household's own membership.  [Decision — deliberate limit;
  *Principle: people decide about people*]
