# Program rollover and leader reservations

Design for issue #1248 (backlog P25), with the leader-reserves-a-place half of
#1235 (backlog P2). Every owner question in §10 is settled; two wait on the
Board (Q28, Q31; B33 and B34 in the Board's question list), and the design records the owner's default for each until
then: no to both. Code read at `main` `8858af535`. Paths are under
`checkin-app/src/` unless they start with `docs/`.

## Problem

Some programs run in a line of segments, year after year, with mostly the same
people: a robotics team runs Fall Training, Competition, Championships and
Summer, then Fall Training again. Today the Board creates each segment by hand,
and every family enrolls again from scratch, racing newcomers for the same
seats. The program leader, who knows who is continuing and who is graduating,
has no way to keep a place for anyone: the enroll route refuses a leader
outright ("Program leads cannot manually add participants").

Objective: a program leader can reserve a place for someone, singly or by
carrying over the previous run's roster; the family confirms it by a deadline
the whole program shares; a place nobody confirms goes back to everyone.

Outcome: the Board creates and prices the next run and switches reservations
on; the leader carries the returning participants over; each family gets an
email, confirms (and only then owes the fee) or declines; reminders go out
before the deadline; unconfirmed places are released on it.

## 1. What `main` has today

- **One `Program` row per run.** `Program` is unique on `(nameKey, appliesToYear)`
  (`lib/programs/nameKey.ts`). Nothing links one run to the next.
- **No copy.** P9 / #156 ("Copy a Program") is open with no code.
- **Leaders cannot enroll.** `POST api/programs/[id]/participants` admits the
  person, their household lead, the Board, a sysadmin, and Board/Finance with a
  basis; a leader gets 403 (`participants/route.ts:84`).
- **Claims are rows.** `PENDING` and `ACTIVE` count against capacity
  (`ENROLLED_PARTICIPANT` = status not `WITHDRAWN`, `lib/person/filters.ts:5`),
  under the program row lock (`lockProgramForClaim`, `lib/program/capacity.ts:40`).
  Under claim-first (`docs/in-design/CLAIM_FIRST_PROGRAM_SEATS.md`) that count is
  the only gate.
- **Unpaid claims are chased.** `cron/pending-participants` warns an unpaid
  claim and escalates it to the Board.
- **Emails are templates.** `EmailTemplate` rows keyed by a registry
  (`lib/email-templates/registry.ts`), plain text with `{{token}}`s, edited by
  the Board without a deploy.
- **The instance tier is not for this.** `ProgramInstance` is for one workshop
  offered several times a year; rollover neither waits for it nor folds into it.

Rules that shape the design (program rules in the rules register):

- Enrollment is done only by the person, their household lead, the Board, a
  sysadmin, or Finance. A reservation is not an enrollment; confirming one is,
  and only the person or their household lead confirms (§6).
- Whoever completes a registration is responsible for paying for it. The family
  completes it by confirming, so nobody owes for a place they did not confirm.
- Only the Board and sysadmins set a price. A leader reserves at the Board's
  price and never changes it.
- A leader sees whether a place is paid, never how.
- A program never enrolls beyond capacity.
- A place nobody took up is removed outright; the expiry sweeps only ever remove.

## 2. The design in short

1. **A run knows the run it follows** (§3).
2. **The Board starts the next run** with "Start next run": a copy (the P9 copy,
   #156) plus the link. The copy carries no price. The Board prices it.
3. **The Board switches reservations on** for the run. The Board sets its
   **confirmation deadline**, one date for the whole program, and the leader
   sets its reminder schedule (§4).
4. **The leader or a program administrator reserves places**: one at a time,
   or by carrying over the previous run's roster (§5). A reserved place holds a
   seat and owes nothing. Each household gets one nightly summary of its changes.
5. **The family confirms or declines** (§6). Confirming turns the reservation
   into an ordinary claim, paid like any other. Declining frees the seat.
6. **Reminders** go out on the days the leader chose before the deadline (§7).
7. **On the deadline** the nightly sweep releases every unconfirmed
   reservation; the seats go back to everyone.

## 3. Identity: what links two runs

**Decided (owner, Q1):** a link on today's model. Each run is its own `Program`
row, priced on its own, and records the run it follows:

```prisma
previousRunId Int? @unique   // on Program, → Program.id
```

`@unique` keeps the chain a line: a run has at most one successor. A program
never splits in this design; if one ever does, the Board sets it up by hand.

### Segments

**Decided (owner, Q11, Q12):** a program may run in several segments a year,
each with its own price and length, taken one after another. Segments and years
form one chain, and carry-over draws on the previous run's roster only:

```
Fall Training 2026 → Competition 2026 → Championships 2026 → Summer 2026 → Fall Training 2027 → …
```

Each segment is its own `Program` row, with its own price, dates, capacity and
roster. Segments in one year need distinct names ("Robotics — Fall Training").
Nobody skips a segment in practice (Summer is free).

**List opt-outs are keyed on the list address (owner, Q7, reconciled with
the membership-sync design).** `docs/in-design/MEMBERSHIP_SYNC.md` keys a
person's opt-out on the list address (or Slack channel id), not on a program or
the chain. Teams reuse their address across years, so an opt-out carries forward
as the team does; a new address is a new list. The chain only feeds who is
desired on a list, never whose opt-out applies. Yearly handling is that design's
option C: once per membership year, the first time the sync would have re-added
someone, one email saying they are off the list and how to rejoin, plus a Board
action to record an opt-in or opt-out on a person's behalf when they ask in
person, with a required note. Team lists and the members list only, never the
newsletter. Nothing here builds the sync.

### Ongoing runs

**Decided (owner, with the membership-sync design):** a run carries an
"ongoing" checkbox meaning "a next run is expected". Links alone cannot tell a
program finished for good from one whose next run is not created yet: Summer
2026 ends 31 August and the Board starts Fall Training 2027 on 5 September. The
sync keeps an ended ongoing run's people on the team list until the next run
starts, and takes a run not marked ongoing off at its end, so a team is not
dropped and re-added across a short gap.

```prisma
ongoing                 Boolean   @default(false)  // on Program: a next run is expected
ongoingReminderSentAt   DateTime?                  // last "no next run" reminder to the Board
```

The nightly sweep reminds the Board about an ongoing run with no next run,
starting 30 days before the run ends and then weekly until a next run exists or
the Board turns ongoing off: "Robotics — Summer 2026 is ongoing, ends 31 August
and has no next run. Start it, or turn off ongoing." It is its own Board email
(`program.ongoingNoNextRun`); the problems digest goes to operations, not the
Board. Each reminder sent is recorded on the run so the weekly cadence survives
a missed night.

**Decided (owner, Q32):** only the Board (or a sysadmin) sets the checkbox. It
already appears in the budget template a program leader gets approved, so the
Board records what it approved. "Start next run" copies it; the Board turns it
off if the new run's budget says otherwise. The reminder above is Q32's last
part.

## 4. Starting the next run, and the Board's switches

**Decided (owner, Q9):** the Board creates and prices the next run; the leader
carries people over.

"Start next run" on a program the Board (or a sysadmin) can edit creates a new
`Program` in one transaction:

| Copied | Not copied | Reset |
|---|---|---|
| name, age band, `orgMemberOnly`, `publiclyVisible`, `maxParticipants`, `announceOnOpen`, `reservationsEnabled`, `ongoing` | prices, Shopify ids and every stock/sale-sweep column, `offSaleAt`, `confirmationDeadline` | `phase = PLANNING`, `enrollmentStatus = CLOSED`, dates and `appliesToYear` from the form, `announcedAt = null` |
| program leader, program administrators, core and ordinary volunteers, as they stand. Nobody is dropped: a lapsed background check or eligibility shows on the audit screen (§4a), never as an automatic removal | | |

New columns on `Program`:

```prisma
reservationsEnabled          Boolean   @default(false)  // Board: reservations may be made
confirmationDeadline         DateTime? @db.Date         // shared by every reservation
confirmationReminderDays     Int[]     @default([])     // leader: days before the deadline to remind
confirmationRemindersSetAt   DateTime?                  // leader saved a schedule; null = not set yet
confirmationRemindersSent    Int[]     @default([])     // days-before already sent; cleared when the deadline or schedule changes
```

- Reservations need both the switch on and a deadline in the future.
- **Owner default until the Board answers Q28: no.** The deadline is fixed by
  the Board; only the Board (or a sysadmin) sets or moves it, and the program
  leader does not. Each edit writes an audit row. If the Board answers yes,
  the leader regains the edit described in Q17.
- **Decided (owner, Q18):**
  - The switch cannot be turned off while the run holds any `RESERVED` row:
    the PATCH refuses with the count. Switching off with reservations
    outstanding is almost always a mistake, and allowing it leaves states
    nobody wants to define.
  - Outstanding reservations always run to whatever the current deadline is.
    Moving it clears `confirmationRemindersSent`, so reminders count back from
    the new date.
  - The deadline edit warns before saving, and the editor confirms or cancels:
    - **Moved into the past (or to today):** "N unconfirmed places will be
      released tonight."
    - **Reminders would be skipped:** a scheduled reminder whose day under the
      new deadline has already passed and which was never sent — "The
      14-days-before reminder will not be sent." Moving the deadline earlier
      is the usual cause.
- A run with no price set takes no reservations, so a family always sees the
  price it would confirm at.

**Decided (owner, Q16):** the reminder schedule is set on each program by its
program leader. A run with reservations switched on cannot be opened for
enrollment or put on sale until the leader has saved a schedule
(`confirmationRemindersSetAt` not null): the open/publish path and the Shopify
sync refuse with "Set the confirmation reminders first."

**Decided (owner, Q23):** reserving is gated the same way — no reservation, single
or carry-over, until a schedule is saved. An empty schedule is refused: there is
always at least one reminder. "Start next run" copies the previous run's
schedule into `confirmationReminderDays` but leaves `confirmationRemindersSetAt`
null, so the leader must press Save on it before reserving or opening.

### 4a. Staff background checks: audit, never removal

**Decided (owner):** "Start next run" copies every staff role as it stands. A
volunteer, administrator or leader whose background check has lapsed is not
removed — removing someone who files the paperwork a day late insults them and
costs the leader work. Lapses surface on an audit screen for a person to act on.

The Board's compliance dashboard (`api/membership-audit/compliance`) already
lists check-obligated adults without a fresh background check
(`PERSON_BG_NEEDED`), warn-only, drawn from `bgObligatedWhere` (participants,
volunteers, program leaders). This design:

- adds program administrators to `bgObligatedWhere`, so they are obligated and
  listed like volunteers;
- lists every program a person staffs and their role on it, instead of the
  first program found, so the Board sees which runs carry a lapsed person.

Who else sees it is Q31.

## 5. Reserving

### State

A reservation is a `ProgramParticipant` with a new status:

```prisma
enum ProgramParticipantStatus {
  RESERVED   // a leader holds the seat; the family has not confirmed; nothing owed
  PENDING
  ACTIVE
  WITHDRAWN
}
```

plus who made it:

```prisma
reservedById Int?       // who reserved it: the leader, an administrator, or the Board
reservedAt   DateTime?
```

Why a status and not a separate table: a reservation must hold a seat, and
`ENROLLED_PARTICIPANT` (status not `WITHDRAWN`) already counts it with no
change to the capacity lock. Why not plain `PENDING`: `PENDING` means owed, and
the unpaid chase, the checkout and the payment views all read it that way.

The cost is that every reader of `status` must handle `RESERVED`. Places that
read "not `ACTIVE`" as "unpaid" would misread it. The build PR greps every
`status` reader (nine literal `"PENDING"` matches outside tests today, plus
`enrollmentState.ts`, the roster, the leader's views, attendance, RSVPs, the
membership-sync population once it ships) and decides each one.

**Decided (owner, Q19):** a reserved person is on the roster, marked
"reserved", and may check in at the kiosk for the program's sessions: by the
first session they hold a badge. On team lists (Q29), someone carried over
stays on in any state; if declined or released they stop counting on the new
run but leave the list only when the run they are on ends (or, if it is
ongoing, when the next run starts); someone new to the
chain joins only once paid. Membership sync is not built; this is a
requirement on its design. They may also sign up for sessions; a declined or
released reservation loses its sign-ups for sessions not yet started, through
the existing leave path.

### Who may reserve

**Decided (owner, Q15):** the program's leader may reserve, on a run with
reservations switched on, including for their own household. The Board and
sysadmins may too. Every reservation needs the family's confirmation; the
leader never completes an enrollment.

**Decided (owner):** a program may also have **program administrators**, who may
reserve (single and carry-over) on that program and nothing else. Being an
administrator grants no other power on the program; an administrator may also
be a core or ordinary volunteer, but need not be.

```prisma
model ProgramAdministrator {
  programId Int
  personId  Int
  program   Program @relation(fields: [programId], references: [id])
  person    Person  @relation(fields: [personId], references: [id])
  @@id([programId, personId])
}
```

A separate table, not a flag on `ProgramVolunteer`, because an administrator
need not volunteer, and `isCore` on that table already drives security scope.
The security boundary gains one claim (`programsAdministered`) and one resolver
case, used only by the reservation and carry-over routes.

**Decided (owner, Q33):** administrators are on the program's mentor list with
its leader and core volunteers. This is a requirement on the membership-sync
design.

**Decided (owner, Q24):** the program leader appoints administrators. An
administrator meets the same requirements as a program leader (at least 23, a
member, background check passed), checked by the same leader-eligibility code at
appointment. "Start next run" copies them as they stand; a lapse shows on the
audit screen (§4a), never as a removal.

**Decided (owner, Q25):**

- **Appointing:** the program leader, the Board and sysadmins appoint and
  remove administrators.
- **Rosters:** an administrator sees the previous run's roster (for carry-over)
  and the current run's.
- **Marks:** reserved, confirmed, paid/unpaid, and the household's contact
  details, so they can chase families who have not confirmed. Never how anyone
  pays.
- **Unreserving:** an administrator, the program leader and the Board may remove
  a reservation (a `RESERVED` row; removed outright, nothing was owed). This is
  how people are moved between teams when a program runs several (3–4) teams
  and places shift with schedules. A confirmed or paid place is not theirs to
  remove; that stays on today's leave path.

Contact details are a wider grant than a leader's roster view carries today, so
the security PR gives the administrator scope its own `returns:` bag for the
roster route rather than reusing the leader's.

The leader reserves at the Board's price and never chooses one. The reserve
path runs the run's age check (age at the run's start) and the capacity lock.
It skips the household's own checks (emergency contact, membership covering the
run's year), which run at confirmation, where the family is acting.

**Decided (owner, Q4):** on a members-only run, a returning participant whose
household membership does not cover the run's year is still reserved. The
carry-over screen marks them, the nightly email tells the family membership must
cover the year, and confirming is refused until it does. Unrenewed by the
deadline, the place is released as usual.

**Settled by Q26 (Q20):** a leader or administrator reserves anyone the existing
people picker returns. `GET api/programs/[id]/eligible-participants` already
admits a program leader (`registry.ts:260`): a name-or-id search over live
households, names only, excluding people already on the program, filtered to
settled members on a members-only run. The security PR adds administrators to
it. Nothing else about the picker changes.

### Moving people between teams

**Decided (owner, Q26):** a move is two ordinary steps, reserve on the new team
then unreserve on the old one. A program running 3–4 parallel teams has one
chain per team (Team A 2026 → Team A 2027), so Team B's carry-over screen does
not list Team A's people; the leader or administrator reserves them on Team B
through the people picker (above), then removes the Team A reservation. The
roster screen offers the steps in that order — reserve first — so a full Team B
never leaves someone with no seat. A one-step "move to team" action is a
follow-up (§9).

### Carry-over

On a run with a `previousRunId`, the leader's screen lists the previous run's
roster. **Decided (owner, Q2a):** `ACTIVE` and `PENDING` places are ticked; an
unpaid one is marked "unpaid on the previous run" (paid/unpaid is already what a
leader sees); withdrawn people are shown unticked and may be ticked in. For
each, a verdict against the new run: eligible, aged out / too young, membership
does not cover the run's year (Q4), or already on the new run (skipped).

The leader unticks anyone graduating or not continuing and presses "Reserve
places". One transaction under the capacity lock; refused if the ticked people
would exceed capacity (the leader unticks or asks the Board for more, Q3).

## 6. Confirming

The person (if an adult) or their household lead sees the reservation on the
program page and in the email, with the price and the deadline.

- **Confirm** runs the family's own enroll checks (emergency contact, the
  household lead's known age) and moves `RESERVED` → `PENDING` for a priced run
  or `ACTIVE` for a free one. From here it is an ordinary claim: paid through
  the usual checkout, chased by the usual unpaid warnings. This is the moment
  the family completes the registration and takes on the fee.
- **Decline** removes the row (a place nobody took up). The seat is free at once.
- **Nobody under 18 confirms for themself.**
- **After the deadline** an unconfirmed reservation is gone; the family enrolls
  like anyone else if a seat is left.

**Settled by Q13 and Q15:** nobody owes for a reservation, so the unpaid chase
never sees one. **Settled with them (Q14):** the emergency-contact check runs at
confirmation, because that is the family's own enrollment.

**Decided (owner, Q6):** scholarships and payment plans never carry. After
confirming, the family asks again on the new run through the existing request
path, and the Board decides again; each run's scholarships stay within its own
budget and waiver limit.

## 7. Reminders and release

### Reservation changes: one nightly summary per household

**Decided (owner, Q27):** reserve and unreserve send nothing at the moment they
happen. Each writes a notice row in the same transaction; the nightly sweep
sends each household one summary of its net changes.

```prisma
model ReservationNotice {
  id        Int                   @id @default(autoincrement())
  personId  Int
  programId Int
  kind      ReservationNoticeKind // RESERVED | RELEASED
  createdAt DateTime              @default(now())
  sentAt    DateTime?
}
```

A deleted reservation leaves no row behind, so the notice table is what lets the
summary say what was removed. Nothing is added to existing tables.

**Netting.** For each person, the unsent notices in `createdAt` order reduce to
the net change from where the family last stood to where they stand now:

| Unsent notices for one person | Summary line |
|---|---|
| reserved A | reserved on A |
| released A | released from A |
| released A, reserved B | moved from A to B |
| released A, reserved B, released B, reserved C | moved from A to C |
| reserved A, released A | nothing |
| released A, reserved B, released B, reserved A | nothing |

The netting is one pure function with a unit test per row of that table; the
A → B, B → C same-day case naming A → C is required. Carry-over is just many
"reserved" notices, so it yields one email per household listing everyone.

The summary uses `program.reservation.made` (renamed to
`program.reservation.changes`), one email per household lead with a line per
person, the price and deadline for each run they are now reserved on, and a
link to confirm or decline. It then stamps `sentAt`. It runs before the release
step, so a run released tonight is not also summarised.

**Late reservations are allowed.** A reservation made after the run's first
reminder day (`deadline − max(confirmationReminderDays)`) is not refused. The
reserve screen shows the leader or administrator a warning to dismiss: "This
place is inside the confirmation reminder window. The family will hear from us
tomorrow; contact them directly so they confirm before {{deadline}}." Reminders
still due after that day are sent as normal.

### Reminders and the deadline

- **Before the deadline:** reminder emails to households still holding a
  reservation, on the days before the deadline the leader's schedule names (for
  example `[14, 3]`). The nightly sweep sends each due reminder once per run and
  records it in `confirmationRemindersSent`. Moving the deadline clears that
  list.
