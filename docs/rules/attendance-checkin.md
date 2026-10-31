# Attendance and check-in

Opening and closing a facility, supervision, the kiosk, and the visit record.

The check-in state machine signed off by the owner (scans, IN/OUT, closing the
building) is in [`docs/ops/checkin-state-machine.md`](../ops/checkin-state-machine.md).

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

- A keyholder who leaves the building occupied has handed over in person, with
  the other keyholder's consent, to one who will badge in. The kiosk has no
  pick-list, so the app records only that they left.

- The app does not model a primary keyholder, so the last recorded keyholder
  stands in for the primary keyholder of §VIII.3.

- Check-in happens at the one facility. Other locations exist and are temporary,
  and checking in at them is out of scope.

---

## Procedure

### Trust, then review

Only check-in leans on this, so it is stated here rather than among the
principles.

- A person's account of what happened is accepted when they give it. The app
  records it, says who gave it, and makes it reviewable. It does not refuse an
  account because its own record disagrees.  [Decision]

- Where the app's record and the room disagree, the room is right. The app
  cannot see a handover, a keyholder who never badged, or a walk-in nobody
  scanned. A gate built on what the app can see blocks the people doing it
  correctly.  [Decision]

- Trust comes with a trail. An accepted account that changes someone else's
  record names who gave it, and a significant one reaches someone who reviews
  it.  [Decision — *Principle: accountability*]

- It widens nothing and overrides no policy. Who may act is still least
  privilege's question; where a policy requires a block, the block stands.  [Decision — *Principle: least privilege*]

The tell is a refusal whose only reason is that the data disagrees with the
person in front of it.

### Opening and closing

- Only the kiosk starts or ends a visit while it is happening, and only the kiosk
  closes the building. The website offers no check-in, check-out, force checkout
  or close, to anyone; people badge at the door. The nightly auto-close is the
  backstop, a close no person makes. This replaces the owner's ruling of
  2026-10-11 that a keyholder can close the building from the web. One path
  still reaches an open visit until its own change lands: a program leader's
  roster mark.  [Decision — Board ruling B7/B14, 2026-10-27]

- A close is one event: a keyholder closed the building at a moment, at the
  kiosk, online or offline. The keyholder decides, from what the kiosk shows. The
  server records that decision and carries it out; it never
  weighs it against a freshness window, and against its own records and clock
  only as the rules below state. Everyone
  still recorded inside departs at that moment, including anyone who checked in
  with no keyholder present: people still recorded inside at a close are
  forgotten badge-outs.  [Decision — *Policy: Event, Location and Keyholder Policy, Arts. VI–VII*]

- Only a keyholder closes the building. A board member closes only as a
  keyholder.  [Decision — *Policy: Event, Location and Keyholder Policy, Arts. VI–VII*]

- At the kiosk, a keyholder leaving when the kiosk shows nobody else inside
  closes the building with that one badge, and the kiosk says the building should
  now be empty. When the kiosk shows anyone else inside — keyholder or not — the
  badge checks out only that keyholder, and the kiosk lists who it shows inside
  and offers the close: the same badge again within fifteen seconds closes the
  building. No second badge, or a badge of anyone else, ends the offer; that
  other badge is handled as an ordinary scan. A read of the same badge within
  three seconds of the offer is the same touch read twice, never the second
  badge. The
  kiosk decides the same way online and offline, from the same view of who is
  inside.  [Decision]

- The kiosk's view decides a one-badge close, but not past a check-in the kiosk
  could not have known of. When anyone checked in after the kiosk last received
  the roster, a live one-badge close does not close: the keyholder is checked
  out, told who checked in and when, and the same badge again closes. A close
  that reaches the server late is applied as the keyholder meant, and raised for
  review naming whoever checked in after the kiosk's roster. A held close whose
  reply never reached the kiosk is resent from its queue, and that resend is such
  a late close: applied and raised for review.  [Decision]

- Nothing on the web stops or undoes a close made at the kiosk, live or queued:
  not correcting the keyholder's visit, nor changing their roles. A kiosk close needs no visit of the
  keyholder's to act on. A live close from a badge that is not a keyholder is
  refused: that badge is checked out as itself, and the kiosk says only a
  keyholder can close. A queued close from someone who is no longer a keyholder
  by the time it reaches the server still closes, and is raised for review: the
  role at the scan's time can't be known.  [Decision]

- A close never ends a visit that began after it, beyond the two-minute clock
  allowance below. Someone who arrives after a
  close starts a new visit. A close's time, once corrected, is when the
  keyholder left: queued scans are compared with the corrected time.  [Decision]

