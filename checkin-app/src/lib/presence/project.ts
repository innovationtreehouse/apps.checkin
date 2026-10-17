import type { Person, PresenceDirection } from "@/generated/prisma/client";
import type { DbClient } from "@/lib/db-client";
import { LIVE_VISIT } from "@/lib/visit/filters";
import { type LegacyKiosk, type ScanOutcome, processCheckin, processCheckout } from "@/lib/attendance/scan";
import {
    PresenceClass,
    appendPresenceEvent,
    classifyPresenceEvent,
    parkReasonToClass,
} from "@/lib/presence/events";

/**
 * Apply a displayed IN/OUT intent (invariant 5). Direction is an input; this
 * never re-toggles from live Visit state. Conflicts park and do not mutate.
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
        isReplay?: boolean;
        clockSuspect?: boolean;
        webClose?: boolean;
        legacyKiosk?: LegacyKiosk | null;
        /** A trusted replay's event id, for the close fence (processCheckin). */
        fenceClientEventId?: string | null;
    },
): Promise<ScanOutcome> {
    const event = await appendPresenceEvent(db, {
        personId: args.participant.id,
        occurredAt: args.occurredAt,
        direction: args.direction,
        source: args.source,
        clientEventId: args.clientEventId,
        classification: null,
        clockSuspect: args.clockSuspect,
    });

    const openVisit = await db.visit.findFirst({
        where: { personId: args.participant.id, departedAt: null, ...LIVE_VISIT },
        orderBy: { arrivedAt: "desc" },
        select: { id: true },
    });

    if (args.direction === "IN") {
        if (openVisit) {
            await classifyPresenceEvent(db, event.id, PresenceClass.CONFLICT_DOUBLE_IN);
            await flagForReview(db, args.participant.id, args.clientEventId, "conflict_double_in");
            return { kind: "parked", reason: "conflict_double_in" };
        }

        const outcome = await processCheckin(args.participant, args.authType, db, args.isReplay ? args.occurredAt : undefined, args.fenceClientEventId);
        await classifyCheckin(db, event.id, outcome, args.participant.id, args.clientEventId);
        return outcome;
    }

    if (!openVisit) {
        await classifyPresenceEvent(db, event.id, PresenceClass.CONFLICT_OUT_NO_IN);
        await flagForReview(db, args.participant.id, args.clientEventId, "conflict_out_no_in");
        return { kind: "parked", reason: "conflict_out_no_in" };
    }

    const outcome = await processCheckout(
        args.participant,
        openVisit.id,
        args.authType,
        db,
        args.occurredAt,
        args.isReplay ?? false,
        args.webClose ?? false,
        args.legacyKiosk ?? null,
    );
    // Mirror the IN branch: PROJECTED only when someone actually left. A
    // supervision warning leaves the visit open — the confirming re-badge
    // writes its own event and projects then.
    if (outcome.kind === "checkout") {
        await classifyPresenceEvent(db, event.id, PresenceClass.PROJECTED, openVisit.id);
    }
    return outcome;
}

/** Puts a conflict park on the unsynced-scans review queue by setting
 *  reviewReason on the RawBadgeLog row /api/scan wrote for this touch. */
export async function flagForReview(
    db: DbClient,
    personId: number,
    clientEventId: string | null | undefined,
    reason: string,
): Promise<void> {
    const row = await db.rawBadgeLog.findFirst({
        where: clientEventId ? { clientEventId, reviewReason: null } : { personId, reviewReason: null },
        orderBy: { timestamp: "desc" },
        select: { id: true },
    });
    if (row) {
        await db.rawBadgeLog.update({ where: { id: row.id }, data: { reviewReason: reason } });
    }
}

/** Classify an IN event from processCheckin's actual outcome, queueing a
 *  double_in park for review. A refusal (a session check-in into a closed
 *  facility) stays unclassified. */
async function classifyCheckin(
    db: DbClient,
    eventId: number,
    outcome: ScanOutcome,
    personId: number,
    clientEventId: string | null | undefined,
): Promise<void> {
    if (outcome.kind === "checkin") {
        await classifyPresenceEvent(db, eventId, PresenceClass.PROJECTED, outcome.visit.id);
    } else if (outcome.kind === "parked") {
        await classifyPresenceEvent(db, eventId, parkReasonToClass(outcome.reason));
        if (outcome.reason === "double_in") {
            await flagForReview(db, personId, clientEventId, "conflict_double_in");
        }
    }
}
