# People and households

Households, leads, identity and age status, emergency contacts, and trusted
adults.

---

## Policy

### Who is who

- An adult is 18 or older. A youth is anyone under 18, and throughout the
  policies "child" is interchangeable with it. — *Definitions Policy, Art. III,
  "Adult" / "Youth"*

- A student is anyone enrolled in school through twelfth grade, which can run to
  age 19. Student and youth are therefore not the same set, and neither is
  interchangeable with a program's participants. — *Definitions Policy,
  Art. III, "Student"*

- A member family resides at one address, contains no more than two adults, and
  all its youth are the children or dependents of those adults. — *Definitions
  Policy, Art. III, "Member Family"*

- A visitor is anyone at a location or event who is not a member. — *Definitions
  Policy, Art. III, "Visitor"*

- Being removed from a volunteer role is not dismissal from membership: one
  removes a role, the other ends all association. — *Volunteer Policy, Art. V*

### Responsibility for youth

- Parents, guardians, or authorised caregivers are responsible for their youth
  at drop-off and pickup and throughout events and locations, including travel
  for a program. — *Membership Policy, Art. IV*

- Youth under 10 are never dropped off and left. — *Event, Location and
  Keyholder Policy, Art. IX*

- A drop-off is allowed only when the youth is attending a specific program
  whose leader knows they are there, or when the parent or guardian has checked
  with a named adult over 21 who agrees to be responsible — and **both parties
  hold each other's emergency contact information**. — *Event, Location and
  Keyholder Policy, Art. IX*

- A dual relationship exists where the adult is the youth's parent, guardian, or
  sibling, or where a parent or guardian has specifically identified that person
  and had the status approved. — *Definitions Policy, Art. III, "Dual
  Relationship"*

### Member information

- Members keep their information current within the membership year, including
  changes to family members, contact details, and emergency contacts.
  — *Membership Policy, Art. III §III.1*

- Personal information is shared on a need-to-know basis and is not sold.
  — *Records Policy, Art. IV; Art. V §V.1*

- A member may ask for inaccurate information to be corrected, and may ask for
  personal information to be deleted except where it is legally required, needed
  for member safety, or a condition of the membership or program participation
  they wish to keep. — *Records Policy, Art. V §§V.3–V.4*

- Records no longer needed for operations or required by law should not be kept.
  — *Records Policy, Art. VI §VI.2*

---

## Assumptions

Things the app takes as true because they are handled outside it.

- A family and the adult they name exchange contact details between themselves.
  The app records the family's side of that.

- Drop-off practice is handled at the door, including who may be left and the
  rule against leaving a youth under 10.

- A trusted adult is over 21, confirmed by the board when it approves them. They
  are a named counterparty rather than a person record, so the app holds no date
  of birth to check.

- The app owns who people are, and deduplicating them is its job. The
  background-check vendor holds the sensitive detail behind a check; none of it
  is imported.

- An email address identifies one person, because that is how signing in works.
  Two people cannot share one, and a household wanting to share an address is
  asking for something the sign-in cannot express.

---

## Procedure

### Households and leads

- Every person belongs to a household from sign-up. There is no householdless
  person.  [Decision]

- A household has at most two leads, and removing the last one is refused. The
  lead cap is the app's proxy for the two-adult limit; membership itself is not
  capped.  [Decision — *Policy: Definitions Policy, Art. III, "Member Family"*]

- A lead always leads their own household; leading another is unsupported.  [Decision — deliberate limit]

- A youth cannot be made a household lead. An unknown date of birth reads as
  adult here — a standing exception to *Principle: fail closed*.  [Decision — deliberate limit]

- A household adds its own members through its leads. The board and sysadmin path
  into any household is a separate one and is unaffected.  [Decision — *Principle: self-scope and repair*]

- A young adult still part of their family — away at college included — stays a
  member of that household rather than leading one of their own.  [Decision — *Policy: Definitions Policy, Art. III, "Member Family"*]

- A household counts as claimed once a lead has signed in, by any route. Waiting
  for every member to sign in was rejected — the list exists to find families who
  never arrived, not to reach a state nobody can guarantee.  [Decision — deliberate limit]

