import prisma from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { apiError } from "@/lib/api-response";
import { processCheckin, processCheckout, type LegacyKiosk, SUPERVISION_CONFIRM_MS, SUPERVISION_CONFIRM_DEADFRONT_MS } from "@/lib/attendance/scan";
import { processCloseRequest, executePendingCloses, LIVE_ARRIVAL_WINDOW_MS } from "@/lib/attendance/close";
import { notifyScanOutcome } from "@/lib/attendance/scanNotify";
import { appendPresenceEvent, parkReasonToClass, PresenceClass } from "@/lib/presence/events";
import { applyPresenceIntent, flagForReview } from "@/lib/presence/project";
import { withKiosk } from "@/lib/kioskAuth";
import { recordKioskProtocolSeen } from "@/lib/kioskProtocolSeen";
import { CLOSE_REQUEST_PROTOCOL_VERSION, KIOSK_DEBOUNCE_PROTOCOL_VERSION, SCAN_PROTOCOL_VERSION, TRUSTED_REPLAY_PROTOCOL_VERSION } from "@/lib/scanProtocol";
import { invalidateAttendanceCache } from "@/lib/getFullAttendance";
import { uniqueViolationFields } from "@/lib/prismaUniqueViolation";
import { resolveMergedPerson } from "@/lib/person/mergeChain";
import { isLiveHousehold } from "@/lib/household/archived";
import { actsAsKeyholder } from "@/lib/visit/filters";
import { specTrace, traceOnCommit } from "@/lib/specTrace";
import type { Prisma } from "@/generated/prisma/client";
import { lastNightlyCloseAt } from "@/lib/attendance/nightlyClose";
import { type ScanResult, toResponse } from "./scanResponse";
import { parseScanBody } from "./scanBody";

// A replayed scan older
// than this still applies, and is also flagged for human review — state may
// have moved on while the kiosk was offline.
const REPLAY_FRESHNESS_WINDOW_MS = 10 * 60 * 1000;

// A replay stamped further ahead of server now than this came from a kiosk
// whose clock is wrong; it applies at server now, flagged clock_suspect.
const REPLAY_FUTURE_TOLERANCE_MS = 2 * 60 * 1000;

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

// The out-of-order guard needs the true latest activity across ALL of a
// participant's visits, not just the most-recently-arrived one -- a
// same-day/next-day resolution can write a departedAt newer than a
// later visit's own arrival, and comparing arrivedAt alone would miss it.
const maxDate = (a: Date | null, b: Date | null): Date | null =>
    !a ? b : !b ? a : (a > b ? a : b);

