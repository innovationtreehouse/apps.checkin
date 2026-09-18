import prisma from "@/lib/prisma";
import { findAssociatedEventAt, processVisitCheckout } from "@/lib/attendanceTransitions";
import { sendCheckinNotifications } from "@/lib/notifications";
import { apiError, apiJson } from "@/lib/api-response";
import type { Person } from "@/generated/prisma/client";
import { type DbClient, isRootClient } from "@/lib/db-client";
import { withFacilityLock } from "@/lib/facilityLock";
import { MAX_VISIT_MS } from "@/lib/visitTimes";
import { MIN_SUPERVISING_ADULTS, supervisingAdultCount, supervisingAdultVisits, youthIsPresent } from "@/lib/supervision";
import { isYouth } from "@/lib/time";
import { getKioskDisplayName } from "@/lib/kiosk-names";
import { invalidateAttendanceCache } from "@/lib/getFullAttendance";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

/**
 * What a scan response may say about who scanned: an id and the same
 * nickname-else-first-name label the kiosk roster shows. The kiosk renders this on
 * an unattended public screen and forwards it into an iframe with a wildcard
 * postMessage origin (client/client.py), so the raw Person — email, phone, date of
 * birth — never ships (docs/rules/attendance-checkin.md, "The kiosk").
 */
function scanParticipant(participant: Person) {
    return { id: participant.id, name: getKioskDisplayName(participant) };
}

/** Seconds the kiosk counts down after showing the force-close warning. The
 *  countdown is display; the confirm is the token, which has no elapsed-time
 *  gate — see the confirm check in processCheckout. */
export const FORCE_CLOSE_CONFIRM_SECONDS = 15;

/** Countdown on the supervision confirm (#1436). #1347 PR-0 extended the
 *  route's debounce exemption to a fresh `supervisionWarnedAt` stamp, so the
 *  full window is usable -- kiosk copy says "within 15 seconds". */
export const SUPERVISION_CONFIRM_MS = 15_000;

/** Floor on the route's debounce exemption (Fable review, #1347 PR-0): a USB
 *  hardware double-read of the warning scan lands ~300-800ms later with the
 *  stamp already fresh. Below this age, treat it as the same physical badge. */
export const SUPERVISION_CONFIRM_DEADFRONT_MS = 1_000;

/**
 * Process a check-in for a participant who has no active visit.
 *
 * The scan route passes its transaction client `db` so these reads and writes
 * run under the per-participant advisory lock. When called standalone (e.g.
 * unit tests) `db` defaults to the global prisma client. Fire-and-forget side
 * effects (notifications) intentionally run off the global client either way.
 */
export async function processCheckin(participant: Person, authType: string, db: DbClient = prisma, visitTime: Date = new Date()) {
    // Facility lock covers the open-state read AND the create, so a racing
    // last-keyholder sweep (#254) cannot leave this visit open after close.
    // Same 2-arg lock space as runFacilityClose — independent of the per-person
    // lock the scan route already holds.
    return withFacilityLock(db, async (tx) => {
    // Non-keyholders require an open facility (at least 1 isKeyholder present)
    if (!participant.isKeyholder) {
        const activeKeyholders = await tx.visit.count({
            where: {
                departedAt: null,
                deletedAt: null,
                person: { isKeyholder: true }
            }
        });

        if (activeKeyholders === 0) {
            // Closed is advisory: a kiosk badge is held (projection C) until a
            // keyholder Visit exists, then auto-projected in occurredAt order.
            // The raw log still carries facility_closed so the scan stays
            // visible on the review panel — without it, a night where no
            // keyholder ever arrives leaves the touch in limbo on every
            // surface. A flushed event's row is simply dismissible.
            // Dashboard check-in still 403s (no badge to hold).
            if (authType === "kiosk") {
                const badge = await tx.rawBadgeLog.findFirst({
                    where: { personId: participant.id, reviewReason: null },
                    orderBy: { timestamp: "desc" },
                    select: { id: true },
                });
                if (badge) {
                    await tx.rawBadgeLog.update({
                        where: { id: badge.id },
                        data: { reviewReason: "facility_closed" },
                    });
                }
                return apiJson({ type: "parked", reason: "facility_closed", message: "Recorded. Will project when a keyholder is present." });
            }
            return apiError("Facility is closed. A Keyholder must check in first.", 403);
        }
    }

    const arrivalTime = visitTime;
    const eventId = await findAssociatedEventAt(participant.id, arrivalTime, tx);

    const newVisit = await tx.visit.create({
        data: {
            personId: participant.id,
            arrivedAt: arrivalTime,
            arrivedVia: "SCANNER",
            associatedEventId: eventId
        },
    });
    invalidateAttendanceCache();

    // Fire-and-forget: send check-in notifications
    sendCheckinNotifications(participant.id, 'checkin', 'SCANNER').catch(err =>
        console.error('Checkin notification error:', err)
    );

    // A youth arriving into a room short of supervision is WARNED, never blocked
    // (#1436): opening the door before the second adult is the keyholder's call to
    // make, and the app's job is to tell the room. Only asked for youth, so an
    // ordinary adult check-in still costs no extra query.
    const isYouthArrival = !participant.isDeclaredAdult
        && isYouth(participant.dateOfBirth, { unknownIs: "youth" });
    const supervisionWarning = isYouthArrival
        && supervisingAdultCount(await supervisingAdultVisits(tx)) < MIN_SUPERVISING_ADULTS
        ? `Warning: fewer than ${MIN_SUPERVISING_ADULTS} supervising adults are in the building.`
        : undefined;

    return apiJson({
        message: "Checked in successfully",
        type: "checkin" as const,
        warning: supervisionWarning,
        participant: scanParticipant(participant),
        visit: newVisit,
        signedRequest: authType === "kiosk",
    });
    });
}

