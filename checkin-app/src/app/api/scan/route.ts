import prisma from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { apiError } from "@/lib/api-response";
import { processCheckin, processCheckout, type LegacyKiosk, SUPERVISION_CONFIRM_MS, SUPERVISION_CONFIRM_DEADFRONT_MS } from "@/lib/attendance/scan";
import { processCloseRequest, executePendingCloses, type CloseKind, LIVE_ARRIVAL_WINDOW_MS } from "@/lib/attendance/close";
import { closeActor, lastKeyholderGuard, finishCloseGuard, recordWebClose, type CloseGuardResult } from "@/lib/attendance/keyholderGuard";
import { notifyScanOutcome } from "@/lib/attendance/scanNotify";
import { appendPresenceEvent, parkReasonToClass, PresenceClass } from "@/lib/presence/events";
import { applyPresenceIntent, flagForReview } from "@/lib/presence/project";
import { config } from "@/lib/config";
import { withKiosk } from "@/lib/kioskAuth";
import { CLOSE_REQUEST_PROTOCOL_VERSION, KIOSK_DEBOUNCE_PROTOCOL_VERSION, SCAN_PROTOCOL_VERSION, TRUSTED_REPLAY_PROTOCOL_VERSION } from "@/lib/scanProtocol";
import { invalidateAttendanceCache } from "@/lib/getFullAttendance";
import { lockFacility } from "@/lib/facilityLock";
import { uniqueViolationFields } from "@/lib/prismaUniqueViolation";
import { resolveMergedPerson } from "@/lib/person/mergeChain";
import { specTrace } from "@/lib/specTrace";
import type { Prisma } from "@/generated/prisma/client";
import { type ScanResult, toResponse } from "./scanResponse";

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

// Whether the open visit began with a live badge IN, as its arrivedLive says.
// A visit older than that column falls back to the badge log: a live IN is
// stamped when it takes the facility lock, after the scan's own badge log row;
// a replayed IN's row carries exactly its arrival time.
// ponytail: the fallback can go once no open visit predates arrivedLive.
async function openedByLiveBadge(tx: Prisma.TransactionClient, personId: number): Promise<boolean> {
    const open = await tx.visit.findFirst({
        where: { personId, departedAt: null, deletedAt: null, arrivedVia: "SCANNER" },
        select: { arrivedAt: true, arrivedLive: true },
    });
    if (open && open.arrivedLive !== null) return open.arrivedLive;
    return !!open && await tx.rawBadgeLog.count({
        where: {
            personId,
            timestamp: { lt: open.arrivedAt, gte: new Date(open.arrivedAt.getTime() - LIVE_ARRIVAL_WINDOW_MS) },
        },
    }) > 0;
}

const KIOSK_ONLY_FIELDS = ["replay", "dead", "deadStatus", "scannedAt", "forceCloseConfirmed", "clockSuspect", "shownEmpty", "close", "rosterAsOf"] as const;

// The out-of-order guard needs the true latest activity across ALL of a
// participant's visits, not just the most-recently-arrived one -- a
// same-day/next-day resolution can write a departedAt newer than a
// later visit's own arrival, and comparing arrivedAt alone would miss it.
const maxDate = (a: Date | null, b: Date | null): Date | null =>
    !a ? b : !b ? a : (a > b ? a : b);