- The facility is open only while a keyholder is present. A visit by someone
  else never makes it read as open on any web surface: people inside with no
  keyholder are shown as inside a closed facility. A keyholder's check-in
  scanned before the latest close but reaching the server after the close was
  carried out is listed as inside but does not reopen the building; an arrival
  after the close does, however soon after. The kiosk's clock is trusted to
  within the same two minutes a late close allows.  [Decision — *Policy: Event, Location and Keyholder Policy, Arts. VI–VII*]

- A badge at the kiosk always checks the person in, keyholder or not. Someone
  scanning inside the building got in somehow, and the screen shows who is
  there. With no keyholder in the building the visit is marked *no keyholder*,
  and a keyholder checking in within ten minutes of that arrival clears the
  mark. The mark is read from the visit record, so correcting a keyholder's
  visit re-decides it. A roster mark that leaves a visit open still needs a
  keyholder already present, for a keyholder too: only a badge at the door opens
  the building. The review panel records a parked scan as a closed visit.  [Decision — Board ruling B7/B14, 2026-10-27]

### Supervision

- The two-deep check counts supervising adults, not adults present. A supervising
  adult is an adult whose background clearance is still valid, whose household
  holds an active org membership, and who is not themselves a participant on a
  program running at that moment. Two people of one
  household count as one, so a couple is not two deep.  [Decision — *Policy: Definitions Policy, Art. III, "Two Deep"*]

- Being a participant on a program in session is what disqualifies someone from
  supervising it, not being at school: a member of eighteen or nineteen enrolled
  in a program does not count while that program runs, and counts again as a
  volunteer on another. School enrollment is not recorded at all, so the part of
  policy that turns on it cannot be tested here.  [Short of policy — *Policy: Definitions Policy, Art. III, "Two Deep"*]

- A clearance that is not recorded is not a clearance: someone with no background
  check on file, or one older than the board's recheck interval, is not one of the
  supervising adults. While the board has set no recheck interval, every check
  counts as expired, so no one is.  [Decision — *Principle: fail closed*]

- Someone whose age is unknown counts as a youth in the supervision check: not
  one of the supervising adults, and one of the people needing cover.  [Decision — *Principle: fail closed*]

- Two deep is shown as a warning. It does not stop anyone entering or checking
  in — surfacing the shortfall to the people in the room is the whole of what the
  app does about it. A youth arriving into a room short of supervision is warned
  about, never turned away: whether to open the door is the keyholder's call.  [Decision — deliberate limit]

- Keyholders reach every household's emergency contacts, not only those of the
  people currently in the building.  [Decision]

- Every live departure at the badge scanner that takes a supervising adult out
  of the building is interrupted, whoever is leaving. A departure badged while
  the kiosk cannot reach the server is not: the kiosk does not compute
  supervision itself. Dropping to two is a warning and nothing more.
  Dropping below two stops the departure until the person badges again within
  fifteen seconds — but only while a youth is in the building. With no youth
  there, that departure is warned about and goes through: two deep is owed
  whenever a youth is present, so an adult-only room locking up has nothing to
  confirm, and an interrupt raised where nothing is at stake teaches people to
  badge through the one that matters. The kiosk's close offer is separate: a
  keyholder held by this interrupt is offered the close once their departure
  goes through.  [Decision — *Policy: Event, Location and Keyholder Policy, §VIII.4*]

- A keyholder's check-out at the kiosk that the kiosk did not send as a close
  checks out only that keyholder. When it leaves no keyholder recorded inside it
  is a leave, audited with the handover not named — the reader
  has no pick-list, and a keyholder staying can badge in at the same reader.  [Decision]

- A kiosk too old to send a close decides it from the keyholder's check-out
  instead: from whether the kiosk showed anyone else inside, when it says so,
  else from the server's records. Shown nobody, that one badge closes; otherwise
  it is a leave, and the kiosk offers the close and its second badge closes. A
  queued badge with no confirm replays as a leave, flagged for a human to check
  who is still recorded inside.  [Decision — deliberate limit]

- When a keyholder closes with others shown inside, the kiosk passes on the
  supervision caution it last knew, in yellow. It cannot re-check two-deep
  itself, so it leaves the call to the keyholder at the reader.  [Decision — *Policy: Event, Location and Keyholder Policy, §VIII.4*]

- Every facility close is recorded: who closed, when, and through which path
  (kiosk, offline kiosk, or the nightly sweep, which no person makes; closes made
  before the website stopped closing name their web path). The record commits
  with the closer's own checkout, and
  the departures are carried out from it, so a close is never lost between the
  two: one whose departures were cut off is carried out at the next scan or
  nightly sweep, the sweep's own stamps coming after it. Every departure
  a close sets is logged against that record with the visit's departure before
  and after. These logs are an audit trail and are never deleted.  [Decision — *Principle: accountability*]

