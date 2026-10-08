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

A web checkout by the last recorded keyholder gives each kind of caller exactly
the choices policy and the owner allow, says who is inside only to someone
entitled to read the roster, and records who made the choice.

## Executive summary

- **The keyholder checking themselves out** gets an explicit choice instead of a
  yes/no close: close and check everyone out, hand over to a named keyholder who
  is in the room, or cancel. The handover needs owner sign-off; "leave the others
  inside with no keyholder" needs a Board decision, because it reads against
  Art. VIII §VIII.3.
- **A caller who is not a keyholder** (household lead, board member, sysadmin)
  can check the keyholder out only when that does not end the last keyholder's
  presence with others inside; otherwise the request is refused with a fixed
  message. Today's behaviour reads against Arts. VI–VII and is flagged for the
  owner.
- **Correcting** an open visit closed follows checkout's choices and closes at the
  typed time. **Removing** an open visit never closes the building.
- **No web warning carries names.** It carries a count, which every signed-in
  member already receives.
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
  **These are Policy-tier. This doc does not decide them; every option below that
  touches one is marked.**
- Assumption: nobody being inside without a keyholder is kept at the door; the
  app records such visits rather than refusing them.
- Procedure: "The keyholder close-guard fires on every close path…"; this doc
  would amend it.
- Procedure: "Any keyholder can close the building at the kiosk with a double
  scan…"; unchanged. The web design deliberately does not copy its "trust the
  keyholder to know they are the last one out" reasoning, because a web caller is
  not shown the room.
- Procedure: the facility is open only while a keyholder is present; people inside
  with no keyholder are shown as inside a closed facility. The state a "leave
  open" option produces is already representable.
- Procedure: a household lead corrects a recorded visit for anyone in their
  household on the same terms as their own; this doc would narrow that for one
  case.
- The kiosk naming rules (no last name, nothing beyond a display label).

