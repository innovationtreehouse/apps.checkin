import prisma from "@/lib/prisma";
import { findAssociatedEventAt, processVisitCheckout } from "@/lib/attendanceTransitions";
import type { Person, Visit } from "@/generated/prisma/client";
import type { DbClient, TxClient } from "@/lib/db-client";
import { withFacilityLock } from "@/lib/facilityLock";
import { KEYHOLDER_IN_BUILDING, LIVE_VISIT } from "@/lib/visit/filters";
import { LATE_CLOSE_SKEW_MS, MAX_VISIT_MS } from "@/lib/visitTimes";
import { MIN_SUPERVISING_ADULTS, supervisingAdultCount, supervisingAdultVisits, youthIsPresent } from "@/lib/supervision";
import { isYouth } from "@/lib/time";
import { invalidateAttendanceCache } from "@/lib/getFullAttendance";
import { auditKioskLeave, closeVia, recordClose } from "@/lib/attendance/close";
import { specTrace } from "@/lib/specTrace";

/** Countdown on the supervision confirm (#1436). #1347 PR-0 extended the
 *  route's debounce exemption to a fresh `supervisionWarnedAt` stamp, so the
 *  full window is usable -- kiosk copy says "within 15 seconds". */
export const SUPERVISION_CONFIRM_MS = 15_000;

/** Floor on the route's debounce exemption (Fable review, #1347 PR-0): a USB
 *  hardware double-read of the warning scan lands ~300-800ms later with the
 *  stamp already fresh. Below this age, treat it as the same physical badge. */
export const SUPERVISION_CONFIRM_DEADFRONT_MS = 1_000;

/** Someone recorded inside, as a close offer names them. */
export type VisitInside = { id: number; arrivedAt: Date; person: Pick<Person, "name" | "nickname" | "email"> };

/** Why the kiosk is offered a close after a keyholder's checkout. */
export type CloseOffer =
    /** No other keyholder is in; `othersInside` is everyone else still recorded inside. */
    | { reason: "last_keyholder"; othersInside: VisitInside[] }
    /** Other keyholders are recorded inside. */
    | { reason: "keyholders_remain" }
    /** A one-badge close held: these checked in after the kiosk's roster. */
    | { reason: "unseen_checkins"; unseen: VisitInside[] };

/** Why a scan was recorded without changing anyone's visit. */
export type ParkReason =
    /** A visit opened for the person between the route's read and the facility lock. */
    | "double_in"
    /** A displayed IN for someone already inside. */
    | "conflict_double_in"
    /** A displayed OUT for someone not inside. */
    | "conflict_out_no_in"
    /** Held for a reviewer: dead-lettered, stale, out of order or a doubtful clock. */
    | "review";

/**
 * What a scan did, as domain facts. The scan route renders it to the kiosk wire
 * (app/api/scan/scanResponse.ts); nothing here is a status, a message or a wire
 * flag.
 */
export type ScanOutcome =
    | {
        kind: "checkin";
        person: Person;
        visit: Visit;
        /** A youth arrived into a room short of supervising adults. */
        supervisionShort: boolean;
        /** A replayed arrival departed at a close that reached the server first. */
        departedAtClose: boolean;
    }
    | {
        kind: "checkout";
        person: Person;
        /** The departed visit; null when the checkout departed no row. */
        visit: Visit | null;
        closed: boolean;
        /** Supervising adults this departure leaves, when the room is to be told. */
        supervisorsRemaining?: number;
        closeOffer?: CloseOffer;
    }
    /** A departure stopped until the person badges again: it leaves a youth short of supervision. */
    | { kind: "confirm_departure"; supervisorsRemaining: number }
    | { kind: "parked"; reason: ParkReason };

/**
 * Process a check-in for a participant who has no active visit.
 *
 * The scan route passes its transaction client `db` so these reads and writes
 * run under the per-participant advisory lock. When called standalone (e.g.
 * unit tests) `db` defaults to the global prisma client. Notifications are the
 * caller's job, after commit (see notifyScanOutcome).
 */
