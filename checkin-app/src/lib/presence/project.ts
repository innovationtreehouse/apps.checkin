import type { Person, PresenceDirection } from "@/generated/prisma/client";
import { apiJson } from "@/lib/api-response";
import type { DbClient } from "@/lib/db-client";
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

        const res = await processCheckin(args.participant, args.authType, db, args.occurredAt);
        await classifyCheckin(db, event.id, res);
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

/** Classify an IN event from processCheckin's actual outcome. An error
 *  response (e.g. a session check-in into a closed facility) stays unclassified. */
async function classifyCheckin(db: DbClient, eventId: number, res: Response): Promise<void> {
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
    } else if (body.type === "parked" && body.reason) {
        await classifyPresenceEvent(db, eventId, parkReasonToClass(body.reason));
    }
}