- **On the deadline:** the nightly sweep removes every `RESERVED` row on a run
  whose deadline has passed, through the existing exit path (audit row, RSVP
  clean-up). The household is told its place was released and that it may
  still enroll if a seat is left (Q21), and the leader and the Board get a
  summary.

Email templates, new keys in `lib/email-templates/registry.ts`:

| Key | Sent | Tokens |
|---|---|---|
| `program.reservation.changes` | nightly, when a household has unsent notices | `{{changes}}` (one line per person: reserved / moved / released, with run, price, deadline), `{{link}}` |
| `program.reservation.reminder` | each scheduled reminder | `{{programName}}`, `{{people}}`, `{{price}}`, `{{deadline}}`, `{{daysLeft}}`, `{{link}}` |
| `program.reservation.released` | at the deadline | `{{programName}}`, `{{people}}`, `{{link}}` |
| `program.ongoingNoNextRun` | to the Board, weekly from 30 days before an ongoing run ends with no next run | `{{programName}}`, `{{endDate}}`, `{{link}}` |

## 8. Security and routes

Each a registry entry before its route (boundary isolation):

| Route | Who |
|---|---|
| `POST api/programs/[id]/next-run` | Board, sysadmin |
| `POST api/programs/[id]/reservations` (one person, or the carry-over list) | the run's program leader or administrators; Board, sysadmin |
| `GET api/programs/[id]/carry-over` (previous roster with verdicts) | the run's program leader or administrators; Board, sysadmin |
| `PATCH api/programs/[id]` gains `confirmationReminderDays` | the run's program leader; Board, sysadmin |
| `DELETE api/programs/[id]/reservations/[personId]` (unreserve; `RESERVED` rows only) | the run's program leader or administrators; Board, sysadmin |
| `GET/POST/DELETE api/programs/[id]/administrators` | the run's program leader; Board, sysadmin |
| `POST api/programs/[id]/reservations/[personId]/confirm`, `/decline` | the person (adult) or their household lead |
| `PATCH api/programs/[id]` gains `reservationsEnabled` | Board, sysadmin |
| `PATCH api/programs/[id]` gains `ongoing` | Board, sysadmin |
| `PATCH api/programs/[id]` gains `confirmationDeadline` | Board, sysadmin |

