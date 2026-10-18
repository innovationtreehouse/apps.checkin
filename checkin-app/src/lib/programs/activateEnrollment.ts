import prisma from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { changeProgramStockWith } from "@/lib/shopify/stock";
import { fromWhere } from "@/lib/programs/enrollmentState";
import { saleStockDelta } from "@/lib/programs/saleState";
import { isOrderReversed, raisePaymentException, recordReversal } from "@/lib/finance/reconcile/exceptions";
import { takeBackRestockedSeats } from "@/lib/finance/reconcile/reversals";

/**
 * Activate paid program enrollments — the single choke point the Shopify
 * orders/paid webhook AND the reconciler both call (mirrors membership's
 * activate()). Extracted from the webhook route so a MISSED webhook can be
 * recovered by the reconciler through the exact same, idempotent path.
 *
 * Per participant: a transactionally-guarded PENDING → ACTIVE flip (so a webhook
 * redelivery or a reconciler re-run can't double-activate or double-count),
 * clearing the pending timer, stamping the paying order id, and squaring the
 * public variant's stock with the seats just filled (see {@link publicStockDelta}).
 *
 * Callers must first establish the order pays for these people
 * (orderEntitlesEnrollment in lib/finance/reconcile/program.ts); this function does not.
 * A reversed order activates nobody (see {@link refuseReversedActivation}).
 */
export interface ActivateEnrollmentInput {
    programId: number;
    /** Person ids to activate (all must belong to this program's pending set). */
    personIds: number[];
    /** Numeric Shopify order id, stored on each activated participant for reversal joins. */
    shopifyOrderId: string;
    /** The paying order's lines; seats on the claimant variant never touched public stock. Omitted = all public. */
    lines?: { variantId: string; quantity: number }[];
}

export interface ActivateEnrollmentResult {
    activatedCount: number;
    releasedHoldCount: number;
    claimantSeatCount: number;
    /** True when the order was reversed, so nobody was activated. */
    reversed?: boolean;
}

/**
 * Each filled seat must end up exactly one unit out of the public variant's stock.
 * A sale on the public variant takes its unit itself; one on the untracked claimant
 * variant takes none. A scholarship hold already took one at request time. So:
 *   held + public   → +1 (the sale took a second unit)
 *   held + claimant →  0
 *   unheld + public →  0
 *   unheld + claimant → -1
 * which sums to released holds minus claimant-paid seats.
 */
export function publicStockDelta(releasedHoldCount: number, claimantSeatCount: number): number {
    return releasedHoldCount - claimantSeatCount;
}

/**
 * A refunded, cancelled or disputed order activates nobody. The reversal goes in
 * the ledger (so a resolved flag still blocks), each child still awaiting payment
 * is raised to the Board (CRITICAL, emailed), and any seat a refund restocked is
 * taken back off sale. Shared by the webhook, the reconciler and the gate below.
 */
export async function refuseReversedActivation(programId: number, personIds: number[], shopifyOrderId: string): Promise<void> {
    logger.warn(`[enroll] order ${shopifyOrderId} was reversed before program ${programId} activated — NOT activated, raised to the board`);
    await recordReversal(shopifyOrderId, "REVERSED_BEFORE_ACTIVATION");
    for (const personId of personIds) {
        const pending = await prisma.programParticipant.findUnique({
            where: { programId_personId: { programId, personId }, ...fromWhere("PENDING_UNPAID") },
            select: { personId: true },
        });
        if (pending) await raisePaymentException("REVERSED_BEFORE_ACTIVATION", { shopifyOrderId, programId, personId, severity: "CRITICAL" });
    }
    const program = await prisma.program.findUnique({ where: { id: programId }, select: { shopifyVariantId: true } });
    await takeBackRestockedSeats(shopifyOrderId, { id: programId, shopifyVariantId: program?.shopifyVariantId ?? null });
}

export async function activateProgramEnrollment(input: ActivateEnrollmentInput): Promise<ActivateEnrollmentResult> {
    const { programId, personIds, shopifyOrderId, lines = [] } = input;
    const program = await prisma.program.findUnique({
        where: { id: programId },
        select: { shopifyVariantId: true, claimantShopifyVariantId: true, maxParticipants: true, startAt: true, offSaleAt: true, saleEndedAt: true },
    });

    // ponytail: checked before the per-row flips, not under a lock. A refund recorded after this
    // check but before a row is flipped matches no row; the daily reconcile raises it as a REFUND, with no take-back.
    if (shopifyOrderId && (await isOrderReversed(prisma, shopifyOrderId))) {
        await refuseReversedActivation(programId, personIds, shopifyOrderId);
        return { activatedCount: 0, releasedHoldCount: 0, claimantSeatCount: 0, reversed: true };
    }

    const claimantVariantId = program?.claimantShopifyVariantId;
    const claimantPaid = claimantVariantId
        ? lines.filter((l) => l.variantId === claimantVariantId).reduce((n, l) => n + l.quantity, 0)
        : 0;

    // The flips and the stock delta they cause commit together under the program's
    // stock lock, so no hold stamp lands between a flip and its count.
    const { result, landed } = await changeProgramStockWith({ id: programId, shopifyVariantId: program?.shopifyVariantId ?? null }, "activation", async (tx) => {
        let activatedCount = 0;
        let releasedHoldCount = 0;
        for (const personId of personIds) {
            // Guarded PENDING → ACTIVE: status flip and hold release in one write (invariant I1),
            // idempotent for a redelivery (the row is already ACTIVE → 0 rows). Whether a hold
            // was released is read off which guarded write matched, never off a pre-read.
            const flip = (held: boolean) => tx.programParticipant.updateMany({
                // T4 activate CAS from-state (any PENDING; sourced from the definition, #1080).
                where: { programId, personId, ...fromWhere("PENDING_UNPAID"), inventoryHeldAt: held ? { not: null } : null },
                data: { status: "ACTIVE", pendingSince: null, shopifyOrderId, inventoryHeldAt: null },
            });
            const released = (await flip(true)).count;
            const unheld = released ? 0 : (await flip(false)).count;
            if (!released && !unheld) {
                logger.warn(`[enroll] Participant ${personId} not pending in program ${programId} — ignoring payment.`);
                continue;
            }
            activatedCount += 1;
            releasedHoldCount += released;
            logger.info(`[enroll] Marked participant ${personId} ACTIVE for program ${programId}`);
        }
        // Uncapped programs don't track public stock, so there is nothing to take a claimant seat from.
        const claimantSeatCount = program?.maxParticipants != null ? Math.min(claimantPaid, activatedCount) : 0;
        // Once the sale has ended only a reduction goes through, so no seat goes back on sale.
        const delta = program ? saleStockDelta(program, publicStockDelta(releasedHoldCount, claimantSeatCount)) : 0;
        return { result: { activatedCount, releasedHoldCount, claimantSeatCount, delta }, delta };
    }, { deferred: true });

    const { activatedCount, releasedHoldCount, claimantSeatCount, delta } = result;
    if (!landed) logger.error(`[enroll] Failed to adjust public stock by ${delta} for program ${programId} (${releasedHoldCount} hold(s) released, ${claimantSeatCount} claimant seat(s)) — capacity may be out of sync.`);

    return { activatedCount, releasedHoldCount, claimantSeatCount };
}
