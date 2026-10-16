import prisma from "@/lib/prisma";
import { processVisitCheckout } from "@/lib/attendanceTransitions";
import { Prisma, type FacilityCloseVia, type Person } from "@/generated/prisma/client";
import type { DbClient, TxClient } from "@/lib/db-client";
import { lockFacility } from "@/lib/facilityLock";
import { LATE_CLOSE_SKEW_MS, MAX_VISIT_MS } from "@/lib/visitTimes";
import { invalidateAttendanceCache } from "@/lib/getFullAttendance";
import { logBackendError } from "@/lib/logger";
import { type AuditActor, personActor, systemActor } from "@/lib/auditActor";
import type { ScanOutcome } from "@/lib/attendance/scan";

/** The last recorded keyholder's kiosk leave, audited like a web leave; the kiosk
 *  has no pick-list, so the handover is not named. */
export async function auditKioskLeave(db: DbClient, personId: number, visitId: number, isReplay: boolean, othersInside: number) {
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
): Promise<ScanOutcome> {
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
        return { kind: "checkout", person: participant, visit, closed: false, closeOffer: { reason: "unseen_checkins", unseen } };
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

    return { kind: "checkout", person: participant, visit, closed: true };
}

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

/** A live badge at the kiosk began visit `v`, as recorded in arrivedLive.
 *  A SCANNER row older than that column falls back to its badge log row:
 *  written in the scan, just before the server stamped the arrival.
 *  ponytail: the fallback can go once no open visit predates arrivedLive. */
const liveBadgeArrival = Prisma.sql`(v."arrivedVia" IS NOT DISTINCT FROM 'SCANNER'::"VisitSource" AND COALESCE(v."arrivedLive", EXISTS (
    SELECT 1 FROM "RawBadgeLog" r
    WHERE r."personId" = v."personId" AND r."timestamp" < v."arrivedAt"
      AND r."timestamp" >= v."arrivedAt" - ${LIVE_ARRIVAL_WINDOW_MS}::double precision * interval '1 millisecond')))`;

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