// High cap: kiosks burst and a whole facility may share one NAT IP. withKiosk
// reads the raw body, authenticates it (kiosk signature OR session), rejects
// unauthenticated, and hands us the parsed body + actor. We own authorization.
export const POST = withKiosk(
    { rateLimit: { name: "scan", limit: 300 } },
    async (_req, body: { participantId?: unknown; clientEventId?: unknown; scannedAt?: unknown; replay?: unknown; forceCloseToken?: unknown; forceCloseConfirmed?: unknown; dead?: unknown; deadStatus?: unknown; intent?: unknown; clockSuspect?: unknown; shownEmpty?: unknown; rosterAsOf?: unknown; protocolVersion?: unknown; closeChoice?: unknown; handoverToId?: unknown; close?: unknown }, auth) => {
    const startTime = Date.now();

    try {
        const participantId = isPersonId(body.participantId) ? body.participantId : null;
        // A queued row (dead-lettered or replayed) is the exception: it is
        // parked below whatever it carries, so a corrupt read reaches the
        // review queue instead of bouncing on the kiosk forever.
        if (participantId === null && body.dead !== true && body.replay !== true) {
            return apiError("A valid numeric participantId is required.", 400);
        }

        if (auth.type !== 'kiosk') {
            const sent = KIOSK_ONLY_FIELDS.filter((f) => body[f] !== undefined);
            if (sent.length > 0) {
                return apiError(`Only a kiosk may send: ${sent.join(", ")}.`, 400);
            }
        }

        // Optional replay fields from a queued kiosk scan. Absent → a plain
        // live scan (web callers, older kiosks). An unparseable scannedAt
        // normalizes to null, which parks a replay below.
        const clientEventId = (typeof body.clientEventId === 'string' && body.clientEventId) || null;
        const parsedScannedAt = typeof body.scannedAt === 'string' ? new Date(body.scannedAt) : null;
        const scannedAt = parsedScannedAt && !isNaN(parsedScannedAt.getTime()) ? parsedScannedAt : null;

        // Replay-ness is explicit: only the outbox drain sets it. It cannot be
        // inferred from clientEventId, because the try-first rule puts that id
        // on the LIVE attempt too so a later redelivery dedups.
        if (body.replay !== undefined && typeof body.replay !== 'boolean') {
            return apiError("replay must be a boolean.", 400);
        }

        // A terminally-failed outbox row rides this same endpoint to reach
        // the server-side DLQ instead of being lost on the kiosk. It shares
        // replay's identity requirements (clientEventId + scannedAt) but is a
        // distinct signal -- never a redelivery attempt, so the two are exclusive.
        if (body.dead !== undefined && typeof body.dead !== 'boolean') {
            return apiError("dead must be a boolean.", 400);
        }
        if (body.dead === true && body.replay === true) {
            return apiError("dead and replay are mutually exclusive.", 400);
        }
        if (body.dead === true && !clientEventId) {
            return apiError("A dead-lettered scan requires clientEventId.", 400);
        }
        if (body.dead === true && !scannedAt) {
            return apiError("A dead-lettered scan requires a valid scannedAt.", 400);
        }

        // The token a web caller echoes from the close-choice dialog. Anything
        // that isn't a non-empty string is simply "no token".
        const confirmToken =
            typeof body.forceCloseToken === 'string' && body.forceCloseToken.length > 0
                ? body.forceCloseToken
                : null;

        // A keyholder's close, decided at the kiosk (docs/rules/attendance-checkin.md,
        // Opening and closing). An older kiosk's offline confirm flag, or a token it
        // echoes on the second scan of the same badge, is the same decision.
        const requestedClose: CloseKind | null = body.close === 'alone' || body.close === 'confirmed'
            ? body.close
            : auth.type === 'kiosk' && (body.forceCloseConfirmed === true || confirmToken !== null)
                ? 'confirmed'
                : auth.type === 'kiosk' && body.shownEmpty === true
                    ? 'alone'
                    : null;
        // Server time of the kiosk's last roster: a check-in after it is one the
        // keyholder could not have seen on the kiosk.
        const parsedRosterAsOf = typeof body.rosterAsOf === 'string' ? new Date(body.rosterAsOf) : null;
        const rosterAsOfValid = parsedRosterAsOf !== null && !isNaN(parsedRosterAsOf.getTime());

        // A replay must carry its own id and event time: falling back to now
        // would make the freshness check pass trivially and toggle a scan that
        // should park. intent is the displayed direction; absent, a legacy
        // live-state toggle. protocolVersion is the contract bit.
        const invalid =
            body.replay === true && !clientEventId ? "A replayed scan requires clientEventId." :
            body.replay === true && !scannedAt ? "A replayed scan requires a valid scannedAt." :
            body.intent !== undefined && body.intent !== 'IN' && body.intent !== 'OUT' ? "intent must be IN or OUT." :
            body.close !== undefined && body.close !== 'alone' && body.close !== 'confirmed' ? "close must be alone or confirmed." :
            requestedClose && body.intent === 'IN' ? "A close is a checkout; intent must be OUT." :
            body.rosterAsOf !== undefined && !rosterAsOfValid ? "rosterAsOf must be a timestamp." :
            body.clockSuspect !== undefined && typeof body.clockSuspect !== 'boolean' ? "clockSuspect must be a boolean." :
            body.shownEmpty !== undefined && typeof body.shownEmpty !== 'boolean' ? "shownEmpty must be a boolean." :
            body.protocolVersion !== undefined && !(typeof body.protocolVersion === 'number' && Number.isInteger(body.protocolVersion) && body.protocolVersion >= 1)
                ? "protocolVersion must be a positive integer." :
            null;
        // A replay is never refused: a refusal would block the head of the
        // kiosk's queue. One the server cannot apply is ingested as a dead
        // letter instead, and parks for review without closing anything.
        if (invalid && body.replay !== true) {
            return apiError(invalid, 400);
        }
        const isReplay = body.replay === true && !invalid;
        const isDead = body.dead === true || (body.replay === true && invalid !== null);
        const deadStatus = invalid ? 400
            : typeof body.deadStatus === 'number' && Number.isFinite(body.deadStatus) ? body.deadStatus
            : 'unknown';
        const closeKind = invalid ? null : requestedClose;
        const rosterAsOf = rosterAsOfValid ? parsedRosterAsOf : null;

        // A live scan is happening now and never inherits the kiosk's clock (the
        // freshness window and the debounce both measure against server now).
        let eventTime = ((isReplay || isDead) && scannedAt) || new Date();
        // A visit can't start or end in the future: a scan time ahead of server
        // now applies at now instead.
        const clockAhead = isReplay && eventTime.getTime() - Date.now() > REPLAY_FUTURE_TOLERANCE_MS;
        if (clockAhead) eventTime = new Date();

        const intent = body.intent === 'IN' || body.intent === 'OUT' ? body.intent : null;
        const clockSuspect = body.clockSuspect === true;
        const slot = auth.type !== 'kiosk' ? "web" : (isReplay || isDead) ? "replay" : "live";
        specTrace("ScanRequest", {
            slot, p: body.participantId, cid: clientEventId, intent, close: closeKind,
            t: eventTime.getTime(), scannedAt: scannedAt?.getTime() ?? null, rosterAsOf: rosterAsOf?.getTime() ?? null,
        });

        // A version newer than this server refuses only the bodies that can be
        // misread — replay/dead rows, whose scannedAt semantics the newer
        // generation may have changed. A LIVE scan is a bare toggle at
        // server-now under every generation, so it always processes: a version
        // race must degrade replay delivery, never door availability. 426 (not
        // 400) so the kiosk drain holds the row and retries — this is also what
        // closes the rolling-deploy race for future bumps: a too-new replay
        // landing on a not-yet-upgraded instance bounces instead of being
        // misread, whatever the advertised version said.
        if ((isReplay || isDead) && typeof body.protocolVersion === 'number' && body.protocolVersion > SCAN_PROTOCOL_VERSION) {
            return apiError(`Unsupported protocolVersion ${body.protocolVersion}; this server speaks ${SCAN_PROTOCOL_VERSION}.`, 426);
        }
        // A kiosk below the close-request generation still has its keyholder
        // checkout decide the close (whether the kiosk showed anyone else inside,
        // else the server's records); from that generation on, only a close
        // request closes.
        const legacyKiosk: LegacyKiosk | null = auth.type === 'kiosk'
            && (typeof body.protocolVersion === 'number' ? body.protocolVersion : 1) < CLOSE_REQUEST_PROTOCOL_VERSION
            ? { shownEmpty: typeof body.shownEmpty === 'boolean' ? body.shownEmpty : null, clientEventId }
            : null;

        // A dead-lettered read that names no person can never project. It still
        // lands in the review queue -- the scan is never discarded -- keyed by
        // the raw value read, so the kiosk can stop retrying it.
        const wire = { signedRequest: auth.type === 'kiosk' };
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
                specTrace("ScanCommit", { slot, p: raw, cid: clientEventId, kind: "duplicate" });
                return toResponse({ kind: "duplicate" }, wire);
            }
            specTrace("ScanCommit", { slot, p: raw, cid: clientEventId, kind: "parked", reason: "unresolvable" });
            return toResponse({ kind: "parked", reason: "review" }, wire);
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

        // 3. Lookup participant. A badge still encoding a merged-away id must not
        // reject its owner at the door: it resolves to the surviving record, and a
        // broken chain asks the operator to reissue the badge.
        const resolved = await resolveMergedPerson(participantId);
        if (resolved.kind !== "live") {
            if (isDead || isReplay) return await parkUnresolvable();
            specTrace("ScanCommit", { slot, p: participantId, cid: clientEventId, kind: "rejected" });
            return resolved.kind === "broken"
                ? apiError(`This badge belongs to a merged record; reissue it for participant ${resolved.lastId}.`, 409)
                : apiError(`Participant ${participantId} not found.`, 404);
        }
        const { person: participant, first: badgeRecord, hops: mergeHops } = resolved;
        if (mergeHops > 0) {
            logger.info("Scan forwarded from merged record", {
                badgeId: participantId,
                tombstoneId: badgeRecord?.mergedIntoId ?? null,
                survivorId: participant.id,
                hops: mergeHops,
                // The scanned id had no Person row at all — the archive resolved it.
                // True means the tombstone was deleted and the archive took over; false
                // while tombstones are being removed means badges resolve some other way.
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
        // A web checkout's chosen close commits in the scan transaction, with the checkout.
        const recordSessionClose = async (tx: Prisma.TransactionClient, result: ScanResult): Promise<ScanResult> => {
            if (auth.type === 'session' && web.guard?.facilityClosed && result.kind === "checkout") {
                await recordWebClose(tx, web.guard, { actorId: Number(auth.user.id), subjectId: participant.id, via: "WEB_CHECKOUT" });
            }
            return result;
        };
        let closeRefused = false;

        let result: ScanResult;
        try {
        result = await prisma.$transaction(async (tx): Promise<ScanResult> => {
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
                if (seen) return { kind: "duplicate" };
            }

            // Only a keyholder closes. Live, the server knows the badge's role now,
            // so a non-keyholder's close is refused and the scan is an ordinary
            // checkout; a late delivery can't know the role at its scan time, so
            // it still closes and is flagged.
            closeRefused = closeKind !== null && !participant.isKeyholder && !isReplay && !isDead;
            // A close request is never debounced, parked or held: it is the
            // keyholder's decision, applied at its own time however late. A
            // closer who is no longer a keyholder (on a late delivery), or a
            // suspect clock, still closes and is flagged for review.
            if (closeKind && !closeRefused) {
                const flag = isDead ? `client_dead:${deadStatus}`
                    : !participant.isKeyholder ? "close_not_keyholder"
                    : (clockSuspect || clockAhead) ? "clock_suspect"
                    : null;
                await tx.rawBadgeLog.create({
                    data: {
                        personId: participant.id,
                        location: "Main Entrance",
                        ...(clientEventId ? { clientEventId } : {}),
                        ...((isReplay || isDead) ? { timestamp: eventTime } : {}),
                        ...(flag ? { reviewReason: flag } : {}),
                    },
                });
                await appendPresenceEvent(tx, {
                    personId: participant.id,
                    occurredAt: eventTime,
                    direction: "OUT",
                    source: "SCANNER",
                    clientEventId,
                    classification: PresenceClass.PROJECTED,
                    clockSuspect,
                });
                logger.info("Facility close requested", { personId: participant.id, kind: closeKind, replay: isReplay });
                return processCloseRequest(participant, tx, eventTime, clientEventId, isReplay || isDead, closeKind, rosterAsOf);
            }

            // A web caller echoing its close-choice token answers the dialog, and a
            // scan following a fresh supervisionWarnedAt stamp IS the supervision
            // confirm -- both must skip the debounce below.
            // Tied to the warning actually being shown, not badge adjacency. The
            // stamp side is floored at SUPERVISION_CONFIRM_DEADFRONT_MS: a USB
            // double-read of the warning scan itself lands well under that age and
            // must still debounce, or the room's warning would auto-confirm with no
            // human acknowledgment at all.
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

            // 4. Double scan debounce check (3 seconds), under the lock so
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

            // Silently ignore to prevent accidental double-scans without disrupting UI
            if (recentScan) return { kind: "debounced" };

            // Every other replay is trusted by default and applied at its scan
            // time; a stale, out-of-order or clock-suspect one is ALSO flagged for
            // review (reviewReason). It is held unapplied only when applying it
            // would contradict the person's later record, or it carries no
            // displayed direction to apply. A dead-lettered event always parks: it
            // never reached the server live, so there is nothing to apply it against.
            let reviewReason: string | null = null;
            let hold = false;
            let pullBackVisitId: number | null = null;
            if (isDead) {
                reviewReason = `client_dead:${deadStatus}`;
                hold = true;
            } else if (clockSuspect || clockAhead) {
                // Applied, and flagged: a scan time from a doubtful clock is a
                // human's to check, never a silent clamp.
                reviewReason = "clock_suspect";
                hold = !intent || !trustsReplays;
            }
            if (isReplay && !hold) {
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
                    // after the scan is pulled back to it. An OUT with no visit
                    // open at its time departs the open visit only when a live
                    // badge IN began it: the kiosk queued the OUT behind that IN,
                    // which the server stamped later than the OUT's kiosk time (its
                    // reply was lost, or the kiosk clock runs behind), so it departs
                    // no earlier than it began. Any other later visit, an IN, or an
                    // OUT against a departure someone recorded after it would
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
                    } else if (intent === "OUT" && at?.departedAt === null) {
                        // Departs the visit open at its time.
                    } else if (!(intent === "OUT" && (!at?.departedAt || at.departedAt <= eventTime)
                        && await openedByLiveBadge(tx, participant.id))) {
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

            // Also append to the presence log. A held scan must not consult Visit
            // state at all: its direction is advisory
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
                return { kind: "parked", reason: "review" };
            }

            if (pullBackVisitId !== null) {
                await tx.visit.update({
                    where: { id: pullBackVisitId },
                    data: { departedAt: eventTime, departedVia: "SCANNER", facilityCloseId: null },
                });
                specTrace("VisitDepart", { p: participant.id, visitId: pullBackVisitId, via: "SCANNER", t: eventTime.getTime(), pulledBack: true });
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
                return { kind: "departure_pulled_back" };
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
            // confirm (docs/rules/attendance-checkin.md, Opening and closing),
            // under the facility lock so no check-in or close lands between the
            // choice and the checkout.
            if (auth.type === 'session' && activeVisit && intent !== 'IN') {
                await lockFacility(tx);
                const guard = await lastKeyholderGuard(
                    activeVisit.id, participant, closeActor(auth.user),
                    { token: confirmToken, choice: body.closeChoice, handoverToId: body.handoverToId }, {}, tx,
                );
                if (guard.action !== 'proceed') return { kind: "close_guard", guard };
                web.guard = guard;
                web.visitId = activeVisit.id;
            }

            // 6. Project. Intent-carrying events apply IN/OUT as displayed
            // (conflicts park). Legacy callers without intent still toggle from
            // live state.
            if (intent) {
                return recordSessionClose(tx, await applyPresenceIntent(tx, {
                    participant,
                    direction: intent,
                    occurredAt: eventTime,
                    authType,
                    source: "SCANNER",
                    clientEventId,
                    isReplay,
                    clockSuspect,
                    webClose: web.guard?.facilityClosed ?? false,
                    legacyKiosk,
                    // A close fences what came before it (processCheckin).
                    fenceClientEventId: isReplay && trustsReplays ? clientEventId : null,
                }));
            }

            const outcome = activeVisit
                ? await processCheckout(participant, activeVisit.id, authType, tx, eventTime, isReplay, web.guard?.facilityClosed ?? false, legacyKiosk)
                : await processCheckin(participant, authType, tx, isReplay ? eventTime : undefined);

            // Classification comes from the ACTUAL outcome. Only a confirmed
            // toggle is PROJECTED; a park keeps its own class; a departure
            // awaiting confirmation (visit still open) stays unclassified.
            const classification = outcome.kind === "checkin" || outcome.kind === "checkout" ? PresenceClass.PROJECTED
                : outcome.kind === "parked" ? parkReasonToClass(outcome.reason)
                : null;
            if (outcome.kind === "parked" && outcome.reason === "double_in") {
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
            return recordSessionClose(tx, outcome);
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
                specTrace("ScanCommit", { slot, p: participant.id, cid: clientEventId, kind: "duplicate" });
                await executePendingCloses();
                return toResponse({ kind: "duplicate" }, wire);
            }
            throw err;
        }
        specTrace("ScanCommit", {
            slot, p: participant.id, cid: clientEventId, kind: result.kind,
            reason: result.kind === "parked" ? result.reason : null,
            closed: result.kind === "checkout" && result.closed,
            held: result.kind === "checkout" && result.closeOffer?.reason === "unseen_checkins",
        });

        // Every recorded close runs here, AFTER the per-participant transaction
        // commits and the advisory lock is released, so the facility-wide sweep
        // never blocks scans for other participants. Unconditional: a resend of
        // a close whose sweep was cut off dedups above and is carried out here.
        await executePendingCloses();
        if (auth.type === 'session' && web.guard && result.kind === "checkout") {
            await finishCloseGuard(web.guard, { actorId: Number(auth.user.id), subjectId: participant.id, visitId: web.visitId, via: "WEB_CHECKOUT", recorded: true });
        }
        if (result.kind === "checkin" || result.kind === "checkout") await notifyScanOutcome(result, eventTime);
        // After the tx (+ optional facility sweep) commits, so a concurrent
        // GET cannot refill the cache from uncommitted rows.
        invalidateAttendanceCache();

        // A live close from a badge that is not a keyholder went through as an
        // ordinary scan; the kiosk is told why the building did not close.
        return await toResponse(result, { ...wire, closeRefused });
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