`reservedById`, `reservedAt`: `personal`, the roster's tier. A leader's grant on
the carry-over route reads the previous run's roster only through the link of a
run they lead. The confirm route reads the caller's household from the DB, as
the roster gate does.

## 9. Build order

Each line is one PR. `[mig]` migration, `[sec]` boundary-only, `[app]` feature.

1. `[app]` P9 copy (#156): copy a program, no price.
2. `[mig]` `Program.previousRunId`, `Program.ongoing` and `ongoingReminderSentAt`, the reservation columns, the two
   `ProgramParticipant` columns, `ProgramAdministrator`, `ReservationNotice`,
   and `RESERVED` added to the enum. Additive. It ships a release ahead of
   anything that writes `RESERVED`: an old task in the drain window that reads
   a `RESERVED` row fails on the unknown enum value.
3. `[app]` Every `status` reader handles `RESERVED` (§5). No writer yet.
4. `[sec]` The `programsAdministered` claim and resolver case, the
   `ProgramAdministrator` scope binding, registry entries for the routes in §8,
   administrators admitted to the people picker, and the administrators'
   `returns:` bag (contact details) on the roster route.
5. `[app]` "Start next run", the Board's switch, the deadline and reminder
   schedule with their gates and warnings, administrators, reserve (single and
   carry-over), unreserve, confirm/decline, the program-page panel, and the
   compliance dashboard changes (§4a), the ongoing checkbox.
6. `[app]` The nightly reservation summary (netting function and its tests),
   reminders and release in the nightly sweep; the ongoing-run Board reminder;
   the four email templates.
7. Once 1–6 have merged: open a GitHub issue for a one-step "move to team"
   action (Q26 option b): `POST api/programs/[toId]/reservations` with a
   `fromProgramId`, both program rows locked in id order, the target's capacity
   and reservation checks, one "moved" email; roughly one registry entry and a
   300–500-line feature PR.
8. `[app]` Household archive refusal for administrators: `archiveRefusal`
   (`lib/household/archiveAction.ts`) refuses while a member is a program
   administrator of a program in the current or a future membership year, as it
   already refuses for program volunteers and leaders. It lands after step 2 and
   no later than step 5, so the archive never misses an administrator.

Issue references: step 1 closes #156; the last of steps 2–6 and 8 closes #1248; every
step mentions #1235 without closing it (Q22).

## 10. Open questions

Numbers are fixed; a settled question is struck, not renumbered.

| # | Question | Default if unanswered | Example |
|---|---|---|---|
| ~~Q1~~ | ~~Identity.~~ **Decided:** a `previousRunId` link on today's model; no splits. | — | — |
| ~~Q2~~ | ~~Who returns, and the window.~~ **Decided:** `ACTIVE` and `PENDING` carry, withdrawn may be ticked in; the window is the program's shared confirmation deadline (§4). | — | — |
| ~~Q3~~ | ~~Too many returning.~~ **Decided:** the leader unticks to fit, or asks the Board to raise capacity; carry-over refuses while too many are ticked; no automatic ranking (§5). | — | — |
| ~~Q4~~ | ~~Lapsed membership on a members-only run.~~ **Decided:** reserve anyway; confirm is refused until membership covers the year (§5). | — | — |
| ~~Q5~~ | ~~Leader and volunteers on the copy.~~ **Decided:** copy the leader, administrators, core and ordinary volunteers as they stand; lapses go to the audit screen, never removal (§4, §4a). The treasurer is the budget bucket's and needs no copy (Q30). | — | — |
| ~~Q6~~ | ~~Scholarships and payment plans.~~ **Decided:** never carried; the family asks again on the new run after confirming (§6). | — | — |
| ~~Q7~~ | ~~List opt-outs.~~ **Decided:** keyed on the list address in the membership-sync design, not the chain; yearly handling is option C (a once-per-membership-year rejoin email plus a Board action to record a person's choice with a note), team lists and members list only (§3). | — | — |
| ~~Q8~~ | ~~Claim-first dependency.~~ **Moot:** a reservation counts in the app's count as any claim does. | — | — |
| ~~Q9~~ | ~~Who starts the next run.~~ **Decided:** the Board creates and prices it; the leader carries people over. | — | — |
| ~~Q10~~ | ~~Pricing under P1.~~ **Settled by Q1.** | — | — |
| ~~Q11~~ | ~~Segment shape.~~ **Decided:** one after another, one chain. | — | — |
| ~~Q12~~ | ~~Who returns into a new year.~~ **Decided:** the previous run's roster only. | — | — |
| ~~Q13~~ | ~~Who owes for a carried place.~~ **Decided:** nobody, until the family confirms (§6). | — | — |
| ~~Q14~~ | ~~Emergency contact.~~ **Settled with Q15:** checked at confirmation. | — | — |
| ~~Q15~~ | ~~A leader creating enrollments.~~ **Decided:** a leader may reserve (including their own household) on a run the Board has switched on; every reservation needs the family's confirmation by the shared deadline. | — | — |
| ~~Q16~~ | ~~Reminder schedule.~~ **Decided:** set per program by its leader; a run with reservations on cannot open or go on sale until it is set (§4). | — | — |
| ~~Q17~~ | ~~Who sets the deadline.~~ **Decided:** the Board and the program leader both set it; latest edit stands, no override. **Held by Q28's default:** until the Board answers Q28, only the Board sets it (§4). | — | — |
| ~~Q18~~ | ~~Moving the deadline or switching off.~~ **Decided:** switching off refused while reservations exist; only the Board moves the deadline while any are outstanding; warnings on a past date and on skipped reminders (§4). | — | — |
| ~~Q19~~ | ~~What a reserved person is.~~ **Decided:** on the roster marked reserved; may check in at the kiosk; may sign up for sessions (§5). | — | — |
| ~~Q20~~ | ~~Reserving beyond carry-over.~~ **Settled by Q26:** anyone the existing people picker returns; administrators added to it (§5). | — | — |
| ~~Q21~~ | ~~Release notice.~~ **Decided:** the family is told (`program.reservation.released`), and the leader and the Board get a summary (§7). | — | — |
| ~~Q22~~ | ~~Relation to #1235.~~ **Decided:** the implementation PRs mention #1235 without closing it; it stays open for a family-side hold. | — | — |
| ~~Q23~~ | ~~Reminder schedule details.~~ **Decided:** required before the first reservation as well as before opening; never empty; copied by "Start next run" but must be saved again (§4). | — | — |
| ~~Q24~~ | ~~Program administrators.~~ **Decided:** appointed by the program leader; same requirements as a leader; copied by "Start next run" (§5). | — | — |
| ~~Q25~~ | ~~What an administrator sees.~~ **Decided:** previous and current rosters; reserved, confirmed, paid/unpaid, contact details, never how anyone pays; administrators, leader and Board may unreserve; leader and Board appoint and remove (§5). | — | — |
| ~~Q26~~ | ~~Moving people between teams.~~ **Decided:** (a) reserve on the new team, then unreserve on the old; a GitHub issue for (b) is opened once the design is built (§5, §9 step 7). | — | — |
| ~~Q27~~ | ~~Telling the family about an unreserve.~~ **Decided:** no immediate emails; a nightly per-household summary of net changes from a notice table (A → B → C same day reads "moved from A to C"); late reservations warned, never refused (§7). | — | — |
| Q28 | **Board: deadline vs budget approval.** May a leader move the confirmation deadline after the Board approves the program's budget, or is it fixed in that approval? Put to the Board. | **No, for now (owner):** only the Board sets and moves it | Championships results land late; the leader asks the Board to move the deadline a week. |
| ~~Q29~~ | ~~Team lists for reserved people.~~ **Decided:** someone carried over from the previous run stays on the team list in any state (reserved, confirmed, paid); if declined or released they stop counting on the new run and leave the list when the run they are on ends or hands over (a family declining Fall Training 2027 in July while on Summer 2026 stays on through Summer); someone new to the chain joins only once paid (`ACTIVE`, or a free place). A requirement on the membership-sync design. | — | — |
| ~~Q30~~ | ~~Treasurer.~~ **Decided:** the policies' "program treasurer" is the budget bucket's treasurer in the software. The bucket outlasts every run, so the copy has nothing to carry; no program-to-bucket link is added. | — | — |
| Q31 | **Board: who sees lapsed staff checks.** The Board's compliance dashboard already lists them. Should a program leader also see their own runs' staff (volunteers, administrators) whose check has lapsed, name and "check lapsed" only? A balance of privacy and security; put to the Board. | **No, for now (owner):** Board only until the Board answers | A core volunteer's check lapsed in October; the Fall Training leader sees it on their program page and reminds them. |
| ~~Q32~~ | ~~Ongoing checkbox.~~ **Decided:** Board only, from the approved budget template; "Start next run" copies it; the Board is reminded from 30 days before an ongoing run ends while it has no next run, then weekly (§3). | — | — |
| ~~Q33~~ | ~~Administrators on the mentor list.~~ **Decided:** a program's administrators are on its mentor list with its leader and core volunteers: the mentors list where the sync models one, else the staff part of the team list. A requirement on the membership-sync design. | — | — |
| Q34 | **Which lists Q29 governs.** The list-sync engine (#3902) proposes four lists per program: participants, parents, mentors, external. Q29's carry-over rule is written for one team list. Does it govern the participants and parents lists (a reserved child keeps their household lead on the parents list), with mentors following the staff copy and external contacts outside the chain? | None; waits on the owner | A child carried over to Fall Training 2027 is still `RESERVED` in August; is their parent on the parents list? |
