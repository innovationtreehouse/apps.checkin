# Attendance and check-in

Opening and closing a facility, supervision, the kiosk, and the visit record.

---

## Policy

### Two deep

- **Two deep means two non-student adult volunteers who are unrelated and do not
  share a household.** Adult presence alone does not satisfy it. — *Definitions
  Policy, Art. III, "Two Deep"*

- Any event or location must meet the two-deep principle. — *Event, Location and
  Keyholder Policy, Art. III*

- A facility must be two deep **and** have a keyholder to be open and
  operational. — *Event, Location and Keyholder Policy, Art. VI*

- A group containing a student that is out of sight and earshot of another group
  must be a tripod, and must be observable and interruptible. Behind a locked
  door it must be two deep. Where someone is both a student and a volunteer, the
  more appropriate role governs. — *Event, Location and Keyholder Policy,
  Art. III*

- A tripod is three members, each at least 9 years old, in a place that is
  observable and interruptible. A closed, locked door does not qualify.
  — *Definitions Policy, Art. III, "Tripod"*

### Keyholders

- Keyholders are volunteers, appointed in writing by the board, and the board may
  revoke the status at any time in writing. — *Event, Location and Keyholder
  Policy, Art. VII*

- Nobody opens or closes a facility without being an active keyholder, so nobody
  else can be in it while no keyholder is present. — *Event, Location and
  Keyholder Policy, Arts. VI–VII*

- There is one primary keyholder for a facility at a time. A primary keyholder
  leaving must either transfer the role, with the other keyholder's consent, or
  close the facility — they cannot simply leave while the building is occupied.
  — *Event, Location and Keyholder Policy, Art. VIII, §VIII.3*

- The primary keyholder present at closing is responsible for securing the
  facility, and must ensure appropriate adult and youth presence while closing —
  **two adults on site with a last youth.** — *Event, Location and Keyholder
  Policy, §§VIII.4*

---

## Assumptions

Things the app takes as true because they are handled outside it.

- A keyholder was appointed in writing by the board, and the board revokes that
  status in writing when it ends. The keyholder flag is what represents the
  appointment.

- The tripod rule is kept in the room — its composition, the
  observable-and-interruptible condition, and whether a student group is within
  range of another are judged by the people present, not tracked here. Nothing
  here controls the shop doors or the tools, so a record of tripod state would
  drive no action; it is left out because it would buy nothing, not because it
  was overlooked.

- Nobody being inside without a keyholder is kept at the door, by the keyholders
  who lock it. The app does not enforce it: a badge read inside the building
  says someone is there, so the app records them and marks the visit rather
  than refusing or hiding the scan.

- A keyholder who leaves the building occupied has handed over in person to the
  keyholder they name, with that keyholder's consent. The app cannot see the
  handover; it records the leaver's statement.

- The app does not model a primary keyholder, so the last recorded keyholder
  stands in for the primary keyholder of §VIII.3.

- Check-in happens at the one facility. Other locations exist and are temporary,
  and checking in at them is out of scope.

---

## Procedure

### Opening and closing

- Closing takes a second deliberate badge within a few seconds, which checks
  everyone out — including anyone who checked in with no keyholder present. A
  single stray badge does neither.  [Decision]

- The facility is open only while a keyholder is present. A visit by someone
  else never makes it read as open on any web surface: people inside with no
  keyholder are shown as inside a closed facility.  [Decision — *Policy: Event, Location and Keyholder Policy, Arts. VI–VII*]

- A badge at the kiosk always checks the person in, keyholder or not. Someone
  scanning inside the building got in somehow, and the screen shows who is
  there. With no keyholder in the building the visit is marked *no keyholder*,
  and a keyholder checking in within ten minutes of that arrival clears the
  mark. The mark is read from the visit record, so correcting a keyholder's
  visit re-decides it. Every other way of checking someone in — the web, a
  household lead, the review panel leaving a visit open — still needs a
  keyholder already present.  [Decision]

### Supervision

- The two-deep check counts supervising adults, not adults present. A supervising
  adult is an adult whose background clearance is still valid and who is not
  themselves a participant on a program running at that moment. Two people of one
  household count as one, so a couple is not two deep.  [Decision — *Policy: Definitions Policy, Art. III, "Two Deep"*]

- Being a participant on a program in session is what disqualifies someone from
  supervising it, not being at school: a member of eighteen or nineteen enrolled
  in a program does not count while that program runs, and counts again as a
  volunteer on another. School enrollment is not recorded at all, so the part of
  policy that turns on it cannot be tested here.  [Short of policy — *Policy: Definitions Policy, Art. III, "Two Deep"*]

