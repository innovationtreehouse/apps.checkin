import type { Person, PresenceDirection } from "@/generated/prisma/client";
import { apiJson } from "@/lib/api-response";
import type { DbClient, TxClient } from "@/lib/db-client";
import { withFacilityLock } from "@/lib/facilityLock";
import { LIVE_PERSON } from "@/lib/person/filters";
import { LIVE_VISIT } from "@/lib/visit/filters";
import { closeOnOfferConfirm, processCheckin, processCheckout } from "@/lib/scan-service";
import {
    PresenceClass,
    appendPresenceEvent,
    classifyPresenceEvent,
    parkReasonToClass,
} from "@/lib/presence/events";

/**
 * Apply a displayed IN/OUT intent (invariant 5). Direction is an input; this
 * never re-toggles from live Visit state. Conflicts park and do not mutate.
 *
 * Projection C: a non-keyholder IN while the facility is closed is held
 * (PARKED_CLOSED, no human queue) until a keyholder Visit exists, then
 * {@link flushParkedClosed} projects in occurredAt order.
 */
export async function applyPresenceIntent(
    db: DbClient,
    args: {
        participant: Person;
        direction: PresenceDirection;
        occurredAt: Date;
        authType: string;
        source: "SCANNER" | "TYPED";
        clientEventId?: string | null;
        confirmToken?: string | null;
        replayEventId?: string | null;
        forceCloseConfirmed?: boolean;
    },
): Promise<Response> {
    const event = await appendPresenceEvent(db, {
        personId: args.participant.id,
        occurredAt: args.occurredAt,
        direction: args.direction,
        source: args.source,
        clientEventId: args.clientEventId,
        classification: null,
    });

    const openVisit = await db.visit.findFirst({
        where: { personId: args.participant.id, departedAt: null, ...LIVE_VISIT },
        orderBy: { arrivedAt: "desc" },
        select: { id: true },
    });

    if (args.direction === "IN") {
        if (openVisit) {
            await classifyPresenceEvent(db, event.id, PresenceClass.CONFLICT_DOUBLE_IN);
            return apiJson({ type: "parked", message: "Recorded for review." });
        }

        if (!args.participant.isKeyholder && args.authType === "kiosk") {
            const activeKeyholders = await db.visit.count({
                where: { departedAt: null, person: { isKeyholder: true, ...LIVE_PERSON }, ...LIVE_VISIT },
            });
            if (activeKeyholders === 0) {
                await classifyPresenceEvent(db, event.id, PresenceClass.PARKED_CLOSED);
                return apiJson({ type: "parked", reason: "facility_closed", message: "Recorded. Will project when a keyholder is present." });
            }
        }

        const res = await processCheckin(args.participant, args.authType, db, args.occurredAt);
        const projected = await classifyCheckin(db, event.id, res);
        if (projected != null && args.participant.isKeyholder) {
            await flushParkedClosed(db);
        }
        return res;
    }

    if (!openVisit) {
        const closed = await closeOnOfferConfirm(
            args.participant,
            args.authType,
            db,
            args.confirmToken ?? null,
            args.replayEventId ?? null,
            args.forceCloseConfirmed ?? false,
            args.occurredAt,
        );
        if (closed) {
            await classifyPresenceEvent(db, event.id, PresenceClass.PROJECTED);
            return closed;
        }
        await classifyPresenceEvent(db, event.id, PresenceClass.CONFLICT_OUT_NO_IN);
        return apiJson({ type: "parked", message: "Recorded for review." });
    }

    const res = await processCheckout(
        args.participant,
        openVisit.id,
        args.authType,
        db,
        args.confirmToken ?? null,
        args.occurredAt,
        args.replayEventId ?? null,
        args.forceCloseConfirmed ?? false,
    );
    // Mirror the IN branch: PROJECTED only when someone actually left. A
    // force-close warning or a review park leaves the visit open — the
    // confirming re-badge writes its own event and projects then.
    if (await checkoutConfirmed(res)) {
        await classifyPresenceEvent(db, event.id, PresenceClass.PROJECTED, openVisit.id);
    }
    return res;
}

async function checkoutConfirmed(res: Response): Promise<boolean> {
    if (!res.ok) return false;
    try {
        const body = (await res.clone().json()) as { type?: string };
        return body.type === "checkout";
    } catch {
        return false;
    }
}

/** After a keyholder Visit exists, project every PARKED_CLOSED event in
 *  happened-at order. No human on the happy path (projection C). */
export async function flushParkedClosed(db: DbClient): Promise<void> {
    // Serialize read-decide-project against every other keyholder check-in on
    // ANY surface (kiosk, web, manual) — two overlapping flushes would both
    // read the same PARKED_CLOSED rows and double-project them. The lock is
    // reentrant, so callers already holding it compose. Batch-bounded: a long
    // closed-night backlog projects across successive keyholder INs instead of
    // risking the locked transaction's timeout.
    await withFacilityLock(db, (tx) => flushParkedClosedLocked(tx));
}

const FLUSH_BATCH = 50;

async function flushParkedClosedLocked(db: TxClient): Promise<void> {
    const held = await db.presenceEvent.findMany({
        where: { classification: PresenceClass.PARKED_CLOSED },
        orderBy: { occurredAt: "asc" },
        include: { person: true },
        take: FLUSH_BATCH,
    });
    for (const ev of held) {
        // A merge racing the flush leaves a tombstone here (the repoint runs at
        // merge time; this is the in-flight window). One hop reaches the keeper —
        // the archive design guarantees chains never exceed it.
        const person = ev.person.mergedIntoId
            ? ((await db.person.findUnique({ where: { id: ev.person.mergedIntoId } })) ?? ev.person)
            : ev.person;
        const openVisit = await db.visit.findFirst({
            where: { personId: person.id, departedAt: null, ...LIVE_VISIT },
            select: { id: true },
        });
        if (ev.direction === "IN") {
            if (openVisit) {
                await classifyPresenceEvent(db, ev.id, PresenceClass.CONFLICT_DOUBLE_IN);
                continue;
            }
            const res = await processCheckin(person, "kiosk", db, ev.occurredAt);
            await classifyCheckin(db, ev.id, res);
        } else if (openVisit) {
            await processCheckout(person, openVisit.id, "kiosk", db, null, ev.occurredAt, ev.clientEventId);
            await classifyPresenceEvent(db, ev.id, PresenceClass.PROJECTED, openVisit.id);
        } else {
            await classifyPresenceEvent(db, ev.id, PresenceClass.CONFLICT_OUT_NO_IN);
        }
    }
}

/** Classify an IN event from processCheckin's actual outcome and return the
 *  projected visit id. An error response (e.g. a session check-in into a
 *  closed facility) stays unclassified — never PARKED_CLOSED, which flushes. */
async function classifyCheckin(db: DbClient, eventId: number, res: Response): Promise<number | null> {
    let body: { type?: string; reason?: string; visit?: { id?: number } } = {};
    if (res.ok) {
        try {
            body = await res.clone().json();
        } catch {
            body = {};
        }
    }
    if (body.type === "checkin" && typeof body.visit?.id === "number") {
        await classifyPresenceEvent(db, eventId, PresenceClass.PROJECTED, body.visit.id);
        return body.visit.id;
    }
    if (body.type === "parked" && body.reason) {
        await classifyPresenceEvent(db, eventId, parkReasonToClass(body.reason));
    }
    return null;
}
