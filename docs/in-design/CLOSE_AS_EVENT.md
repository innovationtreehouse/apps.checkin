# A building close is one event

A close is one fact: **keyholder K closed the building at time t, via kiosk
live, kiosk offline, or the web**. The kiosk (or the web confirm dialog)
decides. The server records the decision and carries it out. It never judges
it again.

Reference behaviour: the owner-reviewed intended state machine (the "Closing"
section). Analysis it answers: the modeling brief's scenarios S1–S3 and items
MC-A1–A4, MC-B1 and MC-C1–C3.

The rollout and the one-time cutover are in `CLOSE_AS_EVENT-migration.md`.

---

## 1. What is wrong today

Each item below names the code on `main` at the time of writing.

| # | Problem | Where |
|---|---|---|
| P1 | The server judges the kiosk's close again. It mints a warn token or an offer token, parks `force_close_review`, applies a 10-minute freshness window with a narrow late-close bypass, and compares against its own records. | `scan-service.ts` `processCheckout`, `closeOnOfferConfirm`; `scan/route.ts` late-close block and replay parking |
| P2 | The kiosk and the web share `Visit.forceCloseToken`. The web guard re-mints it without a lock. A web leave, remove, staff tombstone or role revoke makes a pending or queued kiosk confirm fail. | `lastKeyholderGuard`; `attendance/route.ts` DELETE; `attendance/manual/[id]`; `project.ts` (`conflict_out_no_in`) |
| P3 | The close is decided in the scan transaction but carried out after commit, in another transaction. A crash in between loses it. The kiosk's resend is then deduped on `clientEventId`, so nothing runs it again. | `finalizeFacilityClose` → `closeWithRetry` → `runFacilityClose`; route dedup pre-read |

## 2. The model

### 2.1 State

Server (Postgres):

- `Visit(person, arrivedAt, departedAt, departedVia, deletedAt, facilityCloseId)`.
- `FacilityClose(id, closedAt = t, closedById = K, via, clientEventId?, executedAt?, createdAt)`.
  A row with `executedAt IS NULL` is a **recorded, unexecuted close**.
- `RawBadgeLog(clientEventId unique, reviewReason?)`. Every scan has one.

Kiosk (Python):

- `outbox`: durable rows. Each has `close ∈ {none, alone, confirmed}`.
- `present`: the shown roster, which is the server roster plus the kiosk's queued scans.
- `known_keyholders`: every keyholder id the roster has shown since the kiosk process started.
- `prompt`: either `(K, armedAt, deadline)` or nothing. It is volatile.

Derived, never stored: *open* ⇔ some live visit of a keyholder has `departedAt IS NULL`.

### 2.2 Kiosk actions (the same online and offline)

A badge read `b`, after kiosk debounce, does the following:

| Guard | Effect |
|---|---|
| `prompt = (b, …)`, within the deadline | `close := confirmed`, `intent := OUT`. Clear `prompt`. Show "Building closed". Clear `present`. |
| `prompt = (K, …)`, `K ≠ b` | Clear `prompt`. Then handle `b` as an ordinary scan (rows below). K has already left. |
| `prompt` has expired | Clear `prompt`. Handle `b` as an ordinary scan. |
| `b ∈ present`, `b ∈ known_keyholders`, `present \ {b} = ∅` | `close := alone`, `intent := OUT`. Show "You are closing the building. The building should be empty." Clear `present`. |
| `b ∈ present`, `b ∈ known_keyholders`, `present \ {b} ≠ ∅` | `close := none`, `intent := OUT`: a plain checkout. Show the names shown inside and "Scan again within 15 s to close". Arm `prompt := (b, now, now + 15 s)`. |
| otherwise | An ordinary IN/OUT toggle from `present`. `close := none`. |

Every scan, a close included, is written to the outbox first and then sent.
The `close` value travels with it. The kiosk delivers the row live when it
can, and through the drain otherwise. It removes the row only when the server
has acknowledged it.