- A clearance that is not recorded is not a clearance: someone with no background
  check on file, or one older than the board's recheck interval, is not one of the
  supervising adults.  [Decision — *Principle: fail closed*]

- Someone whose age is unknown counts as a youth in the supervision check: not
  one of the supervising adults, and one of the people needing cover.  [Decision — *Principle: fail closed*]

- Two deep is shown as a warning. It does not stop anyone entering or checking
  in — surfacing the shortfall to the people in the room is the whole of what the
  app does about it. A youth arriving into a room short of supervision is warned
  about, never turned away: whether to open the door is the keyholder's call.  [Decision — deliberate limit]

- Keyholders reach every household's emergency contacts, not only those of the
  people currently in the building.  [Decision]

- Every departure that takes a supervising adult out of the building is
  interrupted, whoever is leaving. Dropping to two is a warning and nothing more.
  Dropping below two stops the departure until the person badges again within
  fifteen seconds — but only while a youth is in the building. With no youth
  there, that departure is warned about and goes through: two deep is owed
  whenever a youth is present, so an adult-only room locking up has nothing to
  confirm, and an interrupt raised where nothing is at stake teaches people to
  badge through the one that matters. The keyholder close-guard is a separate
  interrupt and both can be waiting on one person at once.  [Decision — *Policy: Event, Location and Keyholder Policy, §VIII.4*]

- The supervision interrupt is on the badge scanner only. Checking someone out
  from the web does not raise it — the person doing the checking out is not at the
  reader and cannot re-badge to confirm.  [Decision — deliberate limit]

- The keyholder close-guard fires on every close path — badge, the home-page
  check-out, dashboard checkout or sign-out, self-correction edit that closes an
  open visit, and removal of an open visit. On the badge path the confirm is a
  second badge within the countdown. On the web, when the last recorded keyholder's
  visit ends with others inside, the caller chooses close, leave or cancel in one
  confirm dialog, answered by a server-minted token bound to the person shown the
  choice: a keyholder or board member gets all three; a household lead or
  sysadmin who is neither gets leave or cancel. Close checks everyone out; leave
  checks out only the keyholder and leaves the others inside a closed facility;
  cancel changes nothing. The choices are worked out again on confirm, so a role
  revoked in between takes effect. Every choice is audited with who made it,
  whose visit it was, the choice, the keyholder named and the count left inside.  [Decision]

- On the web only a keyholder or a board member closes the facility; a household
  lead or sysadmin who is neither never does, even with the keyholder alone in
  the record. The board closes whether or not its member holds keys: the owner
  reads the board's superuser standing as covering the active-keyholder rule.  [Decision — *Policy: Event, Location and Keyholder Policy, Arts. VI–VII*]

- A keyholder or board member who chooses leave names, from the keyholders not
  checked in, the one the keyholder handed over to. Where none is free to name,
  the leave stands and records the handover as not named. The named keyholder is
  not checked in — that needs their agreement — and is emailed who left, when,
  and how many are still inside, unless they are checked in by then. A household
  lead or sysadmin's leave names nobody.  [Decision]

- Removing an open visit never closes the facility, whoever removes it: a
  removal says the keyholder was never there, and closing on that basis would
  invent departures for everyone else. The confirm states how many stay inside
  a closed facility.  [Decision]

- The names of the people inside go with the close choice only to keyholders,
  board members and sysadmins, who already read the full roster; a household lead
  sees a count.  [Decision — *Policy: Records Policy, Art. IV*]

- A force-close is triggered only by an explicit confirm — the second badge within
  the visible countdown — never inferred from the spacing between two raw badge
  reads. An ordinary double-tap cannot close the building over the people standing
  in it, and an unattended countdown never becomes a confirm: the confirm is always
  a human's second badge at the door. With a server present that confirm is the
  echoed server-minted token; with no network the kiosk runs the same warning and
  second-badge confirm itself, so a keyholder can still lock up offline. The queued
  close carries the confirm, and the server honours it on the delayed replay
  whenever the badge is a keyholder's.
  Offline the supervision close-guard can only warn, never hold a departure — the
  kiosk cannot re-check two-deep without the server, so it leaves the call to the
  keyholder at the reader.  [Decision — *Policy: Event, Location and Keyholder Policy, Arts. VI–VII, §VIII.4*]