- An account on the organisation's own email domain is a Treehouse account, not
  a member family, and cannot add members to its own household. The board and
  sysadmin path for adding someone to any household is unaffected.  [Decision]

- Nobody is moved into or out of a denied household, by the board's household
  move. The move is refused and goes to the board.  [Decision — *Principle: identity is not authorisation*]

- The board and sysadmin path adds nobody to a denied household, and nobody,
  a lead included, makes anyone its lead. The attempt is refused and goes to the board.  [Decision — *Principle: identity is not authorisation*]

- Finance, operations or the board may add a non-member adult by name alone,
  when naming who a receipt reimburses. The person gets a household of their own,
  with no membership, and leads it. Whoever adds them declares them an adult, and
  the app records that declaration in place of a date of birth. No email is
  taken. Finance confirms who the person is before paying them, outside the app.  [Decision — owner]

- Only the board or a sysadmin moves an existing person out to a new household of
  their own. The person becomes its lead, so a youth cannot be moved into one, and the new
  household starts with no org membership: a membership stays with the household
  it belongs to.  [Decision]

### Identity and age

- Every household member has a date of birth or an over-25 declaration, never
  both. The declaration stands in for a date nobody has, so a date on file
  displaces it. Neither present is a surfaced gap.  [Decision]

- A lead may declare a non-lead adult in their household as over 25. A save that
  blanks a date of birth showing someone is under 18 and declares them over 25 is
  refused.  [Decision — owner]

- Blanking that date in one save and declaring in a later one is accepted, as is
  entering an older date in its place. The app does not check IDs and keeps no
  history to catch this.  [Decision — deliberate limit]

- Date of birth is not retained past 25; the declaration replaces it
  automatically as members age out. Twenty-five holds three things at once: we
  keep nothing we do not need, by then nobody's own age restricts what they may
  do here, and it is young enough that someone of 25 is very unlikely to be the
  parent of anyone in our programs.  [Decision — *Policy: Records Policy, Art. VI §VI.2*]

- Change history can keep a date of birth past 25. A history record copies the
  date when a person's details are saved, and nothing removes that copy later.
  This is an acknowledged gap, accepted for now.  [Short of policy — *Policy: Records Policy, Art. VI §VI.2*; Board ruling B21, 2026-10-27]

- Date of birth is the only field with an ageing-out rule. Broader retention is
  deliberately not automated while the organisation is young and little has
  accumulated; the general obligation is met by hand until that stops being true.  [Decision — deliberate limit]

- A youth cannot edit their own profile. As with leadership, an unknown date of
  birth reads as adult.  [Decision — deliberate limit]

- Self-service member add always creates a new person, never adopts an existing
  account by email. Where the address is already in use the add is refused
  without saying whether anyone holds it — only what will happen if they do.  [Decision — *Principle: no existence oracle*]

- Email identity is case-insensitive.  [Decision]

- A person may be identified by extra addresses for receipt mail only. Finance
  or the Board records them, never for their own household, and each is unique
  across every person's sign-in address and every other extra address. Setting a
  sign-in email to such an address removes it.  [Decision — owner]

- Where someone signs in through the outside sign-in service, the address they
  sign in with is the address they are contacted at. There is no second one to diverge from it.  [Decision]

- A person in a position of trust holds any granted role (sysadmin, board, finance,
  operations, inventory manager, keyholder, background-check reviewer), owns a bucket
  or is its treasurer, leads a program, or may certify others on a tool. One list serves
  every rule that names them.  [Decision — Board ruling B1/B2, 2026-10-27; trusted list per owner decision 2026-10-27; bucket owners per owner decision 2026-10-30]

- A trusted person's sign-in email changes only by a board member's action, with a
  written reason the record keeps. A merge counts: it needs the same when the trusted
  person is the merged-away side, or a trusted keeper takes the other side's identity
  or its linked sign-in accounts. Keeping a trusted person's record and identity, with
  no account coming across, needs neither. A sign-in account with
  a different address cannot be linked to them.  [Decision — Board ruling B1/B2, 2026-10-27; trusted list per owner decision 2026-10-27; bucket owners per owner decision 2026-10-30]