A repeat read of the same badge within 3 s (the kiosk's repeat-read filter) never reaches this table, so a second badge is always more than 3 s after the first.

### 2.3 Server actions

**ScanTx(scan)**: one transaction under the person lock.

1. Dedup. If `RawBadgeLog(clientEventId)` already exists, return `duplicate_ignored`. Then go to **ReDrive**.
2. If `scan.close ≠ none` (a **close request**):
   - **Live, from a non-keyholder: refused.** The scan goes on as an ordinary scan (below); the reply adds `closeRefused` and "Only a keyholder can close the building.", and the kiosk drops the badge from its keyholders.
   - Skip the debounce, the freshness window, the out-of-order check and every park. A close is never held.
   - Let `t := min(eventTime, now)`. `eventTime` is server now on a live scan and `scannedAt` on a replay.
   - Write `RawBadgeLog`. It gets a `reviewReason` (applied *and* flagged) only when one of these holds:
     the row was dead-lettered (`client_dead:<status>`), the clock is suspect
     (`clock_suspect`), or, on a late delivery, K is not a keyholder now (`close_not_keyholder`, see §5).
   - If K has a live open visit with `arrivedAt ≤ t + skew`, check it out at `max(t, arrivedAt)` as `SCANNER`, event chunking included.
   - **Unseen check-ins (D9).** Let `U` be the open visits of anyone else with `rosterAsOf < arrivedAt ≤ t + skew`. These are check-ins the kiosk's roster could not have shown; `U = ∅` when the scan carries no `rosterAsOf`.
     - **Live `close: alone` with `U ≠ ∅`: hold.** Record no close. K's checkout stands as a leave (the `last_keyholder_choice` audit row). The reply is `facilityClosed: false` with a `closePrompt` naming `U` and their check-in times. The kiosk shows it and arms its prompt, and a second badge (`close: confirmed`) closes. Then commit.
     - **Otherwise:** continue below. If `U ≠ ∅`, the scan is flagged `close_stale_roster` (unless it is already flagged), and an audit row against the close lists `U`.
   - Insert `FacilityClose{closedAt: t, closedById: K, via, clientEventId, executedAt: NULL}`.
   - Append a `PresenceEvent` (OUT, PROJECTED).
   - Commit. The checkout, the scan record and the close record commit together, or none of them do.
3. Otherwise, run today's scan path with every close judgement removed. A
   keyholder's OUT is a plain checkout: only that keyholder leaves.

**Execute(c)**: one transaction under the facility lock, after the commit.

- Lock order is the one every visit path uses, the nightly sweep included: the person lock of everyone the sweep may depart, in ascending id, then the facility lock. A lock holder never waits for a lock that comes earlier in that order, so Execute cannot deadlock with a scan or the nightly sweep.

- `SELECT … FROM "FacilityClose" WHERE id = c AND "executedAt" IS NULL FOR UPDATE`. If no row comes back, return. It is already executed, so Execute is idempotent.
- Sweep (§4). Then set `executedAt := now()`.
- Commit. Then invalidate the attendance cache and kick the post-event emails.

**ReDrive**: run **Execute** on every row with `executedAt IS NULL`, ordered by
`closedAt`, then `id`. It runs:

- after every `/api/scan` request, whether it committed, deduped, or found nothing to close;
- after every web close;
- at the start of the nightly cron, before its own sweep.

A failure in Execute is logged and left for the next ReDrive. It is never
thrown into the response, because the close is already durable.

**Crash(any point)**: whatever committed stays. A crash before the ScanTx commit
loses nothing. The kiosk still has the row and resends it. A crash after the
commit leaves an unexecuted close, and the next ReDrive executes it. That can
be the kiosk's resend, which dedups and then re-drives, or any other scan, or
the cron.

### 2.4 Web actions

**WebClose(K)**: the close-choice dialog. It shows who is still recorded IN.
When K chooses *close*, K is checked out (`TYPED`); then the close is recorded at
`t = now` (a correction's typed time), `via ∈ {WEB_CHECKOUT, WEB_DASHBOARD,
WEB_CORRECTION}`, with `closerVisitId` set to K's departed visit when K closed
their own visit. A ReDrive follows. The record comes after the checkout so the
link can find the departed visit (D8).

- Only a keyholder may choose *close* (owner ruling: closing is a keyholder permission, not a board one): K checking themselves out, or a keyholder who is also on the board ending someone else's visit. A board member without the keyholder flag can no longer close. Correcting a close's time afterwards is a separate permission and stays with the board (#1988).
- *Leave* and *cancel* are unchanged.

The dialog's state lives in `Visit.forceCloseToken`, `forceCloseWarnedAt` and
`forceCloseActorId`. These columns are **web-only** now. No kiosk path reads
or writes them, so nothing the web does to them can reach a kiosk close.

**WebLeave / WebRemove / StaffTombstone / WebCheckout(K) / RoleChange / WebCheckin(K2)**:
these act on visits and roles only. None of them touches a `FacilityClose` row,
a kiosk close request, or the outbox.

## 3. Wire contract (scan protocol 6)

A kiosk scan body gains one field. Only a signed kiosk may send it: it joins
`KIOSK_ONLY_FIELDS`.

```jsonc
{
  "participantId": 42,
  "intent": "OUT",
  "close": "alone" | "confirmed",   // absent = not a close
  "rosterAsOf": "2026-10-12T20:58:30Z", // server time of the kiosk's last roster; with a close only
  "clientEventId": "…", "scannedAt": "…", "replay": true, "protocolVersion": 4
}
```

- `t` is the scan's own event time: server now when the scan is live, `scannedAt` when it is a replay. The live rule, that a scan never takes the kiosk's clock, is unchanged.
- `close` implies `intent: OUT`. `close` together with `intent: IN` is a 400.
- The server treats `alone` and `confirmed` the same way, except for a live `alone` close with an unseen check-in, which is held (§2.3, D9). The kind is logged.
- `rosterAsOf` is the HTTP `Date` header of the kiosk's last successful `/api/attendance`. That is server time, so kiosk clock drift does not enter it. The kiosk keeps it in memory and in the outbox row; it has none after an offline restart until a roster arrives. It is accurate to the second, so the error falls on the side of holding.

**Legacy signals map to a close request, for kiosk callers only.** Every one of
these is a decision the kiosk already made under the old protocol, so it is
honoured without verification:

| Old body | Read as |
|---|---|
| `forceCloseConfirmed: true` (offline two-scan confirm) | `close: "confirmed"` |
| `forceCloseToken: "<any string>"` from a kiosk (an armed confirm) | `close: "confirmed"` |

The server no longer stores a kiosk token, so a token is not checked against
anything. A signed kiosk echoes a token only on the second scan of the same
badge inside its countdown, which is exactly the "confirmed" decision.

**A kiosk below protocol 6 sends no close request, so its keyholder checkout
still decides the close** (`LegacyKiosk` in `processCheckout`). This is #1992's
rule, kept for that kiosk generation only:

| Kiosk sent | Server records | Outcome |
|---|---|---|
| `shownEmpty: true` | anything | a one-badge close request (`close: "alone"`), on any protocol |
| `shownEmpty: false` | anything | leave + close offer (live) |
| nothing | no other keyholder, nobody else inside | close at t |
| nothing | no other keyholder, others inside | leave + close offer (live) |
| nothing | another keyholder inside | checkout + close offer (live) |

- A close decided this way is recorded in the checkout's transaction, exactly like a close request.
- The offer's token is random and is not stored. The kiosk's echo reads as `close: "confirmed"`.
- On a replay there is no offer.

From protocol 6 on, `shownEmpty: false` is ignored and the server never decides a
close from its own records.

`SCAN_PROTOCOL_VERSION` becomes **6** (`CLOSE_REQUEST_PROTOCOL_VERSION`). A kiosk advertising N supports every generation at or below N: 3 = the repeat-read filter (#1997), 5 = `shownEmpty` and trusted replays (#1995), 6 = the close request. The kiosk:

- sends live only when the server advertises 6 or more;
- otherwise queues every scan, and the drain holds it, as it does today for a newer generation.

So a new kiosk on an old server shows "will sync" and loses nothing. It never
sends a `close` that an old server would silently ignore.

## 4. The sweep

`Execute(c)` with `t = c.closedAt`, `skew = 2 min` (`LATE_CLOSE_SKEW_MS`):

```
for each live visit v (deletedAt IS NULL)
  with v.arrivedAt ≤ t + skew
  and ( v.departedAt IS NULL
        or (v.departedVia ∈ {AUTO_CLOSE, FACILITY_CLOSE} and v.departedAt > t) ):
    v.departedAt     := min(max(t, v.arrivedAt), v.arrivedAt + 24 h)
    v.departedVia    := FACILITY_CLOSE
    v.facilityCloseId:= c
    audit (before, after) against c
```

- **Unchanged from today:** the skew, the 24-hour cap, the tombstone exclusion, pulling back AUTO_CLOSE departures (chunked segments included), and leaving a departure a person typed alone.
- **New (D4):** a late close also pulls back a *FACILITY_CLOSE* departure set by a later close. Example: K1 closes at t1 offline, then K2 closes at t3 live, and the t1 close drains after that. Anyone who arrived by t1 was gone by t1, so their departure moves back to t1. Before this, the order in which the closes arrived decided the record.
- **Never touched:** a visit that began after `t + skew`. Arriving after a close starts a new visit.

## 5. Decisions taken (owner may overturn)

- **D1 — role at time t.** The kiosk offers the close to `known_keyholders`. Its list grows from every roster and drops a badge a roster shows without keys, or one the server refused.
  - **Live** (owner rule: only keyholders close): t is now, so the server checks the role. A non-keyholder's close is refused, and that badge is checked out as itself.
  - **Late delivery:** the app keeps no role history, so "keyholder at t" can't be checked. A role revoked between t and delivery cannot stop the close; that is what the "changing roles" clause of intended Closing.6 requires. The close applies and is flagged `close_not_keyholder`.
  - **Web:** the close checks the role when the request is made, which is the same moment as t.
- **D2 — the first OUT of a two-scan close is a plain checkout,** sent at once. The second scan is a separate close request. The keyholder may already be checked out (by the first scan, the web, the cron) or have their visit tombstoned. In every case the close is recorded and executed. A close request never needs a visit.
- **D3 — the close time on a two-scan close is the second scan's time,** not the first's. The two are at most 15 s apart. The owner's ruling is that departures are stamped "when the keyholder left", and both scans happen before the keyholder walks out.
- **D4 — closes apply in close-time order,** whatever their arrival order (§4).
- **D5 — kiosks below protocol 6 keep #1992's checkout rule** (§3 table): `shownEmpty`, else the server's records. Without it, an old kiosk's lone keyholder would leave without closing the building during the rollout. Only protocol-6 kiosks get "the server never decides from its own records". The table is removed once the kiosk reports protocol 6 (migration doc).
- **D9 — a stale kiosk roster (owner-approved 2026-10-12).** The keyholder and the kiosk are trusted, but the server warns when the kiosk's view was stale. Example: a web check-in at 20:58, the kiosk roster failing to refresh, and the keyholder badging at 21:00 to close. Live, the one-badge close is held, and the server names who checked in after the kiosk's roster; the second badge closes. A late or offline close is applied as the keyholder meant, and flagged for review naming who it may have swept out. There is no sync wait at the kiosk: the live server check covers it. A confirmed (second-badge) close is never held, only flagged when it sweeps an unseen check-in. After a hold, the kiosk refetches the roster, so the confirm carries a fresh `rosterAsOf` and is not flagged.
- **D8 — a web close is recorded in the transaction that checks the visit out** (`recordWebClose`). This covers the scan route's web checkout, the dashboard checkout and the closing correction. It runs after the checkout inside that transaction, so `closerVisitId` can link the departed visit, and a crash loses neither the checkout nor the close. `finishCloseGuard` then only carries the close out, and records it itself only for a caller that did not.
- **D6 — the web close shows the server's view, not the kiosk's.** It applies at `now`, and the edit screen corrects times afterwards (owner, 2026-10-11).
- **D7 — re-drive points** are the scan route, web closes and the nightly cron. There is no boot hook, because `instrumentation.ts` touches no database by design. An executor that crashes after the response is sent stays stranded until the next scan or midnight, whichever comes first. The cron re-drives before it sweeps, so a stranded close always departs people at t, never at midnight.

## 6. How each analysis item comes out

| Item | Today | After |
|---|---|---|
| MC-A1 Lone keyholder's queued OUT, server still records others | parks `force_close_review` / `stale_replay` | The kiosk showed nobody else and sent `close: alone`. It closes at t, unflagged. |
| MC-A2 Online offer, confirm queued by an outage | the bypass misses a SCANNER-departed visit | `close: confirmed` needs no visit and closes at t2 |
| MC-A3 Token confirm after the cron chunked the visit (token dropped) | `force_close_review` | No token. Closes. The sweep pulls back every AUTO_CLOSE segment that started by t + skew. |
| MC-A4 Link flap mid-countdown, armed close sent live | the flag is ignored live | Live and replay are the same: it closes |
| MC-B1 Crash between commit and sweep, then a resend of the same id | close lost | The FacilityClose row is durable. The resend dedups, then ReDrive executes it. |
| MC-C1 Web guard re-mints the token mid-countdown | the kiosk confirm fails | The kiosk uses no token |
| MC-C2 Web leave, remove or tombstone of K's visit before the confirm | `conflict_out_no_in` | A close request needs no visit (D2) |
| MC-C3 Web checkout, backdated keyholder, or role revoke before a queued close | `out_of_order` / plain checkout | Closes. A backdated keyholder arriving by t + skew is swept. Revoke → flagged (D1). |

Invariants this enforces, as named in the brief:

- **TrustedCloseCloses:** a durable close row exists, plus ReDrive.
- **WebCannotStopClose:** a close request reads no web-written state.
- **CloseRecordConsistent:** Execute runs under the facility lock and is idempotent.

## 7. What is removed

Server (`checkin-app/src`):

- `scan-service.ts`:
  - the keyholder branch of `processCheckout`: remaining-keyholder counting, warn, minting the offer token, `force_close_review`, `offlineConfirmed`, the `confirmToken`, `replayEventId`, `forceCloseConfirmed` and `webClose` parameters;
  - `closeOnOfferConfirm`;
  - `sweepIfStandalone`, `runFacilityClose`, `finalizeFacilityClose`, `closeWithRetry`;
  - `closeVia(authType, replay)`, which is replaced by the via on the recorded row;
  - the close call in `finishCloseGuard`, which now only audits and emails.
- `scan/route.ts`: the `lateCloseVisit` lookup and its `force_close_review` park, the close exemption threaded through the freshness checks, the post-commit `finalizeFacilityClose`, and kiosk use of `forceCloseToken` in the debounce `isConfirm`.
- `presence/project.ts`: the `closeOnOfferConfirm` fallback. An OUT with no open visit and no close request is `conflict_out_no_in`, as it always was.
- Kiosk-facing copy: the "Warning! You are the last keyholder…" body and the offer `closePrompt`.

Kiosk (`client/`):

- the server confirm token: `arm_confirm`, `take_confirm`, `confirm_token`, and the token argument on new rows;
- the old `offline_close_offer` from the roster count;
- reading `forceCloseToken` and `confirmSeconds` from responses.

The one prompt (`prompt` in §2.1) replaces both the online and the offline confirm.

Kept on purpose:

- the `Visit.forceClose*` columns, which the web dialog still uses;
- `FORCE_CLOSE_CONFIRM_SECONDS`, the web dialog's window;
- the `force_close_review` label in the review panel, for rows already parked under it.

## 8. Rebasing on the open work

The design touches the same files as several open PRs. It is laid out so each
rebase is mechanical:

| PR | Overlap | Resolution |
|---|---|---|
| #1992 (kiosk server side: first badge is a leave + offer; honours `shownEmpty` live and on replay) | `processCheckout` keyholder branch, late-close check | If #1992 lands first: **keep** its single-badge leave and its `last_keyholder_choice` audit row (`choice: leave`, `via: KIOSK`/`KIOSK_OFFLINE`), written on a keyholder's plain OUT. **Remove** the offer token on the departed visit, token matching in `processCheckout`, `closeOnOfferConfirm`, the route's late-close check and the remaining `force_close_review` park. Its leave/offer/`shownEmpty` rule is kept for kiosks below protocol 6 (§3, D5); from protocol 6 the close request decides. Its flow test gains a protocol-6 case. **Done: #1996 is rebased on #1992 + #1988.** |
| #1993 (outbox before send) — merged | `handle_scan`, `outbox.enqueue` | Rebased on it. Every scan, a close included, is written and claimed in flight before the live send. `close` and `roster_as_of` are two more `enqueue` fields. The "confirmed close never goes live" special case is gone, because live and replay closes are now the same. |
| #1995 (late replays apply + flag; `shownEmpty`, protocol 5) — merged | route park logic, `shownEmpty`, protocol number | Rebased on it. Close requests bypass parking before #1995's apply-and-flag code runs, so the two compose. Its `shownEmpty: true` is a one-badge close request; `false` or unsaid goes through the §3 table, for kiosks below protocol 6. Its late-close lookup is replaced by the close request. Kept, its rulings on replays: a pre-close IN delivered after the close departs at that close (`closed_before_delivery`), a later OUT pulls a machine departure back (`out_of_order`), a token-less replayed keyholder leave is flagged `force_close_review`, and a stamp ahead of now applies at now flagged `clock_suspect`. The D-2 fence (§9) then only matters for live arrivals. |
| #1994 (heartbeat display) — merged | none in code | — |
| #1988 (correct a close at the typed time; `closerVisitId`; board may correct a close's time) | `FacilityClose` columns, `closeAllOpenVisits` | Additive both ways; keep its correction cascade and the board's right to correct (correcting is not closing). `recordClose` sets `closerVisitId` in the same transaction: K's visit `processCloseRequest` checks out, or the visit the web close departs; null when the close request found no open visit of K's. |
| #1997 (repeat reads filtered at the reader, protocol 3) — merged | `handle_scan`, the dead-front, the server debounce | Rebased on it. Its 3 s filter runs before the §2.2 table, and replaces this design's 1 s dead-front. A close request skips the server debounce on any protocol. |
| #2032 (sliding repeat-read and close windows) — merged | `is_repeat_read`, `arm_local_close`, `slide_close` | Rebased on it. A held badge's repeat read restarts the close prompt (or the held stale-roster prompt) at 15 s and re-shows its banner; there is no server-token arm left to slide. |
| #1998 (kiosk's own roster offline; one-scan close notice; offline prompt lists who is inside) — merged | proxy, `seed_from_attendance`, banners | Rebased on it. The prompt lists names from its `known_people`, and "Checked in offline" for a badge no roster has shown. A proxied roster also records the response `Date` as `rosterAsOf`, so a close sends the time of the roster the kiosk shows. Its one-scan close notice is kept for a server reply that closed without a confirm. |
| kiosk display task | the shown roster | `present` is what the display shows. The prompt reads the same names. |

## 9. Findings from the TLA+ model

The TLA+ model of the intended design is in the Guidance checkin-analysis
`spec/` folder (`CheckinBase.tla`). With no clock drift, every safety
property holds. It raised three points about the intended design. Each is
handled or stated here.

**D-1 — the kiosk's view after a restart.** The model assumes the ack carries
the roster. This design does not do that.
- After every acked scan, the kiosk fetches a fresh roster, and it does the same at boot (`main()`).
- An ack means the server has committed the scan, so a roster fetched after it already reflects that scan.
- A restart while online therefore shows the right direction.
- A restart while offline has no roster: the kiosk shows only its queued scans (the outbox overlay). A person checked in before the restart, with nothing queued, is shown as out, and their next scan goes in as IN, which is flagged `conflict_double_in`.
- Keeping the last roster on disk is the kiosk display task's to add. This PR does not change it.
- A close prompt does not survive a restart. The keyholder scans again, and the kiosk decides again from what it shows.

**D-2 — kiosk scan time against web and cron events.** A queued scan is placed
by its kiosk `scannedAt`. A queued check-in from before a close can be
delivered after the close has run, and then sits open after it. If it is a
keyholder's, the web would show the building open (NoFalseOpen). That can
happen with or without clock drift.
- **Rule: a close is a fence for "open"** (`getFullAttendance`). Take the latest executed close. A keyholder visit does **not** reopen the building when it arrived by that close's time plus `LATE_CLOSE_SKEW_MS` **and** before the close was carried out (`executedAt`). Such a visit is a check-in scanned before the close and delivered after the close ran.
  - A live arrival after a close is stamped with server time after the close ran, so it reopens the building, however soon after the close it comes.
  - The nightly sweep runs on an empty building, so any arrival within the skew of it does not reopen.
- The late visit is kept as it is, and it is still listed as inside. Its own queued OUT still checks it out at the OUT's time. Departing it at the close instead would make that OUT a conflict. The nightly sweep ends it if nothing else does.
- **Drift is absorbed up to `LATE_CLOSE_SKEW_MS` (2 min), in both directions.**
  - A fast kiosk clock can stamp a pre-close check-in up to 2 min after the close. It still does not open the building, as long as the close was carried out after that stamp. That covers every offline close and the nightly sweep. A live close is carried out at once; a pre-close check-in delivered after it would need the kiosk to have been offline while the keyholder's close went live, and is not covered.
  - A slow kiosk clock can stamp a close up to 2 min before a web check-in that really came first; that check-in is still swept.
- **Beyond 2 min there is no guarantee.** The kiosk flags a clock step as `clockSuspect`, and that scan is applied and raised for review. Gradual drift is kept small by NTP. Re-basing kiosk time on the ack's server clock is the next step if review shows larger drift.

**D-3 — correcting a close earlier re-orders history.** Rule: **the corrected
close time is when the keyholder left** (#1988). Queued scans are compared
with the close as it now reads.
- A queued check-in scanned between the new and the old close time arrived after lock-up. It is a new visit and stays open, which is correct. By D-2 it does reopen the building, because it really came after the close.
- A queued check-out scanned in that window finds the visit already departed at the new time. It is recorded and flagged `conflict_out_no_in`, and the departure stays where the correction put it.

## 10. Tests

The integration tests run against a real Postgres. The suite is
`src/app/__tests__/closeAsEvent.integration.test.ts`, one `it` per row:

- **alone:** a live `close: alone` with others still recorded. Everyone departs at t; the keyholder departs as `SCANNER`; the record has `executedAt` set.
- **confirmed:** a plain OUT, then `close: confirmed`. Closes at the second scan.
- **other badge cancels (server side):** a plain keyholder OUT with no close request. Only the keyholder leaves. (The kiosk-side cancel is a client unit test.)
- **offline late:** a replay `close: confirmed` hours old. Closes at `scannedAt`, unflagged.
- **MC-A1:** a stale `close: alone` with others recorded. Closes.
- **MC-A2:** the keyholder already departed `SCANNER`, then a queued `close: confirmed`. Closes.
- **MC-A3:** the cron chunked the keyholder's visit, then a late close. Every AUTO_CLOSE segment is pulled back.
- **MC-A4:** a live `close: confirmed` after the first OUT drained. Closes.
- **MC-B1 / crash:** record the close with execution suppressed (a row with `executedAt` NULL). A resend of the same `clientEventId` → `duplicate_ignored`, and the close is executed. A second resend changes nothing.
- **MC-C1:** the web guard mints a token on the keyholder's visit, then a kiosk close. Closes.
- **MC-C2:** web removal (tombstone) of the keyholder's visit, then a kiosk close. Closes. The tombstone stays.
- **MC-C3:** a web checkout of the keyholder, a backdated second keyholder, and a role revoke, each before a queued close. Each closes; the revoke is flagged `close_not_keyholder`.
- **web close:** a keyholder chooses *close* in the dialog. Durable row, closes at now. A non-keyholder board member is offered no *close*.
- **ordering (D4):** a later close executes first, then an earlier one arrives. Departures move back to the earlier t.
- **stale roster (D9):**
  - live `alone` with a check-in after `rosterAsOf` → held, the leave is audited, the prompt names them, and the second badge closes;
  - live `alone` with a roster after every check-in → closes;
  - a late `alone` replay → closes, is flagged `close_stale_roster`, and its audit row lists the unseen visit.
- **NoFalseOpen (D-2):** a keyholder check-in from before a close, delivered after the close ran, does not reopen the building, and its queued OUT still applies at its own time. A keyholder arriving after the close does reopen it.
- **idempotent execute:** two concurrent Executes of one row produce one set of departure audits.

Unit tests:

- route body validation (`close` is kiosk-only and implies OUT);
- legacy mapping;
- `processCheckout` with no keyholder branch.

Client unit tests cover the §2.2 table:

- alone;
- prompt and confirm;
- another badge cancels;
- expiry;
- offline and online behave the same;
- `close` persists in the outbox;
- live is gated on protocol 6.