- Any keyholder can close the building at the kiosk with a double scan, whoever
  else is recorded inside — another keyholder included. We trust the keyholder
  to know they are the last one out; another keyholder still recorded is a
  forgotten badge-out. When another keyholder is recorded, the first badge checks
  the keyholder out and offers the close; a second badge within the countdown
  closes the facility. The last keyholder with others still present gets the
  warning above instead and stays recorded until they confirm, and a keyholder
  alone closes on a single badge. Offline the kiosk runs the same offer and
  confirm itself, and the server honours the queued confirm whoever else it
  reads as present. The close is bound to the badge that was shown the offer —
  someone else scanning during the countdown scans normally — and a read of that
  badge within a second of the offer is the same touch read twice, never the
  confirm. Nothing on the web can stop a kiosk close.  [Decision — *Policy: Event, Location and Keyholder Policy, Arts. VI–VII*]

- Every facility close is recorded: who closed, when, and through which path
  (kiosk, offline kiosk, a web checkout or correction, or the nightly sweep,
  which no person makes). Every departure a close sets is logged against
  that record with the visit's departure before and after. These logs are an
  audit trail and are never deleted.  [Decision — *Principle: accountability*]

### The kiosk

- The kiosk shows only what an unattended public screen may — no dates of birth,
  phone numbers, emergency contacts or email addresses. Where a person has no
  name recorded, what shows is the part of their address before the @, never the
  address itself.  [Decision — *Policy: Records Policy, Art. IV*]

- The kiosk never shows a last name. It names people as the roster does — the
  nickname, else the first name, with a last initial (or two letters) only to tell
  two people apart — and that applies to everything sent to the kiosk, not only
  what it renders: the roster, the certification grid and every
  warning.  [Decision]

### Kiosk resilience

The badge kiosk and its offline scan path. Infrastructure failure — WiFi loss for
hours at a time — is a normal operating mode here, not an incident.

- A badge scan, once read, is never lost. It survives to a durable server record
  whatever the network or facility state. The system may decline to *display* or
  *project* a scan — park it, defer it — but never discards one.  [Decision]

- Every good-faith badge is acknowledged at the door — "checked in" or "checked
  out" — even when the server's live math disagrees or the network is down.
  Surfacing that the kiosk is out of sync is additive, never a substitute for the
  acknowledgement.  [Decision]

- The direction the kiosk displayed is the intent of record. When a queued scan is
  delivered later, the server applies the in/out the person saw; it never re-infers
  direction from its own live state at delivery, which would flip a replayed
  check-in into a check-out.  [Decision]

- A replayed scan applies at the time the badge was read, not the time it was
  delivered. Within a short freshness window it toggles normally; older than that
  it is held for a human, because once state has moved on a bare toggle cannot
  tell entering from leaving.  [Decision]

- A facility close a keyholder confirmed at the kiosk — the echoed server token,
  or the kiosk's own offline confirm — is applied whenever it reaches the server,
  however late; it is never held for staleness or ordering, and a kiosk clock
  flagged as having stepped is trusted. The keyholder was at the reader and saw
  the room, so the close is a fact, not a toggle. Everyone in the building at that
  moment departs at the keyholder's scan time, not the time the close arrived,
  and never more than 24 hours after arrival. A scan time ahead of the server's
  clock is not trusted: that close is held for a human. Someone who arrived more
  than two minutes after the keyholder's scan is left as they are: they badged in
  after lock-up, and a late close never ends a visit that began after it, however
  late it arrives. An arrival within those two minutes is the kiosk's clock
  disagreeing with the server's, and departs with everyone else. A departure the
  nightly sweep stamped before the close arrived is pulled back to the
  keyholder's time; a departure a person has since corrected is not. A keyholder
  who arrived after the scan does not count as still inside.
  The close still needs the keyholder in the building at their scan time — an
  unconfirmed late keyholder scan is held like any other.  [Decision]

- The kiosk is never blank while anyone is checked in: it shows everyone it
  holds as inside, no-keyholder visits included, and its offline presence view
  treats them as present.  [Decision]

- The kiosk and attendance safety display reads a missing or incomplete safety
  payload as *unknown*, never as an empty, compliant room: a failed fetch or a
  half-populated object must not render as "no violation".  [Decision — *Principle: fail closed*]

- Youth and two-deep math stay server-side, never computed on the kiosk. Resolving
  a parked scan runs the same fail-closed safety math the live path does.  [Decision — *Principle: fail closed*]

### The visit record

- A member inserts their own past visit, backdated as far as they need — there is
  no limit on how far, and the audit trail stands in for one.  [Decision]

