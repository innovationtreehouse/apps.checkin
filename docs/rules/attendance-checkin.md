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

- A close is one event: a keyholder closed the building at a moment, at the
  kiosk, at the kiosk while offline, or on the web. Whoever closes decides — the
  keyholder at the kiosk, from what the kiosk shows, or the keyholder confirming
  on the web. The server records that decision and carries it out; it never
  weighs it against its own records, its clock or a freshness window. Everyone
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
  other badge is handled as an ordinary scan. A read of the same badge within a
  second of the offer is the same touch read twice, never the second badge. The
  kiosk decides the same way online and offline, from the same view of who is
  inside.  [Decision]

- The kiosk's view decides a one-badge close, but not past a check-in the kiosk
  could not have known of. When anyone checked in after the kiosk last received
  the roster, a live one-badge close does not close: the keyholder is checked
  out, told who checked in and when, and the same badge again closes. A close
  that reaches the server late is applied as the keyholder meant, and raised for
  review naming whoever checked in after the kiosk's roster.  [Decision]

- A web close is the keyholder confirming in a dialog that shows who is still
  recorded inside. It closes at the moment of the confirm; times are corrected
  afterwards on the visit edit screen.  [Decision]

- Nothing on the web stops or undoes a close made at the kiosk, live or queued:
  not checking the keyholder out, removing their visit, checking in another
  keyholder, nor changing their roles. A kiosk close needs no visit of the
  keyholder's to act on. A live close from a badge that is not a keyholder is
  refused: that badge is checked out as itself, and the kiosk says only a
  keyholder can close. A queued close from someone who is no longer a keyholder
  by the time it reaches the server still closes, and is raised for review: the
  role at the scan's time can't be known.  [Decision]

- A close never ends a visit that began after it. Someone who arrives after a
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
  visit re-decides it. Every other way of checking someone in — the web, a
  household lead, the review panel leaving a visit open — still needs a
  keyholder already present, and on the web that holds for a keyholder's own
  check-in too: only a badge at the door opens the building, and a keyholder
  inside can check in someone who has lost their badge. The review panel may
  still leave open a keyholder's own parked door badge, which was a badge at
  the door.  [Decision]

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
  badge through the one that matters. The kiosk's close offer is separate: a
  keyholder held by this interrupt is offered the close once their departure
  goes through.  [Decision — *Policy: Event, Location and Keyholder Policy, §VIII.4*]

- The supervision interrupt is on the badge scanner only. Checking someone out
  from the web does not raise it — the person doing the checking out is not at the
  reader and cannot re-badge to confirm.  [Decision — deliberate limit]

- The web close-guard fires on every web path that ends an open visit — the
  home-page check-out, dashboard checkout or sign-out, a self-correction edit that
  closes an open visit, and removal of an open visit. When the last recorded
  keyholder's visit ends with others inside, the caller chooses close, leave or
  cancel in one confirm dialog, answered by a token bound to the person shown the
  choice. The dialog's state is the web's alone; no kiosk close reads it. The
  keyholder checking themselves out, or a board member who holds keys, gets all
  three; anyone else — another keyholder, a household lead, a sysadmin, a board
  member without keys — gets leave or cancel. Close checks everyone out; leave
  checks out only the keyholder and leaves the others inside a closed facility;
  cancel changes nothing. The choices are worked out again on confirm, so a role
  revoked in between takes effect. Every choice is audited with who made it,
  whose visit it was, the choice, the keyholder named and the count left inside.  [Decision]

- On the web only the keyholder checking themselves out, or a board member who
  holds keys, closes the facility; anyone else never does, even with the
  keyholder alone in the record. Correcting a close's time is not closing: the
  board may do it.  [Decision — *Policy: Event, Location and Keyholder Policy, Arts. VI–VII*]

- The keyholder checking themselves out, or a board member who holds keys, who chooses leave
  names, from the keyholders not checked in, the one the keyholder handed over to. Where none is free to name,
  the leave stands and records the handover as not named. The named keyholder is
  not checked in — that needs their agreement — and is emailed who left, when,
  and how many are still inside, unless they are checked in by then. Anyone else's
  leave names nobody.  [Decision]

- Removing an open visit never closes the facility, whoever removes it: a
  removal says the keyholder was never there, and closing on that basis would
  invent departures for everyone else. The confirm states how many stay inside
  a closed facility.  [Decision]

- The names of the people inside go with the close choice only to keyholders,
  board members and sysadmins, who already read the full roster; a household lead
  sees a count.  [Decision — *Policy: Records Policy, Art. IV*]

- A keyholder's check-out at the kiosk that the kiosk did not send as a close
  checks out only that keyholder. When it leaves no keyholder recorded inside it
  is a leave, audited like a web leave with the handover not named — the reader
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
  (kiosk, offline kiosk, a web checkout or correction, or the nightly sweep,
  which no person makes). The record commits with the closer's own checkout, and
  the departures are carried out from it, so a close is never lost between the
  two: one whose departures were cut off is carried out at the next scan, web
  close or nightly sweep, the sweep's own stamps coming after it. Every departure
  a close sets is logged against that record with the visit's departure before
  and after. These logs are an audit trail and are never deleted.  [Decision — *Principle: accountability*]

- A correction that closes an open visit departs everyone at the typed
  departure, as a late kiosk close does; someone who arrived after it stays
  inside. The keyholder who made a close, or the board, corrects its time by
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

- Repeat reads of the same badge within three seconds are one scan: the scanner
  can read one touch twice. The kiosk filters them at the moment the badge is
  read, before the scan is queued or sent, so the rule is the same online and
  offline and a double-read never queues an in and an out. A keyholder's second
  badge to confirm a close therefore comes more than three seconds after the
  first. For a current kiosk the server drops only exact duplicates — the same
  scan sent twice, by its event id — and applies everything else it is sent;
  it keeps its own three-second check only for callers that do not filter
  (older kiosk builds and the web).  [Decision]

- A replayed scan applies at the time the badge was read, not the time it was
  delivered, however late it arrives: a scan is trusted by default. A replay
  older than ten minutes, one that lands behind later activity on the person's
  record, or one from a kiosk whose clock stepped is applied all the same and is
  also flagged for a human to check. A scan time ahead of the server's clock
  applies at the server's time, flagged; that holds for a close too, so a doubtful
  clock is never trusted silently. A replay is held unapplied only when
  applying it would contradict the person's later record, or it carries no
  displayed direction.  [Decision]

- A replay that lands behind later activity belongs to the visit the person was
  in at its own time — their latest arrival at or before it — and never touches a
  visit that began after it. A departure ends that visit: an open one checks out
  at the scan time, and a machine departure — the nightly sweep's, or a
  facility close's — stamped after the scan is pulled back to it. A visit never
  departs before it arrived. An arrival behind
  later activity, or a departure against one a person recorded, would rewrite
  the later record, so it is held for the reviewer.  [Decision]

- A close fences what came before it. A queued check-in scanned before a close
  that reached the server first is recorded as a visit from its scan time,
  departing at that close, as the close would have departed it, and is flagged.
  A check-in scanned after the close, beyond the two-minute clock allowance,
  opens a visit as usual. The same person's queued check-out from before the
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
  and departs with everyone else. A machine departure stamped after the close —
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
  kiosk's own screen shows what the kiosk holds regardless, and checking in or
  out decides from the visit record either way.  [Decision — *Principle: fail closed*]

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