/**
 * Process a check-out for a participant who has an active visit.
 * Handles last-isKeyholder logic and facility closure.
 *
 * `db` is the scan route's transaction client (covered by the per-participant
 * advisory lock) or, when called standalone, the global prisma client.
 */
export async function processCheckout(
    participant: Person,
    activeVisitId: number,
    authType: string,
    db: DbClient = prisma,
    /** Force-close confirm token echoed by this scan, live or replayed. */
    confirmToken: string | null = null,
    visitTime: Date = new Date(),
    /** clientEventId of a REPLAYED event (drain-delivered), null for a live scan. */
    replayEventId: string | null = null,
    /** The kiosk confirmed this close locally while offline — the two-scan
     *  confirm ran on the kiosk, no server token was ever minted to echo.
     *  Honored only on a replay; a live scan stays server-authoritative. */
    forceCloseConfirmed: boolean = false
) {
    let facilityClosed = false;

    if (participant.isKeyholder) {
        const remainingKeyholders = await db.visit.count({
            where: {
                departedAt: null,
                deletedAt: null,
                person: { isKeyholder: true },
                id: { not: activeVisitId }
            }
        });

        if (remainingKeyholders === 0) {
            const remainingUsers = await db.visit.findMany({
                where: {
                    departedAt: null,
                    deletedAt: null,
                    id: { not: activeVisitId }
                },
                include: { person: true }
            });

            if (remainingUsers.length > 0) {
                const ownVisit = await db.visit.findUnique({
                    where: { id: activeVisitId },
                    select: { forceCloseToken: true }
                });
                // The confirm is the token this scan echoes, not the gap between
                // badges and not the wall clock: the countdown runs on the kiosk,
                // so a confirm queued through an outage still closes on arrival.
                // The token is a bearer credential, so compare it timing-safely:
                // hash both sides to a fixed length first (same idiom as
                // cronAuth.ts) so timingSafeEqual can't throw on a length
                // mismatch and no length leaks.
                const stored = ownVisit?.forceCloseToken;
                const confirmForceClose =
                    confirmToken != null && stored != null && timingSafeEqual(
                        createHash("sha256").update(stored).digest(),
                        createHash("sha256").update(confirmToken).digest()
                    );

                // Offline close: while disconnected the kiosk has no server token
                // to mint, so it runs the two-scan warning+confirm locally and
                // flags the confirmed close on the queued event. A force-close
                // confirm is valid by issuance (docs/rules/attendance-checkin.md,
                // kiosk resilience), extended here to a client-issued confirm -- a
                // keyholder standing at the reader confirmed the room is clear.
                // Honored only on a replay (the drain); a live scan carrying the
                // flag falls through to the server-authoritative token flow below.
                // This bypasses ONLY the token: the isKeyholder / no-other-keyholder
                // / others-present guards above still bound it, so a client flag can
                // never close a facility the server doesn't independently read as a
                // last-keyholder-with-others close.
                const offlineConfirmed = forceCloseConfirmed && replayEventId != null;

                if (!confirmForceClose && !offlineConfirmed && replayEventId) {
                    // A replay WITHOUT a token and WITHOUT the offline-confirmed flag
                    // was never confirmed by anyone, and nobody is at the reader hours
                    // later to answer a warning, so park it for a human. Never mint
                    // or stamp on a replay: an unattended countdown is not a confirm.
                    await db.rawBadgeLog.update({
                        where: { clientEventId: replayEventId },
                        data: { reviewReason: 'force_close_review' },
                    });
                    return apiJson({ type: 'parked', reason: 'force_close_review', message: 'Recorded for review.' });
                }

                if (!confirmForceClose && !offlineConfirmed) {
                    // Mint a fresh token with the warning; the old one dies here, so
                    // an unconfirmed countdown cannot be redeemed later.
                    const token = randomUUID();
                    await db.visit.update({
                        where: { id: activeVisitId },
                        data: { forceCloseWarnedAt: new Date(), forceCloseToken: token }
                    });

                    // Never render the raw address (tier `pii`) on the kiosk screen (#329):
                    // fall back to the email local-part, same as getFullAttendance /
                    // kioskdisplay/certifications.
                    const names = remainingUsers
                        .map(u => u.person.name?.trim() || u.person.email?.split("@")[0] || "")
                        .filter(Boolean)
                        .join(", ");
                    return apiJson({
                        error: `Warning! You are the last isKeyholder, but others are here:\n${names}\n\nBadge again within ${FORCE_CLOSE_CONFIRM_SECONDS} seconds to confirm you've checked them and close the facility.`,
                        type: "warning" as const,
                        forceCloseToken: token,
                        confirmSeconds: FORCE_CLOSE_CONFIRM_SECONDS
                    }, 400);
                }
            }

            facilityClosed = true;

            // The token is spent. Clear it before the visit departs so no
            // redeemable force-close state survives on a closed row — every
            // lookup filters `departedAt: null` today, but one that forgets to
            // shouldn't find a live-looking token.
            await db.visit.update({
                where: { id: activeVisitId },
                data: { forceCloseWarnedAt: null, forceCloseToken: null }
            });

            // The facility-wide sweep takes row locks on EVERY open visit, and
            // the email kick fires its own DB queries. Neither may run inside the
            // scan route's per-participant advisory-lock transaction: it would
            // block concurrent scans for other participants and let the email run
            // contend on the still-open transaction. When called standalone (root
            // client — e.g. tests) we own the whole operation, so run them here;
            // under the route's tx client the route runs both AFTER it commits
            // (see finalizeFacilityClose / route.ts).
            if (isRootClient(db)) {
                await runFacilityClose();
            }
        }
    }

    // SUPERVISION INTERRUPT (#1436). Fires on EVERY departure, not just a
    // keyholder's — the close-guard above is a separate interrupt with its own
    // stamp. Skipped when the facility is closing: that sweep departs everyone.
    // Skipped for a REPLAY too: its 400 records nothing but the drain acks that
    // shape, so the queued departure would be dropped and the visit left open.
    // Hours-old bookkeeping has no room to warn about and nobody to re-badge.
    let supervisionWarning: string | undefined;
    if (!facilityClosed && !replayEventId) {
        const interrupt = await supervisionInterrupt(activeVisitId, db);
        if (interrupt?.confirmRequired) return interrupt.response;
        supervisionWarning = interrupt?.warning;
    }

    const finalVisits = await processVisitCheckout(activeVisitId, visitTime, db, "SCANNER");
    const updatedVisit = finalVisits.length > 0 ? finalVisits[finalVisits.length - 1] : null;

    // Fire-and-forget: send check-out notifications (mirrors processCheckin)
    sendCheckinNotifications(participant.id, 'checkout').catch(err =>
        console.error('Checkout notification error:', err)
    );

    return apiJson({
        message: facilityClosed ? "Checked out and Facility closed" : "Checked out successfully",
        type: "checkout" as const,
        warning: supervisionWarning,
        participant: scanParticipant(participant),
        visit: updatedVisit,
        facilityClosed,
        signedRequest: authType === "kiosk",
    });
}

