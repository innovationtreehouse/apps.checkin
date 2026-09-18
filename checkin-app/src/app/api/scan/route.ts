import { Prisma } from "@/generated/prisma/client";
import prisma from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { apiError, apiJson } from "@/lib/api-response";
import { processCheckin, processCheckout, finalizeFacilityClose, SUPERVISION_CONFIRM_MS, SUPERVISION_CONFIRM_DEADFRONT_MS } from "@/lib/scan-service";
import { appendPresenceEvent, parkReasonToClass, PresenceClass } from "@/lib/presence/events";
import { applyPresenceIntent, flushParkedClosed } from "@/lib/presence/project";
import { config } from "@/lib/config";
import { withKiosk } from "@/lib/kioskAuth";
import { SCAN_PROTOCOL_VERSION } from "@/lib/scanProtocol";
import { invalidateAttendanceCache } from "@/lib/getFullAttendance";

// A merged-away badge should still get its owner through the door — an admin
// tidying up dupes must not be the reason a member gets rejected at the
// scanner. Chains this long are pathological (real merges are 1 hop); cap so
// a corrupt/cyclic chain can't loop the lookup forever, and reissue instead.
const MAX_MERGE_HOPS = 5;

// docs/rules/attendance-checkin.md (kiosk resilience): a replayed scan older
// than this parks for human review instead of toggling — state may have moved
// on while the kiosk was offline, and a bare toggle can't tell entering from
// leaving.
const REPLAY_FRESHNESS_WINDOW_MS = 10 * 60 * 1000;

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
    async (_req, body: { participantId?: unknown; clientEventId?: unknown; scannedAt?: unknown; replay?: unknown; forceCloseToken?: unknown; forceCloseConfirmed?: unknown; dead?: unknown; deadStatus?: unknown; intent?: unknown; clockSuspect?: unknown; protocolVersion?: unknown }, auth) => {
    const startTime = Date.now();

    try {
        const participantId = body.participantId;

        if (!participantId || typeof participantId !== 'number') {
            return apiError("A valid numeric participantId is required.", 400);
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
        // has no server token to echo. Honored only on a replay (processCheckout),
        // and only when the server independently sees a last-keyholder-with-others
        // close — the flag bypasses the token, never the occupancy guards.
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

        // Web session: check if user can scan this participant
        let pendingHouseholdCheck = false;
        if (auth.type === 'session') {
            const user = auth.user;
            const isSelf = participantId === Number(user.id);
            const isAdmin = user.isSysadmin || user.isKeyholder || user.isBoardMember;

            // In production, only privileged users may self-check-in via web.
            // Everyone else must use the kiosk badge scanner.
            if (isSelf && !isAdmin && config.isProd()) {
                return apiError("Please use the kiosk badge scanner to check in.", 403);
            }

            if (!isSelf && !isAdmin) {
                if (user.householdId && user.householdLead) {
                    pendingHouseholdCheck = true;
                } else {
                    return apiError("Forbidden: You are not authorized to scan this user.", 403);
                }
            }
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

        // Household lead check: verify participant is in the same household
        if (pendingHouseholdCheck && auth.type === 'session') {
            if (participant.householdId !== auth.user.householdId) {
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
            const isConfirm = (confirmToken !== null && (await tx.visit.count({
                where: {
                    personId: participant.id,
                    departedAt: null,
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
            const threeSecondsAgo = new Date(Date.now() - 3000);
            const recentScan = (isConfirm || isDead) ? null : await tx.rawBadgeLog.findFirst({
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

            // A replay older than the freshness window, or one that lands behind
            // visit activity newer than its own scan time, can't be trusted to
            // toggle — state has moved past it. Park it for a human instead.
            // A dead-lettered event always parks: it never reaches the server
            // live, so there is nothing here for it to safely toggle against.
            let parkReason: string | null = null;
            if (clockSuspect) {
                parkReason = "clock_suspect";
            } else if (isDead) {
                parkReason = `client_dead:${deadStatus}`;
            } else if (isReplay) {
                const stale = Date.now() - eventTime.getTime() > REPLAY_FRESHNESS_WINDOW_MS;
                if (stale) {
                    parkReason = "stale_replay";
                } else {
                    const activity = await tx.visit.aggregate({
                        where: { personId: participant.id, deletedAt: null },
                        _max: { arrivedAt: true, departedAt: true },
                    });
                    const latestActivityAt = maxDate(activity._max.arrivedAt, activity._max.departedAt);
                    if (latestActivityAt && latestActivityAt > eventTime) {
                        parkReason = "out_of_order";
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
                    ...(parkReason ? { reviewReason: parkReason } : {}),
                },
            });

            // Dual-write the Stage-2 log. A parked scan must not consult Visit
            // state at all (the pinned park contract): only PARKED_CLOSED events
            // ever flush, and those always arrive through applyPresenceIntent
            // with a real intent — direction on any other parked event is
            // advisory review context, never projected.
            if (parkReason) {
                await appendPresenceEvent(tx, {
                    personId: participant.id,
                    occurredAt: eventTime,
                    direction: intent ?? "IN",
                    source: "SCANNER",
                    clientEventId,
                    classification: parkReasonToClass(parkReason),
                    clockSuspect,
                });
                return apiJson({ type: 'parked', message: 'Recorded for review.' });
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
            // (conflicts park; closed non-keyholder INs hold for C). Legacy
            // callers without intent still toggle from live state.
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
                });
            }

            const res = activeVisit
                ? await processCheckout(participant, activeVisit.id, authType, tx, confirmToken, eventTime, isReplay ? clientEventId : null, forceCloseConfirmed)
                : await processCheckin(participant, authType, tx, eventTime);

            // Classification comes from the ACTUAL outcome. Only a confirmed
            // toggle is PROJECTED; only a genuine closed-facility hold is
            // PARKED_CLOSED (the auto-flush class) — review parks keep their
            // own class so the flush can never bypass a human gate; warnings
            // (visit still open) stay unclassified.
            let classification: string | null = null;
            try {
                const body = (await res.clone().json()) as { type?: string; reason?: string };
                if (body.type === "checkin" || body.type === "checkout") {
                    classification = PresenceClass.PROJECTED;
                } else if (body.type === "parked") {
                    classification = body.reason ? parkReasonToClass(body.reason) : null;
                }
            } catch {
                classification = null;
            }
            await appendPresenceEvent(tx, {
                personId: participant.id,
                occurredAt: eventTime,
                direction: activeVisit ? "OUT" : "IN",
                source: "SCANNER",
                clientEventId,
                classification,
            });
            if (!activeVisit && participant.isKeyholder && classification === PresenceClass.PROJECTED) {
                await flushParkedClosed(tx);
            }
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
            if (clientEventId && err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
                return apiJson({ type: 'duplicate_ignored', message: 'Event already recorded.' });
            }
            throw err;
        }

        // Facility-wide close runs here, AFTER the per-participant transaction
        // commits and the advisory lock is released. Keeping the sweep + email
        // kick out of the locked section means a last-isKeyholder close no longer
        // blocks concurrent scans for other participants. No-op unless the
        // response reports facilityClosed.
        await finalizeFacilityClose(res);
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