// High cap: kiosks burst and a whole facility may share one NAT IP. withKiosk
// reads the raw body and authenticates it; only a signed kiosk scans.
export const POST = withKiosk(
    { rateLimit: { name: "scan", limit: 300 } },
    async (_req, body: unknown, auth) => {
    if (auth.type !== 'kiosk') return apiError("Check in at the kiosk.", 403);

    const startTime = Date.now();
    // The protocol version recorded for this kiosk key; set only once the body passes validation.
    let seenVersion: number | null = null;

    try {
        const parsed = parseScanBody(body);
        if (!parsed.ok) return apiError(parsed.error, 400);
        const scan = parsed.scan;
        seenVersion = scan.recordedVersion;
        const { rawId, personId, clientEventId, scannedAt, intent, clockSuspect, rosterAsOf, slot } = scan;
        const isReplay = slot === "replay";
        const isDead = slot === "dead";
        const closeKind = scan.kind === "close" ? scan.close : null;
        const deadStatus = scan.slot === "dead" ? scan.status : null;
        const uncertaintyMs = scan.slot === "replay" ? scan.uncertaintyMs : 0;

        // A live scan is happening now and never inherits the kiosk's clock (the
        // freshness window and the debounce both measure against server now).
        let eventTime = ((isReplay || isDead) && scannedAt) || new Date();
        // A visit can't start or end in the future: a scan time ahead of server
        // now applies at now instead.
        const clockAhead = isReplay && eventTime.getTime() - Date.now() > REPLAY_FUTURE_TOLERANCE_MS;
        if (clockAhead) eventTime = new Date();

        specTrace("ScanRequest", {
            slot, p: rawId, cid: clientEventId, intent, close: closeKind,
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
        if ((isReplay || isDead) && scan.protocolVersion > SCAN_PROTOCOL_VERSION) {
            return apiError(`Unsupported protocolVersion ${scan.protocolVersion}; this server speaks ${SCAN_PROTOCOL_VERSION}.`, 426);
        }
        // A kiosk below the close-request generation still has its keyholder
        // checkout decide the close (whether the kiosk showed anyone else inside,
        // else the server's records); from that generation on, only a close
        // request closes.
        const legacyKiosk: LegacyKiosk | null = scan.protocolVersion < CLOSE_REQUEST_PROTOCOL_VERSION
            ? { shownEmpty: scan.shownEmpty, clientEventId }
            : null;

        // A dead-lettered read that names no person can never project. It still
        // lands in the review queue -- the scan is never discarded -- keyed by
        // the raw value read, so the kiosk can stop retrying it.
        // Read after the scan's transaction, so it never waits on a second connection while holding one.
        const respond = async (result: ScanResult, closeRefused = false): Promise<Response> =>
            toResponse(result, { signedRequest: true, closeRefused, lastNightlyCloseAt: await lastNightlyCloseAt() });
        const parkUnresolvable = async (): Promise<Response> => {
            const scannedValue = (typeof rawId === 'string' ? rawId : JSON.stringify(rawId) ?? '').slice(0, 64);
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
                specTrace("ScanCommit", { slot, p: rawId, cid: clientEventId, kind: "duplicate" });
                return respond({ kind: "duplicate" });
            }
            specTrace("ScanCommit", { slot, p: rawId, cid: clientEventId, kind: "parked", reason: "unresolvable" });
            return respond({ kind: "parked", reason: "review" });
        };
        if (personId === null) {
            return await parkUnresolvable();
        }

        // 3. Lookup participant. A badge still encoding a merged-away id must not
        // reject its owner at the door: it resolves to the surviving record, and a
        // broken chain asks the operator to reissue the badge. A member of an
        // archived household scans exactly as a badge that matches nobody.
        const resolved = await resolveMergedPerson(personId);
        if (resolved.kind !== "live" || !(await isLiveHousehold(resolved.person.householdId))) {
            if (isDead || isReplay) return await parkUnresolvable();
            specTrace("ScanCommit", { slot, p: personId, cid: clientEventId, kind: "rejected" });
            return resolved.kind === "broken"
                ? apiError(`This badge belongs to a merged record; reissue it for person ${resolved.lastId}.`, 409)
                : apiError(`Person ${personId} not found.`, 404);
        }
        const { person: participant, hops: mergeHops } = resolved;
        if (mergeHops > 0) {
            logger.info("Scan forwarded from merged record", {
                badgeId: personId,
                survivorId: participant.id,
                hops: mergeHops,
            });
        }

        // Steps 4–6 (debounce read → record event → find visit → check-in/out)
        // are a read-modify-write on this participant's visit state. Without
        // serialization, two near-simultaneous scans for the same participant
        // both pass the debounce read and both observe the same visit state
        // before either writes — producing two open visits (double check-in) or
        // a double check-out that 500s on Prisma P2025 when the second tries to
        // delete the already-deleted visit. We wrap the whole sequence in one
        // transaction and take a per-participant Postgres advisory xact lock at
        // the top, so concurrent scans for the same person serialize: the
        // second blocks until the first commits, then observes committed state
        // and branches correctly. The lock auto-releases on commit/rollback.
        let closeRefused = false;

        let result: ScanResult;
        try {
        result = await traceOnCommit(() => prisma.$transaction(async (tx): Promise<ScanResult> => {
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

            // A close inside the scan time's uncertainty: which side of it the scan
            // belongs on cannot be known, so the scan applies at its time and is flagged.
            const nearClose = uncertaintyMs > 0 && await tx.facilityClose.count({
                where: { closedAt: { gte: new Date(eventTime.getTime() - uncertaintyMs), lte: new Date(eventTime.getTime() + uncertaintyMs) } },
            }) > 0;

            // Only a keyholder closes. Live, the server knows the badge's role now,
            // so a non-keyholder's close is refused and the scan is an ordinary
            // checkout; a late delivery can't know the role at its scan time, so
            // it still closes and is flagged.
            const keyholder = closeKind !== null && await actsAsKeyholder(participant, tx);
            closeRefused = closeKind !== null && !keyholder && !isReplay && !isDead;
            // A close request is never debounced, parked or held: it is the
            // keyholder's decision, applied at its own time however late. A
            // closer who is no longer a keyholder (on a late delivery), or a
            // suspect clock, still closes and is flagged for review.
            if (closeKind && !closeRefused) {
                const flag = isDead ? `client_dead:${deadStatus}`
                    : !keyholder ? "close_not_keyholder"
                    : (clockSuspect || clockAhead) ? "clock_suspect"
                    : nearClose ? "close_time_uncertain"
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

            // A scan following a fresh supervisionWarnedAt stamp IS the supervision
            // confirm and must skip the debounce below.
            // Tied to the warning actually being shown, not badge adjacency. The
            // stamp side is floored at SUPERVISION_CONFIRM_DEADFRONT_MS: a USB
            // double-read of the warning scan itself lands well under that age and
            // must still debounce, or the room's warning would auto-confirm with no
            // human acknowledgment at all.
            const isConfirm = async () => (await tx.visit.count({
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
            const kioskDebounces = scan.protocolVersion >= KIOSK_DEBOUNCE_PROTOCOL_VERSION;
            // An older kiosk's late, out-of-order or clock-suspect scan still parks.
            const trustsReplays = scan.protocolVersion >= TRUSTED_REPLAY_PROTOCOL_VERSION;
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
                reviewReason ??= nearClose ? "close_time_uncertain" : behind ? "out_of_order" : stale ? "stale_replay" : null;

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

            // 6. Project. Intent-carrying events apply IN/OUT as displayed
            // (conflicts park). Legacy callers without intent still toggle from
            // live state.
            if (intent) {
                return applyPresenceIntent(tx, {
                    participant,
                    direction: intent,
                    occurredAt: eventTime,
                    source: "SCANNER",
                    clientEventId,
                    isReplay,
                    clockSuspect,
                    legacyKiosk,
                    // A close fences what came before it (processCheckin).
                    fenceClientEventId: isReplay && trustsReplays ? clientEventId : null,
                });
            }

            const outcome = activeVisit
                ? await processCheckout(participant, activeVisit.id, tx, eventTime, isReplay, legacyKiosk)
                : await processCheckin(participant, tx, isReplay ? eventTime : undefined);

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
            return outcome;
        }, {
            // maxWait: time a racing scan waits to acquire a connection / start.
            // timeout: ceiling on the whole locked section, including time spent
            // blocked on pg_advisory_xact_lock while an earlier scan holds it.
            maxWait: 5000,
            timeout: 15000,
        }));
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
                return respond({ kind: "duplicate" });
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
        if (result.kind === "checkin" || result.kind === "checkout") await notifyScanOutcome(result, eventTime);
        // After the tx (+ optional facility sweep) commits, so a concurrent
        // GET cannot refill the cache from uncommitted rows.
        invalidateAttendanceCache();

        // A live close from a badge that is not a keyholder went through as an
        // ordinary scan; the kiosk is told why the building did not close.
        return await respond(result, closeRefused);
    } finally {
        // Errors propagate to withKiosk's top-level catch/500; this finally only
        // records the metric and the kiosk's protocol version. The metric times the
        // handler body (post-auth), not rate-limit.
        const durationMs = Date.now() - startTime;
        prisma.systemMetricLog.create({
            data: {
                metric: "scan_response_time",
                value: durationMs,
            }
        }).catch((err: unknown) => logger.error("Failed to log scan_response_time metric:", err));
        const keyFingerprint = auth.keyFingerprint;
        const protocolVersion = seenVersion;
        if (keyFingerprint && protocolVersion !== null) {
            recordKioskProtocolSeen(keyFingerprint, protocolVersion).catch((err: unknown) => logger.error("Failed to record kiosk protocol version:", err));
        }
    }
});