From `docs/rules/principles.md`: least privilege ("a surface grants nothing its
gate does not already grant"), fail closed ("where finishing an operation would
take inventing a fact, refuse"), accountability ("a discretionary decision records
why").

From `docs/rules/people-households.md`: "Personal information is shared on a
need-to-know basis" (Records Policy Art. IV); leads act for their own household.

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
recorded inside, or to work around the dialog: check the other keyholder in from
the dashboard first (keyholders may check anyone in), then check out. The
workaround is correct; it is just undiscoverable.

### 2.2 Non-keyholders closing the building

Two kinds of caller who need not be keyholders can confirm a close:

- a **household lead** checking out, correcting or removing a keyholder household
  member's open visit, on the dashboard, the `household` page, or (API only) the
  session scan;
- a **board member or sysadmin** using the dashboard's Sign Out modal, or a session
  scan, on the last keyholder.

Arts. VI–VII say nobody closes a facility without being an active keyholder.
Whether the app's close (a record sweep that departs every open visit) is
"closing a facility" in the policy's sense is itself a question for the owner.
Either way, none of these callers is checked for being a keyholder, and none is
in the building by any test the app applies.

### 2.3 The names leak

| Caller | Reads the roster today? | Gets names from the warning? |
|---|---|---|
| Keyholder, board, sysadmin (not kiosk-signed) | Yes, full access on `GET /api/attendance` | Yes; no widening |
| Household lead with none of those roles | No; counts plus their own household only | **Yes; widening** |
| Kiosk screen | Yes, kiosk labels | Not a web path |

The leak's audience is a non-keyholder household lead, who may be anywhere. It
fails least privilege's per-field test, and Records Policy Art. IV need-to-know:
the lead needs to know their household member's visit closed, not who else is
inside. "The kiosk shows the names anyway" does not apply, because the kiosk shows
them to people standing in the building, and this caller need not be.

---

## 3. Decisions for the owner

### (a) Choices at web checkout for the last recorded keyholder

Applies when the caller is the keyholder themselves; non-keyholder callers are
(c).

| Option | What happens | Trade-off |
|---|---|---|
| A1. Status quo | Close and check everyone out, or cancel. | Forces a false close when another keyholder is there unbadged, or leaves the leaver recorded inside. |
| **A2. Close, hand over, or cancel** | Close as today; or name another keyholder, who is checked in on the spot (typed arrival entered by the leaver), then check out; or cancel. | Makes the record true when the other keyholder is present. Maps onto §VIII.3's "transfer the role". The app cannot verify the named keyholder's presence or consent; see (b). |
| A3. Close, leave others recorded inside, or cancel | Check out only the leaver; the others stay as visits with no keyholder, shown inside a closed facility. | Simplest, and honest about what the app knows. **Policy-tier:** reads against §VIII.3 ("cannot simply leave while the building is occupied") and Arts. VI–VII. Not the app's to decide. |

**Recommendation: A2.** It covers the owner's scenario without the app recording
a state policy forbids, and it turns a workaround keyholders can already do into a
visible choice. A3 only on a Board decision.

### (b) What "leave open" requires

| Option | Requirement | Trade-off |
|---|---|---|
| B1. Nothing | Checkout proceeds. | No trail of the judgement; fails *accountability*. |
| B2. A reason | Free-text reason stored on the audit row. | Records why, but the record still shows nobody in charge. |
| **B3. A named keyholder** | The leaver picks a keyholder; that person is checked in, the audit row names leaver, named keyholder and time, and the named keyholder is emailed that they were recorded as taking over. | The record shows a keyholder present, so the facility reads open truthfully if they are there. The email lets a falsely named keyholder see it. Consent is not verified. |
| B4. Board notification | Any of the above, plus an email to the board. | Noise on a routine handover; the board is not the party who can act within minutes. |

**Recommendation: B3, without B4.** It is the only form that squares with
Arts. VI–VII, because the record never shows people inside without a keyholder by
the leaver's choice. The named keyholder's consent then becomes an Assumption: "a
keyholder handing over from the web has the named keyholder's consent; the named
keyholder is told." Whether that meets §VIII.3's "with the other keyholder's
consent" is **Policy-tier and goes to the owner or Board**; a stricter form holds
the handover until the named keyholder confirms from their own session.

If the Board instead adopts A3, the minimum is B2 plus an audit row, and the rules
doc gains a Policy line citing the Board's decision.

Two details either way:

- The named keyholder must be a current keyholder with no open visit. Picking from
  a list shows keyholders' names to the leaver; the leaver is a keyholder and
  already reads the roster and the board contact directory, so this widens nothing.
- §VIII.4 (two adults with a last youth at closing) is untouched; the close option
  still cannot check it remotely, as today.

### (c) A non-keyholder caller and the last keyholder's visit

A household lead, board member or sysadmin acting on someone else's open
keyholder visit.

| Option | What happens | Trade-off |
|---|---|---|
| C1. Status quo | The caller sees the warning and can confirm a close. | **Policy-tier concern:** a non-keyholder closes the facility (Arts. VI–VII). |
| **C2. Refuse** | When ending this visit would leave others inside with no keyholder, the request is refused with a fixed message: the keyholder checks out themselves, or closes at the kiosk. | Respects Arts. VI–VII. The visit stays open until the keyholder acts or the overnight sweep closes it, which is the existing backstop. |
| C3. Check out only the member | The member's visit closes; the others stay inside with no keyholder. | The A3 Policy question, now decided by someone who is not a keyholder. |

**Recommendation: C2.** It needs no Board decision, because it is the stricter
reading. A caller who is a keyholder in their own right (a board member who also
holds keys) acting on another keyholder's visit is offered close or cancel, not
handover on someone else's behalf. Flag for the owner: the board's Sign Out modal
loses its power to close the building; that is the one place C2 removes a
capability a role uses.

### (d) Correction and tombstone paths

**A correction that closes an open visit** (a departure typed onto an open visit).

| Option | What happens |
|---|---|
| D1. Same choices as checkout, close at **now** | Today's timing: the leaver departs at the typed time, everyone else at the moment the correction is saved. |
| **D2. Same choices as checkout, close at the typed time** | Everyone departs at the leaver's typed departure, matching the kiosk's late-close rule ("everyone departs at the keyholder's scan time"). Anyone who arrived after it is left as they are. |
| D3. Narrower: a correction never closes | A correction that would close is refused with "check out instead". |

**Recommendation: D2.** Correcting a forgotten badge-out is exactly when the
keyholder is no longer in the building, and closing at "now" stamps departures
hours after the person who closed actually left. Handover is not offered on a
correction; a handover is a live act.

**A tombstone of an open visit** (saying "I was not here").

| Option | What happens |
|---|---|
| T1. Same as checkout | Removing the visit can close the building, as today. |
| **T2. Never closes** | The visit is removed; others stay recorded, now with no keyholder. If others are inside, the confirm states the count and that they will read as inside a closed facility. |
| T3. Refuse while others are inside | The removal waits until the building is empty. |

**Recommendation: T2.** A removal asserts the keyholder was never there; closing
the building on that basis invents departures for everyone else, which *fail
closed* forbids. The result is what the record would have shown had the visit
never existed, and the Assumption about the door already covers that state. T2
does not raise the A3 Policy question, because nobody is choosing to leave; the
record is being corrected. Owner to confirm that reading.

### (e) Names in the dialog

| Option | Who sees names |
|---|---|
| E1. Status quo | Everyone who reaches the warning. |
| E2. Roster-holders only | Names to callers whose `GET /api/attendance` is full access (keyholder, board, sysadmin, not kiosk-signed); a count to everyone else. |
| **E3. Nobody** | Every web warning carries a count; anyone who holds the roster opens the dashboard for names. |

**Recommendation: E3.** With C2 adopted, only keyholders ever reach a close
choice, and they read the roster already; names add little to a one-tap dialog and
cost a second response shape to keep right. The count is already in every
signed-in member's `GET /api/attendance`, so it widens nothing. The app cannot
tell on-site from remote for a web caller, so no option keys on location. The
kiosk is unchanged: names on the door display serve the people in the building.

### (f) The legacy `/api/attendance` route

| Option | What happens |
|---|---|
| **F1. Same rules now, migrate separately** | The new decision lives in the shared guard; the legacy `DELETE` and the session scan call it as the manual route does. Moving `DELETE /api/attendance` to `handler()` is its own work. |
| F2. Migrate first | Registry entry PR, then a route PR moving `DELETE /api/attendance` to `handler()`, then the behaviour change. |
| F3. Retire the web verb | Point the dashboard at the manual route and delete the legacy `DELETE`. |

**Recommendation: F1.** The leak and the Policy concern are in the shared guard,
so fixing it there fixes every caller at once; waiting on a migration leaves both
open longer. The new warning body is fixed and carries no model data, so it does
not depend on the stripper. The session branch of `POST /api/scan` stops using the
kiosk's inline copy and calls the same web guard; the kiosk path keeps its own.

---

## 4. Affected surfaces

**Response shape.** The warning becomes a fixed body with no model data:

- `type: "close_choice"` for a keyholder caller, with `othersInside` (a count),
  the allowed `choices` (`close`, `handover`, `cancel`, per the decisions), the
  token, and the seconds; or
- `type: "refused"` for a non-keyholder caller under C2, with a fixed message and
  the count.

No names, no person ids. A handover request carries the named keyholder's id, and
the server checks they hold the role and have no open visit. On the manual route
the body still leaves through the `withCloseGuard` side channel, since `handler()`
drops any key outside the bag. Replacing the side channel with a declared
"confirm required" response in `handler()` is a boundary change and ships alone;
this design does not need it.

**Confirm UI.** One shared dialog replaces the three in use (the dashboard modal
and two `window.confirm` calls) and the home page's press-again timer. It shows
the count and one button per allowed choice; handover adds a picker of keyholders.
Kiosk wording ("badge again") leaves the web copy. A non-keyholder gets a plain
notice with no buttons.

**Guard.** `lastKeyholderGuard` takes the actor as well as the subject, decides
the caller class, mints a token only when a choice will be offered, and the audit
row records the choice (actor, subject, choice, named keyholder). The legacy
`DELETE` writes that audit row too, which it does not today. The guard needs a
count, so it stops loading full person rows.

**Rules doc** (`docs/rules/attendance-checkin.md`), on merge:

- Amend "The keyholder close-guard fires on every close path…" to say which paths
  close, that a tombstone never does, and that a web warning names nobody.
- Add who may close from the web: a keyholder, for themselves or, being a
  keyholder, for another keyholder; never a non-keyholder. Tag with the Arts. VI–VII
  citation if the owner reads it as an expression of that policy.
- Add the handover rule and its consent Assumption, if B3 is adopted.
- Amend the household-lead correction rule with the C2 carve-out.
- A Board decision on A3 or §VIII.3 is recorded as a Policy line with its
  citation; this change does not write one on its own authority.

**Flow tests** (`checkin-app/flow-tests/last-keyholder-checkout.flow.test.ts`).
The seed has no household with a non-keyholder lead and a keyholder member; the
test builds one through the lead's member-add and the board's keyholder grant, or
the seed gains that persona (open question 4).

1. Keyholder alone checks out: closes, no warning.
2. Last keyholder with others inside checks out: the warning has a count and no
   names; confirming `close` departs every visit.
3. Handover: the named keyholder is recorded inside, the others stay inside, the
   facility reads open, the audit row names both.
4. Household lead checks out the last keyholder member with others inside:
   refused, no names, nothing closed, no token stamped.
5. Board member uses the legacy `DELETE` on the last keyholder: refused, if C2
   covers the board.
6. Correction closing the last keyholder's open visit at a past time: everyone
   departs at that time; someone who arrived after it stays inside.
7. Tombstone of the last keyholder's open visit with others inside: removed,
   nobody else departs, the facility reads closed with people inside.

## 5. Open questions

1. Is the app's record close "closing a facility" under Arts. VI–VII, or a
   bookkeeping act that reflects a physical close? The answer decides whether C1
   is a Policy violation or a Procedure choice. **Owner, possibly Board.**
2. Does a web handover with a notification satisfy §VIII.3's "with the other
   keyholder's consent", or must the named keyholder confirm first? **Policy-tier.**
3. "Primary keyholder" (§VIII.3) is not modelled; the app treats every keyholder
   alike. Is "the last recorded keyholder" an acceptable stand-in for the primary
   one? If not, that is a separate gap for the tracker.
4. Seed a "keyholder household member under a non-keyholder lead" persona, or have
   the flow test build it?
5. Should the board's dashboard Sign Out keep the power to close the building, the
   one capability C2 removes from a role that uses it?
6. Outside this design: the session scan raises the supervision interrupt, which
   the rules say is badge-only. A separate fix or a rules correction.

---

## Appendix: provenance

- Found while extending the route-coverage lint to the manual visit route
  (PR #1918); the warning body leaving through the side channel was the first
  sign.
- Journeys: `docs/backlog/CUJS.md` A7 step 6 covers the kiosk double-badge close
  only; no journey covers a web close. The flow tests above would be its first
  coverage.
- Rejected without a table: inferring presence from the caller's network location
  (unreliable, and a location signal the app has no reason to collect); and a
  countdown after which an unconfirmed web close takes effect (an unattended
  countdown is never a confirm, per the kiosk rule).