/**
 * The two-rung supervision ladder for a departure (#1436), keyed on how many
 * supervising adults would REMAIN — and only when this departure is what removes
 * one. A second adult from the same household leaving changes nothing, because
 * the household is still represented; that is the same-household rule.
 *
 *   remaining === 2 (the third supervising adult leaves) → warn, do not confirm.
 *   remaining  <  2 (the next one leaves), youth present → warn AND confirm.
 *   remaining  <  2 with no youth in the building        → warn, do not confirm.
 *
 * Only the confirm rung is youth-gated; the warn rung over-warns deliberately.
 *
 * The confirm is bound to the warning having been SHOWN, not to badge adjacency:
 * only a scan following a fresh `supervisionWarnedAt` stamp goes through, exactly
 * as the force-close confirm works. Countdown window is
 * {@link SUPERVISION_CONFIRM_MS}; #1347's explicit-confirm slice renders the tick.
 */
async function supervisionInterrupt(
    activeVisitId: number,
    db: DbClient,
): Promise<{ confirmRequired: true; response: Response } | { confirmRequired: false; warning?: string } | null> {
    const supervising = await supervisingAdultVisits(db);
    const before = supervisingAdultCount(supervising);
    const remaining = supervisingAdultCount(supervising, activeVisitId);
    if (remaining >= before || remaining > MIN_SUPERVISING_ADULTS) return null;

    if (remaining === MIN_SUPERVISING_ADULTS) {
        return {
            confirmRequired: false,
            warning: `Warning: only ${MIN_SUPERVISING_ADULTS} supervising adults remain in the building.`,
        };
    }

    const left = remaining === 1 ? "only 1 supervising adult" : "NO supervising adult";

    // The confirm rung is youth-gated (#1436, 2026-08-19): policy's floor is two
    // adults whenever a youth is, so an adult-only room locking up warns and goes.
    // Probed on this rung only — every quieter departure pays nothing for it.
    if (!(await youthIsPresent(db))) {
        return { confirmRequired: false, warning: `Warning: checking out leaves ${left} in the building.` };
    }

    const ownVisit = await db.visit.findUnique({
        where: { id: activeVisitId },
        select: { supervisionWarnedAt: true },
    });
    const warnedAt = ownVisit?.supervisionWarnedAt;
    if (warnedAt != null && Date.now() - warnedAt.getTime() <= SUPERVISION_CONFIRM_MS) {
        return { confirmRequired: false };
    }

    await db.visit.update({
        where: { id: activeVisitId },
        data: { supervisionWarnedAt: new Date() },
    });
    return {
        confirmRequired: true,
        response: apiJson({
            error: `Warning! Checking out leaves ${left} in the building.\n\nBadge again within ${SUPERVISION_CONFIRM_MS / 1000} seconds to confirm.`,
            type: "warning" as const,
        }, 400),
    };
}

