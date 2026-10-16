import prisma from "@/lib/prisma";
import { findAssociatedEventAt, processVisitCheckout } from "@/lib/attendanceTransitions";
import { sendCheckinNotifications } from "@/lib/notifications";
import { apiError, apiJson } from "@/lib/api-response";
import { Prisma, type FacilityCloseVia, type Person } from "@/generated/prisma/client";
import type { DbClient, TxClient } from "@/lib/db-client";
import { lockFacility, withFacilityLock } from "@/lib/facilityLock";
import { KEYHOLDER_IN_BUILDING, LIVE_KEYHOLDER, LIVE_VISIT } from "@/lib/visit/filters";
import { LATE_CLOSE_SKEW_MS, MAX_VISIT_MS } from "@/lib/visitTimes";
import { MIN_SUPERVISING_ADULTS, supervisingAdultCount, supervisingAdultVisits, youthIsPresent } from "@/lib/supervision";
import { isYouth } from "@/lib/time";
import { getKioskDisplayName, getKioskDisplayNames } from "@/lib/kiosk-names";
import { invalidateAttendanceCache } from "@/lib/getFullAttendance";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { logBackendError } from "@/lib/logger";
import { type AuditActor, personActor, systemActor } from "@/lib/auditActor";
import type { AuthenticatedUser } from "@/types/auth";
import { sendEmail } from "@/lib/email";
import { escapeHtml } from "@/lib/email-templates/base";
import { formatDateTime, formatTime } from "@/lib/time";
import { resolveDisplayTimezone } from "@/lib/appSettings";

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

/**
 * The "others are here" list on a force-close warning, labelled as the kiosk
 * roster labels people: nickname, else first name, a last initial only to tell
 * two apart, else the email local-part. Never a last name or an address — the
 * badge path renders it on the public kiosk screen (docs/rules/attendance-checkin.md,
 * "The kiosk"). Keyed by visit id, which is unique per row.
 */
function presentLabels(visits: { id: number; person: Pick<Person, "name" | "nickname" | "email"> }[]): string[] {
    const labels = getKioskDisplayNames(visits.map(v => ({ ...v.person, id: v.id })));
    return visits.flatMap(v => labels.get(v.id) || []);
}

/** Seconds the kiosk counts down after showing the force-close warning. The
 *  countdown is display; the confirm is the token, which has no elapsed-time
 *  gate — see the confirm check in processCheckout. */
export const FORCE_CLOSE_CONFIRM_SECONDS = 15;

/** How long a web close-choice dialog's answer is accepted; an older one was
 *  shown against a building that may have changed since. */
export const WEB_CLOSE_CHOICE_TTL_MS = 5 * 60_000;

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
 * unit tests) `db` defaults to the global prisma client. Notifications are the
 * caller's job, after commit (see notifyScanOutcome).
 */
export async function processCheckin(
    participant: Person,
    authType: string,
    db: DbClient = prisma,
    /** A replay's scan time; absent for a live check-in. */
    visitTime?: Date,
    /** A trusted replay's event id: the arrival is fenced by any close after its scan time. */
    fenceClientEventId?: string | null,
) {
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
        return apiJson({ type: "parked", reason: "double_in", message: "Recorded for review." });
    }

    if (visitTime && fenceClientEventId) {
        const fenced = await fenceReplayedArrival(tx, participant.id, visitTime, fenceClientEventId);
        if (fenced) return fenced;
    }

    // A badge at the kiosk always checks in — someone scanning inside the
    // building got in somehow, and the screen must show them. With no keyholder
    // present the visit reads as "no keyholder" (derived in getFullAttendance).
    // Every other surface needs a keyholder already present, a keyholder's own
    // check-in included: only a badge at the door opens the building.
    if (authType !== "kiosk") {
        const activeKeyholders = await tx.visit.count({ where: KEYHOLDER_IN_BUILDING });
        if (activeKeyholders === 0) {
            return apiError("Facility is closed. A keyholder must badge in at the door first.", 403);
        }
    }

    // A live arrival is stamped once it holds the facility lock: after any close
    // it waited behind was carried out, so it reads as arriving after that close.
    const arrivalTime = visitTime ?? new Date();
    const eventId = await findAssociatedEventAt(participant.id, arrivalTime, tx);

    const newVisit = await tx.visit.create({
        data: {
            personId: participant.id,
            arrivedAt: arrivalTime,
            arrivedVia: "SCANNER",
            arrivalSource: visitTime ? "REPLAYED_SCAN" : "LIVE_SCAN",
            associatedEventId: eventId
        },
    });
    invalidateAttendanceCache();

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
            arrivalSource: "REPLAYED_SCAN",
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
    return apiJson({ type: "checkin" as const, message: "Checked in; departed at the close that followed", visit });
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
 * {@link processCloseRequest}), decided by the kiosk or the web dialog. The one
 * exception is a {@link LegacyKiosk}, whose keyholder checkout may close.
 *
 * `db` is the scan route's transaction client (covered by the per-participant
 * advisory lock) or, when called standalone, the global prisma client.
 */
