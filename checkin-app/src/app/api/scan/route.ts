import prisma from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { apiError, apiJson } from "@/lib/api-response";
import { processCheckin, processCheckout, finalizeFacilityClose, closeVia, closeActor, lastKeyholderGuard, finishCloseGuard, type CloseGuardResult, forceCloseTokenMatches, notifyScanOutcome, SUPERVISION_CONFIRM_MS, SUPERVISION_CONFIRM_DEADFRONT_MS, LATE_CLOSE_SKEW_MS } from "@/lib/scan-service";
import { findAssociatedEventAt } from "@/lib/attendanceTransitions";
import { MAX_VISIT_MS } from "@/lib/visitTimes";
import { appendPresenceEvent, parkReasonToClass, PresenceClass } from "@/lib/presence/events";
import { applyPresenceIntent, flagForReview } from "@/lib/presence/project";
import { config } from "@/lib/config";
import { withKiosk } from "@/lib/kioskAuth";
import { KIOSK_DEBOUNCE_PROTOCOL_VERSION, SCAN_PROTOCOL_VERSION, TRUSTED_REPLAY_PROTOCOL_VERSION } from "@/lib/scanProtocol";
import { invalidateAttendanceCache } from "@/lib/getFullAttendance";
import { uniqueViolationFields } from "@/lib/prismaUniqueViolation";

// A merged-away badge should still get its owner through the door — an admin
// tidying up dupes must not be the reason a member gets rejected at the
// scanner. Chains this long are pathological (real merges are 1 hop); cap so
// a corrupt/cyclic chain can't loop the lookup forever, and reissue instead.
const MAX_MERGE_HOPS = 5;

// docs/rules/attendance-checkin.md (kiosk resilience): a replayed scan older
// than this still applies, and is also flagged for human review — state may
// have moved on while the kiosk was offline.
const REPLAY_FRESHNESS_WINDOW_MS = 10 * 60 * 1000;

// A replay stamped further ahead of server now than this came from a kiosk
// whose clock is wrong; it applies at server now, flagged clock_suspect.
const REPLAY_FUTURE_TOLERANCE_MS = 2 * 60 * 1000;

// Outbox-only fields: they rewrite a scan's event time, skip its interrupts, or
// inject review rows. Only a signed kiosk may send them.
// Bounded to Postgres int4 (see lib/searchId.ts): a larger id makes the
// lookup throw instead of matching nothing.
const isPersonId = (v: unknown): v is number =>
    typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 2147483647;

const KIOSK_ONLY_FIELDS = ["replay", "dead", "deadStatus", "scannedAt", "forceCloseConfirmed", "clockSuspect", "shownEmpty"] as const;

// F7: the out-of-order guard needs the true latest activity across ALL of a
// participant's visits, not just the most-recently-arrived one -- a
// same-day/next-day resolution (D7) can write a departedAt newer than a
// later visit's own arrival, and comparing arrivedAt alone would miss it.
const maxDate = (a: Date | null, b: Date | null): Date | null =>
    !a ? b : !b ? a : (a > b ? a : b);