/** Mark every still-open visit as departed. Facility-wide, not participant-scoped:
 *  a single atomic statement, so it needs no wrapping transaction.
 *
 *  Raw rather than `updateMany` because the stamp is per-row: the close moment
 *  is capped at the visit's own `arrivedAt + MAX_VISIT_MS`, and `updateMany`
 *  can only set one constant for every row it touches.
 *
 *  FACILITY_CLOSE, not AUTO_CLOSE: the stamp is normally the moment the building
 *  actually closed, so it is bounded by building hours — plausible, unlike the
 *  cron's midnight sweep. Where the cap bites the stamp is 24h after arrival
 *  instead; both are placeholders the member is meant to correct, and a
 *  placeholder inside the 24h rule beats an accurate record that breaks it.
 *
 *  `now()` is timestamptz and the columns are timestamp-without-zone holding
 *  UTC, so the clock must be pulled AT TIME ZONE 'UTC' or the comparison is off
 *  by the server's offset. */
async function closeAllOpenVisits(db: DbClient) {
    // Tombstoned visits are excluded: closing one would rewrite a record the
    // member chose to erase, and resurrect a machine departure if it is undone.
    await db.$executeRaw`
        UPDATE "Visit"
        SET "departedAt" = LEAST(
                (now() AT TIME ZONE 'UTC'),
                "arrivedAt" + ${MAX_VISIT_MS}::double precision * interval '1 millisecond'
            ),
            "departedVia" = 'FACILITY_CLOSE'::"VisitSource"
        WHERE "departedAt" IS NULL AND "deletedAt" IS NULL`;
}

/** Fire-and-forget post-event email run on facility close. The dynamic import
 *  AND the call are both in the promise chain, so an import or run failure is
 *  logged, never an unhandled rejection. */