export async function processCheckin(
    participant: Person,
    db: DbClient = prisma,
    /** A replay's scan time; absent for a live check-in. */
    visitTime?: Date,
    /** A trusted replay's event id: the arrival is fenced by any close after its scan time. */
    fenceClientEventId?: string | null,
): Promise<ScanOutcome> {
    // Facility lock serializes the open-state read and the create against the
    // last-keyholder sweep: a check-in lands wholly before a close (and is swept)
    // or wholly after it. Same 2-arg lock space as the close sweep —
    // independent of the per-person lock the scan route already holds.
    return withFacilityLock(db, async (tx) => {
    // Callers read "no open visit" before this lock; a concurrent check-in for
    // the same person can land in that window. Park the scan instead of
    // letting the one-open-visit index throw.
    const openVisit = await tx.visit.findFirst({
        where: { personId: participant.id, departedAt: null, ...LIVE_VISIT },
        select: { id: true },
    });
    if (openVisit) {
        return { kind: "parked", reason: "double_in" };
    }

    if (visitTime && fenceClientEventId) {
        const fenced = await fenceReplayedArrival(tx, participant.id, visitTime, fenceClientEventId);
        if (fenced) {
            specTrace("VisitOpen", { p: participant.id, visitId: fenced.id, t: visitTime.getTime(), live: false, fencedBy: fenced.facilityCloseId });
            return { kind: "checkin", person: participant, visit: fenced, supervisionShort: false, departedAtClose: true };
        }
    }

    // A badge at the kiosk always checks in — someone scanning inside the
    // building got in somehow, and the screen must show them. With no keyholder
    // present the visit reads as "no keyholder" (derived in getFullAttendance).

    // A live arrival is stamped once it holds the facility lock: after any close
    // it waited behind was carried out, so it reads as arriving after that close.
    const arrivalTime = visitTime ?? new Date();
    const eventId = await findAssociatedEventAt(participant.id, arrivalTime, tx);

    const newVisit = await tx.visit.create({
        data: {
            personId: participant.id,
            arrivedAt: arrivalTime,
            arrivedVia: "SCANNER",
            arrivedLive: !visitTime,
            associatedEventId: eventId
        },
    });
    invalidateAttendanceCache();
    specTrace("VisitOpen", { p: participant.id, visitId: newVisit.id, t: arrivalTime.getTime(), live: !visitTime, fencedBy: null });

    // A youth arriving into a room short of supervision is WARNED, never blocked
    // (#1436): opening the door before the second adult is the keyholder's call to
    // make, and the app's job is to tell the room. Only asked for youth, so an
    // ordinary adult check-in still costs no extra query.
    const isYouthArrival = !participant.isDeclaredAdult
        && isYouth(participant.dateOfBirth, { unknownIs: "youth" });
    const supervisionShort = isYouthArrival
        && supervisingAdultCount(await supervisingAdultVisits(tx)) < MIN_SUPERVISING_ADULTS;

    return { kind: "checkin", person: participant, visit: newVisit, supervisionShort, departedAtClose: false };
    });
}

/**
 * A replayed arrival scanned before a close that reached the server first
 * departs at that close, as the close's sweep would have departed it, and is
 * flagged. Read under the facility lock, so every close committed before this
 * check-in is seen; a close recorded after it sweeps it instead. A close from
 * the kiosk's own queue was stamped by the same clock as the arrival, so it
 * gets no clock-skew allowance.
 */
async function fenceReplayedArrival(tx: TxClient, personId: number, arrivedAt: Date, clientEventId: string) {
    const fence = await tx.facilityClose.findFirst({
        where: {
            OR: [
                { closedAt: { gte: arrivedAt } },
                { closedAt: { gte: new Date(arrivedAt.getTime() - LATE_CLOSE_SKEW_MS) }, via: { not: "KIOSK_OFFLINE" } },
            ],
        },
        orderBy: { closedAt: "asc" },
        select: { id: true, closedAt: true },
    });
    if (!fence) return null;
    const visit = await tx.visit.create({
        data: {
            personId,
            arrivedAt,
            arrivedVia: "SCANNER",
            arrivedLive: false,
            departedAt: new Date(Math.min(
                Math.max(fence.closedAt.getTime(), arrivedAt.getTime()),
                arrivedAt.getTime() + MAX_VISIT_MS,
            )),
            departedVia: "FACILITY_CLOSE",
            facilityCloseId: fence.id,
            associatedEventId: await findAssociatedEventAt(personId, arrivedAt, tx),
        },
    });
    await tx.rawBadgeLog.updateMany({ where: { clientEventId }, data: { reviewReason: "closed_before_delivery" } });
    return visit;
}

/** A kiosk older than the close-request generation sends no close request, so
 *  its keyholder checkout still decides the close: shown others (`shownEmpty`
 *  false) leaves, and unsaid falls back to the server's records. The route reads
 *  `shownEmpty: true` as a one-badge close request. `clientEventId` is the scan's,
 *  for flagging a replay. */
export type LegacyKiosk = { shownEmpty: boolean | null; clientEventId: string | null };

