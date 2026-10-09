# Web checkout by the last recorded keyholder

## Problem

When the last keyholder the app has recorded inside checks out from a web page
while other people are still recorded inside, the app offers one thing: confirm,
and the building closes, checking everyone out. Three things go wrong with that.

First, the app's idea of "last keyholder" is only as good as the badges. A second
keyholder can be in the room without having badged in. The person checking out
from their phone knows this and does not want to close, but the only alternative
the app offers is to not check out at all.

Second, the people who can trigger and confirm that close include people who are
not keyholders and may not be in the building: a household lead checking out a
keyholder spouse from home, or a board member signing someone out from the
dashboard. Policy says nobody closes a facility without being an active
keyholder.

Third, the warning names everyone recorded inside. A household lead with no
keyholder or board role is otherwise shown counts only; the dashboard tells them
in so many words that individual names are visible only to administrators and on
the kiosk. The warning hands them the names anyway, wherever they are.

## Objective

A web checkout of the last recorded keyholder always goes through; the caller
chooses whether the building closes, within what policy and the owner allow; the
choice is recorded; and names go only to people who already read the roster.

## Executive summary

- **A keyholder or board member checking out the last recorded keyholder** chooses
  close, leave or cancel. The close choice says plainly that no other keyholder is
  checked in. *Leave* checks out only the leaver and names, from a pick-list, the
  keyholder they handed over to in person; the app records that and does not check
  the named keyholder in. A named keyholder who is not checked in is emailed.
- **A household lead** who is not a keyholder can always check the keyholder out,
  but chooses only leave or cancel, and sees a count instead of names.
- **A sysadmin** who is neither a keyholder nor on the board also chooses only
  leave or cancel; they do see names.
- **Names** go to keyholders, board members and sysadmins, who already read the
  full roster.
- **Correcting the close time earlier** moves everyone the close checked out, and
  every departure the close sets or moves is logged. **Removing** an open visit
  never closes the building.
- **The kiosk** gets the same shape: one badge from the last keyholder checks them
  out and offers the close; a second badge closes. Today the first badge does not
  check them out; this design changes that, server and offline kiosk alike.
- **All four web paths** run one shared decision, including the legacy dashboard
  route and the home-page toggle that currently runs the kiosk's copy of the guard.

## Rules this relies on or would change

From `docs/rules/attendance-checkin.md`:

- Policy, Keyholders: "Nobody opens or closes a facility without being an active
  keyholder" (Arts. VI–VII); "A primary keyholder leaving must either transfer the
  role, with the other keyholder's consent, or close the facility" (Art. VIII
  §VIII.3); the closing keyholder ensures two adults with a last youth (§VIII.4).
  **Policy-tier.** The "leave" choice and any close by a non-keyholder touch these;
  §3.1 records the owner's reading of them.
- Assumption: nobody being inside without a keyholder is kept at the door; the
  app records such visits rather than refusing them. The "leave" choice relies on
  this.
- Procedure: "The keyholder close-guard fires on every close path…"; this design
  amends it.
- Procedure: "Any keyholder can close the building at the kiosk with a double
  scan…"; unchanged.
- Procedure: the facility is open only while a keyholder is present; people inside
  with no keyholder are shown as inside a closed facility. "Leave" produces exactly
  that state.
- Procedure: a member or household lead's correction "always applies… Integrity is
  after the fact rather than a gate". This design keeps that: no caller in scope
  is refused a checkout.

