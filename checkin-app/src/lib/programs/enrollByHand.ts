import { ServiceError } from "@checkin/component-kit";
import type { EnrollmentBasis, ProgramParticipant } from "@/generated/prisma/client";
import type { TxClient } from "@/lib/db-client";
import { personActor, recordAudit } from "@/lib/auditActor";
import { ENROLLMENT_WRITES } from "@/lib/programs/enrollmentState";
import { publicStockDelta, unspentSeats } from "@/lib/programs/activateEnrollment";
import { saleStockDelta } from "@/lib/programs/saleState";
import { isOrderReversed } from "@/lib/finance/reconcile/exceptions";
import { isPaid, isReversed } from "@/lib/finance/reconcile/orderStatus";
import * as mirror from "@/lib/shopifyRead/client";

export const ENROLLMENT_BASES = ["OUTSIDE_PAYMENT", "MATCHED_ORDER", "COMP"] as const satisfies readonly EnrollmentBasis[];

export function isEnrollmentBasis(v: unknown): v is EnrollmentBasis {
    return (ENROLLMENT_BASES as readonly unknown[]).includes(v);
}

export type HandProgram = {
    id: number;
    maxParticipants: number | null;
    shopifyVariantId: string | null;
    claimantShopifyVariantId: string | null;
    startAt: Date;
    offSaleAt: Date | null;
    saleEndedAt: Date | null;
};

/** A matched store order, read from the mirror before the transaction. */
export type MatchedOrder = {
    shopifyOrderId: string;
    lines: { variantId: string; quantity: number; currentQuantity: number }[];
    /** The program and people the app's checkout signed onto the order, when it went through that checkout. */
    cartProgramId: number | null;
    cartPersonIds: number[] | null;
};

/**
 * Look up the order a Board or Finance member matched by hand. Refused unless the
 * mirror holds it as a real, paid, unreversed order; the seat count is judged later,
 * under the order's lock.
 */
export async function readMatchedOrder(shopifyOrderId: string): Promise<MatchedOrder> {
    if (!mirror.isConfigured()) throw new ServiceError(503, "The store's order records are not connected, so an order cannot be matched.");
    const [order] = await mirror.ordersByLegacyIds([shopifyOrderId]);
    if (!order) throw new ServiceError(409, "No store order with that id.");
    if (isReversed(order) || !isPaid(order)) throw new ServiceError(409, "That order is not paid, or was refunded or cancelled.");
    const program = mirror.orderAttr(order, "Program_ID");
    const people = mirror.orderAttr(order, "CheckMeIn_Account_ID");
    return {
        shopifyOrderId,
        lines: await mirror.orderLines(order.orderGid),
        cartProgramId: program ? parseInt(program, 10) : null,
        cartPersonIds: people ? people.split(",").map((s) => parseInt(s.trim(), 10)) : null,
    };
}

/**
 * Activate an unpaid place in place, recording what it stands for. Runs inside the
 * caller's changeProgramStockWith transaction and returns the stock delta it causes.
 *
 * Paid outside the store or comped: a held seat stays off sale as a seat taken
 * without a sale; an unheld one on a capped program comes off sale now.
 * A matched order counts as that order's own activation would, and its seat is
 * spent under the order's lock, so the webhook and reconciler cannot spend it again.
 */
export async function enrollByHandIn(
    tx: TxClient,
    program: HandProgram,
    personId: number,
    basis: EnrollmentBasis,
    order: MatchedOrder | null,
    actorId: number,
    note: string,
    today: Date,
): Promise<{ row: ProgramParticipant; delta: number }> {
    const matched = basis === "MATCHED_ORDER";
    if (matched !== !!order) throw new ServiceError(400, "A store order is matched only with its id.");
    if (order) {
        // An order the app's checkout made pays for the program and people it names; the
        // webhook and reconciler activate those, so a hand match must not spend it on someone else.
        if ((order.cartProgramId !== null && order.cartProgramId !== program.id)
            || (order.cartPersonIds !== null && order.cartPersonIds.some((id) => id !== personId))) {
            throw new ServiceError(409, "That order's checkout was for another program, or named someone besides this person; the store's own record activates it.");
        }
        if (await isOrderReversed(tx, order.shopifyOrderId)) throw new ServiceError(409, "That order was refunded or cancelled.");
        const cap = await unspentSeats(tx, program, program.id, order.shopifyOrderId, order.lines);
        if (cap?.spentOn.has(personId)) throw new ServiceError(409, "That order already paid for this person's earlier place.");
        if (!cap?.unspent) throw new ServiceError(409, "That order has no seat in this program left to give.");
    }

    const now = new Date();
    const capped = program.maxParticipants !== null;
    const byHand = (held: boolean) => ({
        pendingSince: null,
        enrollmentBasis: basis,
        shopifyOrderId: order?.shopifyOrderId ?? null,
        ...(!matched && (held || capped) && { seatTakenWithoutSaleAt: now }),
    });
    const at = { programId: program.id, personId };
    const held = (await tx.programParticipant.updateMany({
        where: { ...at, ...ENROLLMENT_WRITES.enrollByHandHeld.where },
        data: { ...ENROLLMENT_WRITES.enrollByHandHeld.data(), ...byHand(true) },
    })).count;
    const unheld = held ? 0 : (await tx.programParticipant.updateMany({
        where: { ...at, ...ENROLLMENT_WRITES.enrollByHandUnheld.where },
        data: { ...ENROLLMENT_WRITES.enrollByHandUnheld.data(), ...byHand(false) },
    })).count;
    if (!held && !unheld) throw new ServiceError(409, "This place is no longer unpaid. Reload and try again.");

    const claimantSeat = order && capped && order.lines.some((l) => l.variantId === program.claimantShopifyVariantId && l.currentQuantity > 0) ? 1 : 0;
    const raw = matched ? publicStockDelta(held, claimantSeat) : held || !capped ? 0 : -1;

    const row = await tx.programParticipant.findUniqueOrThrow({ where: { programId_personId: at } });
    await recordAudit(tx, personActor(actorId), {
        action: "EDIT",
        tableName: "ProgramParticipant",
        affectedEntityId: personId,
        secondaryAffectedEntity: program.id,
        newData: { ...row, ...(note && { note }) },
    });
    return { row, delta: saleStockDelta(program, raw, today) };
}
