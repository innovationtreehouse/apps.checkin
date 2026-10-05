import type { PresenceDirection, VisitSource } from "@/generated/prisma/client";
import type { DbClient } from "@/lib/db-client";

/** M2 classify output. String, not a Prisma enum — new park reasons must not
 *  require ALTER TYPE ... ADD VALUE. */
export const PresenceClass = {
    PROJECTED: "PROJECTED",
    PARKED_CLOCK: "PARKED_CLOCK",
    PARKED_STALE: "PARKED_STALE",
    PARKED_CLOSED: "PARKED_CLOSED",
    PARKED_DEAD: "PARKED_DEAD",
    PARKED_OUT_OF_ORDER: "PARKED_OUT_OF_ORDER",
    PARKED_REVIEW: "PARKED_REVIEW",
    CONFLICT_DOUBLE_IN: "CONFLICT_DOUBLE_IN",
    CONFLICT_OUT_NO_IN: "CONFLICT_OUT_NO_IN",
} as const;

export type PresenceClassification = (typeof PresenceClass)[keyof typeof PresenceClass];

export function parkReasonToClass(reason: string): PresenceClassification {
    if (reason === "stale_replay") return PresenceClass.PARKED_STALE;
    if (reason === "out_of_order") return PresenceClass.PARKED_OUT_OF_ORDER;
    if (reason === "clock_suspect") return PresenceClass.PARKED_CLOCK;
    if (reason === "facility_closed") return PresenceClass.PARKED_CLOSED;
    if (reason === "double_in") return PresenceClass.CONFLICT_DOUBLE_IN;
    if (reason.startsWith("client_dead:")) return PresenceClass.PARKED_DEAD;
    // force_close_review and any future human-gated reason: parked for a
    // person, never auto-flushed.
    return PresenceClass.PARKED_REVIEW;
}

export async function appendPresenceEvent(
    db: DbClient,
    data: {
        personId: number;
        occurredAt: Date;
        direction: PresenceDirection;
        source: VisitSource;
        clientEventId?: string | null;
        classification?: string | null;
        clockSuspect?: boolean;
        visitId?: number | null;
    },
) {
    return db.presenceEvent.create({
        data: {
            personId: data.personId,
            occurredAt: data.occurredAt,
            direction: data.direction,
            source: data.source,
            ...(data.clientEventId ? { clientEventId: data.clientEventId } : {}),
            classification: data.classification ?? null,
            clockSuspect: data.clockSuspect ?? false,
            visitId: data.visitId ?? null,
        },
    });
}

export async function classifyPresenceEvent(
    db: DbClient,
    id: number,
    classification: string,
    visitId?: number | null,
) {
    return db.presenceEvent.update({
        where: { id },
        data: { classification, ...(visitId !== undefined ? { visitId } : {}) },
    });
}
