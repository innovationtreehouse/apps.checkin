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

- **A keyholder checking out** chooses between three things: close the building
  and check everyone out; leave, checking out only themselves, while naming the
  keyholder they believe is still inside; or cancel. Naming that keyholder only
  writes their name on the audit row. It does not check them in, because checking
  someone in needs their agreement and the app cannot get it at that moment.
- **A caller who is not a keyholder** (household lead, board member, sysadmin) can
  always check the keyholder out. What else they may choose is still open (§3,
  question 1).
- **Correcting** an open visit closed offers the same choices and closes at the
  typed time. **Removing** an open visit never closes the building.
- **Names** go to callers who already read the full roster: keyholders, so that
  checking out on the web gives them what the kiosk would show. Everyone else gets
  a count, which every signed-in member already receives.
- **All four web paths** run one shared decision, including the legacy dashboard
  route and the home-page toggle that currently runs the kiosk's copy of the guard.
- **Not changing:** the kiosk. A keyholder at the reader still closes with a double
  badge, and the kiosk still names who is inside on a screen in the building.

## Rules this relies on or would change

From `docs/rules/attendance-checkin.md`:

- Policy, Keyholders: "Nobody opens or closes a facility without being an active
  keyholder" (Arts. VI–VII); "A primary keyholder leaving must either transfer the
  role, with the other keyholder's consent, or close the facility" (Art. VIII
  §VIII.3); the closing keyholder ensures two adults with a last youth (§VIII.4).
  **Policy-tier.** The "leave" choice and any close by a non-keyholder touch these;
  §3 says how this design reads them and asks the owner to confirm the reading.
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

**Choices for a keyholder checking out as the last recorded keyholder: close,
leave, or cancel.**

- *Close* checks the leaver out and departs every open visit, as today.
- *Leave* checks out only the leaver. The others stay recorded inside with no
  keyholder, which every surface already shows as inside a closed facility. The
  leaver names the keyholder they believe is still inside; the name goes on the
  audit row with the leaver, the time and the count of people left inside. The
  named keyholder is **not** checked in: an arrival recorded for someone needs
  their agreement, and the app has no way to get it at that moment.
- *Cancel* changes nothing; the leaver stays recorded inside.

How this reads against policy. §VIII.3 lets a primary keyholder leave an occupied
building only by transferring the role with the other keyholder's consent. This
design treats that transfer and its consent as happening in the room, between the
two keyholders, and the app records the leaver's statement that it happened. That
is an Assumption in the register's sense: handled outside the app, and recorded.
The owner confirms this reading or takes it to the Board (§3.2, question 2).

**A non-keyholder can always check the last keyholder out.** Refusing them would
put a gate where the visit-record rules put trust and review after the fact. What
they may choose beyond checking the keyholder out is open (§3.2, question 1).

**Names go to keyholders, not to non-keyholders.** A keyholder who checks out on
the web instead of at the kiosk sees who is inside, as the kiosk would show them.
A non-keyholder sees a count.

**Rejected: handing over to a named keyholder by checking them in.** It needs both
keyholders to agree, and the app can only hear from one of them.

### 3.2 Still to decide

**1. What a non-keyholder caller may choose.** A household lead, board member or
sysadmin who is not a keyholder, ending the last keyholder's visit with others
inside.

| Option | What happens | Trade-off |
|---|---|---|
| **N1. Leave or cancel** | The keyholder is checked out; the others stay inside with no keyholder. No close offered. | The checkout always works, and a non-keyholder never closes the building (Arts. VI–VII). |
| N2. Close, leave or cancel, with a count | As a keyholder, but without names. | A close chosen blind, by someone who may not be there. **Policy-tier:** a non-keyholder closing. |
| N3. Close, leave or cancel, names for roster-holders | Board and sysadmin see names, leads a count. | Same Policy question as N2, for board and sysadmin. |

Recommendation: **N1.** It keeps the trust ruling (nothing is refused) and stays
inside Arts. VI–VII. The non-keyholder is not asked to name a keyholder; they may
not know one, and the audit row records that a non-keyholder left the building
open. The board Sign Out modal loses its power to close; a board member who wants
the building closed and is not a keyholder asks one.

**2. Is "leave" within §VIII.3?** The owner's reading above, that the transfer and
consent happen in the room, or a Board decision. **Policy-tier.**

**3. Naming on "leave": required or optional, and from what list?**

| Option | What happens |
|---|---|
| **L1. Required, picked from current keyholders** | The leaver picks from keyholders with no open visit. |
| L2. Required, picked or typed | As L1, plus free text for "someone not on the list". |
| L3. Optional | The leaver may skip it. |

Recommendation: **L1.** A pick is a person id the audit trail can follow; free
text is not. Listing keyholders' names to a keyholder widens nothing, since they
already read the board contact directory.

**4. Is the named keyholder told?**