- A member corrects or removes a visit of their own once it is in. The correction
  always applies: the only bars are validity — the times parse, departure follows
  arrival, the visit runs no longer than 24 hours, and a closed one is never
  reopened — and whose record it is. Integrity is after the fact rather than a
  gate: every change is audited, and a significant one is flagged to the board.  [Decision — *Principle: self-scope and repair*]

- An audited change to a visit records two people: who made the change, and whose
  attendance it was. The second is always the person, never the event they
  attended. Telling a correction of one's own record from one person editing
  another's is the comparison of those two, so an audit that records anything
  else as its subject makes every review of who changed whose record answer
  wrongly, and silently.  [Decision]

- A household lead corrects a recorded visit for anyone in their household —
  inserting a past one, changing its times, or removing it — on the same terms as
  correcting their own. Only the lead, not every household member: the lead is the
  responsible adult, and for someone too young to correct their own record it is
  the only way one gets fixed.  [Decision]

- There are no separately recorded hours to correct. Hours are counted from
  visits, so correcting somebody's hours is correcting the visit underneath them.  [Decision]

- Correcting a time replaces where that time came from: a badge-measured arrival
  a member edits is their own report afterwards, not a measurement. Correcting
  the same time twice is weighed the second time as overwriting a self-report.  [Decision]

- Removing a visit marks it removed rather than erasing it: it stops counting
  wherever visits are listed, counted or totalled, and it can be put back.  [Decision — *Principle: decisions are reversible*]

- Significance is the size of a change weighted by how authoritative the value it
  overwrote was. A measured badge outweighs somebody else's observation of a
  member, which outweighs the member's own earlier report. Every removal shows
  on the review screen whatever it overwrote, because erasing a record is
  notable at any size.  [Decision]

- Every correction or removal is weighed on the same terms whoever made it — the
  member, their household lead, a program's leader, the board — and stays on the
  record to be reviewed. Showing on that screen and the board being emailed at
  the time are separate: only a member's change to their own visit, or their
  household lead's on their behalf, emails the board as it happens. Marking who
  did not turn up and clearing duplicate visits are a leader's routine week, and
  on the board's own corrections the board would be telling itself.  [Decision — deliberate limit]

- A departure that the building closing or the overnight sweep stamped is a
  placeholder the member is meant to fix, so correcting one adds nothing to the
  score however large the correction. The suppression keys on where the value
  came from, not on its size: the sweep stamps at its own run time, so the least
  trustworthy guess is exactly the one producing the largest correction.  [Decision]

- A visit cannot run longer than 24 hours.  [Decision]

- The board and sysadmins edit or delete any visit, and record one for someone
  else at any past time — the walk-in nobody badged in.  [Decision]

- Operations reach attendance in aggregate only — the trends, and printing the ID
  badges. One person's record sits outside that reach: operations do not record,
  correct or remove a visit, do not read the raw badge events behind one, and do
  not review other people's corrections. Running the facility works off the shape
  of attendance, not off who was there when.  [Decision — *Principle: least privilege*]

- A household lead records a visit for a household member the same way they
  record their own — open (still here) or closed (came and left). Board and
  sysadmins always record a closed visit for someone outside their household.
  An open visit for a non-keyholder still requires a keyholder already present
  (the facility-open guard).  [Decision]

- Every completed visit counts toward facility hours, whatever recorded it — a
  badge at the kiosk, a visit staff entered for somebody else, a roster mark. Where
  a time came from governs how a correction to it is weighed and reviewed, not
  whether the visit is counted; a walk-in that a roster mark adopts keeps its
  badged times, and so keeps the source that measured them.  [Decision]

- Facility hours split by program enrollment, not age: anyone present and not
  enrolled counts on the volunteer side.  [Decision]

### Marking an event's roster

Distinct from a visit, which is presence at the facility and belongs to no
program. This is a record of who was at one session of one program.

- Only people enrolled in or volunteering on that program can be marked present.
  Someone else in the list is refused by name rather than dropped from it, and
  having been in the building at the time proves nothing — a walk-in who is not
  enrolled needs enrolling first.  [Decision — *Principle: identity is not authorisation*]

- Who attended is for the people running it — the program's leader, its core
  volunteers, the board and sysadmins. Anyone else is refused outright rather than
  handed a trimmed version, because the names are the part that matters and they
  survive any trimming.  [Decision — *Principle: least privilege*]

- A finished session whose roster is unmarked chases someone by email: the
  program's leader, or a core volunteer where the program has no leader. An in-app
  list of the same sessions is additive and never a replacement — it reaches the
  leader only, so a program with no leader has the email and nothing else.  [Decision]