// High cap: kiosks burst and a whole facility may share one NAT IP. withKiosk
// reads the raw body, authenticates it (kiosk signature OR session), rejects
// unauthenticated, and hands us the parsed body + actor. We own authorization.
export const POST = withKiosk(
    { rateLimit: { name: "scan", limit: 300 } },
    async (_req, body: { participantId?: unknown; clientEventId?: unknown; scannedAt?: unknown; replay?: unknown; forceCloseToken?: unknown; forceCloseConfirmed?: unknown; dead?: unknown; deadStatus?: unknown; intent?: unknown; clockSuspect?: unknown; shownEmpty?: unknown; protocolVersion?: unknown; closeChoice?: unknown; handoverToId?: unknown }, auth) => {
    const startTime = Date.now();

    try {
        const participantId = isPersonId(body.participantId) ? body.participantId : null;
        // A dead-lettered row is the exception: it is parked below whatever it
        // carries, so a corrupt read reaches the review queue instead of
        // bouncing on the kiosk forever.
        if (participantId === null && body.dead !== true) {
            return apiError("A valid numeric participantId is required.", 400);
        }

        if (auth.type !== 'kiosk') {
            const sent = KIOSK_ONLY_FIELDS.filter((f) => body[f] !== undefined);
            if (sent.length > 0) {
                return apiError(`Only a kiosk may send: ${sent.join(", ")}.`, 400);
            }
        }

        // Optional replay fields from a queued kiosk scan. Absent → exactly
        // today's behavior (legacy/web callers). An unparseable scannedAt
        // normalizes to null, which a replay then rejects below.
        const clientEventId = (typeof body.clientEventId === 'string' && body.clientEventId) || null;
        const parsedScannedAt = typeof body.scannedAt === 'string' ? new Date(body.scannedAt) : null;
        const scannedAt = parsedScannedAt && !isNaN(parsedScannedAt.getTime()) ? parsedScannedAt : null;

        // Replay-ness is explicit: only the outbox drain sets it. It cannot be
        // inferred from clientEventId, because D4's try-first rule puts that id
        // on the LIVE attempt too so a later redelivery dedups.
        if (body.replay !== undefined && typeof body.replay !== 'boolean') {
            return apiError("replay must be a boolean.", 400);
        }
        const isReplay = body.replay === true;

        // Q10: a terminally-failed outbox row rides this same endpoint to reach
        // the server-side DLQ instead of being lost on the kiosk. It shares
        // replay's identity requirements (clientEventId + scannedAt) but is a
        // distinct signal -- never a redelivery attempt, so the two are exclusive.
        if (body.dead !== undefined && typeof body.dead !== 'boolean') {
            return apiError("dead must be a boolean.", 400);
        }
        const isDead = body.dead === true;
        if (isDead && isReplay) {
            return apiError("dead and replay are mutually exclusive.", 400);
        }
        const deadStatus = typeof body.deadStatus === 'number' && Number.isFinite(body.deadStatus)
            ? body.deadStatus
            : 'unknown';

        // A live scan is happening now and never inherits the kiosk's clock (D3's
        // window and the debounce both measure against server now). A replay must
        // carry its own id and event time: falling back to now would make the
        // freshness check pass trivially and toggle a scan that should park.
        let eventTime = new Date();
        if (isReplay) {
            if (!clientEventId) {
                return apiError("A replayed scan requires clientEventId.", 400);
            }
            if (!scannedAt) {
                return apiError("A replayed scan requires a valid scannedAt.", 400);
            }
            eventTime = scannedAt;
        }
        // A visit can't start or end in the future: a scan time ahead of server
        // now applies at now instead.
        const clockAhead = isReplay && eventTime.getTime() - Date.now() > REPLAY_FUTURE_TOLERANCE_MS;
        if (clockAhead) eventTime = new Date();
        if (isDead) {
            if (!clientEventId) {
                return apiError("A dead-lettered scan requires clientEventId.", 400);
            }
            if (!scannedAt) {
                return apiError("A dead-lettered scan requires a valid scannedAt.", 400);
            }
            eventTime = scannedAt;
        }

        // Optional force-close confirm token, echoed from the warning response.
        // A replay carries the token it was queued with (the outbox persists it),
        // which is what lets a pre-outage confirm still close on arrival.
        // Anything that isn't a non-empty string is simply "no token" — it can
        // only ever grant the confirm, never deny an ordinary scan.
        const confirmToken =
            typeof body.forceCloseToken === 'string' && body.forceCloseToken.length > 0
                ? body.forceCloseToken
                : null;

        // The kiosk ran the force-close warning+confirm locally while offline and
        // has no server token to echo. Honored only on a replay, and only from a
        // keyholder — the flag bypasses the token, never the keyholder check.
        const forceCloseConfirmed = body.forceCloseConfirmed === true;

        // Displayed direction (invariant 5). Absent → legacy live-state toggle.
        if (body.intent !== undefined && body.intent !== 'IN' && body.intent !== 'OUT') {
            return apiError("intent must be IN or OUT.", 400);
        }
        const intent = body.intent === 'IN' || body.intent === 'OUT' ? body.intent : null;
        if (body.clockSuspect !== undefined && typeof body.clockSuspect !== 'boolean') {
            return apiError("clockSuspect must be a boolean.", 400);
        }
        const clockSuspect = body.clockSuspect === true;
        // Whether the kiosk showed anyone else inside when a keyholder badged
        // out. The kiosk's view decides a close, live or replayed; absent, the
        // server's records decide.
        if (body.shownEmpty !== undefined && typeof body.shownEmpty !== 'boolean') {
            return apiError("shownEmpty must be a boolean.", 400);
        }
        const shownEmpty = typeof body.shownEmpty === 'boolean' ? body.shownEmpty : null;

        // Contract bit (§2): a caller may declare the scan-body generation it
        // speaks. A version newer than this server refuses only the bodies
        // that can be misread — replay/dead rows, whose scannedAt semantics
        // the newer generation may have changed. A LIVE scan is a bare toggle
        // at server-now under every generation, so it always processes: a
        // version race must degrade replay delivery, never door availability.
        // 426 (not 400) so the kiosk drain holds the row and retries — this
        // is also what closes the rolling-deploy race for future bumps: a
        // too-new replay landing on a not-yet-upgraded instance bounces
        // instead of being misread, whatever the advertised version said.
        if (body.protocolVersion !== undefined) {
            if (typeof body.protocolVersion !== 'number' || !Number.isInteger(body.protocolVersion) || body.protocolVersion < 1) {
                return apiError("protocolVersion must be a positive integer.", 400);
            }
            if ((isReplay || isDead) && body.protocolVersion > SCAN_PROTOCOL_VERSION) {
                return apiError(`Unsupported protocolVersion ${body.protocolVersion}; this server speaks ${SCAN_PROTOCOL_VERSION}.`, 426);
            }
        }

        // A dead-lettered read that names no person can never project. It still
        // lands in the review queue -- the scan is never discarded -- keyed by
        // the raw value read, so the kiosk can stop retrying it.
        const parkUnresolvable = async (): Promise<Response> => {
            const raw = body.participantId;
            const scannedValue = (typeof raw === 'string' ? raw : JSON.stringify(raw) ?? '').slice(0, 64);
            try {
                await prisma.rawBadgeLog.create({
                    data: {
                        personId: null,
                        scannedValue,
                        location: "Main Entrance",
                        clientEventId,
                        timestamp: eventTime,
                        reviewReason: "client_dead:unresolvable",
                    },
                });
            } catch (err) {
                if (!uniqueViolationFields(err)?.includes("clientEventId")) throw err;
                return apiJson({ type: 'duplicate_ignored', message: 'Event already recorded.' });
            }
            return apiJson({ type: 'parked', message: 'Recorded for review.' });
        };
        if (participantId === null) {
            return await parkUnresolvable();
        }

        // Web session: refuse up front anyone who could only ever scan
        // themselves, so the lookup below can't serve them as an id oracle.
        // The full self/household check runs on the resolved participant.
        const sessionUser = auth.type === 'session' && !(auth.user.isSysadmin || auth.user.isKeyholder || auth.user.isBoardMember)
            ? auth.user
            : null;
        if (sessionUser && participantId !== Number(sessionUser.id) && !(sessionUser.householdId && sessionUser.householdLead)) {
            return apiError("Forbidden: You are not authorized to scan this user.", 403);
        }

        // 3. Lookup participant
        const badgeRecord = await prisma.person.findUnique({
            where: { id: participantId },
        });

        // A badge still encoding a merged-away id must not reject its owner at the
        // door. Two ways such an id presents, since 2b archives before it deletes:
        //   row is GONE      -> PersonMerge.fromId -> toId   (2b-3 onward)
        //   tombstone exists -> mergedIntoId                 (today, and legacy)
        // One loop, not two: an archive row's survivor may itself be a tombstone.
        //
        // Order is the trap. The archive lookup must run BEFORE the not-found 404 —
        // once tombstones are deleted the findUnique above simply misses and the
        // badge is rejected at the door, the exact failure this exists to prevent.
        // Dormant till then; pinned by an integration test that deletes a row by hand.
        //
        // The archive arm cannot exceed one hop (toId is a RESTRICT FK the merge
        // repoints), but shares MAX_MERGE_HOPS anyway: being wrong costs a member
        // refused at the door, and a bad 2a backfill is all it would take.
        let participant = badgeRecord;
        let lookupId = participantId;
        let mergeHops = 0;
        while (participant == null || participant.mergedIntoId != null) {
            const tombstonePointer = participant === null ? null : participant.mergedIntoId;
            if (tombstonePointer === null) {
                const archived = await prisma.personMerge.findUnique({
                    where: { fromId: lookupId },
                    select: { toId: true },
                });
                if (!archived) {
                    // Before any hop the scanned id is simply unknown. After one, we got
                    // here by following a merge pointer into a gap — a different fault,
                    // and one the operator can act on by reissuing the badge.
                    if (isDead) return await parkUnresolvable();
                    return mergeHops > 0
                        ? apiError(`This badge belongs to a merged record; reissue it for participant ${lookupId}.`, 409)
                        : apiError(`Participant ${participantId} not found.`, 404);
                }
                lookupId = archived.toId;
            } else {
                lookupId = tombstonePointer;
            }
            // Counted once the next id is known, so the cap message can name the
            // record to reissue for — and so that id is never fetched.
            mergeHops++;
            if (mergeHops > MAX_MERGE_HOPS) {
                if (isDead) return await parkUnresolvable();
                return apiError(`This badge belongs to a merged record; reissue it for participant ${lookupId}.`, 409);
            }
            participant = await prisma.person.findUnique({ where: { id: lookupId } });
        }
        if (mergeHops > 0) {
            logger.info("Scan forwarded from merged record", {
                badgeId: participantId,
                tombstoneId: badgeRecord?.mergedIntoId ?? null,
                survivorId: participant.id,
                hops: mergeHops,
                // The scanned id had no Person row at all — the archive resolved it.
                // Watch this during the 2b-3 rollout: it going true is the delete
                // path working, and staying false while tombstones are being removed
                // means badges are resolving some other way than expected.
                viaArchive: badgeRecord == null,
            });
        }

        // Checked against the resolved id, so a merged-away id can't disguise
        // a self scan as a household scan.
        if (sessionUser) {
            const isSelf = participant.id === Number(sessionUser.id);
            // In production, only privileged users may self-check-in via web.
            // Everyone else must use the kiosk badge scanner.
            if (isSelf && config.isProd()) {
                return apiError("Please use the kiosk badge scanner to check in.", 403);
            }
            if (!isSelf && !(sessionUser.householdLead && sessionUser.householdId && participant.householdId === sessionUser.householdId)) {
                return apiError("Forbidden: You are not authorized to scan this user.", 403);
            }
        }

        // Steps 4–6 (debounce read → record event → find visit → check-in/out)
        // are a read-modify-write on this participant's visit state. Without
        // serialization, two near-simultaneous scans for the same participant
        // both pass the debounce read and both observe the same visit state
        // before either writes — producing two open visits (double check-in) or
        // a double check-out that 500s on Prisma P2025 when the second tries to
        // delete the already-deleted visit. We wrap the whole sequence in one
        // transaction and take a per-participant Postgres advisory xact lock at
        // the top, so concurrent scans for the same participantId serialize: the
        // second blocks until the first commits, then observes committed state
        // and branches correctly. The lock auto-releases on commit/rollback.
        const authType = auth.type;

        // A session checkout's last-keyholder decision, set inside the transaction
        // and acted on after it commits.
        const web: { guard: Extract<CloseGuardResult, { action: "proceed" }> | null; visitId: number } = { guard: null, visitId: 0 };

        let res: Response;
        try {
        res = await prisma.$transaction(async (tx) => {
            // Per-participant lock. Serializes only same-participant scans;
            // different participants get different lock keys and never block.
            // $executeRaw (not $queryRaw): pg_advisory_xact_lock returns `void`,
            // which $queryRaw cannot deserialize. $executeRaw just runs it.
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(${participant.id})`;

            // A replayed event carries its own idempotency key. Pre-read before
            // the debounce check — an ack lost after the original attempt
            // committed must dedup even once the 3s debounce window has passed.
            if (clientEventId) {
                const seen = await tx.rawBadgeLog.findUnique({ where: { clientEventId } });
                if (seen) {
                    return apiJson({ type: 'duplicate_ignored', message: 'Event already recorded.' });
                }
            }

            // A scan echoing a live confirm token IS the force-close confirm, and a
            // scan following a fresh supervisionWarnedAt stamp IS the supervision
            // confirm (#1347 PR-0, decision 7) -- both must skip the debounce below.
            // Tied to the warning actually being shown, not badge adjacency; the
            // token clause is unchanged and stays primary. The stamp side is
            // floored at SUPERVISION_CONFIRM_DEADFRONT_MS: a USB double-read of
            // the warning scan itself lands well under that age and must still
            // debounce, or the room's warning would auto-confirm with no human
            // acknowledgment at all.
            // The token may sit on a departed visit: a close offered with a checkout.
            const isConfirm = async () => (confirmToken !== null && (await tx.visit.count({
                where: {
                    personId: participant.id,
                    deletedAt: null,
                    forceCloseToken: confirmToken,
                },
            })) > 0) || (await tx.visit.count({
                where: {
                    personId: participant.id,
                    departedAt: null,
                    deletedAt: null,
                    supervisionWarnedAt: {
                        gte: new Date(Date.now() - SUPERVISION_CONFIRM_MS),
                        lte: new Date(Date.now() - SUPERVISION_CONFIRM_DEADFRONT_MS),
                    },
                },
            })) > 0;

            // 4. Double scan debounce check (3 seconds) — now under the lock, so
            // it sees the committed badge event of any racing scan ahead of it.
            // A dead-lettered event always skips it too: it only ever parks, and
            // the touch must never be silently dropped by a debounce window.
            // A current kiosk filters repeat reads at the reader, so only exact
            // duplicates (clientEventId, above) are dropped for it.
            const kioskDebounces = typeof body.protocolVersion === 'number'
                && body.protocolVersion >= KIOSK_DEBOUNCE_PROTOCOL_VERSION;
            // An older kiosk's late, out-of-order or clock-suspect scan still parks.
            const trustsReplays = typeof body.protocolVersion === 'number'
                && body.protocolVersion >= TRUSTED_REPLAY_PROTOCOL_VERSION;
            const threeSecondsAgo = new Date(Date.now() - 3000);
            const recentScan = (kioskDebounces || isDead || await isConfirm()) ? null : await tx.rawBadgeLog.findFirst({
                where: {
                    personId: participant.id,
                    timestamp: {
                        gte: threeSecondsAgo
                    }
                }
            });

            if (recentScan) {
                // Silently ignore to prevent accidental double-scans without disrupting UI
                return new Response(JSON.stringify({ type: 'ignored_debounce', message: 'Scan ignored due to debounce.' }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' }
                });
            }

            // A keyholder's late close applies whenever it arrives, however late:
            // the keyholder was at the reader and saw the room, and the
            // FacilityClose record is its audit trail. It is a close when the
            // keyholder confirmed it at the kiosk (the echoed server token, or the
            // kiosk's own offline confirm) or when the kiosk showed nobody else
            // inside (shownEmpty) — anyone the server still records is a forgotten
            // badge-out. It needs the keyholder in the building at the scan time —
            // a visit still open, or one the nightly cron closed after the scan —
            // or already checked out themselves at or before the confirm, the
            // close offered with that checkout. Against a departed visit the server
            // never ran the confirm, so it takes the offer's token or the kiosk's
            // offline confirm; anything else parks for review.
            const lateCloseVisit = isReplay && participant.isKeyholder && intent !== "IN"
                && (forceCloseConfirmed || confirmToken !== null || shownEmpty === true)
                ? await tx.visit.findFirst({
                    where: {
                        personId: participant.id,
                        deletedAt: null,
                        arrivedAt: { lte: eventTime },
                        OR: [
                            { departedAt: null },
                            { departedVia: { in: ["SCANNER", "TYPED"] }, departedAt: { lte: eventTime } },
                            { departedVia: "AUTO_CLOSE", departedAt: { gt: eventTime } },
                        ],
                    },
                    // By departure, not arrival: a backdated visit can arrive before one that left earlier.
                    // Postgres sorts NULLs first under DESC, so a still-open visit wins.
                    orderBy: { departedAt: "desc" },
                    select: { id: true, departedAt: true, forceCloseToken: true },
                })
                : null;

            // Every other replay is trusted by default and applied at its scan
            // time; a stale, out-of-order or clock-suspect one is ALSO flagged for
            // review (reviewReason). It is held unapplied only when applying it
            // would contradict the person's later record, or it carries no
            // displayed direction to apply. A dead-lettered event always parks: it
            // never reached the server live, so there is nothing to apply it against.
            // Against a cron-closed visit the server never ran the confirm, so a
            // token that doesn't match parks exactly as processCheckout's would.
            let reviewReason: string | null = null;
            let hold = false;
            let pullBackVisitId: number | null = null;
            if (isDead) {
                reviewReason = `client_dead:${deadStatus}`;
                hold = true;
            } else if (lateCloseVisit?.departedAt && !forceCloseConfirmed && shownEmpty !== true
                && !forceCloseTokenMatches(lateCloseVisit.forceCloseToken, confirmToken)) {
                reviewReason = "force_close_review";
                hold = true;
            } else if (clockSuspect || clockAhead) {
                // Applied, and flagged: a close or scan time from a doubtful
                // clock is a human's to check, never a silent clamp.
                reviewReason = "clock_suspect";
                hold = lateCloseVisit ? clockAhead && !trustsReplays : !intent || !trustsReplays;
            }
            if (isReplay && !hold && !lateCloseVisit) {
                const activity = await tx.visit.aggregate({
                    where: { personId: participant.id, deletedAt: null },
                    _max: { arrivedAt: true, departedAt: true },
                });
                const latestActivityAt = maxDate(activity._max.arrivedAt, activity._max.departedAt);
                const behind = latestActivityAt !== null && latestActivityAt > eventTime;
                const stale = Date.now() - eventTime.getTime() > REPLAY_FRESHNESS_WINDOW_MS;
                reviewReason ??= behind ? "out_of_order" : stale ? "stale_replay" : null;

                if (!intent || !trustsReplays) {
                    hold = reviewReason !== null;
                } else if (behind) {
                    // Out of order: the scan belongs to the visit the person was in
                    // at its own time — their latest arrival at or before it — and
                    // never touches a visit that began after it. An OUT departs that
                    // visit: an open one checks out normally, and a machine
                    // departure (the nightly sweep, or a facility close) stamped
                    // after the scan is pulled back to it. An IN,
                    // or an OUT against a departure someone recorded, would
                    // contradict the later record, so it is held for the reviewer.
                    const at = await tx.visit.findFirst({
                        where: { personId: participant.id, deletedAt: null, arrivedAt: { lte: eventTime } },
                        orderBy: { arrivedAt: "desc" },
                        select: { id: true, departedAt: true, departedVia: true },
                    });
                    if (intent === "OUT" && (at?.departedVia === "AUTO_CLOSE" || at?.departedVia === "FACILITY_CLOSE")
                        && at.departedAt && at.departedAt > eventTime) {
                        // ponytail: pulls back only the segment holding the scan; later
                        // event-chunk segments of the same stay keep the cron stamp (flagged).
                        pullBackVisitId = at.id;
                    } else if (!(intent === "OUT" && at?.departedAt === null)) {
                        hold = true;
                    }
                }
            }

            // 5. Record raw badge event — always, even when parking: the touch
            // itself is never lost, only its Visit projection is deferred for
            // review.
            await tx.rawBadgeLog.create({
                data: {
                    personId: participant.id,
                    location: "Main Entrance",
                    ...(clientEventId ? { clientEventId } : {}),
                    ...((isReplay || isDead) ? { timestamp: eventTime } : {}),
                    ...(reviewReason ? { reviewReason } : {}),
                },
            });

            // Dual-write the Stage-2 log. A held scan must not consult Visit
            // state at all (the pinned park contract): its direction is advisory
            // review context for a human, never projected.
            if (hold && reviewReason) {
                await appendPresenceEvent(tx, {
                    personId: participant.id,
                    occurredAt: eventTime,
                    direction: intent ?? "IN",
                    source: "SCANNER",
                    clientEventId,
                    classification: parkReasonToClass(reviewReason),
                    clockSuspect,
                });
                return apiJson({ type: 'parked', message: 'Recorded for review.' });
            }

            if (pullBackVisitId !== null) {
                await tx.visit.update({
                    where: { id: pullBackVisitId },
                    data: { departedAt: eventTime, departedVia: "SCANNER", facilityCloseId: null },
                });
                await appendPresenceEvent(tx, {
                    personId: participant.id,
                    occurredAt: eventTime,
                    direction: "OUT",
                    source: "SCANNER",
                    clientEventId,
                    classification: PresenceClass.PROJECTED,
                    clockSuspect,
                    visitId: pullBackVisitId,
                });
                return apiJson({ type: 'checkout', message: 'Checked out successfully', facilityClosed: false });
            }

            // The keyholder is already departed — by the cron, or by their own badge
            // that offered the close — so there is no checkout left to run, but the
            // close still applies at the keyholder's scan time; the sweep pulls that
            // night's AUTO_CLOSE departures back to it. The offer's token is spent.
            if (lateCloseVisit?.departedAt) {
                await tx.visit.update({
                    where: { id: lateCloseVisit.id },
                    data: { forceCloseWarnedAt: null, forceCloseToken: null },
                });
                await appendPresenceEvent(tx, {
                    personId: participant.id,
                    occurredAt: eventTime,
                    direction: "OUT",
                    source: "SCANNER",
                    clientEventId,
                    classification: PresenceClass.PROJECTED,
                });
                return apiJson({ type: 'checkout', message: 'Checked out and Facility closed', facilityClosed: true });
            }

            // A close fences what came before it: an arrival scanned before a close
            // that reached the server first departs at that close, as the close's
            // sweep would have departed it, and is flagged. One scanned after the
            // close (beyond the clock-skew allowance) opens a visit as usual.
            if (isReplay && trustsReplays && intent === "IN" && clientEventId) {
                const fence = await tx.facilityClose.findFirst({
                    where: { closedAt: { gte: new Date(eventTime.getTime() - LATE_CLOSE_SKEW_MS) } },
                    orderBy: { closedAt: "asc" },
                    select: { id: true, closedAt: true },
                });
                const open = fence && await tx.visit.count({ where: { personId: participant.id, departedAt: null, deletedAt: null } });
                if (fence && !open) {
                    const departedAt = new Date(Math.min(
                        Math.max(fence.closedAt.getTime(), eventTime.getTime()),
                        eventTime.getTime() + MAX_VISIT_MS,
                    ));
                    const visit = await tx.visit.create({
                        data: {
                            personId: participant.id,
                            arrivedAt: eventTime,
                            arrivedVia: "SCANNER",
                            departedAt,
                            departedVia: "FACILITY_CLOSE",
                            facilityCloseId: fence.id,
                            associatedEventId: await findAssociatedEventAt(participant.id, eventTime, tx),
                        },
                    });
                    await tx.rawBadgeLog.update({
                        where: { clientEventId },
                        data: { reviewReason: "closed_before_delivery" },
                    });
                    await appendPresenceEvent(tx, {
                        personId: participant.id,
                        occurredAt: eventTime,
                        direction: "IN",
                        source: "SCANNER",
                        clientEventId,
                        classification: PresenceClass.PROJECTED,
                        clockSuspect,
                        visitId: visit.id,
                    });
                    return apiJson({ type: 'checkin', message: 'Checked in; departed at the close that followed', visit });
                }
            }

            // Live path. Direction: the displayed intent if the kiosk sent one,
            // else the live-state toggle (legacy callers).
            const activeVisit = await tx.visit.findFirst({
                where: {
                    personId: participant.id,
                    departedAt: null,
                    deletedAt: null,
                },
                orderBy: { arrivedAt: "desc" },
            });


            // A web checkout runs the shared close choice, not the kiosk's badge
            // confirm (docs/rules/attendance-checkin.md, Opening and closing).
            if (auth.type === 'session' && activeVisit && intent !== 'IN') {
                const guard = await lastKeyholderGuard(
                    activeVisit.id, participant, closeActor(auth.user),
                    { token: confirmToken, choice: body.closeChoice, handoverToId: body.handoverToId }, {}, tx,
                );
                if (guard.action === 'warn') return apiJson(guard.warning, 400);
                if (guard.action === 'refuse') return apiError(guard.error, guard.status);
                web.guard = guard;
                web.visitId = activeVisit.id;
            }

            // 6. Project. Intent-carrying events apply IN/OUT as displayed
            // (conflicts park). Legacy callers without intent still toggle from
            // live state.
            if (intent) {
                return await applyPresenceIntent(tx, {
                    participant,
                    direction: intent,
                    occurredAt: eventTime,
                    authType,
                    source: "SCANNER",
                    clientEventId,
                    confirmToken,
                    replayEventId: isReplay ? clientEventId : null,
                    forceCloseConfirmed,
                    clockSuspect,
                    webClose: web.guard?.facilityClosed ?? false,
                    shownEmpty,
                });
            }

            const res = activeVisit
                ? await processCheckout(participant, activeVisit.id, authType, tx, confirmToken, eventTime, isReplay ? clientEventId : null, forceCloseConfirmed, web.guard?.facilityClosed ?? false, shownEmpty)
                : await processCheckin(participant, authType, tx, eventTime);

            // Classification comes from the ACTUAL outcome. Only a confirmed
            // toggle is PROJECTED; review parks keep their own class; warnings
            // (visit still open) stay unclassified.
            let classification: string | null = null;
            let parkedDoubleIn = false;
            try {
                const body = (await res.clone().json()) as { type?: string; reason?: string };
                if (body.type === "checkin" || body.type === "checkout") {
                    classification = PresenceClass.PROJECTED;
                } else if (body.type === "parked") {
                    classification = body.reason ? parkReasonToClass(body.reason) : null;
                    parkedDoubleIn = body.reason === "double_in";
                }
            } catch {
                classification = null;
            }
            if (parkedDoubleIn) {
                await flagForReview(tx, participant.id, clientEventId, "conflict_double_in");
            }
            await appendPresenceEvent(tx, {
                personId: participant.id,
                occurredAt: eventTime,
                direction: activeVisit ? "OUT" : "IN",
                source: "SCANNER",
                clientEventId,
                classification,
            });
            return res;
        }, {
            // maxWait: time a racing scan waits to acquire a connection / start.
            // timeout: ceiling on the whole locked section, including time spent
            // blocked on pg_advisory_xact_lock while an earlier scan holds it.
            maxWait: 5000,
            timeout: 15000,
        });
        } catch (err) {
            // Cross-lock race on the same clientEventId (e.g. two replay attempts
            // of one queued event racing different advisory-lock windows) — the
            // unique constraint is the backstop the pre-read can't fully close.
            // Only a clientEventId collision is a duplicate: any other P2002
            // (e.g. the one-open-visit index) must 500 so the kiosk retries
            // instead of acking a scan whose rows just rolled back.
            if (clientEventId && uniqueViolationFields(err)?.includes("clientEventId")) {
                return apiJson({ type: 'duplicate_ignored', message: 'Event already recorded.' });
            }
            throw err;
        }

        // Facility-wide close runs here, AFTER the per-participant transaction
        // commits and the advisory lock is released. Keeping the sweep + email
        // kick out of the locked section means a last-isKeyholder close no longer
        // blocks concurrent scans for other participants. No-op unless the
        // response reports facilityClosed.
        if (auth.type === 'session' && web.guard) {
            const outcome = (await res.clone().json().catch(() => null)) as { type?: string } | null;
            if (outcome?.type === 'checkout') {
                await finishCloseGuard(web.guard, { actorId: Number(auth.user.id), subjectId: participant.id, visitId: web.visitId, via: "WEB_CHECKOUT" });
            }
        } else {
            await finalizeFacilityClose(res, {
                closedById: participant.id,
                via: closeVia(authType, isReplay ? clientEventId : null),
            }, isReplay ? eventTime : undefined);
        }
        await notifyScanOutcome(res, eventTime);
        // After the tx (+ optional facility sweep) commits, so a concurrent
        // GET cannot refill the cache from uncommitted rows.
        invalidateAttendanceCache();

        return res;
    } finally {
        // Errors propagate to withKiosk's top-level catch/500; this finally only
        // records the metric. Times the handler body (post-auth), not rate-limit.
        const durationMs = Date.now() - startTime;
        prisma.systemMetricLog.create({
            data: {
                metric: "scan_response_time",
                value: durationMs,
            }
        }).catch((err: unknown) => logger.error("Failed to log scan_response_time metric:", err));
    }
});