- Correcting a close's time is not closing. The keyholder who made a close, or
  the board, corrects its time by
  correcting the closer's departure; the log names who moved it and, for the
  board, whose close it was. Earlier: every departure the close set moves to the new time,
  except someone who arrived after it, who keeps the original close's departure
  as a placeholder for a person to fix, and a departure its owner has corrected,
  which is never moved. Later: only the closer's own departure moves. Every
  departure a correction moves is logged against the close with who moved it,
  the path, and its before and after.  [Decision]

### The kiosk

- The kiosk shows only what an unattended public screen may — no dates of birth,
  phone numbers, emergency contacts or email addresses. Where a person has no
  name recorded, what shows is the part of their address before the @, never the
  address itself.  [Decision — *Policy: Records Policy, Art. IV*]

- The kiosk never shows a whole last name. It names people as the roster does —
  the nickname, else the first name — and adds a shortened last name only to tell
  two people apart: at most two letters of the name itself, with any particles
  before them whole ("van der B."). A last name its script cannot shorten is left
  off rather than shown whole. That applies to everything sent to the kiosk, not
  only what it renders: the roster, the certification grid and every
  warning.  [Decision]

### Kiosk resilience

The badge kiosk and its offline scan path. Infrastructure failure — WiFi loss for
hours at a time — is a normal operating mode here, not an incident.

- A badge scan, once read, is never lost. It survives to a durable server record
  whatever the network or facility state. The system may decline to *display* or
  *project* a scan — park it, defer it — but never discards one.  [Decision]

- A raw badge read is never edited or deleted, by anyone, a sysadmin included.
  Its time, place and person stay as the kiosk read them, and a wrong time is
  corrected on the visit. Only its review markings and replay key change, and a
  merge moves it to the surviving person.  [Decision]

- A read that cannot name anyone — not a badge number at all, or, scanned live,
  a number that matches nobody — is refused at the reader, which asks for the
  badge again, and is not kept. A queued read that names nobody is kept for
  review.  [Decision]

- Every good-faith badge is acknowledged at the door — "checked in" or "checked
  out" — even when the server's live math disagrees or the network is down.
  Surfacing that the kiosk is out of sync is additive, never a substitute for the
  acknowledgement.  [Decision]

- The direction the kiosk displayed is the intent of record. When a queued scan is
  delivered later, the server applies the in/out the person saw; it never re-infers
  direction from its own live state at delivery, which would flip a replayed
  check-in into a check-out.  [Decision]

- Repeat reads of the same badge within three seconds are one scan: the scanner
  can read one touch twice. The kiosk filters them at the moment the badge is
  read, before the scan is queued or sent, so the rule is the same online and
  offline and a double-read never queues an in and an out. A keyholder's second
  badge to confirm a close therefore comes more than three seconds after the
  first. For a current kiosk the server drops only exact duplicates — the same
  scan sent twice, by its event id — and applies everything else it is sent;
  it keeps its own three-second check only for callers that do not filter
  (older kiosk builds).  [Decision]

- A replayed scan applies at the time the badge was read, not the time it was
  delivered, however late it arrives: a scan is trusted by default. A replay
  older than ten minutes, one that lands behind later activity on the person's
  record, or one from a kiosk whose clock stepped is applied all the same and is
  also flagged for a human to check. A scan time ahead of the server's clock
  applies at the server's time, flagged; that holds for a close too, so a doubtful
  clock is never trusted silently. A replay is held unapplied only when
  applying it would contradict the person's later record, or it carries no
  displayed direction. A kiosk build older than this behaviour keeps the older
  one: its late, out-of-order or doubtful-clock replay is held for review rather
  than applied.  [Decision]

- A replay that lands behind later activity belongs to the visit the person was
  in at its own time — their latest arrival at or before it — and never touches a
  visit that began after it. A departure ends that visit: an open one checks out
  at the scan time, and a machine departure — the nightly sweep's, or a
  facility close's — stamped after the scan is pulled back to it. A visit never
  departs before it arrived. A departure with no visit open at its own time ends
  the open visit only when a live badge check-in began it: the kiosk queued the
  departure behind that check-in, which the server stamped later (its reply was
  lost, or the kiosk clock runs behind). It departs no earlier than the visit
  began, and is flagged. Any other later visit, an arrival behind later
  activity, or a departure against one a person recorded after it would rewrite
  the later record, so it is held for the reviewer.  [Decision]

