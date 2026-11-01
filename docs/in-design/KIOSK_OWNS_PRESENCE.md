# The kiosk owns who is in the building

Design for the Board's rulings on B7 and B14. Research and design only; no app
code changes here. The owner reads this before any PR exists.

## Problem

Today four different places can say someone walked into or out of the
building: a badge at the door kiosk, the website's check-in and check-out
buttons, a program leader marking someone present, and staff editing a visit
that is still open. Each of them can also end someone's visit, and three of
them can close the building.

Because the website can change who is inside without anyone being at the door,
the kiosk's screen and the server's records drift apart. Most of the hard
check-in code exists to cope with that drift:

- The kiosk sends the time of the roster it last saw with every close, so the
  server can hold a one-badge close when the website checked someone in that
  the kiosk never showed: the keyholder is checked out, the building stays
  open, and the same badge again closes it.
- Every website path that ends a visit runs a "last keyholder" guard: a
  close / leave / cancel dialog with a five-minute single-use token, a choice
  of keyholder to hand the building over to, and an email to that keyholder.
- Every website path that starts a visit checks "is a keyholder already in?"
  and refuses otherwise, while the kiosk never refuses. Two rules for one
  question, and the Board was asked (B14) which one is right.
- The Board was also asked (B7) whether a website checkout of somebody else
  may close the building.

The rules that answer these questions take up most of the check-in rules
register, and the formal model found most of its bugs on these paths.

## Objective

The Board ruled on 2026-10-27 (B7 and B14 together):

1. The kiosk manages the building, and the website mirrors it.
2. The website keeps only two things: the 11 PM auto-close and the
   reconciliation screen. Signing in and out on the website goes.
3. Trust in-person scans. Never lose a scan. Someone who scans in at the kiosk
   shows as in, even with no keyholder present.
4. Simplify the kiosk as much as possible.

**How this design reads ruling 2.** "Only two things" is about the website's
check-in features: of everything the website does with attendance, exactly two
survive. The 11 PM auto-close, and the reconciliation screen, which is every
correction of a closed visit: the Board's visit edits and inserts, its
correction of a close's time, the flagged-scan review, members' and household
leads' own corrections (decision Q1), and program leaders' roster marks
(decision Q3). Nothing else in the website's check-in features stays. Person
merge is not a check-in feature: it is the people-records tool, and it moves
a merged person's visits along with everything else they own.

Once this is done:

- **Only the kiosk starts or ends a visit while it is happening.** The only
  other thing that ends visits is the 11 PM auto-close.
- **Only the kiosk closes the building**, and the 11 PM auto-close is the
  backstop when nobody did.
- **The website writes no presence.** Of the Board's two keeps, the 11 PM
  auto-close is the only writer of open visits besides the kiosk, and the
  reconciliation screen writes closed visits only.
- **The website reads.** It shows the roster the kiosk built, says "can't
  confirm" when it has not heard from the kiosk, and offers one place to fix
  past records after the fact.