From `docs/rules/principles.md`: least privilege ("a surface grants nothing its
gate does not already grant"), fail closed ("where finishing an operation would
take inventing a fact, refuse"), accountability ("a discretionary decision records
why").

From `docs/rules/people-households.md`: "Personal information is shared on a
need-to-know basis" (Records Policy Art. IV).

---

## 1. Current behaviour

Four web endpoints can end the last keyholder's open visit. Three call
`lastKeyholderGuard` (`checkin-app/src/lib/scan-service.ts`); the home page's
toggle calls `processCheckout`, which carries its own inline copy of the same
rule.

The shared rule, on every path: if the visit's person is a keyholder, no other
keyholder has an open visit, and anyone else has an open visit, the server mints
a single-use token, stamps it on the visit, and returns 400 with a warning. The
caller echoes the token to confirm; the server then checks the person out and
runs the facility close, which departs every open visit. A keyholder alone in the
record closes on the first request with no warning. When another keyholder is
recorded, the web never offers a close; only the kiosk does.

| Path | Who can trigger it | Guard | Confirm | Data returned |
|---|---|---|---|---|
| **Home page toggle**: `POST /api/scan` with a session (`src/app/page.tsx`) | UI: the signed-in user for themselves; in production only sysadmin, board and keyholders get the button. The API also accepts a sysadmin, board member or keyholder scanning **anyone**, and a household lead scanning a household member (no UI for either). | Inline copy in `processCheckout`. Also runs the supervision interrupt, which the rules say is badge-only. | Press the button again within 15 s (client-side timer; the server has no elapsed gate). Copy says "Badge again within 15 seconds", which is kiosk wording. | 400 `{ error, type: "warning", forceCloseToken, confirmSeconds }`; `error` embeds the names. Route is `withKiosk`, not `handler()`. |
| **Dashboard checkout and Sign Out modal**: `DELETE /api/attendance` (`src/app/attendance/current/page.tsx`) | Self; a household lead for a household member (card button in the limited view); **any keyholder, board member or sysadmin for anyone** (Sign Out modal). | `lastKeyholderGuard` | "Close Facility?" modal showing the server message; "Confirm & Close Facility" re-sends with the token. | Same warning body. Success returns `{ success, visit, facilityClosed }` with the raw visit row. `withAuth`, not `handler()`; writes no audit row of its own. |
| **Self-correction closing an open visit**: `PATCH /api/attendance/manual/[id]` with a departure (`my-visits`, `household` pages) | Self; a household lead for a household member. | `lastKeyholderGuard`, run before the edit. | `window.confirm(message + "Confirm facility close?")`, then re-send with the token. | Warning body from the `withCloseGuard` side channel, outside `handler()` and the stripper. On success the close runs at **now**, not at the typed departure. Audit row: EDIT, actor and subject. |
| **Tombstone of an open visit**: `DELETE /api/attendance/manual/[id]` | Self; a household lead for a household member. | `lastKeyholderGuard` | Same `window.confirm`. | Same warning body via the side channel. On confirm the visit is tombstoned **and** the building closes. Audit row: DELETE; every delete emails the board. |

The names in every warning come from `presentNames`, which loads each open visit
with its full person row and renders kiosk labels: nickname or first name, a last
initial only to tell two apart, else the email local-part. They are labels, not
full names, but they identify who is inside. The response never passes through a
stripper, and a stripper would not help: the names are inside a string.

The legacy route's `POST` has no guard; that verb only checks people in.

## 2. The problems

### 2.1 The present-but-unbadged keyholder

The app cannot tell "the last keyholder is leaving" from "a keyholder who never
badged is staying". The kiosk resolves this by trusting the keyholder at the
reader, who can see the room. A web caller may be on the street outside or at
home hours later, and the app cannot tell which; the only on-site signal is a
signed kiosk request, and web requests never carry one.

Today the keyholder's only alternatives to closing are to cancel, and stay
recorded inside, or to check the other keyholder in from the dashboard first
(keyholders may check anyone in). The second records an arrival for someone who
did not agree to it.

### 2.2 Non-keyholders closing the building

Two kinds of caller who need not be keyholders can confirm a close:

- a **household lead** checking out, correcting or removing a keyholder household
  member's open visit, on the dashboard, the `household` page, or (API only) the
  session scan;
- a **board member or sysadmin** using the dashboard's Sign Out modal, or a session
  scan, on the last keyholder.

Arts. VI–VII say nobody closes a facility without being an active keyholder.
None of these callers is checked for being a keyholder, and none is in the
building by any test the app applies.

### 2.3 The names leak

| Caller | Reads the roster today? | Gets names from the warning? |
|---|---|---|
| Keyholder, board, sysadmin (not kiosk-signed) | Yes, full access on `GET /api/attendance` | Yes; no widening |
| Household lead with none of those roles | No; counts plus their own household only | **Yes; widening** |
| Kiosk screen | Yes, kiosk labels | Not a web path |

The leak's audience is a non-keyholder household lead, who may be anywhere. It
fails least privilege's per-field test, and Records Policy Art. IV need-to-know.
"The kiosk shows the names anyway" does not apply, because the kiosk shows them to
people standing in the building, and this caller need not be.

---

## 3. Design

### 3.1 Decided by the owner

**Close, leave or cancel.** Offered to a keyholder checking themselves out, and to
a board member (keyholder or not) checking out the last keyholder.

- *Close* checks the leaver out and departs every open visit. The choice states
  that no other keyholder is checked in, alongside the people recorded inside.
- *Leave* checks out only the leaver. The others stay recorded inside with no
  keyholder, which every surface already shows as inside a closed facility. The
  leaver picks, from the current keyholders, the one they handed over to. The
  pick goes on the audit row with the leaver, the time and the count of people
  left inside. The named keyholder is **not** checked in: recording an arrival
  for someone needs their agreement.
- *Cancel* changes nothing; the leaver stays recorded inside.

**The handover happens between people.** §VIII.3 lets a primary keyholder leave
an occupied building only by transferring the role with the other keyholder's
consent. That transfer and its consent take place in person, and the app cannot
see them; when a keyholder hands over correctly, nothing the app reads can tell.
The app records the leaver's statement and does not second-guess it. This is an
Assumption: handled outside the app, and recorded. So is the stand-in that goes
with it: the app does not model a primary keyholder, so the last recorded
keyholder is treated as the primary one.

**The named keyholder is told when they are not checked in.** An email: who left,
when, that they named them, and how many people are recorded inside. A named
keyholder who already has an open visit at that moment is not emailed. The
pick-list offers keyholders without an open visit, so in practice the email goes
unless they badged in during the dialog.

**The board closes; a household lead does not.** The board is a superuser and
closes the building whether or not its member holds keys; the owner reads its
standing as covering Arts. VI–VII. A household lead who is not a keyholder can
always check a keyholder member out, because refusing would put a gate where the
visit-record rules put trust and review after the fact; they choose leave or
cancel, and are not asked to name a keyholder.

**A sysadmin does not close.** A sysadmin who is neither a keyholder nor on the
board chooses leave or cancel, like a household lead, and is not asked to name a
keyholder. Closing the building is an operational act, not part of running the
system.

**Names go to keyholders, board members and sysadmins.** All three already read
the full roster. A household lead sees a count.

**Correcting a close.** A correction that closes an open visit offers the same
choices, and a close departs everyone at the typed departure, matching the
kiosk's late-close rule. A keyholder who corrects the time of a close they made
to an earlier one moves the departures that close set, for everyone. Correcting
it to a later time moves only the closer's own departure; nobody else's changes.
Someone who arrived between the corrected time and the original one keeps the
departure the original close gave them, as with the kiosk's late close; it is a
placeholder for a person to fix, not something the correction guesses at.
Someone who has since corrected their own departure keeps it; a later correction
of the close never overwrites it. Every
departure a close sets or moves is logged: which close, who made it, through
which path, and each visit's departure before and after.

**Removing an open visit never closes the building.** A removal says the keyholder
was never there; closing on that basis would invent departures for everyone else.
The confirm states the count and that they will read as inside a closed facility.

**The kiosk has an implied leave.** The last keyholder badges once and is checked
out; the kiosk offers the close for the countdown, then shows the persistent
no-keyholder banner, and keeps showing who is inside. A second badge within the
countdown closes. Today the last keyholder's first badge, with others inside,
does not check them out: they stay recorded until a second badge closes. The
change is part of this design and covers the offline kiosk (`client/client.py`)
as well as the server; building it may take several PRs.

The kiosk's colours stay as they are. The single-badge leave returns the same
close offer the kiosk already shows when another keyholder is recorded: the amber
"checked out" banner with its countdown. After it, the dashboard's existing orange
"Facility closed, no keyholder present" banner covers the state. Red stays
reserved for errors and the supervision confirm. The one change is copy: the
close offer for the last keyholder states that no other keyholder is checked in.

**The trust principle.** Agreed text for `docs/rules/principles.md`, shipped as
its own change:

> ## Trust, then review
>
> - **A person's account of what happened is accepted when they give it.** The app
>   records it, says who gave it, and makes it reviewable. It does not refuse an
>   account because its own record disagrees.
> - **Where the app's record and the room disagree, the room is right.** The app
>   cannot see a handover, a keyholder who never badged, or a walk-in nobody
>   scanned. A gate built on what the app can see blocks the people doing it
>   correctly.
> - **Trust comes with a trail.** An accepted account that changes someone else's
>   record names who gave it, and a significant one reaches someone who reviews it.
> - **It widens nothing and overrides no policy.** Who may act is still least
>   privilege's question; where a policy requires a block, the block stands.
>
> The tell is a refusal whose only reason is that the data disagrees with the
> person in front of it.

**Rejected: handing over by checking the named keyholder in.** It needs both
keyholders to agree, and the app hears from only one.

### 3.2 Still to decide

Each question keeps its label; an answered one stays here as a one-line stub
pointing to §3.1.

**`Q-SYSADMIN-CLOSE`: answered.** A sysadmin does not close; see §3.1.

**`Q-CLOSE-LATER`: answered.** A later close time moves nobody else; see §3.1.

**`Q-CLOSE-ARRIVALS`: answered.** Left as the original close set them; see §3.1.

**`Q-CLOSE-CORRECTED`: answered.** A person's own correction stands; see §3.1.

**`Q-KIOSK-SCOPE`: answered.** One design, built in several PRs; see §3.1.

**`Q-KIOSK-COLOURS`: answered.** No colour changes; see §3.1.

### 3.3 The legacy `/api/attendance` route

The decision lives in the shared guard; the legacy `DELETE` and the session scan
call it, as the manual route does. Moving `DELETE /api/attendance` to `handler()`
is separate work; the new warning body is fixed apart from the names, so it does
not wait on the stripper. The session branch of `POST /api/scan` stops using the
kiosk's inline copy; the kiosk path keeps its own.

---

## 4. Affected surfaces

**Response shape.** The warning becomes a fixed body:

- `type: "close_choice"`, with `othersInside` (a count), the allowed `choices`
  (`close`, `leave`, `cancel` for a keyholder or board member; `leave`, `cancel`
  for a household lead or sysadmin), the token, and the seconds;
- `names` only for a keyholder, board member or sysadmin; kiosk labels, as today;
- for a keyholder choosing `leave`, the request carries the named keyholder's id,
  and the server checks they hold the role.

Names are the one data field in the body. On the manual route the body leaves
through the `withCloseGuard` side channel, which `handler()`'s stripper never
sees, so the names gate is the guard's own check on the caller. Moving that gate
into the registry needs `handler()` to support a declared "confirm required"
response; that is a boundary change and ships alone, before or after this.

**Confirm UI.** One shared dialog replaces the three in use (the dashboard modal
and two `window.confirm` calls) and the home page's press-again timer. It shows
the count, the names where sent, and one button per allowed choice; "leave" for a
keyholder adds a keyholder picker. Kiosk wording ("badge again") leaves the web
copy.

**Guard.** `lastKeyholderGuard` takes the actor as well as the subject, works out
the allowed choices from both, and mints a token for the choice. The audit row
records actor, subject, choice, named keyholder and count; the legacy `DELETE`
writes it too, which it does not today. The guard loads person rows only when
names are sent.

**Rules doc** (`docs/rules/attendance-checkin.md`), on merge:

- Amend "The keyholder close-guard fires on every close path…": close, leave or
  cancel on the web; who gets which (keyholder and board: all three; household
  lead and sysadmin: leave or cancel); a tombstone never closes; names to
  keyholders, board and sysadmins only.
- Add the Assumption: a keyholder who leaves the building occupied has handed over
  in person to the keyholder they name; the app records the statement.
- Add the Assumption: the last recorded keyholder stands in for the primary
  keyholder of §VIII.3, which the app does not model.
- Add: a named keyholder who is not checked in is emailed.
- Add: correcting a close to an earlier time moves the departures it set; a later
  correction moves only the closer. Someone who arrived after the corrected time
  keeps the original close's departure, and a departure its owner has corrected
  is never moved. Every departure a close sets or moves is logged.
- Amend "Any keyholder can close the building at the kiosk with a double scan…":
  the last keyholder's first badge checks them out and offers the close, online
  and offline; a second badge within the countdown closes.
- Tag the board's close with the Arts. VI–VII citation and the owner's reading
  that the board's superuser standing covers it.

`docs/rules/principles.md` gains the trust principle (text in §3.1), in its own
change.

**Logging.** A facility close today is a bulk update that writes no per-visit
audit and does not say which close set a departure. Correcting a close's time
needs both, so each close becomes a record (who, when, path, choice), and each
departure it sets or moves is logged against it with before and after.

**Flow tests** (`checkin-app/flow-tests/last-keyholder-checkout.flow.test.ts`).
The seed has no household with a non-keyholder lead and a keyholder member, so
the test builds one through the board and admin routes; the shared seed is not
changed.

1. Keyholder alone checks out: closes, no warning.
2. Last keyholder with others inside: the warning carries names and the three
   choices; `close` departs every visit.
3. `leave` naming keyholder2: only the leaver departs; keyholder2 has no visit;
   the facility reads closed with people inside; the audit row names keyholder2.
4. Household lead checks out the last keyholder member: the warning has a count,
   no names, and no `close`; `leave` checks the member out and departs nobody else.
5. Board member who is not a keyholder uses the legacy `DELETE` on the last
   keyholder: the warning carries names and the three choices; `close` departs
   every visit.
6. Correction closing the last keyholder's open visit at a past time, `close`:
   everyone departs at that time; someone who arrived after it stays inside.
7. Tombstone of the last keyholder's open visit with others inside: removed,
   nobody else departs.
8. Keyholder closes, then corrects their departure to an earlier time: every
   departure the close set moves to the new time, and the log shows each one's
   before and after.
9. Close choice copy: the warning to a keyholder states that no other keyholder
   is checked in.

The email to a named keyholder is not a flow-test assertion (flow tests see only
HTTP responses); an integration test covers it.

## 4a. Build order

One design, several PRs. Each PR amends the rules-doc lines for the part it ships.

1. **Close record and logging.** Each facility close becomes a record (who, when,
   path, choice); every departure it sets is logged against it with before and
   after. No behaviour change; it is what the later steps write to.
2. **Web choices.** The shared guard with close, leave or cancel by caller class,
   names gating, the keyholder pick-list and email, the one confirm dialog, the
   legacy `DELETE` and session scan on the shared guard, tombstone never closing,
   and the flow tests.
3. **Correcting a close.** A correction closes at the typed time; an earlier
   correction moves the departures its close set; a later one moves only the
   closer.
4. **Kiosk, server side.** The last keyholder's first badge checks them out and
   offers the close, with "no other keyholder is checked in" copy. The kiosk client already handles a close
   offer (it gets one today when another keyholder is recorded), so this ships
   before the client change.
5. **Kiosk, offline.** `client/client.py` runs the same single-badge leave and
   close offer while disconnected.

The trust principle ships on its own, in any order.

## 5. Other open questions

- Session-scan supervision interrupt: fixed separately (claude/gracious-mestorf-9dc204, 4aa71d25).

---

## Appendix: provenance

- Found while extending the route-coverage lint to the manual visit route
  (PR #1918); the warning body leaving through the side channel was the first
  sign.
- Related: #1437 (primary-keyholder model); the §VIII.3 stand-in Assumption
  touches it.
- Journeys: `docs/backlog/CUJS.md` A7 step 6 covers the kiosk double-badge close
  only; no journey covers a web close. The flow tests above would be its first
  coverage.
- Rejected: handover by checking the named keyholder in (needs both parties'
  agreement); refusing a non-keyholder's checkout (a gate where the rules put
  trust); inferring presence from the caller's network location (unreliable, and
  a signal the app has no reason to collect); a countdown after which an
  unconfirmed web close takes effect (an unattended countdown is never a confirm).