/**
 * Process a check-out for a participant who has an active visit. Only this
 * person leaves: a building close is its own request (see
 * {@link processCloseRequest}), decided by the kiosk. The one exception is a {@link LegacyKiosk}, whose keyholder checkout may close.
 *
 * `db` is the scan route's transaction client (covered by the per-participant
 * advisory lock) or, when called standalone, the global prisma client.
 */
export async function processCheckout(
    participant: Person,
    activeVisitId: number,
    db: DbClient = prisma,
    visitTime: Date = new Date(),
    isReplay: boolean = false,
    legacy: LegacyKiosk | null = null,
): Promise<ScanOutcome> {
    let facilityClosed = false;
    let closeOffer: CloseOffer | undefined;
    /** The last recorded keyholder's single-badge leave, with how many it left inside. */
    let leave: { othersInside: number } | null = null;

    if (participant.isKeyholder) {
        const remainingKeyholders = await db.visit.count({
            where: {
                ...KEYHOLDER_IN_BUILDING,
                id: { not: activeVisitId },
                // A late replay reads the building as it was at the scan.
                ...(isReplay ? { arrivedAt: { lte: visitTime } } : {}),
            },
        });
        const others = remainingKeyholders === 0
            ? await db.visit.findMany({
                where: { departedAt: null, deletedAt: null, id: { not: activeVisitId } },
                include: { person: true },
            })
            : [];
        if (remainingKeyholders === 0 && legacy && others.length === 0 && legacy.shownEmpty !== false) {
            facilityClosed = true;
        } else if (remainingKeyholders === 0) {
            leave = { othersInside: others.length };
            if (legacy) {
                if (!isReplay) closeOffer = { reason: "last_keyholder", othersInside: others };
                if (isReplay && legacy.clientEventId) {
                    // Nobody confirmed a close: the leave applies, and a human
                    // checks who the server still records inside.
                    await db.rawBadgeLog.updateMany({
                        where: { clientEventId: legacy.clientEventId },
                        data: { reviewReason: "force_close_review" },
                    });
                }
            }
        } else if (legacy && !isReplay) {
            closeOffer = { reason: "keyholders_remain" };
        }
    }

    // SUPERVISION INTERRUPT (#1436). Fires on every live badge departure.
    // Skipped when the facility is closing: that sweep departs everyone.
    // Skipped for a REPLAY: its 400 records nothing but the drain acks that
    // shape, so the queued departure would be dropped and the visit left open.
    let supervisorsRemaining: number | undefined;
    if (!facilityClosed && !isReplay) {
        const interrupt = await supervisionInterrupt(activeVisitId, db);
        if (interrupt?.confirm) return { kind: "confirm_departure", supervisorsRemaining: interrupt.remaining };
        supervisorsRemaining = interrupt?.remaining;
    }

    const finalVisits = await processVisitCheckout(activeVisitId, visitTime, db, "SCANNER");
    const updatedVisit = finalVisits.length > 0 ? finalVisits[finalVisits.length - 1] : null;
    if (facilityClosed) {
        await recordClose(db, { closedById: participant.id, via: closeVia(isReplay) }, visitTime);
    }
    if (leave) await auditKioskLeave(db, participant.id, updatedVisit?.id ?? activeVisitId, isReplay, leave.othersInside);

    return { kind: "checkout", person: participant, visit: updatedVisit, closed: facilityClosed, supervisorsRemaining, closeOffer };
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
): Promise<{ remaining: number; confirm: boolean } | null> {
    const supervising = await supervisingAdultVisits(db);
    const before = supervisingAdultCount(supervising);
    const remaining = supervisingAdultCount(supervising, activeVisitId);
    if (remaining >= before || remaining > MIN_SUPERVISING_ADULTS) return null;

    if (remaining === MIN_SUPERVISING_ADULTS) return { remaining, confirm: false };

    // The confirm rung is youth-gated (#1436, 2026-08-19): policy's floor is two
    // adults whenever a youth is, so an adult-only room locking up warns and goes.
    // Probed on this rung only — every quieter departure pays nothing for it.
    if (!(await youthIsPresent(db))) return { remaining, confirm: false };

    const ownVisit = await db.visit.findUnique({
        where: { id: activeVisitId },
        select: { supervisionWarnedAt: true },
    });
    const warnedAt = ownVisit?.supervisionWarnedAt;
    if (warnedAt != null && Date.now() - warnedAt.getTime() <= SUPERVISION_CONFIRM_MS) return null;

    await db.visit.update({
        where: { id: activeVisitId },
        data: { supervisionWarnedAt: new Date() },
    });
    return { remaining, confirm: true };
}