export async function processCheckout(
    participant: Person,
    activeVisitId: number,
    authType: string,
    db: DbClient = prisma,
    visitTime: Date = new Date(),
    isReplay: boolean = false,
    /** A web checkout whose dialog chose close; reported in the response. */
    webClose: boolean = false,
    legacy: LegacyKiosk | null = null,
) {
    let facilityClosed = authType !== "kiosk" && webClose;
    let closeOffer: { closePrompt: string; forceCloseToken: string; confirmSeconds: number } | null = null;
    /** The last recorded keyholder's single-badge leave, with how many it left inside. */
    let leave: { othersInside: number } | null = null;

    if (participant.isKeyholder && authType === "kiosk") {
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
        // An older kiosk echoes this token on the same badge's second scan; the
        // route reads any echo as a confirmed close, so nothing stores it.
        const offer = (closePrompt: string) => isReplay ? null
            : { closePrompt, forceCloseToken: randomUUID(), confirmSeconds: FORCE_CLOSE_CONFIRM_SECONDS };

        if (remainingKeyholders === 0 && legacy && others.length === 0 && legacy.shownEmpty !== false) {
            facilityClosed = true;
        } else if (remainingKeyholders === 0) {
            leave = { othersInside: others.length };
            if (legacy) {
                const inside = others.length > 0
                    ? `, and others are still recorded inside: ${presentLabels(others).join(", ")}.`
                    : ".";
                closeOffer = offer(`No other keyholder is checked in${inside} Badge again within ${FORCE_CLOSE_CONFIRM_SECONDS} seconds to close the building and check everyone out.`);
                if (isReplay && legacy.clientEventId) {
                    // Nobody confirmed a close: the leave applies, and a human
                    // checks who the server still records inside.
                    await db.rawBadgeLog.updateMany({
                        where: { clientEventId: legacy.clientEventId },
                        data: { reviewReason: "force_close_review" },
                    });
                }
            }
        } else if (legacy) {
            closeOffer = offer(`Others are still recorded inside. Badge again within ${FORCE_CLOSE_CONFIRM_SECONDS} seconds to close the building and check everyone out.`);
        }
    }

    // SUPERVISION INTERRUPT (#1436). Fires on every live badge departure.
    // Skipped when the facility is closing: that sweep departs everyone.
    // Skipped for a REPLAY: its 400 records nothing but the drain acks that
    // shape, so the queued departure would be dropped and the visit left open.
    // Skipped for a web checkout as well: the badge scanner is the only place
    // anyone can re-badge (docs/rules/attendance-checkin.md, Supervision).
    let supervisionWarning: string | undefined;
    if (!facilityClosed && !isReplay && authType === "kiosk") {
        const interrupt = await supervisionInterrupt(activeVisitId, db);
        if (interrupt?.confirmRequired) return interrupt.response;
        supervisionWarning = interrupt?.warning;
    }

    const finalVisits = await processVisitCheckout(activeVisitId, visitTime, db, "SCANNER");
    const updatedVisit = finalVisits.length > 0 ? finalVisits[finalVisits.length - 1] : null;
    if (facilityClosed && authType === "kiosk") {
        await recordClose(db, { closedById: participant.id, via: closeVia(authType, isReplay) }, visitTime);
    }
    if (leave) await auditKioskLeave(db, participant.id, updatedVisit?.id ?? activeVisitId, isReplay, leave.othersInside);

    return apiJson({
        message: facilityClosed ? "Checked out and Facility closed" : "Checked out successfully",
        type: "checkout" as const,
        warning: supervisionWarning,
        participant: scanParticipant(participant),
        visit: updatedVisit,
        facilityClosed,
        ...closeOffer,
        signedRequest: authType === "kiosk",
    });
}

/** The last recorded keyholder's kiosk leave, audited like a web leave; the kiosk
 *  has no pick-list, so the handover is not named. */
async function auditKioskLeave(db: DbClient, personId: number, visitId: number, isReplay: boolean, othersInside: number) {
    await db.auditLog.create({
        data: {
            ...personActor(personId),
            action: "EDIT",
            tableName: "Visit",
            affectedEntityId: visitId,
            secondaryAffectedEntity: personId,
            newData: { type: "last_keyholder_choice", choice: "leave", via: closeVia("kiosk", isReplay), handoverToId: null, othersInside },
        },
    });
}

/** What the kiosk decided when it sent a close: the keyholder alone on its
 *  screen, or the second scan of the same badge. */
export type CloseKind = "alone" | "confirmed";

/**
 * A keyholder's close request from the kiosk: check the keyholder out and record
 * the close, both in the caller's transaction. The keyholder at the reader saw
 * the room, so the server's records never overrule it, with one exception: the
 * check-ins the kiosk's roster could not have shown (after `rosterAsOf`).
 *
 * - A live one-badge close with such a check-in does not close yet: the keyholder
 *   leaves, and is told who checked in; the same badge again closes.
 * - Any other close applies, and if it sweeps such a check-in it is raised for
 *   review, naming them.
 *
 * The keyholder's visit may already be departed or removed; the close needs
 * none. The sweep runs after commit, from the recorded row ({@link executePendingCloses}).
 */