- A member's email is not edited from the household card, by them or by a lead,
  once they have signed in, are in a position of trust, or hold anything the board granted: a role, a program
  they lead or volunteer on, or a background check on file. The board changes it,
  and the refusal says how to ask. A member with neither stays editable, and
  resending the unchanged address is not a change.  [Decision]

- On the board and sysadmin person edit, only a board member changes a person's
  email, and only with a written reason, which the edit's record keeps. Nobody
  changes the email of anyone in their own household this way. The email decides
  who signs in as the person, so changing it hands over everything they hold.  [Decision — *Principle: identity is not authorisation*]

- An account with the sign-in service must have a verified email before it is
  first linked to a person record; an account already linked keeps signing in unchanged.  [Decision]

- A first sign-in through the sign-in service links to the person whose email
  matches, or creates a new person. After that, the linked account signs in, not the address.  [Decision — *Principle: identity is not authorisation*]

- An adult whose email a household added is asked at first sign-in whether to join it,
  and nothing else opens until they answer. They are asked when someone else in that
  household has already signed in; someone in a household where nobody has signed in
  claims their record unasked. The question names the household and shows nothing of
  the record.  [Decision — Board ruling B1/B2, 2026-10-27; scope per owner decision 2026-10-30]

- A yes leaves them in the household. A no leaves the household's record where it is,
  with everything on it and without the address, and gives the person a new empty record
  in a household of their own, because nobody knows they are who the household meant.
  Nothing from the old record reaches them, including any role it holds, and this is
  the one change to a trusted person's sign-in email made without the Board. Neither answer
  lands while the household is denied.  [Decision — Board ruling B1/B2, 2026-10-27; owner decision 2026-10-30]

- A youth stays in the household that added them, with no question, and cannot answer one. A youth
  never adds themselves to a household. Age here is what the record says at
  first sign-in.  [Decision — Board ruling B1/B2, 2026-10-27; owner decision 2026-10-30]

- Changing a person's email unlinks their sign-in service accounts.  [Decision — *Principle: fail closed*]

- A person's identifier is opaque, and its only job is to be unique and to stay
  unique. It is never reissued and never worked out from the people already on
  file: issuing the highest number in use plus one hands a deleted person's
  number to a new one, and every badge printed for the first would then scan as
  the second at the kiosk. Numbers are issued in order from a count the database
  keeps, which a pause cannot skip ahead and a deletion cannot wind back.  [Decision]

- A person is never lost. A merge deletes the merged-away record and keeps an
  archive of it, which names the surviving record. The merged-away person drops
  out of every live list, count and roster. A record of what happened still names
  them, from the archive, because hiding a since-merged identity there would
  falsify the history rather than protect anyone. An older merged record that
  something still refers to stays as a hidden row until that is cleared.  [Decision — owner ruling 2026-10-31; *Principle: decisions are reversible*]

- A merge moves email, sign-in identity and verification together as one unit,
  never split across the two records.  [Decision]

- A merged person's pre-merge state is held in the archive, so a merge of the wrong two
  people can be investigated and the person reconstructed. There is no un-merge:
  what the record does not carry is which rows moved, so putting a bad merge right
  is hand work, not a button.  [Decision — *Principle: decisions are reversible*]

- A person's membership standing belongs to their household, and merging two
  records never alters it as a side effect, with one exception: a merge that
  carries in a still-valid background check completes an application already paid
  for and waiting only on that check, which makes the household a member. It leaves
  alone an application with a standing rejection or one the board has reset. A
  merge that would move a person across a denied-or-revoked boundary, or abandon an
  active membership, is refused until the household side is settled by hand.  [Decision — owner ruling 2026-10-30; *Principle: identity is not authorisation*]

### Roles

- Nobody grants or removes a role or flag — board, keyholder, staging access, a
  program's treasurer, or any other — for themself or for anyone in their own
  household. A sysadmin may grant roles in general; this binds them like anyone
  else. The board and sysadmin household-move paths refuse to move anyone out of
  or into the actor's own household, which would get around it, and the board and
  sysadmin paths that add a person to an existing household or make someone a lead
  refuse the actor's own household for the same reason. A lead promoting within
  their own household is unaffected.  [Decision — *Policy: Ethics Policy, Art. III §III.5*]