- A close fences what came before it. A queued check-in scanned before a close
  that reached the server first is recorded as a visit from its scan time,
  departing at that close, as the close would have departed it, and is flagged.
  A check-in scanned after the close, beyond the two-minute clock allowance,
  opens a visit as usual; a close from the kiosk's own queue was stamped by the
  same clock, so it gets no allowance. The fence is read at the moment the
  check-in is written, so a close that commits while it waits still fences it. The same person's queued check-out from before the
  close then pulls that departure back to their own scan.  [Decision]

- A close queued at the kiosk is applied whenever it reaches the server, however
  late; it is never held for staleness or ordering, and is not raised for review
  for being late. The keyholder was at the reader and saw the room, so the close
  is a fact, not a toggle. Everyone in the building at that moment departs at the
  keyholder's scan time, not the time the close arrived, and never more than 24
  hours after arrival. A scan time ahead of the server's clock closes at the
  server's now, and is raised for review, as is a close from a kiosk clock
  flagged as having stepped. Someone who arrived more than two minutes after the
  keyholder's scan is left as they are: they badged in after lock-up. An arrival
  within those two minutes is the kiosk's clock disagreeing with the server's,
  and departs with everyone else, unless the server recorded the arrival after
  it recorded the close: that arrival came after the close. A machine departure stamped after the close —
  the nightly sweep's, or a later close's — is pulled back to the keyholder's
  time, so closes apply in the order they were made, whatever order they arrive
  in; a departure a person has since corrected is not moved. A plain keyholder
  check-out that the kiosk did not send as a close checks out only that keyholder,
  however late it arrives.  [Decision]

- The kiosk is never blank while anyone is checked in: it shows everyone it
  holds as inside, no-keyholder visits included, and its offline presence view
  treats them as present.  [Decision]

- The kiosk and attendance safety display reads a missing or incomplete safety
  payload as *unknown*, never as an empty, compliant room: a failed fetch or a
  half-populated object must not render as "no violation".  [Decision — *Principle: fail closed*]

- The web states the building's state — who is inside, whether it is open,
  whether it is two deep — as fact only while the server has heard from the
  kiosk within the last five minutes. Otherwise it says it can't confirm the
  building's state and when the kiosk was last heard from, and what it lists is
  the visit record, not presence. A kiosk resting in a building it knows is
  empty sends nothing on purpose, so that is the expected reading then. The
  kiosk's own screen shows what the kiosk holds regardless.  [Decision — *Principle: fail closed*]

- The kiosk rests — sends the server nothing on its own — only while the
  building is known empty: its last real roster showed nobody inside, no badge
  at the kiosk and no check-in made on its screen since, and no scan waiting
  to be delivered. That holds at any hour, and the next badge ends it. Before
  it rests, its screen shows the real empty roster. This rests on the front
  door being the only scanner: every arrival badges there first. While anyone
  is inside, or occupancy is unknown, it keeps fetching whatever its clock
  says. When the server cannot answer, its screen shows the kiosk's own view —
  the last server roster with its badges since, marked not up to date — and it
  never invents a roster or states supervision it cannot know.  [Decision — *Principle: fail closed*]

- Youth and two-deep math stay server-side, never computed on the kiosk. Resolving
  a parked scan runs the same fail-closed safety math the live path does.  [Decision — *Principle: fail closed*]

### The visit record

- A visit that is still open is changed only by the kiosk or the nightly
  auto-close, apart from a roster mark (see Opening and closing). A member, a
  household lead or the board corrects or removes a visit once it is closed, and is told to badge out at the kiosk or wait for the
  11 PM close before then.  [Decision — Board ruling B7/B14, 2026-10-27]

- A member inserts their own past visit, with a departure, backdated as far as
  they need — there is no limit on how far, and the audit trail stands in for one.  [Decision]

- A member corrects or removes a visit of their own once it is in. The correction
  always applies: the only bars are validity — the times parse, neither time is
  in the future, departure follows arrival, the visit runs no longer than 24
  hours, and it stays closed — and whose record it is. Integrity is after the fact rather than a
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

- A visit records whether the building closing or the overnight sweep ended it,
  and the two stay distinct. Neither close is audited, so the visit is the only
  record of how it closed, and the two guesses deserve different trust: the
  building closing is bounded by its hours, the sweep is not.  [Decision]

- A correction to somebody else's visit weighs double — the same nudge that is
  noise on your own record is worth seeing on someone else's. It doubles the
  score rather than setting a floor, so a routine fix by a household lead still
  does not flag, and a corrected building-close or sweep departure still adds
  nothing.  [Decision]

- Merging two people moves their visits to the surviving record without counting
  as a correction: it changes whose attendance it is, not what happened, so it
  does not appear among corrections for review.  [Decision]

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
  An open visit, whoever it is for, a keyholder's own included, needs a
  keyholder already inside (the facility-open guard).  [Decision]

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