export async function processCloseRequest(
    participant: Person,
    db: DbClient,
    closeTime: Date,
    clientEventId: string | null,
    isReplay: boolean,
    kind: CloseKind = "confirmed",
    /** Server time of the kiosk's last roster; null when it had none to send. */
    rosterAsOf: Date | null = null,
) {
    const closedAt = clampToNow(closeTime);
    const unseen = rosterAsOf
        ? await db.visit.findMany({
            where: {
                departedAt: null,
                deletedAt: null,
                personId: { not: participant.id },
                arrivedAt: { gt: rosterAsOf, lte: new Date(closedAt.getTime() + LATE_CLOSE_SKEW_MS) },
            },
            include: { person: true },
            orderBy: { arrivedAt: "asc" },
        })
        : [];
    const hold = unseen.length > 0 && kind === "alone" && !isReplay;
    const ownVisit = await db.visit.findFirst({
        where: {
            personId: participant.id,
            departedAt: null,
            deletedAt: null,
            arrivedAt: { lte: new Date(closedAt.getTime() + LATE_CLOSE_SKEW_MS) },
        },
        orderBy: { arrivedAt: "desc" },
        select: { id: true, arrivedAt: true },
    });
    const departed = ownVisit
        ? await processVisitCheckout(ownVisit.id, new Date(Math.max(closedAt.getTime(), ownVisit.arrivedAt.getTime())), db, "SCANNER")
        : [];
    const visit = departed.length > 0 ? departed[departed.length - 1] : null;

    if (hold) {
        if (clientEventId) {
            // A held close is not the close, so it frees its event id: a resend
            // (the kiosk lost this reply) applies as a late close, flagged.
            const held = { clientEventId: `${clientEventId}:held` };
            await db.rawBadgeLog.updateMany({ where: { clientEventId }, data: held });
            await db.presenceEvent.updateMany({ where: { clientEventId }, data: held });
        }
        const othersInside = await db.visit.count({ where: { departedAt: null, deletedAt: null, personId: { not: participant.id } } });
        if (visit) await auditKioskLeave(db, participant.id, visit.id, isReplay, othersInside);
        const timeZone = await resolveDisplayTimezone();
        const labels = getKioskDisplayNames(unseen.map(v => ({ ...v.person, id: v.id })));
        const who = unseen.map(v => `${labels.get(v.id) || "Someone"} checked in at ${formatTime(v.arrivedAt, { timeZone })}`).join("; ");
        return apiJson({
            message: "Checked out successfully",
            type: "checkout" as const,
            participant: scanParticipant(participant),
            visit,
            facilityClosed: false,
            closePrompt: `${who}. Badge again to close the building.`,
            signedRequest: true,
        });
    }

    const closeId = await recordClose(db, { closedById: participant.id, via: closeVia("kiosk", isReplay) }, closedAt, clientEventId);
    if (unseen.length > 0) {
        // The kiosk's roster predates these check-ins: the close may have swept
        // out someone still inside. Raised for review, never held.
        if (clientEventId) {
            await db.rawBadgeLog.updateMany({ where: { clientEventId, reviewReason: null }, data: { reviewReason: "close_stale_roster" } });
        }
        await db.auditLog.create({
            data: {
                ...personActor(participant.id),
                action: "EDIT",
                tableName: "FacilityClose",
                affectedEntityId: closeId,
                secondaryAffectedEntity: participant.id,
                newData: {
                    type: "close_stale_roster",
                    rosterAsOf: rosterAsOf!.toISOString(),
                    unseen: unseen.map(v => ({ visitId: v.id, personId: v.personId, arrivedAt: v.arrivedAt.toISOString() })),
                },
            },
        });
    }

    return apiJson({
        message: "Checked out and Facility closed",
        type: "checkout" as const,
        participant: scanParticipant(participant),
        visit,
        facilityClosed: true,
        signedRequest: true,
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

export { LATE_CLOSE_SKEW_MS };

/** Who closed the facility, and through which path. `ownCheckout` is false
 *  when the closer ended someone else's visit, so no visit of theirs is the close. */
export type FacilityCloser = { closedById: number; via: FacilityCloseVia; ownCheckout?: boolean };

/** The path a scan-route close came through. */
export function closeVia(authType: string, isReplay: boolean): FacilityCloseVia {
    if (authType !== "kiosk") return "WEB_CHECKOUT";
    // A replay reached the server from the kiosk's offline queue.
    return isReplay ? "KIOSK_OFFLINE" : "KIOSK";
}

/** A close time from a kiosk clock running ahead is taken as now. */
const clampToNow = (t: Date) => new Date(Math.min(t.getTime(), Date.now()));

/**
 * Record a close in the caller's transaction, unexecuted. It commits with
 * whatever the caller commits (the keyholder's checkout); the sweep then runs
 * from this row, so a crash after commit loses nothing.
 */
export async function recordClose(db: DbClient, closer: FacilityCloser, closeTime: Date, clientEventId: string | null = null): Promise<number> {
    const closedAt = clampToNow(closeTime);
    // The closer's own visit the close ends: their latest departure at or before
    // it, with no time bound (a late kiosk confirm can come long after the leave),
    // or one the overnight sweep departed after it.
    const closerVisit = closer.ownCheckout === false ? null : await db.visit.findFirst({
        where: {
            personId: closer.closedById,
            deletedAt: null,
            arrivedAt: { lte: closedAt },
            OR: [
                { departedVia: { in: ["SCANNER", "TYPED"] }, departedAt: { lte: closedAt } },
                { departedVia: "AUTO_CLOSE", departedAt: { gt: closedAt } },
            ],
        },
        // By departure, not arrival: a backdated visit can arrive before one that left earlier.
        orderBy: { departedAt: "desc" },
        select: { id: true },
    });
    const close = await db.facilityClose.create({
        data: {
            closedAt, closedById: closer.closedById, via: closer.via, clientEventId, executedAt: null,
            closerVisitId: closerVisit?.id ?? null,
        },
        select: { id: true },
    });
    return close.id;
}

export type DepartureChange = {
    id: number;
    /** The open visit this row replaced, when the checkout split it into segments. */
    previousVisitId?: number;
    personId: number;
    oldDepartedAt: Date | null;
    oldDepartedVia: string | null;
    departedAt: Date;
    departedVia: string;
};

/** Log each departure a facility close set, or a correction of it moved, with
 *  its before and after, against the close record. */
export async function logCloseDepartures(
    db: DbClient,
    facilityCloseId: number,
    actor: AuditActor,
    changes: DepartureChange[],
    via: FacilityCloseVia,
    note: Record<string, unknown> = {},
): Promise<void> {
    if (changes.length === 0) return;
    await db.auditLog.createMany({
        data: changes.map(c => ({
            ...actor,
            action: "EDIT" as const,
            tableName: "FacilityClose",
            affectedEntityId: facilityCloseId,
            secondaryAffectedEntity: c.id,
            oldData: { visitId: c.previousVisitId ?? c.id, personId: c.personId, departedAt: c.oldDepartedAt, departedVia: c.oldDepartedVia },
            newData: { visitId: c.id, personId: c.personId, departedAt: c.departedAt, departedVia: c.departedVia, via, ...note },
        })),
    });
}

/** The close's moment as `t.close_at`, and when the server recorded it as
 *  `t.recorded_at`. The columns are timestamp-without-zone holding UTC, so the
 *  instant is converted AT TIME ZONE 'UTC' or the comparison is off by the
 *  server's offset. */
const closeMoment = (id: number, closedAt: Date) => Prisma.sql`t AS (
    SELECT (${closedAt.toISOString()}::timestamptz AT TIME ZONE 'UTC') AS close_at, fc."createdAt" AS recorded_at
    FROM "FacilityClose" fc WHERE fc.id = ${id}
)`;

/** How long before its arrival stamp a live badge's own log row is written: at
 *  most the scan transaction's timeout. A replayed arrival's log row carries
 *  exactly the arrival's time instead. */
export const LIVE_ARRIVAL_WINDOW_MS = 15_000;

/** A live badge at the kiosk began visit `v`, as recorded in arrivalSource.
 *  A row older than that column falls back to its badge log row: written in the
 *  scan, just before the server stamped the arrival.
 *  ponytail: the fallback can go once no open visit predates arrivalSource. */
const liveBadgeArrival = Prisma.sql`(CASE WHEN v."arrivalSource" IS NOT NULL
    THEN v."arrivalSource" = 'LIVE_SCAN'::"VisitArrivalSource"
    ELSE EXISTS (
    SELECT 1 FROM "RawBadgeLog" r
    WHERE r."personId" = v."personId" AND r."timestamp" < v."arrivedAt"
      AND r."timestamp" >= v."arrivedAt" - ${LIVE_ARRIVAL_WINDOW_MS}::double precision * interval '1 millisecond') END)`;

/** The visits `v` a close at `t` departs: open, or machine-departed after it,
 *  and begun by then. Tombstoned visits are excluded: closing one would rewrite
 *  a record the member chose to erase.
 *
 *  An arrival up to {@link LATE_CLOSE_SKEW_MS} after the close is a kiosk clock
 *  disagreeing with the close's, so it departs too, unless the server stamped it
 *  (a live badge, a web check-in) after it recorded the close: that arrival came
 *  after the close. Further past the close is someone who came in after lock-up. */
const closeSweeps = Prisma.sql`v."deletedAt" IS NULL
    AND (v."arrivedAt" <= t.close_at
         OR (v."arrivedAt" <= t.close_at + ${LATE_CLOSE_SKEW_MS}::double precision * interval '1 millisecond'
             AND NOT (v."arrivedAt" > t.recorded_at
                      AND (v."arrivedVia" IS NOT DISTINCT FROM 'TYPED'::"VisitSource" OR ${liveBadgeArrival}))))
    AND (v."departedAt" IS NULL
         OR (v."departedVia" IN ('AUTO_CLOSE'::"VisitSource", 'FACILITY_CLOSE'::"VisitSource")
             AND v."departedAt" > t.close_at))`;

/** Depart everyone who was in the building at the close's `closedAt` — the
 *  moment the keyholder closed. Live that is server now; a close replayed late
 *  carries the keyholder's own scan time.
 *
 *  Raw rather than `updateMany` because the stamp is per-row: the close moment
 *  is capped at the visit's own `arrivedAt + MAX_VISIT_MS`, and `updateMany`
 *  can only set one constant for every row it touches.
 *
 *  A close never ends a visit that began after it ({@link closeSweeps}); one
 *  inside the clock-skew allowance departs no earlier than it arrived.
 *  A machine departure stamped after the close — the nightly cron's AUTO_CLOSE,
 *  or a later close's FACILITY_CLOSE — is pulled back to it: closes apply in
 *  close-time order, whatever order they reach the server. A departure a person
 *  typed is left alone.
 *
 *  FACILITY_CLOSE, not AUTO_CLOSE: the stamp is the moment the building
 *  actually closed, so it is bounded by building hours — plausible, unlike the
 *  cron's midnight sweep. Where the cap bites the stamp is 24h after arrival
 *  instead; both are placeholders the member is meant to correct, and a
 *  placeholder inside the 24h rule beats an accurate record that breaks it. */
async function sweepForClose(db: DbClient, close: { id: number; closedAt: Date; closedById: number | null; via: FacilityCloseVia }) {
    // `old` locks each row before reading it, so the logged before-value is the
    // one this statement overwrites.
    const changes = await db.$queryRaw<DepartureChange[]>`
        WITH ${closeMoment(close.id, close.closedAt)}, old AS (
            SELECT v.id, v."departedAt", v."departedVia"
            FROM "Visit" v, t
            WHERE ${closeSweeps}
            FOR UPDATE OF v
        )
        UPDATE "Visit" v
        SET "departedAt" = LEAST(
                GREATEST(t.close_at, v."arrivedAt"),
                v."arrivedAt" + ${MAX_VISIT_MS}::double precision * interval '1 millisecond'
            ),
            "departedVia" = 'FACILITY_CLOSE'::"VisitSource",
            "facilityCloseId" = ${close.id}
        FROM t, old
        WHERE v.id = old.id
        RETURNING v.id, v."personId", old."departedAt" AS "oldDepartedAt", old."departedVia"::text AS "oldDepartedVia",
                  v."departedAt", v."departedVia"::text AS "departedVia"`;
    const actor = close.closedById != null ? personActor(close.closedById) : systemActor("system:facility-close");
    await logCloseDepartures(db, close.id, actor, changes, close.via);
}

/**
 * The closer, or the board, corrected the closer's departure, the close's time. Earlier: every
 * departure the close set moves with it, except a visit that began after the
 * new time, or one its owner has since corrected (no longer FACILITY_CLOSE).
 * Later: nobody else moves. Runs inside the correction's transaction.
 */
export async function correctCloseTime(
    db: TxClient,
    close: { id: number; closedAt: Date; closedById: number | null },
    actorId: number,
    newTime: Date,
): Promise<void> {
    if (newTime >= close.closedAt) return;
    await lockFacility(db);
    const at = newTime.toISOString();
    const changes = await db.$queryRaw<DepartureChange[]>`
        WITH t AS (
            SELECT (${at}::timestamptz AT TIME ZONE 'UTC') AS close_at
        ), old AS (
            SELECT v.id, v."departedAt", v."departedVia"
            FROM "Visit" v, t
            WHERE v."facilityCloseId" = ${close.id}
              AND v."deletedAt" IS NULL
              AND v."departedVia" = 'FACILITY_CLOSE'::"VisitSource"
              AND v."arrivedAt" < t.close_at
              AND v."departedAt" > t.close_at
            FOR UPDATE OF v
        )
        UPDATE "Visit" v
        SET "departedAt" = t.close_at
        FROM t, old
        WHERE v.id = old.id
        RETURNING v.id, v."personId", old."departedAt" AS "oldDepartedAt", old."departedVia"::text AS "oldDepartedVia",
                  v."departedAt", v."departedVia"::text AS "departedVia"`;
    await db.facilityClose.update({ where: { id: close.id }, data: { closedAt: newTime } });
    await logCloseDepartures(db, close.id, personActor(actorId), changes, "WEB_CORRECTION",
        { moved: true, ...(actorId !== close.closedById ? { correctedForCloserId: close.closedById } : {}) });
}

/** Fire-and-forget post-event email run on facility close. The dynamic import
 *  AND the call are both in the promise chain, so an import or run failure is
 *  logged, never an unhandled rejection. */
function kickPostEventEmails() {
    import("@/lib/postEventEmails")
        .then(({ processPostEventEmails }) => processPostEventEmails({ forceImmediate: true }))
        .catch(err => console.error("Failed to run post-event emails on facility close:", err));
}

/** Run one recorded close's sweep, unless it already ran. The facility lock
 *  serializes executors, so a close runs exactly once however many re-drive it.
 *  Locks follow the order every visit path uses: the person lock of everyone the
 *  sweep may depart (ascending, so executors never cross), then the facility. */
async function executeClose(id: number): Promise<boolean> {
    return prisma.$transaction(async (tx) => {
        const pending = await tx.facilityClose.findFirst({ where: { id, executedAt: null }, select: { closedAt: true } });
        if (!pending) return false;
        // A superset of sweepForClose's rows: a check-in that lands after this read
        // arrives after the close and is not swept.
        const people = await tx.$queryRaw<{ personId: number }[]>`
            WITH ${closeMoment(id, pending.closedAt)}
            SELECT DISTINCT v."personId" FROM "Visit" v, t
            WHERE ${closeSweeps}
            ORDER BY v."personId"`;
        for (const { personId } of people) await tx.$executeRaw`SELECT pg_advisory_xact_lock(${personId})`;
        await lockFacility(tx);
        const close = await tx.facilityClose.findFirst({
            where: { id, executedAt: null },
            select: { id: true, closedAt: true, closedById: true, via: true },
        });
        if (!close) return false;
        await sweepForClose(tx, close);
        await tx.facilityClose.update({ where: { id }, data: { executedAt: new Date() } });
        return true;
    }, { maxWait: 5_000, timeout: 15_000 });
}

/** How long a close whose sweep failed waits before this instance retries it,
 *  so a close that keeps failing costs a scan one attempt a minute, not one each. */
const CLOSE_RETRY_BACKOFF_MS = 60_000;
const closeRetryAt = new Map<number, number>();

/**
 * Carry out every recorded close that has not run, oldest close time first.
 * Called after every scan, after a web close and by the nightly cron, so a close
 * whose sweep was cut off (crash, lock timeout) runs at the next of those. Never
 * throws: the close is already durable, and a later re-drive retries it. A
 * failing close does not hold up the ones after it: closes apply in close-time
 * order whatever order they run in ({@link sweepForClose}).
 */
export async function executePendingCloses(): Promise<void> {
    let ran = false;
    try {
        const pending = await prisma.facilityClose.findMany({
            where: { executedAt: null },
            orderBy: [{ closedAt: "asc" }, { id: "asc" }],
            select: { id: true },
        });
        for (const { id } of pending) {
            if ((closeRetryAt.get(id) ?? 0) > Date.now()) continue;
            try {
                ran = (await executeClose(id)) || ran;
                closeRetryAt.delete(id);
            } catch (err) {
                closeRetryAt.set(id, Date.now() + CLOSE_RETRY_BACKOFF_MS);
                await logBackendError(err, "facility-close");
            }
        }
    } catch (err) {
        await logBackendError(err, "facility-close");
    }
    if (!ran) return;
    // After the sweep commits, so a concurrent kiosk GET cannot refill the
    // cache from still-open rows (READ COMMITTED).
    invalidateAttendanceCache();
    kickPostEventEmails();
}

/** Timing-safe force-close token compare: hash both sides to a fixed length so
 *  timingSafeEqual can't throw on a length mismatch and no length leaks. */
export function forceCloseTokenMatches(stored: string | null | undefined, given: string | null | undefined): boolean {
    return stored != null && given != null && timingSafeEqual(
        createHash("sha256").update(stored).digest(),
        createHash("sha256").update(given).digest()
    );
}

/** A web caller's answer to the last-keyholder choice; cancel sends nothing. */
export type CloseChoice = "close" | "leave";

/** The signed-in person checking a keyholder out, correcting or removing their visit. */
export type CloseActor = { id: number; isKeyholder: boolean; isBoardMember: boolean; isSysadmin: boolean };

/** What the caller echoes back from the choice: the token, the choice, and for a leave the keyholder named. */
export type CloseConfirm = { token?: unknown; choice?: unknown; handoverToId?: unknown };

/** The 400 body a web path returns when the last keyholder leaves others inside. */
export type CloseChoiceWarning = {
    error: string;
    type: "close_choice";
    othersInside: number;
    choices: (CloseChoice | "cancel")[];
    forceCloseToken: string;
    confirmSeconds: number;
    /** Kiosk labels of everyone else inside; only to callers who read the roster. */
    names?: string[];
    /** Keyholders with no open visit, for a leave to name; only to callers who may close. */
    keyholders?: { id: number; name: string }[];
};

/** A choice a caller made, for the audit row and the handover email. */
export type CloseChoiceMade = { choice: CloseChoice; handoverToId: number | null; othersInside: number };

export type CloseGuardResult =
    | { action: "proceed"; facilityClosed: boolean; choice: CloseChoiceMade | null }
    | { action: "warn"; warning: CloseChoiceWarning }
    | { action: "refuse"; error: string; status: 400 | 409 };

export function closeActor(user: AuthenticatedUser): CloseActor {
    return { id: Number(user.id), isKeyholder: !!user.isKeyholder, isBoardMember: !!user.isBoardMember, isSysadmin: !!user.isSysadmin };
}

/** Only a keyholder closes the building (Arts. VI–VII): checking themselves
 *  out, or, on the board, checking out the last keyholder. */
const mayClose = (actor: CloseActor, subjectId: number) => actor.isKeyholder && (actor.id === subjectId || actor.isBoardMember);

/** Keyholders, the board and sysadmins already read the full roster. */
const readsRoster = (actor: CloseActor) => actor.isKeyholder || actor.isBoardMember || actor.isSysadmin;

/** Live keyholders other than the leaver with no open visit: who a leave can name. */
async function handoverCandidates(db: DbClient, subjectId: number) {
    const people = await db.person.findMany({
        where: { ...LIVE_KEYHOLDER, id: { not: subjectId }, visits: { none: { departedAt: null, deletedAt: null } } },
        select: { id: true, name: true, nickname: true, email: true },
    });
    const labels = getKioskDisplayNames(people);
    return people.map(p => ({ id: p.id, name: labels.get(p.id) ?? "" }));
}

/**
 * Last-keyholder guard for every web path that ends an open visit: checkout,
 * correction and removal. When the visit is the last keyholder's and others
 * are inside, the caller chooses close, leave or cancel:
 *
 * - a keyholder checking themselves out, or a board member who is a keyholder,
 *   gets all three; a leave names the keyholder handed over to, unless no
 *   keyholder is free to name;
 * - anyone else — another keyholder, a board member who is not a keyholder, a
 *   household lead, a sysadmin — gets leave or cancel and names nobody;
 * - a removal never closes, whoever makes it.
 *
 * The token is bound to the actor shown the choice and expires after
 * {@link WEB_CLOSE_CHOICE_TTL_MS}, and the allowed choices are worked out again
 * on confirm, so a role revoked in between takes effect. The
 * token columns belong to this dialog alone; no kiosk path reads them.
 * A keyholder alone in the record closes with no warning when the caller may
 * close. Callers depart or remove the visit, recording the close in the same
 * transaction ({@link recordWebClose}), then call {@link finishCloseGuard}.
 */
export async function lastKeyholderGuard(
    visitId: number,
    subject: { id: number; isKeyholder: boolean },
    actor: CloseActor,
    confirm: CloseConfirm,
    opts: { removal?: boolean } = {},
    db: DbClient = prisma,
): Promise<CloseGuardResult> {
    const proceed = { action: "proceed" as const, facilityClosed: false, choice: null };
    if (!subject.isKeyholder) return proceed;

    const remainingKeyholders = await db.visit.count({
        where: { ...KEYHOLDER_IN_BUILDING, id: { not: visitId } }
    });
    if (remainingKeyholders > 0) return proceed;

    const canClose = !opts.removal && mayClose(actor, subject.id);
    const othersInside = await db.visit.count({ where: { departedAt: null, deletedAt: null, id: { not: visitId } } });
    const clearToken = () => db.visit.update({
        where: { id: visitId },
        data: { forceCloseWarnedAt: null, forceCloseToken: null, forceCloseActorId: null },
    });

    if (othersInside === 0) {
        await clearToken();
        return { ...proceed, facilityClosed: canClose };
    }

    const choices: CloseChoice[] = canClose ? ["close", "leave"] : ["leave"];
    const visit = await db.visit.findUnique({
        where: { id: visitId },
        select: { forceCloseToken: true, forceCloseActorId: true, forceCloseWarnedAt: true },
    });
    const token = typeof confirm.token === "string" ? confirm.token : null;
    const confirmed = visit?.forceCloseActorId === actor.id && forceCloseTokenMatches(visit.forceCloseToken, token)
        && visit.forceCloseWarnedAt != null && Date.now() - visit.forceCloseWarnedAt.getTime() <= WEB_CLOSE_CHOICE_TTL_MS;

    // A token that does not answer this caller's open choice — spent, replaced,
    // stale, or shown to someone else — is refused, never re-bound to this caller.
    if (token != null && !confirmed) {
        return { action: "refuse", error: "That choice has expired or was already answered.", status: 409 };
    }

    if (!confirmed) {
        const fresh = randomUUID();
        await db.visit.update({
            where: { id: visitId },
            data: { forceCloseWarnedAt: new Date(), forceCloseToken: fresh, forceCloseActorId: actor.id },
        });
        const others = othersInside === 1 ? "1 other person is" : `${othersInside} other people are`;
        const consequence = opts.removal
            ? "Removing this visit leaves them inside a closed facility."
            : canClose
                ? "Close the facility and check everyone out, or leave having handed over to another keyholder."
                : "Checking out leaves them inside a closed facility.";
        return {
            action: "warn",
            warning: {
                error: `No other keyholder is checked in. ${others} still recorded inside. ${consequence}`,
                type: "close_choice",
                othersInside,
                choices: [...choices, "cancel"],
                forceCloseToken: fresh,
                confirmSeconds: FORCE_CLOSE_CONFIRM_SECONDS,
                ...(readsRoster(actor) ? {
                    names: presentLabels(await db.visit.findMany({
                        where: { departedAt: null, deletedAt: null, id: { not: visitId } },
                        include: { person: true },
                    })),
                } : {}),
                ...(canClose ? { keyholders: await handoverCandidates(db, subject.id) } : {}),
            },
        };
    }

    const choice = choices.find(c => c === confirm.choice);
    if (!choice) return { action: "refuse", error: "That choice is not available.", status: 400 };

    let handoverToId: number | null = null;
    if (choice === "leave" && canClose) {
        const candidates = await handoverCandidates(db, subject.id);
        if (confirm.handoverToId == null) {
            // Nobody free to name: the leave stands, recorded as not named.
            if (candidates.length > 0) return { action: "refuse", error: "Name the keyholder you handed over to.", status: 400 };
        } else {
            const named = typeof confirm.handoverToId === "number" && Number.isInteger(confirm.handoverToId)
                ? await db.person.findFirst({
                    where: { ...LIVE_KEYHOLDER, id: confirm.handoverToId, NOT: { id: subject.id } },
                    select: { id: true },
                })
                : null;
            if (!named) return { action: "refuse", error: "The keyholder named is not a current keyholder.", status: 400 };
            handoverToId = named.id;
        }
    }

    // Single use: only one confirm of this token consumes it, however many race.
    const consumed = await db.visit.updateMany({
        where: { id: visitId, deletedAt: null, forceCloseToken: visit.forceCloseToken, forceCloseActorId: actor.id },
        data: { forceCloseWarnedAt: null, forceCloseToken: null, forceCloseActorId: null },
    });
    if (consumed.count === 0) {
        return { action: "refuse", error: "That choice has expired or was already answered.", status: 409 };
    }
    return { action: "proceed", facilityClosed: choice === "close", choice: { choice, handoverToId, othersInside } };
}

/**
 * Record the close a web caller chose, on `db` — the transaction that checks the
 * visit out, so the checkout and the close commit together. It runs after the
 * checkout, so it can link the closer's departed visit. False when the caller
 * did not choose a close.
 */
export async function recordWebClose(
    db: DbClient,
    guard: Extract<CloseGuardResult, { action: "proceed" }>,
    ctx: { actorId: number; subjectId: number; via: FacilityCloseVia; closeTime?: Date },
): Promise<boolean> {
    if (!guard.facilityClosed) return false;
    await recordClose(db, { closedById: ctx.actorId, via: ctx.via, ownCheckout: ctx.actorId === ctx.subjectId }, ctx.closeTime ?? new Date());
    return true;
}

/**
 * After the guarded visit is departed or removed: carry out the close the caller
 * chose (recording it first unless the caller already did, `recorded`), audit
 * the choice, and email a named keyholder who is not checked in. Never throws;
 * the checkout has already committed.
 */
export async function finishCloseGuard(
    guard: Extract<CloseGuardResult, { action: "proceed" }>,
    ctx: { actorId: number; subjectId: number; visitId: number; via: FacilityCloseVia; closeTime?: Date; recorded?: boolean },
): Promise<void> {
    if (guard.facilityClosed) {
        if (!ctx.recorded) {
            try {
                await recordWebClose(prisma, guard, ctx);
            } catch (err) {
                await logBackendError(err, "facility-close");
            }
        }
        await executePendingCloses();
    }
    if (!guard.choice) return;
    const { choice, handoverToId, othersInside } = guard.choice;
    try {
        await prisma.auditLog.create({
            data: {
                ...personActor(ctx.actorId),
                action: "EDIT",
                tableName: "Visit",
                affectedEntityId: ctx.visitId,
                secondaryAffectedEntity: ctx.subjectId,
                newData: { type: "last_keyholder_choice", choice, via: ctx.via, handoverToId, othersInside },
            },
        });
        if (handoverToId != null) await emailHandover(handoverToId, ctx.subjectId, othersInside);
    } catch (err) {
        await logBackendError(err, "last-keyholder-choice");
    }
}

/** Tell the keyholder a leaver named that the building was left to them, unless they are checked in. */
async function emailHandover(handoverToId: number, leaverId: number, othersInside: number) {
    const [named, leaver, open] = await Promise.all([
        prisma.person.findUnique({ where: { id: handoverToId }, select: { email: true, name: true } }),
        prisma.person.findUnique({ where: { id: leaverId }, select: { name: true, nickname: true } }),
        prisma.visit.count({ where: { personId: handoverToId, departedAt: null, deletedAt: null } }),
    ]);
    if (!named?.email || open > 0) return;
    const leaverName = escapeHtml(leaver?.nickname || leaver?.name || "A keyholder");
    const when = formatDateTime(new Date(), { timeZone: await resolveDisplayTimezone() });
    const inside = othersInside === 1 ? "1 person is" : `${othersInside} people are`;
    await sendEmail(
        named.email,
        "You were named as the keyholder in charge",
        `<p>${leaverName} checked out at ${when} and named you as the keyholder they handed the building over to.</p>` +
        `<p>${inside} still recorded inside, and no keyholder is checked in. If you are there, check in; if not, let them know.</p>`,
    );
}

/**
 * Send the check-in/out email for a committed scan. Runs only after the scan
 * transaction commits, so a rollback can't leave a false email and a retried
 * (duplicate_ignored) scan can't send a second one. `at` is the scan's event
 * time, so a replayed or held scan reports when it happened.
 */
export async function notifyScanOutcome(res: Response, at: Date): Promise<void> {
    let body: { type?: string; participant?: { id?: number }; visit?: unknown } | null;
    try {
        body = await res.clone().json();
    } catch {
        return;
    }
    const personId = body?.participant?.id;
    if (typeof personId !== "number") return;
    // A close request for a keyholder already checked out departs nobody: the keyholder
    // already left, and got their checkout email then.
    if (body?.visit === null) return;
    if (body?.type === "checkin") {
        sendCheckinNotifications(personId, "checkin", "SCANNER", at).catch(err =>
            console.error("Checkin notification error:", err)
        );
    } else if (body?.type === "checkout") {
        sendCheckinNotifications(personId, "checkout", undefined, at).catch(err =>
            console.error("Checkout notification error:", err)
        );
    }
}