- Everyone the 11 PM auto-close checks out is listed as checked out by it,
  linked to that close (the owner's 2026-10-25 ruling on forced exits stands).

## Executive summary

**Members and household leads** lose the Check In / Check Out button on the
home page and on the "Who's here" page. They check in by badging at the door.
They keep inserting, correcting and removing their own past visits (and a
lead, their household's), on closed visits only (decision Q1).

**Keyholders and the Board** lose website check-in, check-out, "force
checkout" and "close the building" from the website. A keyholder closes the
building at the kiosk, as today. If nobody closes, the 11 PM auto-close does.

**Program leaders** can no longer mark someone as in the building right now.
A "Present" mark records attendance at the session: it links to the kiosk
visit that covers the session, or else creates a closed visit for the
session's time (decision Q3).

**The kiosk** keeps doing what it does well: it saves every badge before
sending it, shows who it thinks is inside even offline, and decides the close
itself. It stops forwarding anything but page loads and roster reads from its
screen, and sheds the code that existed only to cope with website check-ins.

**What does not change:** a badge at the kiosk always checks the person in,
keyholder or not; a visit with no keyholder present is still marked "no
keyholder"; the web never shows the building as open on the strength of
no-keyholder visits; the web says "can't confirm the building's state" when
the kiosk has gone quiet; scans queued offline still apply at their scan time,
however late.

**Cost:** roughly 1,000 lines of server code and 150–250 lines of kiosk code
deleted, one small database migration (three columns dropped), one kiosk
release. Small additions, all from the model check: the nightly close is
always recorded, kiosk scan times are rebased on the server's clock, web edits
that overlap an open visit are refused, the web says "syncing N scans" while
the kiosk has a backlog, and the kiosk sends live only behind an empty queue.
One new filter on the reconciliation screen.

**Supersedes:** the owner's 2026-10-11 ruling that a keyholder can close the
building from the web, and Board B7 (who may close from the web for someone
else). Nobody closes from the web.

## Rules this relies on or changes

Register lines in `docs/rules/attendance-checkin.md`, by fate. Lines kept as
they are are not listed.

**Stay (the kiosk already behaves this way):** a close is one event; only a
keyholder closes; the kiosk's one-badge and two-badge close; nothing on the
web stops a kiosk close; a close never ends a later visit; open is derived
from a keyholder being in; a kiosk badge always checks in and no-keyholder
visits are marked; never lose a scan; the direction shown is the record; the
3-second repeat-read filter at the kiosk; late scans apply at scan time and
are flagged; a queued close applies however late; never blank; fail-closed
safety display; "can't confirm" without a kiosk heartbeat; the kiosk rests
only when the building is known empty; two-deep math stays on the server; the
kiosk's minimal names.

**Go, because the path they govern goes:**

- "The kiosk's view decides a one-badge close, but not past a check-in the
  kiosk could not have known of" — nothing but the kiosk checks anyone in, so
  there is no such check-in. Delete the hold and its review flag.
- "A web close is the keyholder confirming in a dialog…" and the whole web
  close-guard block (close / leave / cancel, token, handover naming, handover
  email, "removing an open visit never closes", names shown with the choice).
- "On the web only the keyholder checking themselves out, or a board member who
  holds keys, closes the facility" — nobody closes on the web.
- "Every other way of checking someone in … still needs a keyholder already
  present" (the facility-open guard) and the household-lead "open (still
  here)" visit line — no website path opens a visit any more, so there is
  nothing to guard.
- "A kiosk too old to send a close decides it from the keyholder's check-out"
  — the door runs v1.2.7 (protocol 7); confirm on the kiosk-version status
  page before deleting.
- The server-side 3-second check "for callers that do not filter (older kiosk
  builds and the web)".
- "A correction that closes an open visit departs everyone at the typed
  departure" — corrections no longer close open visits.

**New (the Board ruling, cited as Board B7/B14, 2026-10-27):**

- Only the kiosk starts or ends a visit while it is happening, and only the
  kiosk closes the building. The website never writes presence; the nightly
  auto-close is the one exception, and it is a close no person made.
- A visit that is still open is changed only by the kiosk or the auto-close.
  The reconciliation screen corrects visits once they are closed.

**New (from the model check of this design; the app's own choices):**

- The nightly auto-close is recorded every night, even when it ends no visit,
  so a scan from before it that arrives late is always fenced by it.
- A kiosk scan's time is the server's clock as the kiosk last measured it, plus
  the time elapsed since. A scan whose time is too uncertain to place on one
  side of a close is applied and flagged.
- A web insert or edit whose times overlap an open visit of the same person is
  refused; one that overlaps a closed visit is applied and flagged.
- While the kiosk reports scans waiting to send, the web says it is syncing
  them instead of stating who is in or whether the building is open.
- The kiosk sends a scan live only when nothing is waiting in its queue;
  otherwise the scan queues behind the others, so scans reach the server in
  the order they were made.
- Which close ended a visit is the visit's own link to that close. The close
  log is the history of every change and is never edited; a pull-back's own
  log row names the close it replaced.

**Changed:** "Every facility close is recorded" now covers an empty nightly
close too. "The web states the building's state … as fact only while the
server has heard from the kiosk within the last five minutes" gains "and the
kiosk has no scans waiting to send". "The kiosk's clock is trusted to within
the same two minutes a late close allows" becomes the rebased-time rule above;
the two-minute allowance stays as a backstop.

**Unchanged but worth restating:** the auto-close records who it checked out,
linked to that close, as forced exits.

The register edits ship with the PR that makes the code match (rollout
step 2), not before.

## End state

### Who writes presence

| Writer | Writes | When |
| --- | --- | --- |
| Kiosk badge (live or queued) | Starts a visit, ends a visit, closes the building | Any time |
| 11 PM auto-close | Records one close with no person behind it, every night, and ends every open visit at it | Nightly |
| Reconciliation screen | Edits, inserts or removes **closed** visits; resolves flagged scans | After the fact |
| Person merge | Moves visits to the surviving person | Late-night cleanup, building closed |

Nothing else writes `Visit` rows. In code terms: the only callers of
`processCheckin`, `processCheckout` and `processCloseRequest`
(`checkin-app/src/lib/attendance/`) are the kiosk branch of `/api/scan`; the
only other caller of `processVisitCheckout` on an open visit is
`/api/cron/nightly`. Every other visit write refuses an open visit
(`departedAt: null`) as a target and refuses to create one.

### What the website reads

Unchanged: `GET /api/attendance` (via `getFullAttendance`) and the kiosk
heartbeat link (`buildingLink` in `lib/kioskSeen`). With a recent heartbeat
the web shows who is inside, whether a keyholder is in, and supervision state;
without one, "can't confirm the building's state (kiosk last seen X ago)" and
the visit record labelled as such. No-keyholder visits never make it read as
open.

Since nothing but the kiosk writes open visits, the server's open visits
**are** the kiosk's view, delayed by whatever is still queued on the kiosk.
That is the whole of "the website mirrors it".

**Syncing.** A fresh heartbeat alone does not make that delayed view current:
a keyholder's close still in the kiosk's queue leaves the web showing the
building open. So the heartbeat carries the queue depth. Every signed kiosk
request (the proxy's roster reads and the drain's scans) adds a
`X-Kiosk-Queue-Depth` header; `stampKioskSeen` stores it beside the stamp, and
`BuildingLink` gains `queued`. While `queued > 0` the web shows "Syncing N
scans from the kiosk" in place of open/closed, occupancy and supervision, and
lists the visit record labelled as such, the same way it treats a stale
heartbeat. A kiosk that is resting has an empty queue by definition, so
resting never reads as syncing. With the queue empty the web is still up to
one roster poll behind; that lag is inherent and accepted.

### The 11 PM auto-close

`/api/cron/nightly` keeps its current behaviour:

1. Carry out any recorded close whose departures were cut off
   (`executePendingCloses`), at the keyholder's time.
2. Record one `FacilityClose` with `via: NIGHTLY_SWEEP` and no closer, then
   depart each open visit at run time as `AUTO_CLOSE` and log each departure
   against that close (`logCloseDepartures`). These are the forced exits,
   listed and linked.

Three changes:

- **The close is recorded every night, even when nobody is open.** Today it is
  recorded only when someone is (`abandonedVisits.length > 0`). The fence that
  catches a late scan needs a close row to fence against: without one, a
  keyholder's 22:59 badge-in that reaches the server after an empty 23:00 run
  opens a visit, and the web shows the building open all the next day. An
  empty close sweeps nobody and shows nothing on the "closed out by a close"
  filter; it costs one row a night. (The alternative, fencing at the day
  boundary instead, puts a second notion of "close" into the fence; not
  chosen.)

- **Schedule.** The cron's schedule lives in the infrastructure repository,
  not here. The rollout sets (or confirms) it to fire at 23:00 in the
  organisation's display timezone, timezone-aware so daylight saving does not
  move it. Today the route is time-agnostic, so nothing in this repo changes.
- **A queued kiosk scan from before 23:00 that arrives after it** then
  behaves correctly: a queued IN scanned before the close is recorded from its
  scan time and departed at the close (the close fence), and a queued close
  pulls the auto-close's later stamps back to the keyholder's time. This holds
  only because the close is now always recorded (above), and only when the
  scan's time is right to within the fence's allowance (see "Scan times").

The "board alert" wording around `boardNotified` (an audit row and a log line,
no email) is untouched by this design; it is the separate decision 4 in the
kiosk scope review.

### The reconciliation screen

One place for fixing what happened, all of it on **closed** records:

- **Flagged and parked scans** — the existing review panel
  (`components/admin/UnsyncedScansPanel.tsx`, `/api/system-status/unsynced-scans`).
  Recording a parked scan always writes a **closed** visit; the "leave it
  open" option goes.
- **Visit corrections** — the existing visits screen
  (`app/facility-ops/visits`, `/api/facility/visits`, `/api/facility/visits/insert`)
  and the corrections review (`app/facility-ops/corrections`). Edits and
  removals are refused on an open visit ("this person is still checked in;
  they badge out at the kiosk, or the 11 PM close ends the visit").
- **New filter: "closed out by a close"** on the visits screen: visits whose
  departure the kiosk close or the auto-close stamped (`departedVia`
  `FACILITY_CLOSE` / `AUTO_CLOSE`, grouped by `facilityCloseId`), so the Board
  sees who was forcefully exited by which close and fixes the times. This is
  the only new UI; it is a query over columns that already exist.

Members' and household leads' own correction pages
(`app/attendance/my-visits`, `app/attendance/household`, `app/attendance/manual`)
and the leaders' roster marks are part of reconciliation too (decisions Q1 and
Q3), on the same terms: closed visits only.

**Overlaps.** Every reconciliation write that inserts a visit or moves its
times checks it against the same person's other live visits, under the
person lock it already takes:

- overlapping an **open** visit: refused ("you are checked in from HH:MM;
  badge out at the kiosk first, or wait for tonight's close"). An open visit
  counts as running until now.
- overlapping a **closed** visit: applied and flagged, naming the other visit,
  so the hours are not counted twice unseen. The flag lists on the
  reconciliation screen with the other correction flags.

This covers the member insert and edit (`app/api/attendance/manual`,
`manual/[id]`), the Board's edit and insert (`app/api/facility/visits`,
`visits/insert`), and roster marks (`lib/programs/events.ts`): a mark whose
closed visit would overlap an open kiosk visit links to that visit instead,
as decision Q3 already says. The review panel's record of a parked scan
already refuses an overlap. One helper, the interval test the duplicate-visit
resolver uses (`intervalsOverlap` in `app/api/my-programs/conflicts/resolve`),
serves all of them.

**Which close ended a visit.** A kiosk close that arrives late pulls the 23:00
run's departures back to the keyholder's time and moves the visit's
`facilityCloseId` to the kiosk close. The 23:00 run's log rows still list
those visits. The visit's `facilityCloseId` is authoritative for "who did this
close end", and the filter reads it. The log is history and is never edited
(audit rows are never deleted or rewritten); the pull-back writes its own log
row against the kiosk close, and that row gains `supersededCloseId`, naming
the close whose departure it replaced, so a reader of either close's log can
see the visit moved.

## Never lose a scan

The mechanism exists and stays. It is named here so nothing in the cleanup
cuts it.

1. **Write before send.** The badge read is filtered for a repeat of the same
   badge within 3 seconds, then written to the kiosk's local SQLite queue
   (`client/outbox.py`, WAL with full sync) with a fresh scan id
   (`clientEventId`, a UUID), the scan time, the direction the screen showed,
   and the close decision if any. Only then is it sent.
2. **Delete on acknowledgement.** The row leaves the queue only when the server
   answers with an acknowledgement for that scan id. A timeout, a 5xx, a
   captive-portal page answering 200, or a 426 (server older than the kiosk)
   all leave it queued. A row is marked "being sent" while a send is in flight
   so the drain never sends it twice concurrently.
3. **Ordered drain.** The drain sends the oldest row first, one at a time, with
   backoff and jitter, honouring `Retry-After`, and waits until the server
   speaks the kiosk's protocol version. **A new scan goes live only when the
   queue is empty**; otherwise it is written and queued behind the rest. Today
   `handle_scan` in `client/client.py` checks only the same person's queued
   rows (`queue_only = outbox.has_pending_for_participant(...)`), so a
   keyholder's live close can overtake another person's queued arrival, and the
   kiosk then shows that person inside after the close. The change is one line:
   `queue_only = outbox.pending_count() > 0 or ...`. While a backlog drains, a
   new scan gets the kiosk's offline behaviour (the kiosk decides the close
   itself, as it always does; no live two-deep interrupt), for as long as the
   backlog takes to send.
4. **Idempotent apply.** The server dedups on `clientEventId` under the
   person's advisory lock: a resend after a lost acknowledgement is answered as
   already applied and changes nothing. The server never discards a kiosk
   scan; one it cannot apply is recorded and parked for review, and the answer
   is still an acknowledgement, so it cannot block the queue.
5. **Order and time.** Each scan applies at its own scan time, in the order the
   kiosk sent it. A scan more than 10 minutes late, behind later activity, or
   from a clock that stepped is applied and flagged. A scan ahead of server time
   applies at server time, flagged. Scan times come from the server's clock, as
   the next section describes.
6. **Restarts.** Self-update and the Chromium watchdog can restart the kiosk at
   any hour; a row written before the restart is sent after it.

**What this design removes from the risk.** Today a queued scan can collide
with a visit the website created or ended while the kiosk was offline, which
is what the out-of-order hold ("a departure against one a person recorded
after it … is held for the reviewer") mostly guards. With the website no
longer writing open visits, the remaining collisions come from the kiosk's own
queue and the 11 PM close, both of which the fence and pull-back rules already
handle. The hold stays for closed records a member inserted (they still may,
decision Q1), and gets rarer.

**Duplicate badge reads** are one scan by the kiosk's 3-second filter; the
server keeps only exact-duplicate dedup by scan id.

### Scan times

With the website gone, the 23:00 run is the only writer that is not the kiosk,
so the only ordering left to get wrong is a kiosk scan against that close. A
Pi without a battery clock drifts steadily; none of the flags above catch
steady drift, and a fast clock can stamp a 22:59 badge-in after 23:00, past
the fence.

- **Measure.** On every successful exchange with the server (roster read, scan
  acknowledgement, version check) the kiosk takes a sample: the server's
  `Date` header, and the kiosk's monotonic clock at send and at receipt. The
  server time at the midpoint is the `Date` value; its uncertainty is half the
  round trip plus one second (`Date` has whole-second resolution). The kiosk
  keeps the latest sample (on disk, so a restart keeps it).
- **Stamp.** A scan's time is the sample's server time plus the monotonic time
  elapsed since the sample. Its uncertainty is the sample's plus one second per
  hour since it (well above a Pi oscillator's drift). Both go in the queue row
  (`scanned_at` as now, plus a new `time_uncertainty_ms`) and are sent
  (`scanTimeUncertaintyMs`). With no sample since the queue file was created,
  the kiosk falls back to its wall clock and marks the scan clock-suspect, as
  today.
- **Flag.** The server applies the scan at its time, as today, and flags it for
  review when a close's time falls within its uncertainty
  (`|closedAt − scannedAt| ≤ uncertainty`): which side of the close it belongs
  on cannot be known. The two-minute allowance the fence already gives a
  server-stamped close stays as a backstop.
- **Contract.** A new body field, so the kiosk speaks protocol 8, and the server
  accepts it before the kiosk sends it. The clock-step watch (`ClockWatch`)
  stays; it is cheap and still catches the fallback case.

Online, a sample is at most a minute old and the uncertainty is about a
second. Offline for a night, it grows to about eight seconds by morning, which
is still far inside the two-minute allowance.

## Scans with no keyholder present

Behaviour stays as it is today (the owner's 2026-10-05 ruling, now Board B14):

- **What shows on the kiosk:** the person, like anyone else. The kiosk is never
  blank and does not distinguish.
- **What shows on the website:** the person is listed as inside, marked
  "no keyholder", and the building reads as **closed** while no keyholder is
  in. The mark clears if a keyholder checks in within 10 minutes of the
  arrival. It is derived from the visit record, so nothing is stored.
- **What is flagged:** nothing that needs action. The mark is visible on the
  roster and on the reconciliation screen's visit list. No email, no review
  item. Escalating when no keyholder ever arrives (issue #1775) is not adopted
  here; the 11 PM close ends such visits like any other.

The B14 table of "which kind of check-in is trusted to open the building"
collapses: only kiosk badges create live visits, so only a keyholder's own
badge can make the building read as open.

## Removed from the website

This is the delete list for the implementation PRs (see Rollout); this
design PR changes no code, so everything below still exists on `main` today.
Paths are under `checkin-app/src/`. "Ambiguity removed" is the question the
code no longer has to answer.

| What goes | Where | Ambiguity removed |
| --- | --- | --- |
| Home-page Check In / Check Out toggle | `app/page.tsx` (`handleToggleCheckin`, `canSelfCheckin`) | Who may self-check-in on the web, and in which environment |
| Web-session branch of the scan route | `app/api/scan/route.ts`: the `sessionUser` admission, the session close-choice echo (`closeChoice`, `handoverToId`, `forceCloseToken` from a session), `recordWebClose` there; `withKiosk` admits kiosk signatures only | Two kinds of caller sharing one scan pipeline; the 3-second server debounce kept "for the web" |
| Dashboard manual check-in | `app/api/attendance/route.ts` POST `MANUAL_CHECKIN`; "Check in" search on `app/attendance/current/page.tsx` | "Does a keyholder already need to be in?" for a web check-in |
| Dead two-deep notification | `app/api/attendance/route.ts` POST `TWO_DEEP_VIOLATION` (no caller; it only logs) | None; dead code |
| Dashboard checkout / force checkout | `app/api/attendance/route.ts` DELETE; buttons and confirm dialog on `app/attendance/current/page.tsx` | Who may end someone else's visit, and whether that closes the building (B7) |
| Open "still here" self entry | `app/api/attendance/manual/route.ts`: entries without a departure are refused; the facility-open guard goes | Self-reported presence with no proof of being inside |
| Closing an open visit by editing it | `app/api/attendance/manual/[id]/route.ts` PATCH (`closingOpenVisit` branch); `app/api/facility/visits/route.ts` PATCH on an open visit | An edit that is really a check-out, and whether it closes the building |
| Removing an open visit | `app/api/attendance/manual/[id]/route.ts` DELETE and `app/api/facility/visits/route.ts` DELETE on an open visit; conflict resolve (`app/api/my-programs/conflicts/resolve/route.ts`) on an open visit | Erasing a person from the live roster that a kiosk scan put there |
| Roster mark "Present, still here" | `lib/programs/events.ts` `manualEditAttendance`: a departure is required; an open kiosk visit covering the session is linked, never departed; otherwise a closed visit is created (decision Q3) | A leader opening the building from the web (the B14 gap) |
| Review panel "leave open" | `app/api/system-status/unsynced-scans/[id]/route.ts`: departure required | Whether a set-aside scan may reopen the building |
| The web close machinery | `lib/attendance/keyholderGuard.ts` whole file (`lastKeyholderGuard`, `recordWebClose`, `finishCloseGuard`, handover candidates and email, token compare); `withCloseGuard` wrapper in `manual/[id]/route.ts`; `components/CloseChoiceDialog.tsx` (`isCloseChoiceWarning`, `askCloseChoice`) and its four callers (`app/page.tsx`, `app/attendance/current`, `my-visits`, `household`); the `close_choice` body (`CloseChoiceWarning`, defined in `keyholderGuard.ts`) and the `close_guard` case that renders it in `app/api/scan/scanResponse.ts` | The five-minute token, who gets which of close / leave / cancel, naming a handover, emailing it |
| "Unseen check-in" hold on a kiosk close | `lib/attendance/close.ts` `processCloseRequest` (`rosterAsOf`, `unseen_checkins` offer and review flag) | Whether a one-badge close should wait for a check-in the kiosk did not show |
| Kiosk leave audit | `lib/attendance/close.ts` `auditKioskLeave` (the "leave" twin of the web handover) | None the visit record does not already show; optional, see below |
| Old-protocol paths | `app/api/scan/route.ts`: `legacyKiosk` (below 6), the toggle path (below 5), the server debounce (below 3), the untrusted-replay parking (below 5); constants in `lib/scanProtocol.ts` | Two ways to decide a direction and a close |
| Visit columns for the web dialog | `Visit.forceCloseWarnedAt`, `forceCloseToken`, `forceCloseActorId` (`prisma/schema.prisma`) | State only the web dialog read |

**What the remaining write paths gain** rather than lose: the overlap check
(refuse against an open visit, flag against a closed one) on the member,
household-lead, Board and roster-mark paths, as "Overlaps" describes. The
"refuse an open visit as a target" rule and the overlap check are the whole
of what replaces the facility-open guard on those paths.

`FacilityCloseVia` keeps `WEB_CHECKOUT`, `WEB_DASHBOARD`, `WEB_CORRECTION` and
`WEB_REMOVAL`: past closes carry them and audit rows are never deleted. New
code stops writing them.

`auditKioskLeave` is listed because it exists to mirror the web "leave"
choice. Dropping it loses only an audit row saying "the last keyholder left
without closing", which the visit record shows anyway. Keep it if the Board
wants that row; it is not one of the owner's questions because either answer
is cheap.

**What stays on the website** besides the reads: exactly the Board's two
things. The 11 PM auto-close, and the reconciliation screen as above, which
includes the close-time correction (`correctCloseTime`, the Board moving a
close's time moves everyone it closed out), members' own corrections and
program leaders' roster marks (see "How this design reads ruling 2"). Person
merge is outside the check-in features and is untouched.

**Size:** about 300 lines of guard, 250 of route branches, 150 of old-protocol
handling, 100 of close-hold, and the UI around them; roughly 1,000 production
lines, and more in tests.

**Boundary:** none of the routes above is deleted whole except
`POST /api/attendance` (both its branches go) and `DELETE /api/attendance`.
Neither is a `handler()` registry entry (they use `withAuth`), so no security
registry change is needed. If review finds otherwise, the registry removal
rides the decommission exception (whole entries for a verb deleted in the
same PR).

## The kiosk: what it does and what it drops

### What it does today

`client/kiosk.sh` keeps the process up, pulls the newest release tag and
starts `client.py` and full-screen Chromium. `client.py` runs:

- a badge reader thread (USB, with a 3-second repeat filter);
- a local web server that serves the frame page, proxies **every** request the
  screen makes to the server and signs it with the kiosk's key;
- the close decision (one badge when it shows nobody else inside; otherwise a
  15-second "badge again to close" prompt);
- its own roster view (last server roster plus its queued scans), shown when
  the server cannot answer;
- a roster poller, a version poller with self-update, a health monitor, and the
  queue drain (`outbox.py`).

### What it keeps

Signing; the write-before-send queue and its drain; scan ids; the repeat
filter; the direction shown; the local close decision and prompt; the
never-blank own view; resting while the building is known empty; the protocol
handshake; self-update; Chromium restart on a silent browser; the status
banners; the offline two-deep caution on the close prompt.

### What it drops

| # | Drop | Why it can go now | Size (≈ lines) |
| --- | --- | --- | --- |
| K1 | Proxying anything but `GET`s: the screen's `POST`/`PUT`/`PATCH`/`DELETE` are refused locally | The screen no longer writes. It also stops the kiosk signing writes for whatever script runs in its browser | 20, plus the "check-in made on the board" branch in `_proxy_request` and the `counts_known` / `presence_seq` bump it drives |
| K2 | `rosterAsOf` bookkeeping, the "held close" banner (`_held_close_html`), and sending `rosterAsOf` | The server no longer holds a close | 40 |
| K3 | The close-token field (`force_close_token`) and `force_close_confirmed` in the queue and `post_scan` | Server close tokens went in protocol 6; nothing sends them | 25 |
| K4 | The 15-second "slide" while a badge is held (`slide_close`) | The repeat filter already stops a held badge toggling | 15 |
| K5 | Blackout screen (`disable_blackout`, `#blackout`) | Off by default; nothing uses it | 40 |
| K6 | Release-channel marker fallback (`RELEASE_CHANNEL_MARKER`, `_tracks_releases`) | Every release since v1.2.5 carries the marker | 20 |
| K7 | Health monitor WiFi bounce and reboot escalation (`allow_wifi_bounce`, `allow_reboot`) | Off by default; keep the Chromium restart and nightly reboot. Check the door's `config.json` first | 120 |
| K8 | Outbox: the seven copy-pasted "add column if missing" blocks become one loop over a column list | Same guarantee, fewer lines | 35 |

K1 and K2 follow from this ruling. K3–K8 are the kiosk scope review's cut list
(items 2, 4, 11, 12), restated because "simplify the kiosk as much as
possible" makes them in scope.

**Not dropped, on purpose:** the Python roster poller. The scope review called
it mostly redundant with the screen's own poll, but it is what notices people
leaving while the screen sits idle and decides when the kiosk may rest. Remove
it only with a test showing the screen poll alone keeps "known empty"
correct; not part of this design.

### What it adds

Small, and each closes a gap the model found:

- **Live only behind an empty queue** (`handle_scan`, one line; see "Never
  lose a scan" point 3).
- **Server-time stamps**: the clock sample on each exchange, the rebased scan
  time and its uncertainty, one new queue column and one new body field
  (protocol 8); see "Scan times". About 40 lines.
- **Queue depth on every signed request**: an `X-Kiosk-Queue-Depth` header from
  the proxy and the drain. About 5 lines.
- **Clearing its own view at 23:00** when offline, by server-based time; see Q4.
  About 15 lines.

**Server-only items that shrink the kiosk's contract** (no kiosk code, but the
kiosk no longer has to cope with them): the held-close reply, the
`close_choice` reply, and the old-protocol branches above.

### What the kiosk does *not* take on

The Board's "the kiosk manages the building" does not move the two-deep math
or the safety display to the kiosk: they stay server-side and fail closed, as
the register requires. The kiosk does not get a check-in-by-name screen
(decision Q2).

## Rollout

Order matters because old code keeps serving traffic during each deploy's
drain window (`docs/ops/DEPLOY_MIGRATION_ORDER_OF_OPERATIONS.md`).

0. **Confirm the door.** The kiosk-version status page shows the door on
   protocol 7 (v1.2.7 or later). If not, the old-protocol deletions (part of
   step 3) wait for the next kiosk release.
1. **Infrastructure:** set the nightly cron to 23:00 in the organisation's
   timezone. Independent of the code; can go first. The nightly route's
   always-record change (a few lines) ships with it or in PR 1, whichever is
   first.
2. **PR 1 — website stops writing presence.** Remove the UI controls and refuse
   the open-visit paths in the table above (home toggle, dashboard check-in and
   checkout, scan route session branch, open self entry, closing or removing an
   open visit, open roster marks, review "leave open"). Add the "closed out by a
   close" filter, the overlap check, the server half of "syncing" (read the
   queue-depth header; show "Syncing N scans"), and accept and flag the
   protocol-8 time uncertainty (the server must speak 8 before the kiosk does). Update the rules register and `docs/ops/checkin-state-machine.md`
   in the same PR. Keep `keyholderGuard.ts` compiled but unreferenced so the
   diff stays reviewable.
3. **PR 2 — server cleanup** (after PR 1 is in production): delete
   `keyholderGuard.ts`, the close hold in `processCloseRequest`, the
   old-protocol paths, the server debounce, and stop writing the web
   `FacilityCloseVia` values. Add `supersededCloseId` to the pull-back's log
   row. No schema change (it is a field in the log row's data).
4. **PR 3 — drop the three `Visit.forceClose*` columns** (a release after PR 2,
   so no running code reads them). A contract-phase migration; live data in the
   columns is transient dialog state, so nothing to preserve.
5. **PR 4 — kiosk client** (K1–K8, plus the four additions: live only behind
   an empty queue, server-time stamps at protocol 8, the queue-depth header,
   clearing its own view at 23:00),
   shipped as the next kiosk release. It can
   merge any time after PR 1; until PR 1 is live, K1 would only make the
   kiosk's own screen buttons fail, which no one uses at the door. K2 needs the
   server to have stopped holding closes (PR 2) only in the sense that a held
   reply would show as an ordinary checkout, which is harmless.
6. **Model.** The design model is re-checked (see "Checked by model"). Still
   to do: the check-in Base and Impl without the web actions (web check-in,
   web checkout, web close, web removal, open roster mark) on PR 2's head. The
   coordinator owns this.

### What happens at cutover

- **Visits opened on the website before PR 1 deploys** stay open. They are on
  the server's roster, so the kiosk shows them; the person badges out at the
  door, or the 11 PM close ends them and lists them as forced exits. No data
  migration.
- **A close-choice dialog open in someone's browser** when PR 1 deploys: the
  answer reaches a route that now refuses it. Nothing was written when the
  dialog opened (only a token on the visit), so nothing is half-done. The
  keyholder closes at the kiosk or the 11 PM close does.
- **A close recorded but not yet carried out** (a crash between record and
  sweep) is still carried out by the next kiosk scan or the nightly run.
  Losing the web close as a trigger changes nothing.
- **Old code during the drain window** may still accept a website check-in or
  checkout for a few minutes. Those are valid rows the kiosk will see; nothing
  breaks.
- **A browser tab left open on the old home page** posts to the scan route with
  a session and is refused ("check in at the kiosk").

## Owner decisions (2026-10-27)

Asked of the owner after the first draft. All are settled.

**Q1. Members' and household leads' own corrections stay**, on closed visits
only. Members insert their own past visits, correct their times and remove
them; a household lead does the same for their household. They fix the
placeholder departure the 11 PM close stamps. The three member pages stay;
they refuse an open visit like every other reconciliation path.

**Q2. Nobody checks in without a badge.** No check-in-by-name screen on the
kiosk, no website check-in. The organisation already has ways to get someone a
badge read at the door, which the kiosk treats as an ordinary badge. A visit
nobody badged is recorded afterwards on the reconciliation screen, closed.

**Q3. A roster "Present" mark records attendance at the session.** If a kiosk
visit covers the session, the mark links to it and never departs it. If not,
the mark creates a closed visit for the session's time, so the hours count.
The leader enters a departure; a mark never creates an open visit or ends one.

**Q4. The kiosk offline across 11 PM: the kiosk clears its own view at 23:00
(owner, 2026-10-31).** A kiosk that has not heard from the server since before
23:00 applies the close to its own view, so the next morning's first arrival
gets "Welcome" rather than a wrong "Goodbye".

- **Time source.** The server-time sample plus elapsed monotonic time (see "Scan
  times"), with the organisation's timezone from config. Never the Pi's clock:
  that is the risk behind the rule removed in #2039, where a wrong clock or
  timezone emptied the door screen with people inside. With no sample since boot
  the kiosk does nothing, and the view stays as it was.
- **It sends nothing.** The server's 23:00 run stays the one close of record, and
  the backstop when the kiosk is dead or unplugged.
- **Not yet re-checked.** The model showed a fast Pi clock giving a "Welcome" to
  someone still inside. That run used the Pi's clock, so this time source needs
  its own check.

About 15 lines on the kiosk. It needs the server-time sample, so it ships with
protocol 8.

**Q5. A wrong "Goodbye" for a keyholder records a building close: accepted.**
The kiosk still shows keyholder K inside after K left without badging out. K
comes back. The kiosk shows K inside and nobody else, so K's badge is a one-badge
close: the door says "You are closing the building", and the kiosk queues a
close, which the server applies like every kiosk close. Nobody else is swept,
since nobody else is in yet. This happens on the same day whenever a keyholder
who forgot to badge out returns. It also happens the next morning when a kiosk
offline across 23:00 had no server-time sample and so could not clear its view
(Q4).

The owner accepts this as an ordinary mistaken scan. People read the screen: a
returning keyholder who sees "Goodbye" or "closing the building" knows they
forgot to badge out, badges straight back in, and fixes the missed scan-out
later through their own corrections (Q1). The stray close record stays
visible on the reconciliation screen's "closed out by a close" list. No
confirm step is added at the kiosk, no flag, and the server does not
second-guess the close.

## Checked by model

The design was model-checked in TLA+ on 2026-10-27 and re-checked on the
revised design on 2026-10-28. The model and its runs are in the coordinator's
analysis folder, outside this repo
(`checkin-analysis/kiosk-design/spec/KioskDesign.tla`; findings and the
re-check in `checkin-analysis/kiosk-design/findings-2026-10-27.md`; runs in
`spec/README.md`, Round R2). The re-check found no new gaps.

| Finding | Design change | Result on the revised design |
| --- | --- | --- |
| F1: an empty 23:00 run leaves no close to fence against | The close is recorded every night | Fixed; holds |
| F2: clock drift moves a scan past the 23:00 close | Server-time stamps; flag a scan whose uncertainty spans a close | Fixed as designed: such a scan is applied and flagged. The residual case (flagged but still open the next day) only affects scans within seconds of 23:00, by this design's own uncertainty figures |
| F3: a keyholder's wrong "Goodbye" records a close | None: accepted (Q5) | Accepted as decided; still occurs, by design |
| F4: an insert or edit overlaps an open visit | Refuse against an open visit, flag against a closed one | Fixed; holds |
| F5: the web states building state while scans are queued | Queue depth on the heartbeat; "Syncing N scans" | Fixed; holds. The web never shows a false open. The one-poll lag remains, as accepted above |
| F6: a live scan overtakes another person's queued scan | Live only behind an empty queue | Fixed; scans reach the server in order, and the queue still drains |

Held throughout:

- Liveness: the queue drains when the network returns, and every scan is
  eventually applied.
- A roster mark racing a queued kiosk arrival never leaves an unflagged
  overlap.
- Every badge is applied or still queued; every scan is applied exactly once;
  every machine departure links to the close whose time it carries.
- Reconciliation (only the kiosk opens visits, no web step changes who is in,
  no false open, overlaps flagged): no violation in 75 million states. This
  run is partial; it stopped at its time limit.
- "Can't confirm" without a fresh heartbeat holds by construction.

Not modelled: the close-log wording (`facilityCloseId` authoritative,
`supersededCloseId` on the pull-back's log row), which is text only, and the
kiosk clearing its own view at 23:00 by server-based time (Q4), which needs a
variant before the kiosk release.

## Appendix: sources

- Board rulings B7 and B14, 2026-10-27 (Board doc), as relayed in the brief.
- Owner rulings in the check-in guidance: trust the keyholder's close
  (2026-10-05); no-keyholder check-ins are recorded and marked (2026-10-05);
  web shows building state only with a kiosk heartbeat (2026-10-11); a late
  close applies at the keyholder's scan time (2026-10-05); forced exits listed
  and linked to the close (2026-10-25); the 3-second filter belongs on the
  kiosk (2026-10-11).
- `docs/ops/checkin-state-machine.md` (owner-signed state machine) and
  `docs/rules/attendance-checkin.md`, read at `main@39f1c6d19`.
- The kiosk design and scope review (Claude Doc, 2026-10-13) for K3–K8.
- The scope review's line counts are estimates; the PRs report real ones.