| Option | What happens |
|---|---|
| **K1. Email the named keyholder** | "X left at 18:40 and named you as the keyholder inside; N people are recorded inside." |
| K2. Audit row only | Nobody is told. |
| K3. Email the board | As K1 or K2, plus the board. |

Recommendation: **K1.** It costs one email, it is the only way a wrongly named
keyholder finds out, and it nudges the right one to badge in so the record reads
open. It is not a request for consent and does not change any visit.

**5. Who gets names: keyholders only, or everyone who reads the full roster?**
Board and sysadmin already receive every name on `GET /api/attendance`. Giving
them names in the warning widens nothing; withholding them is consistent with
"keyholders". Recommendation: **everyone with full roster access**, because the
rule then reads off an existing gate rather than defining a new audience. Under
N1, board and sysadmin who are not keyholders are never offered a close, so the
names only tell them who they are leaving inside.

**6. Correction and tombstone.** Previously recommended, now reconciled with the
three choices; confirm both.

- A correction that closes an open visit offers close, leave or cancel, and a
  close departs everyone at the **typed** departure, matching the kiosk's
  late-close rule. Anyone who arrived after it stays inside. Today it closes at
  "now", stamping departures hours after the keyholder actually left.
- Removing an open visit never closes the building. A removal asserts the
  keyholder was never there; closing on that basis would invent departures for
  everyone else, which *fail closed* forbids. The confirm states the count and
  that they will read as inside a closed facility. No name is asked, because
  nobody is choosing to leave.

**7. Does the kiosk get "leave" too?** At the kiosk today, the last keyholder with
others inside gets the close warning and, without a second badge, stays recorded
inside. The other keyholder is standing in the room and can badge in, so the kiosk
does not need "leave". Recommendation: **no change to the kiosk.** The web and the
kiosk then differ deliberately, and the rules doc says so.

**8. Write down "we trust people" as a principle?** The owner's ruling on
non-keyholders rests on a stance the register states only for the visit record
("integrity is after the fact rather than a gate") and the kiosk ("we trust the
keyholder"). It is cross-cutting and a change could violate it, which is the test
for `principles.md`. Recommendation: **yes, as its own change**, worded so it
does not override Policy-tier rules: the app records and reviews rather than
blocks, except where policy requires a block.

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
  (`close`, `leave`, `cancel` for a keyholder; `leave`, `cancel` for a
  non-keyholder under N1), the token, and the seconds;
- `names` only when the caller reads the full roster (question 5); kiosk labels,
  as today;
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

- Amend "The keyholder close-guard fires on every close path…": the three web
  choices, who gets which, which paths can close (a tombstone cannot), and who
  sees names.
- Add the Assumption: a keyholder who leaves the building occupied has handed over
  in person to the keyholder they name.
- Add a line that the kiosk does not offer "leave", tagged deliberate limit.
- Record whatever the owner or Board decides on §VIII.3 at the Policy line it
  qualifies.

**Flow tests** (`checkin-app/flow-tests/last-keyholder-checkout.flow.test.ts`).
The seed has no household with a non-keyholder lead and a keyholder member; the
test builds one through the lead's member-add and the board's keyholder grant, or
the seed gains that persona (question 9).

1. Keyholder alone checks out: closes, no warning.
2. Last keyholder with others inside: the warning carries names and the three
   choices; `close` departs every visit.
3. `leave` naming keyholder2: only the leaver departs; keyholder2 has no visit;
   the facility reads closed with people inside; the audit row names keyholder2.
4. Household lead checks out the last keyholder member: the warning has a count,
   no names, and no `close`; `leave` checks the member out and departs nobody else.
5. Board member uses the legacy `DELETE` on the last keyholder: as test 4, with
   names if question 5 goes that way.
6. Correction closing the last keyholder's open visit at a past time, `close`:
   everyone departs at that time; someone who arrived after it stays inside.
7. Tombstone of the last keyholder's open visit with others inside: removed,
   nobody else departs.

## 5. Other open questions

9. Seed a "keyholder household member under a non-keyholder lead" persona, or have
   the flow test build it?
10. "Primary keyholder" (§VIII.3) is not modelled; the app treats every keyholder
    alike. Is "the last recorded keyholder" an acceptable stand-in for the primary
    one? If not, that is a separate gap for the tracker.
11. Outside this design: the session scan raises the supervision interrupt, which
    the rules say is badge-only. A separate fix or a rules correction.

---

## Appendix: provenance

- Found while extending the route-coverage lint to the manual visit route
  (PR #1918); the warning body leaving through the side channel was the first
  sign.
- Journeys: `docs/backlog/CUJS.md` A7 step 6 covers the kiosk double-badge close
  only; no journey covers a web close. The flow tests above would be its first
  coverage.
- Rejected: handover by checking the named keyholder in (needs both parties'
  agreement); refusing a non-keyholder's checkout (a gate where the rules put
  trust); inferring presence from the caller's network location (unreliable, and
  a signal the app has no reason to collect); a countdown after which an
  unconfirmed web close takes effect (an unattended countdown is never a confirm).