function kickPostEventEmails() {
    import("@/lib/postEventEmails")
        .then(({ processPostEventEmails }) => processPostEventEmails({ forceImmediate: true }))
        .catch(err => console.error("Failed to run post-event emails on facility close:", err));
}

/**
 * Close every open visit and kick post-event emails. Called after the
 * last-keyholder checkout is committed — both from the scan route (via
 * finalizeFacilityClose) and from web close paths.
 */
export async function runFacilityClose(): Promise<void> {
    await withFacilityLock(prisma, (tx) => closeAllOpenVisits(tx));
    // After the lock/tx commits so a concurrent kiosk GET cannot refill the
    // cache from still-open rows (READ COMMITTED).
    invalidateAttendanceCache();
    kickPostEventEmails();
}

export type CloseGuardResult =
    | { action: 'proceed'; facilityClosed: boolean }
    | { action: 'warn'; token: string; names: string; message: string; confirmSeconds: number };

/**
 * Last-keyholder close guard for web close paths. Checks whether closing
 * (or tombstoning) this visit would leave the facility without a keyholder.
 *
 * - Not a keyholder, or other keyholders remain → proceed, no close.
 * - Last keyholder, nobody else present → proceed, facility closes.
 * - Last keyholder, others present, no valid token → warn (mint a token).
 * - Last keyholder, others present, valid token → proceed, facility closes.
 *
 * Callers run `runFacilityClose()` when `facilityClosed` is true, AFTER
 * the visit is departed/tombstoned.
 */
export async function lastKeyholderGuard(
    visitId: number,
    person: { isKeyholder: boolean },
    clientToken: string | null | undefined,
    db: DbClient = prisma,
): Promise<CloseGuardResult> {
    if (!person.isKeyholder) return { action: 'proceed', facilityClosed: false };

    const remainingKeyholders = await db.visit.count({
        where: { departedAt: null, deletedAt: null, person: { isKeyholder: true }, id: { not: visitId } }
    });
    if (remainingKeyholders > 0) return { action: 'proceed', facilityClosed: false };

    const remainingUsers = await db.visit.findMany({
        where: { departedAt: null, deletedAt: null, id: { not: visitId } },
        include: { person: true }
    });

    if (remainingUsers.length > 0) {
        const visit = await db.visit.findUnique({
            where: { id: visitId },
            select: { forceCloseToken: true }
        });
        const stored = visit?.forceCloseToken;
        const confirmed =
            clientToken != null && stored != null && timingSafeEqual(
                createHash("sha256").update(stored).digest(),
                createHash("sha256").update(String(clientToken)).digest()
            );

        if (!confirmed) {
            const token = randomUUID();
            await db.visit.update({
                where: { id: visitId },
                data: { forceCloseWarnedAt: new Date(), forceCloseToken: token }
            });
            const names = remainingUsers
                .map(u => u.person.name?.trim() || u.person.email?.split("@")[0] || "")
                .filter(Boolean)
                .join(", ");
            return {
                action: 'warn',
                token,
                names,
                message: `Warning: you are checking out the last keyholder, but others are still here: ${names}. Confirm to close the facility and check everyone out.`,
                confirmSeconds: FORCE_CLOSE_CONFIRM_SECONDS,
            };
        }
    }

    await db.visit.update({
        where: { id: visitId },
        data: { forceCloseWarnedAt: null, forceCloseToken: null }
    });
    return { action: 'proceed', facilityClosed: true };
}

/**
 * Run the facility-wide visit close + post-event email kick AFTER the scan
 * route's per-participant transaction has committed — off the advisory lock.
 *
 * processCheckout (under the lock, on the tx client) only *decides* whether the
 * facility closed and reports it via `facilityClosed` in the response body; the
 * route hands that response here once committed. A sweep failure is logged, not
 * thrown, so it never turns an already-committed checkout into a 500.
 */
export async function finalizeFacilityClose(res: Response): Promise<void> {
    let body: { facilityClosed?: boolean } | null;
    try {
        body = await res.clone().json();
    } catch {
        return; // non-JSON / empty body (e.g. debounce) — nothing to close
    }
    if (!body?.facilityClosed) return;

    try {
        await runFacilityClose();
    } catch (err) {
        console.error("Failed to close facility-wide visits after scan:", err);
    }
}