- A merge moves the merged-away record's roles under the same checks as a hand
  grant. It is refused when either record is in the actor's household, or when
  the merged-away record holds the board role and the actor is not on the board.  [Decision — *Policy: Ethics Policy, Art. III §III.5*]

- Only a board member removes someone's board role, and the last board member
  cannot be removed. A sysadmin may add a board member but not remove one.  [Decision]

- Signing in never grants a role, with one exception: an address on the
  deployment's bootstrap list becomes sysadmin only while the system has no
  sysadmin, and never if that person's sysadmin role was once removed.  [Decision — *Principle: least privilege*]

### Who may see what

- A program leader reaches a participant's contact details and their emergency
  contact, never their date of birth.  [Decision — *Principle: least privilege*]

- Keyholders hold the board's email and phone as the front desk's emergency
  reference. It is a grant made on purpose, not an over-share to be narrowed.  [Decision]

- A badge or the kiosk shows a person by the name they go by: the nickname set for
  them, else their given name. Their surname appears only when someone shown with
  them goes by the same name, and then only shortened: the badge takes as many
  letters as telling the two apart needs, the kiosk at most two. A shortened
  surname keeps its particles whole ("van der B.", "Ní B."). A name written in
  Chinese, Japanese or Korean script shows whole, and so does a surname in a script
  with no initials — except on the kiosk, which leaves such a surname off rather
  than show all of it.  [Decision]

### Emergency contacts

- An emergency contact is someone outside the household; one matching a member
  by phone, email or name is refused.  [Decision — *Policy: Event, Location and Keyholder Policy, Art. IX*]

- An emergency contact needs a name and a phone number. One missing either does
  not count toward the household's obligation to have one.  [Decision]

- An emergency contact's relationship to the household is optional free text,
  with no picklist of types.  [Decision — deliberate limit]

- Only the household lead reads the household's emergency contacts; other
  members of the household do not.  [Decision]

- A household names at least one emergency contact at intake, and its last valid
  contact cannot be removed.  [Decision]

- A household change that invalidates a contact flags the row and keeps it.
  Nothing is blocked; the household resolves it.  [Decision]

- A missing emergency contact is the household's to fix and the board's to chase.
  It raises a list of the households to contact, a count in the board's
  navigation, and a notification the front desk sees too. Nothing is blocked —
  chasing it is a conversation, not a refusal at the door.  [Decision — *Principle: people decide about people*]

### Trusted adults

- Trusted-adult approval belongs to the household, not to an individual member.  [Decision — *Policy: Event, Location and Keyholder Policy, Art. IX*]

- The family's context note is written for the board and read by the board and
  the family, never by keyholders or program leaders. The board's note on its own
  decision is the board's alone. What reaches the front desk is the shared note
  below, and nothing else.  [Decision — *Policy: Ethics Policy, Art. IV*]

- How a trusted adult is connected to the family is prose inside the context note
  the family has to write. There is no separate relationship field.  [Decision — deliberate limit]

- Amending a trusted adult's details does not disturb the live approval, and
  rejecting the amendment is a separate action from revoking the person.  [Decision]

- Withdrawing a trusted adult retires every approval they hold, not just the
  most recent, and drops them from the pickup list at once.  [Decision]

- Denying a household's membership revokes, at once and in the same act, every
  review not already revoked or denied — approved, open or expired — on the
  household's own trusted adults, and on any other household's trusted adult who
  is a member of the denied household. A review the board already denied stays
  denied. Each revocation is audited
  with the person who denied and the reason "household denied". Restoring the
  household brings none back. Revoking a household's membership revokes no
  trusted adult.  [Decision]

- An approval lasts a year. The family is warned a month out and resubmits
  without re-entering what the board already holds.  [Decision]

- A withdrawn trusted adult can be hidden from the household's own view, and the
  household cannot bring it back. The record is kept, but no board surface lists
  it either — the review queue holds what is awaiting action or expiring, and the
  pickup list holds what is approved. A withdrawn one survives in the audit trail
  rather than in anyone's view.  [Decision]

- One board member settles a disclosure; it does not need the whole board.  [Decision]

- A visitor may raise one, not only a member.  [Decision]

- Approving one requires a note the front desk can act on — read by the family,
  keyholders and program leaders, and never shown on the kiosk.  [Decision — *Policy: Records Policy, Art. IV*]
