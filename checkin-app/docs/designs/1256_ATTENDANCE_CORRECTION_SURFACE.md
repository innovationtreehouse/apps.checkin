# Attendance / Visit / Hour Correction Surface

**Backlog:** AT3 (visit management for staff) + AT5 (user self-correction of own
hours) + AT12 (admin correction-review screen), designed as **one** surface.
AT13 (visit-edit UI/API gate mismatch) falls out of the permission matrix and is
answered here.

**Status:** implemented, except where marked. AT5 ships in
[#1357](https://github.com/innovationtreehouse/checkin/pull/1357); AT3 (#1254) stacks on it —
household-lead correction, staff insert-for-others, the program-lead tombstone
+ audit, and the `VisitSource` split. AT13 landed separately in
[#1350](https://github.com/innovationtreehouse/checkin/pull/1350). **Still open:** dropping the
legacy `SYSTEM` enum value (§3, contract stage). AT12 (§4) has since shipped,
and the `isOperations` gate decision (§6.1) is **answered** —
[#1633](https://github.com/innovationtreehouse/checkin/pull/1633) keeps operations' reach into
attendance aggregate-only. The advisory-lock work tracked as §7 has landed.
Sections below are written in the present tense and describe the code as it
stands; anything not built says so in its heading.

## Why one design, not three

All three sit on a single substrate: **a permission matrix over the visit-edit
model**. A `Visit` is the only stored attendance fact; "hours" are a *derived
read* over visit durations, never stored. So:

- **AT3** decides who may insert / edit / delete *whose* visits.
- **AT5** ("correct my hours") has no stored hours to write — it resolves to
  editing an underlying `Visit`. It is the `self` (and household-lead) row of the
  AT3 matrix plus the self-scoped edit path that does not exist today.
- **AT12** is the oversight half: corrections land only as `AuditLog` rows today;
  AT12 aggregates them. Its shape is determined by what AT3/AT5 write to the
  audit trail.

Designed apart, the matrix and the audit contract fragment. One doc.

## Terminology: the visit-source model

Every `Visit` records *how* its arrival and departure were captured, in
`arrivedVia` / `departedVia` (`VisitSource`). **Five** sources with
non-overlapping meaning, plus the retired `SYSTEM` they replaced (§3):

| source | on | meaning | departure accuracy |
|---|---|---|---|
| `SCANNER` | both | physical kiosk badge — **measured** | exact |
| `WEB` | both | dashboard / self-service entry — **self-reported** | member's own claim |
| `LEAD_MARKED` | both | staff asserted presence — a post-hoc roster mark that creates a **full** visit (arrival + departure at the event window), no badge involved | event window, not real |
| `FACILITY_CLOSE` | `departedVia` | the building closed (last keyholder badged out) while the member was still checked in — departure stamped at the **close moment** | plausible: bounded by building hours |
| `AUTO_CLOSE` | `departedVia` | the nightly cron swept an abandoned open visit — departure stamped at **cron-run time** | poor: the member may have left hours earlier |

Domains: `arrivedVia ∈ {SCANNER, WEB, LEAD_MARKED}`,
`departedVia ∈ {SCANNER, WEB, LEAD_MARKED, FACILITY_CLOSE, AUTO_CLOSE}`.

`LEAD_MARKED` is not arrival-only: marking someone present has no badge times, so
the writer fabricates a **closed** visit stamping *both* fields (a null departure
would mark it "open" and trip the nightly auto-checkout + the one-open-visit
index). Both fields are staff assertions, so both read `LEAD_MARKED`.

**These three replaced one overloaded `SYSTEM`**, which collapsed the post-hoc
roster mark, the keyholder building-close sweep, and the nightly-cron sweep into
a single value. Splitting `FACILITY_CLOSE` from `AUTO_CLOSE` is **not cosmetic** —
no checkout path writes a `Visit` audit row, so `departedVia` is the *only*
record of how a visit closed, and the two machine closers have opposite accuracy
(see §2). A two-name rename would have fused them permanently; the third value is
what lets the board tell "the building closed while you were badged in" from "you
were still badged in at midnight", and lets the significance flag treat their
corrections differently. `LEAD` is the accepted umbrella — the roster-mark gate is
lead-mentor OR sysadmin/board/keyholder, and there is no "staff" concept in this
codebase's vocabulary. §3 has the migration, the legacy mapping, and why `SYSTEM`
is still in the enum.

---

## The write surface

Every route that can create, change, or erase a `Visit`.

### Self-insert own past visit
`POST /api/attendance/manual`
([route.ts](../../src/app/api/attendance/manual/route.ts))
- The subject is resolved server-side by `visitSubject`
  ([lib/visit/scope.ts](../../src/lib/visit/scope.ts)): yourself always, and — as
  a household lead — any member of your own household. A `personId` in the body
  is only ever a target checked against the actor's household, never the scope
  itself; a non-lead naming a household peer is a 403.
- Backdate allowed arbitrarily far; future arrivals rejected past a 5-min skew
  clamp. Open (no-departure) backfill restricted to today / last 6h.
- Per-person advisory xact lock + one-open-visit re-check — same race guard as
  `/api/scan`, keyed on the **subject**.
- Audit `CREATE` on `Visit`, `newData.type = "manual_entry"`,
  `secondaryAffectedEntity` = the subject (§6.6).
- `arrivedVia = "WEB"` marks it self-reported, not measured.

The route's header comment states the posture explicitly: arbitrary backdate is
accepted on purpose, self-reported hours are **not a security boundary**, the
board reconciles against the audit trail. That posture anchors the AT5 model.

### Self- and household-lead EDIT / DELETE
`PATCH`/`DELETE /api/attendance/manual/[id]`
([route.ts](../../src/app/api/attendance/manual/[id]/route.ts)) — the AT5 gap,
widened by AT3 to the household-lead scope. Same `visitSubject` check, reached
through the visit's `personId`; out-of-scope and tombstoned both read as 404, so
there is no existence oracle on other people's visit ids. Delete is a tombstone
(below). See §2 for the model and §3 for the proxy weighting.

### Staff edit — facility-wide
`GET/PATCH/DELETE /api/facility/visits`
([route.ts](../../src/app/api/facility/visits/route.ts)) gate
`roles: ['isSysadmin', 'isBoardMember']`.
- `PATCH` edits `arrivedAt`/`departedAt`, re-validates order + 24h max, forbids
  reopening a closed visit, audit `EDIT`.
- `DELETE` tombstones (it hard-deleted before AT5), audit `DELETE` with the
  pre-delete row in `oldData`.
- The UI page gate matches the API gate — `useRequireRole(['isSysadmin',
  'isBoardMember'])`. The two sets drifting apart was AT13, fixed in
  [#1350](https://github.com/innovationtreehouse/checkin/pull/1350); §1 defines the target
  they must stay aligned to.

### Staff insert-for-others at an arbitrary past time
`POST /api/facility/visits/insert`
([route.ts](../../src/app/api/facility/visits/insert/route.ts)), same gate. The
walk-in path neither the kiosk (live only) nor an attendance correction
(program-scoped, one session) can record.
Unlike the self-service route, the target `personId` **is** taken from the body —
that is the point of the endpoint — so the role gate is the whole boundary.
Closed visits only: an open one would put someone on the live in-the-building
roster on staff say-so and leave a visit nobody will badge out of.

Its own path rather than a `POST` on the sibling collection: adding a verb to an
existing legacy route file cannot satisfy the security lints in any PR ordering
(registry-first trips `orphan-registry`, route-first trips
`new-route-old-authz`, both together trip boundary isolation). A new path is the
register-first state `orphan-registry` already warns for. Tracked as
[#1491](https://github.com/innovationtreehouse/checkin/issues/1491); if that is fixed the
endpoint can fold back onto `/api/facility/visits`. Advisory-lock
wrapped, `WEB` on both fields, event association via `findAssociatedEventAt`,
audited with `secondaryAffectedEntity` = the subject.

### Lead add-for-others / attendance correction — program-scoped
One route, gated on program `leadMentorId`, core volunteer, or sysadmin/board.
Targets are restricted to the program roster (enrolled + volunteering); anyone
else is rejected — no cross-program fabrication.
- `PATCH /api/events/[id]`, action `manualEditAttendance`
  ([route.ts](../../src/app/api/events/[id]/route.ts)) — per-participant
  Present/Absent correction, scoped to this event's visits. Present writes or
  updates a visit; Absent **tombstones** (it hard-deleted before AT3) and refuses
  outright when the participant has an open visit, since that row is the live
  proof they are on-site. Both branches now write an audit row —
  `newData.type = "lead_attendance_correction"` — which they did not before.

`/api/scan` ([route.ts](../../src/app/api/scan/route.ts)) is `withKiosk`,
live-only, `personId` from the badge — not a staff-for-other path.

### Hours — derived read, source-independent
`GET /api/facility/trends`
([route.ts](../../src/app/api/facility/trends/route.ts)), gate sysadmin/board.
Hours = `Σ (departedAt − arrivedAt)` over visits, bucketed. Every completed visit
counts toward facility hours whatever recorded it — a roster mark is facility
time the same as a badge scan. Source governs how a correction is weighed and
reviewed, not whether the visit is counted. The exclusions are structural: an
open visit has no duration to sum, and a deleted visit did not happen. No
stored-hours column exists; the only thing to correct is the underlying visits.

### Audit substrate — already present
`AuditLog` (schema line 1083): `actorId`, `action` (CREATE/EDIT/DELETE),
`tableName`, `affectedEntityId`, `secondaryAffectedEntity`, `oldData`, `newData`.
A generic viewer exists at `/system-status/audit-log` (gate **isSysadmin-only**),
filterable by `tableName`/`action`/date. This is AT12's foundation (§4).

Audit coverage across visit-write paths: **every human edit path logs** a `Visit`
audit row — manual `CREATE`, the self/household-lead `EDIT`/`DELETE`,
`facility/visits` `EDIT`/`DELETE`, the staff insert, `manualEditAttendance`, and
`my-programs/conflicts/resolve`. Each carries
`actorId` = who acted and `secondaryAffectedEntity` = whose visit it is, so
acting-for-another reads off the inequality without a join (§6.6).
`manualEditAttendance` was the one gap — it wrote nothing at all — closed by AT3.

The participant **merge** (`membership-ops/.../merge`) is deliberately not on
that list. It re-parents visits with `updateMany` and audits `Person` and
`OrgMembershipProcess`, never `Visit`: a merge changes who owns an attendance
fact, not the fact itself, so it is an identity operation rather than a
correction and AT12 should not surface it as one.

The automated / baseline paths do **not** log — kiosk `scan`, the `attendance`
check-in (writes only a `SYSTEM_NOTIFY` row), and **both** machine closes
(`FACILITY_CLOSE` via `closeAllOpenVisits`, `AUTO_CLOSE` via
`processVisitCheckout`). That the closes are unaudited is exactly why
`departedVia` must carry the close provenance itself — it is the only record of
how a visit closed. Those paths aren't corrections, and AT12 aggregates
corrections, so leaving them unaudited is fine.

### Roles available
`BusinessRole = isSysadmin | isBoardMember | isKeyholder |
isBackgroundCheckReviewer | isOperations`
([types/auth.ts](../../src/types/auth.ts)). Program-lead is per-program
(`event.program.leadMentorId`). Household-lead is a household-leadership relation,
**not** a `BusinessRole` flag. `isOperations` exists but is not on any visit-edit
gate today.

---

## 1. Permission matrix

Rows = actor, cols = action. "own" = `personId === actor`; scope words name the
target set the actor may act on. The **correct-hours** column always resolves to
editing an underlying visit — there is no separate hours write.

| actor | insert own-past | insert for-others | edit a visit | delete a visit |
|---|---|---|---|---|
| **self** | ✅ `personId` forced self | ⛔ never another person | ✅ own visits — any field; significant changes flag (§2) | ✅ own visits (tombstone; delete flags) |
| **household-lead** | ✅ (as self) | ✅ own household members | ✅ household members' visits, same as self | ✅ household members' visits (tombstone) |
| **program-lead** | ✅ (as self) | ✅ program roster (synthetic mark at event window) | ✅ visits associated to their program's events (`manualEditAttendance`) | ✅ same program-event scope (tombstone) |
| **ops** (`isOperations`) | ✅ (as self) | ⛔ not another person's record ([#1633](https://github.com/innovationtreehouse/checkin/pull/1633)) | ⛔ not another person's record | ⛔ not another person's record |
| **board** | ✅ (as self) | ✅ facility-wide | ✅ facility-wide | ✅ facility-wide (tombstone) |
| **sysadmin** | ✅ | ✅ facility-wide | ✅ facility-wide | ✅ facility-wide (tombstone) |

✅ = allowed, built · ⛔ = deny by design

**Enforcing boundaries:**
- The self / household-lead scope is one server-side resolution,
  `visitSubject(actorId, subjectId)`
  ([lib/visit/scope.ts](../../src/lib/visit/scope.ts)): self always, plus your
  own household's members if you are its lead. The household comes from the
  actor's own row, so a `personId` off the body is only ever a target checked
  against it. A non-lead naming a household peer is denied, and so is a lead
  reaching into another household — leadership, not membership, is the grant.
- Self / household-lead edits are **not gated** by the value's source — the
  source only weights significance for post-hoc flagging (§2). The only edit-time
  checks are validity (no future times, departure after arrival, ≤ 24h).
- The open-visit facility guard follows the **subject**, not the actor. An open
  backfill asserts the subject is in the building now, so it obeys the same
  keyholder-first rule as `/api/scan`: a keyholder parent cannot open the
  building by backfilling an open visit for their non-keyholder child. Self keeps
  reading the session claim (unchanged behaviour, and the claim derives from the
  Person row anyway); the proxy case reads the subject's row. Closed backfills
  are historical and never gate.
- program-lead scope = roster membership (the enrolled + volunteering set the
  events route already computes) **and** the visit's `associatedEventId`
  belonging to that program.
- board / sysadmin facility-wide = the `withAuth` role gate on the route.

### AT13 — answered (fixed in PR #1350)
The matrix puts board at **allow** for edit + delete, and the API already granted
it, so board needed the edit UI. The fix aligned the page gate to the API gate:

```
useRequireRole(['isSysadmin'])                      // was — wrong, dropped board
→ useRequireRole(['isSysadmin', 'isBoardMember'])   // matches the API
```

The rule that outlives the fix: **the two role sets must stay equal.** AT13 was
precisely "they drifted apart", and this matrix is the single source that
re-couples them. Ops is not added — [#1633](https://github.com/innovationtreehouse/checkin/pull/1633)
keeps one person's record outside operations' reach — but the rule holds for any
future widening: the same set widens on both the route (`withAuth roles`) and
the page (`useRequireRole`) together.

---

## 2. AT5 — self-correction model

**Model: trust-first. A member edits or deletes any of their own visits directly
— no permission ask, no justification required. Integrity comes from post-hoc
oversight: the system *flags significant changes* to the board (and, for another
person's observation, potentially that observer) for async review. Nobody is
blocked; big changes are simply made visible.**

This is the posture the codebase already takes — the manual-insert route's own
comment: self-reported hours are *not a security boundary*, the board reconciles
against the audit trail. People act in good faith; the rare bad or mistaken edit
is caught by review after the fact, not by a gate in front of everyone.

Rejected alternatives:
- **Append an `AttendanceAdjustment` record.** The original is already preserved:
  `AuditLog.oldData` snapshots every pre-edit state, and the source enum marks
  self-reported vs measured. An adjustment table duplicates the audit trail and
  forces `trends` to sum visits *plus* overlays — more model, more read
  complexity, no new information.
- **Per-field locks + a request/approval queue.** Gating good-faith edits behind
  staff sign-off is the wrong tone and wastes human time: nobody should review a
  15-minute nudge, and a *required* "reason" reads as distrust — like asking why
  a plate broke and being told "gravity." Non-answers, friction, no signal.
  Replace the gate with a **signal**: let the edit through, and flag it only when
  it's big enough to be worth a human's attention.

### The member's own visits are theirs to fix

Extend the self-service surface from INSERT-only to INSERT + EDIT + DELETE,
scoped to the member's own visits (and, for a household-lead, their household
members' — §3). **No field is locked.** A member can correct a `SCANNER` arrival,
an `AUTO_CLOSE` departure, or a `LEAD_MARKED` visit alike — the source of the
value they're changing does not gate the edit, it only weights how significant
the change is (below). No reason field.

### Significance: what gets flagged

A change is scored **after** the edit lands, when the change is large *relative
to how authoritative the value it overwrote was*. Two inputs:

- **Source trust-weight** — how much we trust the old value. Highest for
  `SCANNER` (a physical measurement), then `LEAD_MARKED` (another person's
  observation of the member), then `WEB` (the member's own prior self-report).
  Lowest — effectively *expected to be wrong* — for the machine closes
  `FACILITY_CLOSE` and `AUTO_CLOSE`: those are placeholder departures the member
  is *meant* to fix. Editing your own self-report is nearly free; overwriting a
  measurement or someone else's observation is where scrutiny belongs.
- **Magnitude** — the size of the change in counted hours / minutes shifted. A
  small delta is noise; a large one moves the numbers.

**significance ≈ magnitude × source-weight**, over a threshold. A delete has a
**floor** — erasing a record is inherently notable even at low weight, so a
member deleting a visit they themselves submitted still surfaces (we want to see
that), and deleting a `SCANNER`/`LEAD_MARKED` visit flags strongly.

**The machine-close exception (why the third enum value earns its keep).** A
correction to a machine-stamped departure is expected *by construction*, so
magnitude alone would invert the intent — `AUTO_CLOSE` (cron) stamps at cron-run
time, so the member's real leave can be hours earlier and the correction is
**large**, which under a plain magnitude rule would fire the *loudest* alert for
the *least* trustworthy guess. That is backwards. Because `departedVia` now
distinguishes the two closers, the rule is expressed on the **source**, not the
size: **a correction whose overwritten departure was `AUTO_CLOSE` or
`FACILITY_CLOSE` does not flag on magnitude** — we already know that time was a
placeholder. (`FACILITY_CLOSE` corrections are small anyway — bounded by building
hours — but keying on the source, not the delta, is what makes the `AUTO_CLOSE`
case correct.) Fixing a machine close is the happy path, never a board alert.

| change | weight of old value | flagged? |
|---|---|---|
| +5 min on own `WEB` arrival | low | no — noise |
| fix an `AUTO_CLOSE` (cron) departure to the real leave time | machine placeholder | **no — source-suppressed, even a 10 h correction** |
| fix a `FACILITY_CLOSE` departure | machine placeholder | no — source-suppressed (and small anyway) |
| shift a `LEAD_MARKED` visit by 15 min | high | no — small delta, not worth a human |
| move a `SCANNER` arrival 2 h earlier | high | **yes** — overwriting a measurement, big delta |
| delete a `LEAD_MARKED` or `SCANNER` visit | high | **yes** — strong |
| delete an own submitted `WEB` visit | low | **yes** — delete floor: we should see it |

### Acting for someone else weighs double

A household lead editing a member's visit is itself a flag input — an adult
changing another person's record — so the score is multiplied by 2 when the actor
is not the visit's person. The `WEB` flag threshold therefore halves in practice:
a 50-minute nudge on your own self-reported arrival is noise, the same nudge on
your child's record reaches the board.

A **multiplier**, not a floor, and not a second weight table. A floor would flag
every proxy edit including a two-minute typo fix — the "required justification
reads as distrust" failure this section rejects. A second table doubles the
tuning surface to encode one bit. The multiplier composes with the existing axes
and stays one constant to calibrate.

The interaction that decides it: **multiplicative means source suppression
survives.** A machine-close weight of 0 stays 0 when doubled, so a lead fixing
their child's `AUTO_CLOSE` departure — cron stamped midnight, the child left at
4pm, an eight-hour correction — still never flags. An additive proxy weight would
make that happy-path fix the loudest alert in the system, the exact inversion
this section warns against.

### Calibration

Weights and threshold are v1 defaults awaiting board calibration — the right
cutoffs are a judgment against real volume. They live as constants in
[lib/visit/significance.ts](../../src/lib/visit/significance.ts); promote them to
BoardSettings when AT12 gives the board a place to calibrate from (§6). The
machine-close suppression is a source rule, not a threshold, and is not a knob.

### Mechanics (reuses what exists)
`PATCH`/`DELETE /api/attendance/manual/[id]`, scoped by `visitSubject` (§1).
- Reuses the existing validation helpers (`parseVisitTime`,
  `departureAfterArrival`, `withinMaxDuration`) and the advisory-lock +
  one-open-visit guard from the sibling `POST`. The lock and every `where` key on
  the **visit's person**, not the actor — that is the key the one-open-visit
  invariant is per, so a lead's edit serializes against the member's own kiosk
  scan. Scope and liveness are re-asserted *inside* the lock, so a delete that
  lands mid-flight cannot have its tombstone overwritten.
- The edit **always applies** (subject only to those validity checks — no
  future times, departure after arrival, ≤ 24h, no reopening a closed visit).
  No source gate, no approval.
- An edit that CLOSES an open visit routes through `processVisitCheckout` rather
  than a bare update, so back-to-back event chunking still happens; the audit row
  and the response name a chunk that survives.
- Delete is a **tombstone**, not a row removal (§3) — so a flagged delete is
  reviewable *and* reversible. `deletedById` records the actor, which for a
  household-lead delete is the lead, not the member.
- Computes `significance(old, new, { byProxy })`; if over threshold, fires a
  fire-and-forget board email — never blocking the member's response. The actor's
  name is HTML-escaped into it: a self-editable profile name is untrusted markup
  in the board's inbox.
- Audits `EDIT`/`DELETE`, `actorId` = the acting user,
  `secondaryAffectedEntity` = the subject, `newData.type = "self_correction"`,
  plus the significance object so AT12 can filter to the flagged ones without
  re-deriving (§4).

### Which paths email the board

The real-time board email fires on the **self and household-lead** corrections
only (`attendance/manual/[id]`). The staff and lead paths — `facility/visits`
`PATCH`/`DELETE`, `manualEditAttendance`, `my-programs/conflicts/resolve` —
deliberately do **not** email, for two reasons:

- **The delete floor would make it noise.** `deleteSignificance` always flags, by
  design: a member erasing their own visit should always be seen. But marking a
  roster Absent, or resolving a duplicate-visit conflict, is a lead's routine
  weekly workflow, not an anomaly. Wiring the floor into those paths emails the
  board on every ordinary correction, which trains everyone to ignore the alert
  and costs the signal its whole value.
- **On `facility/visits` the actor is the recipient.** That route is gated to
  sysadmin/board, so a flag would be the board notifying itself.

This costs AT12 nothing, but not for the reason first given here. The original
argument was that the screen **recomputes** significance from the audit row's
old/new values, making the persisted object a filtering convenience. That is no
longer how it works: every edit and delete path persists `newData.significance`,
and the review screen **reads** it. A stored value is also the only form the
database can filter on, which is what lets the default view page at all.

Two row shapes cannot be recomputed — `facility/visits` edits written before the
`oldData` fix stored no before-state — but recompute is not the fallback for
them either. They are simply unscored, and the screen says so rather than
showing a zero.

If the board later wants leads' corrections in the live feed, the lever is the
recipient set (§6.3) plus a per-path threshold — not the delete floor.

### Who gets flagged (scope — decision owed)
Default recipient: **board**. For a `LEAD_MARKED` change, the lead who made the
observation is a natural additional recipient — their assertion is being
overwritten. Ops may want facility-wide visibility. The exact recipient set per
change-type is an open decision (§6) — the mechanism (a fire-and-forget notify +
an AT12 lens) is the same regardless of who's on the list.

### No new model
The flag is a **notification + an AT12 filter**, not a workflow object.
Significance is computable from the audit row's old/new values, so AT12 recomputes
and filters "significant only" straight from the audit trail — no request table,
no PENDING/APPROVED state machine, nothing to approve. (If the board later wants a
reviewed/acknowledged worklist rather than just a feed, add a light ack state
then — YAGNI until they ask.)

**"Correct my hours" UI** resolves to: show the member their own visits (already
possible via the manual-entry surface); every field is inline-editable; a
significant save just goes through, with the score written quietly behind it.

### Abuse: it's audited, and the big moves are seen
The manual-insert route already accepts that a member can inflate their own
self-reported hours — they could already do it by inserting fictitious `WEB`
visits. Opening edits doesn't widen that ceiling; it just makes correcting a real
mistake as easy as making one. **No backdating time-cap** — the control is the
audit trail plus the significance flag, not a time fence:
- Every edit and delete is audited (`actorId`, `oldData`, `newData`).
- Large or high-trust-overwriting changes flag to the board in real time.
- Every visit carries its source: `WEB` self-reports are visibly `WEB` in the
  visits table (source icon), so hours stay reconcilable against how they were
  recorded even though all of them count.
- AT12 aggregates the flags, so a member whose edits flag often is a standing
  signal, not a buried audit row.

---

## 3. AT3 — staff visit management

AT3 is the non-`self` rows of the matrix.

- **Board / sysadmin facility-wide edit/delete** — `facility/visits`. The UI gate
  mismatch was AT13, fixed in #1350.
- **Household-lead act-for-members** — a household lead may insert / edit / delete
  visits for **anyone in their household**, self-serve and ungated exactly as
  `self`, with the same significance flagging (§2). The lead is the responsible
  adult, so this is self-equivalent for household members — notably minors, who
  cannot self-serve at all, and for whom this is the *only* correction path.
  Scope enforced server-side by `visitSubject`; audited with `actorId` = the lead
  and `secondaryAffectedEntity` = the member. The proxy weighting is §2.
- **Program-lead edit within their program** — `manualEditAttendance` on
  `PATCH /api/events/[id]`, which already owned the event scope and the
  lead/core-vol authz. Kept off the facility-wide route so the broad gate stays
  broad and the scoped gate stays scoped. AT3 brought it in line with the rest of
  the surface: its Absent branch tombstones instead of hard-deleting, and both
  branches write an audit row — previously it wrote none at all, the one human
  visit-write path that did not.
- **Insert-for-others at an arbitrary past time** — `POST /api/facility/visits/insert`
  under the staff gate. The target `personId` **is** taken from the body here,
  unlike the self-service route. Closed visits only (see "The write surface").

### Delete = tombstone (reversible), not hard-delete
A deleted visit stays knowable and reversible — a correction can be backed out.
`Visit` carries `deletedAt` + `deletedById`; every delete path is a soft-delete
update, and every read that feeds a user surface filters `deletedAt: null`
through `LIVE_VISIT` ([lib/visit/filters.ts](../../src/lib/visit/filters.ts)).
The one-open-visit partial index was recreated with `deletedAt IS NULL` in its
predicate — a tombstoned open visit must not block that person's next check-in
forever. A drift guard
([liveVisitDriftGuard.test.ts](../../src/__tests__/liveVisitDriftGuard.test.ts))
scans every `Visit`-query site and fails CI on a new unfiltered one.

### The `VisitSource` split
A **3-way** split — the three `SYSTEM` writers meant three different things, so
this was a per-writer edit, not a rename:

| writer | was | now |
|---|---|---|
| events-attendance roster mark (`POST /api/events/[id]/attendance`, since deleted) | `SYSTEM` (both fields) | `LEAD_MARKED` |
| keyholder building-close `closeAllOpenVisits` ([attendance/close.ts](../../src/lib/attendance/close.ts)) | `departedVia: "SYSTEM"` | `FACILITY_CLOSE` |
| nightly-cron sweep `processVisitCheckout` ([cron/nightly](../../src/app/api/cron/nightly/route.ts)) | `departedVia: "SYSTEM"` | `AUTO_CLOSE` |

`processVisitCheckout`'s `source` union carries the new value from the cron call
site; the SCANNER/WEB self-checkout callers are unchanged. Also updated: the
`SOURCE_META` UI map, the check-in email phrasing, and the `trends` filter (which
keys on `arrivedVia`, so the departure-side split does not reach it).

**Expand only.** `SYSTEM` stays in the enum. During a rolling deploy the previous
release serves traffic against the fully-migrated schema and still writes it from
all three paths above, so removing the value would fail every one of them for the
whole drain window. Dropping it is a follow-up release, once no deployed code can
write it — the one piece of this section not yet done.

Two migrations, and the shapes are deliberate:
- `20260803000000_visit_source_split_add` — three `ALTER TYPE … ADD VALUE`,
  **not** wrapped in a transaction, because Postgres forbids *using* a value in
  the transaction that added it. The statements are additive and idempotent, so a
  partial apply is harmless.
- `20260803000100_visit_source_split_backfill` — the row mapping, wrapped,
  because its two updates must land together.

**Legacy data.** `departedVia = "SYSTEM"` rows are *fused* history — the
discriminator between the two machine closers was never stored and cannot be
recovered. One case can: the roster mark is the only writer that puts `SYSTEM` on
*arrivedVia*, and it writes both fields together, so a `SYSTEM`/`SYSTEM` pair is
unambiguously a lead mark. Everything else falls back to `AUTO_CLOSE` — the
conservative "don't trust this departure" reading, which also leaves those rows
source-suppressed in §2 rather than flagging their corrections to the board.

| before | after |
|---|---|
| `SYSTEM` / `SYSTEM` | `LEAD_MARKED` / `LEAD_MARKED` |
| `SCANNER` / `SYSTEM` | `SCANNER` / `AUTO_CLOSE` |
| anything else | unchanged |

**What it bought.** Significance no longer has to *infer* a machine close for new
rows — the source says so outright. The inference branch survives for legacy
`SYSTEM` only, and dies with the value in the contract release.

**Not a security-boundary change**, despite touching a field whose values are
`public`: `classifications.ts` tiers *fields*, not enum values, so
`arrivedVia`/`departedVia` stay `public` whatever the value set is and the
generated file comes out byte-identical. `security-boundary-isolation.yml` fires
only on `src/security/**` (excluding `generated/`), the generator script, or a
genuine re-tier of an existing field. So this ships inside the AT3 PR rather than
its own.

---

## 4. AT12 — correction-review screen — *built in [#1560](https://github.com/innovationtreehouse/checkin/pull/1560) ([#1258](https://github.com/innovationtreehouse/checkin/issues/1258))*

**Surfaces** attendance corrections by **kind** (insert / edit / delete),
**actor class** (self vs proxy) and **time**, as a filterable feed carrying the
before-and-after of each change on the row. It sees corrections only — the
automated / baseline paths don't write `Visit` audit rows (that's fine; they
aren't corrections).

**Source:** `AuditLog` where `tableName = 'Visit'`. Everything already lands there
— manual `CREATE` (`type:"manual_entry"`), `facility/visits` `EDIT`/`DELETE`,
and the new self / household-lead `EDIT`/`DELETE` (`type:"self_correction"`).
No new model.

**Self vs proxy, cheaply:** don't join `AuditLog → Visit` (the visit may be
tombstoned; `personId` isn't on the audit row). Compare `actorId` against
`secondaryAffectedEntity`, which every visit audit write fills with the subject
person: equal is a correction of one's own record, different is one person
editing another's. `newData.type` does **not** answer this — it names the route
that wrote the row, so a household lead correcting a member's visit still writes
`type:"self_correction"`. It stays useful as a label on the row, never as the
axis.

**Significant-edit flags (§2) are the headline view.** The flag is **read** from
the persisted `newData.significance`, not recomputed at read time. One row shape
carries nothing to recompute from: `facility/visits` edits written before the
`oldData` fix stored no before-state. A persisted flag is also the only form the
database can filter on, which is what lets the default view paginate. The cost is that a stored score
freezes the thresholds in force when the row was written. This makes persisting
significance on **every** edit and delete path a requirement on the writers
(#1523) — a lens with an undeclared hole is worse than no lens, since "no flagged
corrections this month" would otherwise mean "the paths capable of the largest
corrections never score themselves". Rows that never scored are *outside* the
lens, not "reviewed and found insignificant". AT12's default lens is "flagged
changes" — big or high-trust-overwriting edits, and deletes — with the full
correction feed behind a filter. A member whose edits flag often is a standing
signal. This *is* the board-review surface; the write-time notification (§2)
is the push, AT12 is the pull.

**Audience:** board + sysadmin. Reviewing other people's corrections is one
person's record, so operations stay out ([#1633](https://github.com/innovationtreehouse/checkin/pull/1633)). The
existing `/system-status/audit-log` viewer is sysadmin-gated and buries visit
corrections among all tables — that is the "missed screen" AT12 exists to replace.

**Build:** a read-only route `GET /api/facility/corrections` over the
`tableName='Visit'` audit rows, plus a `facility-ops` page rendering a filterable
list. Reuse the existing audit-log route's shape (it already filters
`tableName`/`action`/date and resolves `actorId → name`) and pin
`tableName='Visit'` in the handler. Do not build a second generic audit browser.

**The gate is sysadmin + board, not ops.** The section gate
(`FACILITY_SECTION_ROLES` in [lib/facilityNav.ts](../../src/lib/facilityNav.ts))
admits operations for the two aggregate tools ([#1623](https://github.com/innovationtreehouse/checkin/pull/1623)),
but each tab carries its own roles and Corrections is `FACILITY_RECORD_ROLES` —
sysadmin + board. The route is gated to that same set, so the two stay equal:
granting ops the route while the tab filter keeps them off the page would
produce a role that can call the API and cannot reach a page — the AT13 defect
this design family exists to close.

**It cannot return a group-by aggregate.** The boundary stripper drops any bag
key that is not a model name, and copies only fields declared on that model, so
`buckets`, `total`, `page` and derived scalars like `kind` and `actorClass`
cannot cross it — a separate counts endpoint fails identically, because a count
is still not a model field. The route therefore returns model-shaped `AuditLog` /
`Person` / `Visit` entries, with the before/after times lifted out of the audit
blobs so they travel as the `personal`-tier `Visit` fields they actually are and
the raw blobs stay server-side. Kind, actor class and the range count are derived
client-side from what ships.

---

## 5. Interactions with adjacent backlog items

- **AT1 / AT2 (inference & ambiguity) — different problem, shared field.** AT1/AT2
  decide *which event* a visit associates to when events overlap (association is
  deterministic single-match today). This surface edits a visit's
  *times / existence / who*. The seam is `associatedEventId`: exposing it as an
  editable field lets AT2's "admin resolves the overlap" reuse the same `PATCH`,
  but ambiguity **detection + resolution** is out of scope here. Boundary:
  correction = "this visit is wrong"; ambiguity = "this visit's event is
  undecided."
- **AT6 / #300 (two-deep) — no coupling.** Two-deep is a live, real-time coverage
  check at check-out. Editing a *past* visit does not and should not retro-fire a
  historical two-deep evaluation; corrections don't recompute past violations.
  AT10 (unknown-DOB fails open) is a separate live-path bug.
- **AT9 / #254 (force-close race) — shared invariant.** The facility-close sweep
  (`closeAllOpenVisits`, writing `FACILITY_CLOSE`) is itself a bulk visit-write and
  shares this surface's substrate: the one-open-visit invariant + per-participant
  advisory lock. AT9 is a race where a check-in survives the close. The correction
  surface's single-visit writes must take the **same advisory lock** so a manual
  edit can't race the sweep. Both converge on one rule — **every visit write
  (self, staff, automated) goes through the advisory-lock + one-open-visit
  guard** — while keeping the single-edit and bulk-close code paths distinct.
  Every visit-write path satisfies that rule as of #1475 (§7).

---

## 6. Open questions

1. **Widen the `facility/visits` gate to `isOperations`? — ANSWERED: no.**
   [#1633](https://github.com/innovationtreehouse/checkin/pull/1633) puts operations'
   reach into attendance at aggregate only, and
   [#1623](https://github.com/innovationtreehouse/checkin/pull/1623) granted the two tools
   that follow from it (Participation Trends, Print ID Badges). The
   `facility/visits` gate stays `['isSysadmin', 'isBoardMember']` on both route and
   page. ([#1476](https://github.com/innovationtreehouse/checkin/issues/1476))
2. **Significance thresholds — the actual cutoffs.** Shipped as v1 constants in
   [lib/visit/significance.ts](../../src/lib/visit/significance.ts) — source
   weights 3 / 2 / 1 / 0, threshold 90 weighted minutes, proxy ×2. The numbers
   remain a board judgment: what delta on a `SCANNER` value should flag? Is
   own-`WEB` ever flagged short of a delete? Promote to BoardSettings and
   calibrate once AT12 shows real volume.
3. **Flag recipient scope.** Currently board only, for every flagged change. Per
   change-type: does a `LEAD_MARKED` overwrite also notify the observing lead?
   Does ops get facility-wide flag visibility? Still open; the mechanism is
   unaffected by the answer.
4. **Flag = feed or worklist?** v1 is a notification + an AT12 lens (no state). If
   the board wants to *track* "reviewed / acknowledged" per flag, add a light ack
   state (not a full approval model). Defer until asked.
5. **AT12 home — ANSWERED: the scoped route.**
   [#1560](https://github.com/innovationtreehouse/checkin/pull/1560) shipped
   `facility-ops/corrections` over `GET /api/facility/corrections`, not a rollup
   bolted onto the sysadmin-gated `/system-status/audit-log`.
6. **Exact self=actor proof in AT12.** ~~Marker-only~~ — **adopted.** Every visit
   audit write now sets `secondaryAffectedEntity` = the subject person, so
   self = `actorId === secondaryAffectedEntity` without a join, and a proxy
   correction is visible as the inequality.

---

## 7. Parallel work — landed

Both items here were **pre-existing** — neither introduced by AT3/AT5 — and both
have since landed on `main` in
[#1475](https://github.com/innovationtreehouse/checkin/pull/1475), independently of this
surface's PRs.

**The advisory-lock gap is closed.** `PATCH`/`DELETE /api/facility/visits` and
the whole `manualEditAttendance` branch now take the per-person advisory lock and
re-read visit state inside it, so §5's rule — *every* visit write, self, staff or
automated, goes through the lock plus the one-open-visit guard — holds across the
surface.

That also closed an audit-fidelity window AT3 would otherwise have left in the
Absent branch: it read the doomed visits, then tombstoned them and wrote their
audit rows from that snapshot. A visit someone else deleted in the gap was
correctly skipped by the `LIVE_VISIT`-filtered update but still got an audit row,
crediting this lead with a deletion they did not perform. Under the lock the rows
audited are exactly the rows tombstoned.

**The one-open-visit collision was real.** `manualEditAttendance`'s Present branch
looked up an existing visit scoped to `associatedEventId` while the
`Visit_one_open_per_participant` index is scoped to `personId` alone, so a
participant with an open *unassociated* walk-in, marked Present with a blank
departure, hit a unique violation surfacing as a bare 500. The fix adopts an
adoptable open visit into the event instead of writing a second one, and returns
a 400 naming the problem when the open visit belongs to another session.

---

## Security-boundary note

`Visit` fields are `@sensitivity:public`/`personal`; `AuditLog` is
`@sensitivity:internal`. The `facility/corrections` read exposes audit rows
(internal) — it must be a registered route with a tight select, and per the
boundary-isolation rule any registry/scope change ships in its own PR ahead of
the feature route. The `VisitSource` split is **not** a boundary change and
needs no isolated PR: `classifications.ts` tiers *fields*, not enum values —
`arrivedVia`/`departedVia` stay `public` whatever the value set is, so adding
values leaves the generated file byte-identical (verified), and
`security-boundary-isolation.yml` fires only on `src/security/**` (excluding
`generated/`), the generator script, or a genuine re-tier of an existing field.
It therefore ships inside the AT3 PR, as §3 says. The self-scoped
`PATCH`/`DELETE` writes only the actor's own (or a
household member's) `Visit` — no new sensitivity surface. The scope check
(`personId` = self or a household member, never from the body) is the security
invariant and belongs in the route, not the UI; the significance/flagging logic
is oversight, not an access boundary, so it never gates the write.
