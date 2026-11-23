import prisma from "@/lib/prisma";
import type { DbClient } from "@/lib/db-client";
import { logger } from "@/lib/logger";
import { changeProgramStockWith } from "@/lib/shopify/stock";
import { ENROLLMENT_WRITES, fromWhere } from "@/lib/programs/enrollmentState";
import { saleStockDelta } from "@/lib/programs/saleState";
import { isOrderReversed, raisePaymentException, recordReversal } from "@/lib/finance/reconcile/exceptions";
import { takeBackRestockedSeats } from "@/lib/finance/reconcile/reversals";
import { peopleSpentBy, surplusSeats, type Surplus } from "@/lib/finance/reconcile/program";
import { programVariantIds } from "@/lib/programs/variants";
import { formatCents } from "@checkin/money";
import { orgToday } from "@/lib/appSettings";

/**
 * Activate paid program enrollments — the single choke point the Shopify
 * orders/paid webhook AND the reconciler both call (mirrors membership's
 * activate()). Shared with the webhook route so a MISSED webhook can be
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
 * Under the order's lock it activates no more people than the order has unspent seats,
 * and raises the rest for the Board (see {@link unspentSeats}). Seats it leaves unspent
 * are raised as a surplus, so a person activated another way since the order was judged
 * is still raised as a duplicate payment. A seat paid at a price other than the
 * program's still seats its person and is raised (see {@link priceMismatch}).
 */
export interface ActivateEnrollmentInput {
    programId: number;
    /** Person ids to activate (all must belong to this program's pending set). */
    personIds: number[];
    /** Numeric Shopify order id, stored on each activated participant for reversal joins. */
    shopifyOrderId: string;
    /** The paying order's lines; seats on the claimant variant never touched public stock. Omitted = all public, uncounted. */
    lines?: { variantId: string; quantity: number; currentQuantity?: number; unitPriceCents?: number | null }[];
}

export interface ActivateEnrollmentResult {
    activatedCount: number;
    releasedHoldCount: number;
    claimantSeatCount: number;
    /** True when the order was reversed, so nobody was activated. */
    reversed?: boolean;
    /** People left pending because the order's seats were already spent. */
    refusedPersonIds?: number[];
}

/**
 * Seats on this program's variants the order still has to give, and the people it
 * already seated, counted under the order's lock, so two activations of one order
 * cannot both spend its last seat and nobody is seated twice by it.
 * Null when the caller gave no lines: there is nothing to count against.
 */
export async function unspentSeats(
    db: DbClient,
    program: { shopifyVariantId: string | null; claimantShopifyVariantId: string | null },
    programId: number,
    shopifyOrderId: string,
    lines: ActivateEnrollmentInput["lines"],
): Promise<{ unspent: number; spentOn: Set<number> } | null> {
    if (!lines?.length || !shopifyOrderId) return null;
    const variantIds = new Set(programVariantIds(program));
    const seats = lines.filter((l) => variantIds.has(l.variantId)).reduce((n, l) => n + (l.currentQuantity ?? l.quantity), 0);
    const spentOn = await peopleSpentBy(db, shopifyOrderId, programId);
    return { unspent: Math.max(0, seats - spentOn.size), spentOn };
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

/**
 * The order's seat price set against the program's price, when a seat line differs
 * from it: the Board may have changed the price while the family's checkout was
 * open. Both variants sell at the full price (members pay through a code), so the
 * line's unit price before discounts is compared with the full price. Null when
 * they agree or either price is unknown.
 */
export function priceMismatch(
    program: { shopifyVariantId: string | null; claimantShopifyVariantId: string | null; nonOrgMemberPriceCents: number | null },
    lines: ActivateEnrollmentInput["lines"] = [],
): string | null {
    const price = program.nonOrgMemberPriceCents;
    if (price == null) return null;
    const variantIds = new Set(programVariantIds(program));
    const paid = lines.find((l) => variantIds.has(l.variantId) && l.unitPriceCents != null && l.unitPriceCents !== price)?.unitPriceCents;
    return paid == null ? null : `Paid ${formatCents(paid)} per seat; the program's price is ${formatCents(price)}. The family is seated; settle the difference by hand.`;
}

export async function activateProgramEnrollment(input: ActivateEnrollmentInput): Promise<ActivateEnrollmentResult> {
    const { programId, personIds, shopifyOrderId, lines = [] } = input;
    const program = await prisma.program.findUnique({
        where: { id: programId },
        select: { shopifyVariantId: true, claimantShopifyVariantId: true, maxParticipants: true, startAt: true, offSaleAt: true, saleEndedAt: true, nonOrgMemberPriceCents: true },
    });
    const today = await orgToday();

    const claimantVariantId = program?.claimantShopifyVariantId;
    const claimantPaid = claimantVariantId
        ? lines.filter((l) => l.variantId === claimantVariantId).reduce((n, l) => n + (l.currentQuantity ?? l.quantity), 0)
        : 0;

    // The flips and the stock delta they cause commit together under the program's
    // stock lock, so no hold stamp lands between a flip and its count.
    const { result, landed } = await changeProgramStockWith({ id: programId, shopifyVariantId: program?.shopifyVariantId ?? null }, "activation", async (tx) => {
        // Holds the order's reversal lock to commit: a refund is either seen here, or waits and then finds the flipped rows.
        if (shopifyOrderId && (await isOrderReversed(tx, shopifyOrderId))) {
            return { result: { activatedCount: 0, activatedPersonIds: [] as number[], releasedHoldCount: 0, claimantSeatCount: 0, delta: 0, reversed: true, refusedPersonIds: [], surplus: undefined as Surplus | undefined }, delta: 0 };
        }
        const cap = program ? await unspentSeats(tx, program, programId, shopifyOrderId, lines) : null;
        let activatedCount = 0;
        const activatedPersonIds: number[] = [];
        let releasedHoldCount = 0;
        const refusedPersonIds: number[] = [];
        for (const personId of personIds) {
            // A person the order already seated, who left and came back, is not seated by it again.
            if (cap !== null && (activatedCount >= cap.unspent || cap.spentOn.has(personId))) {
                refusedPersonIds.push(personId);
                continue;
            }
            // Guarded PENDING → ACTIVE: status flip and hold release in one write (invariant I1),
            // idempotent for a redelivery (the row is already ACTIVE → 0 rows). Whether a hold
            // was released is read off which guarded write matched, never off a pre-read.
            const paid = { pendingSince: null, shopifyOrderId };
            const released = (await tx.programParticipant.updateMany({
                where: { programId, personId, ...ENROLLMENT_WRITES.activateHeld.where },
                data: { ...ENROLLMENT_WRITES.activateHeld.data(), ...paid },
            })).count;
            const unheld = released ? 0 : (await tx.programParticipant.updateMany({
                where: { programId, personId, ...ENROLLMENT_WRITES.activateUnheld.where },
                data: { ...ENROLLMENT_WRITES.activateUnheld.data(), ...paid },
            })).count;
            if (!released && !unheld) {
                logger.warn(`[enroll] Participant ${personId} not pending in program ${programId} — ignoring payment.`);
                continue;
            }
            activatedCount += 1;
            activatedPersonIds.push(personId);
            releasedHoldCount += released;
            logger.info(`[enroll] Marked participant ${personId} ACTIVE for program ${programId}`);
        }
        const surplus = cap !== null ? await surplusSeats(tx, shopifyOrderId, programId, personIds, cap.unspent - activatedCount) : undefined;
        // Uncapped programs don't track public stock, so there is nothing to take a claimant seat from.
        const claimantSeatCount = program?.maxParticipants != null ? Math.min(claimantPaid, activatedCount) : 0;
        // Once the sale has ended only a reduction goes through, so no seat goes back on sale.
        const delta = program ? saleStockDelta(program, publicStockDelta(releasedHoldCount, claimantSeatCount), today) : 0;
        return { result: { activatedCount, activatedPersonIds, releasedHoldCount, claimantSeatCount, delta, reversed: false, refusedPersonIds, surplus }, delta };
    }, { deferred: true });

    const { activatedCount, activatedPersonIds, releasedHoldCount, claimantSeatCount, delta, reversed, refusedPersonIds, surplus } = result;
    // After commit: the refusal records the reversal on its own connection, which needs the order's lock released.
    if (reversed) {
        await refuseReversedActivation(programId, personIds, shopifyOrderId);
        return { activatedCount: 0, releasedHoldCount: 0, claimantSeatCount: 0, reversed: true };
    }
    // The same exception the order check raises for a shortfall; only a child still pending is raised.
    for (const personId of refusedPersonIds) {
        const pending = await prisma.programParticipant.findUnique({
            where: { programId_personId: { programId, personId }, ...fromWhere("PENDING_UNPAID") },
            select: { personId: true },
        });
        if (pending) await raisePaymentException("AMOUNT_MISMATCH", { shopifyOrderId, programId, personId });
    }
    // Keyed like the order check's own raise (kind, order, person), so a surplus it already raised is not raised twice.
    if (surplus) await raisePaymentException(surplus.kind, { shopifyOrderId, programId, personId: surplus.personId ?? personIds[0] ?? null });
    const mismatch = program && activatedPersonIds.length > 0 ? priceMismatch(program, lines) : null;
    if (mismatch) await raisePaymentException("AMOUNT_MISMATCH", { shopifyOrderId, programId, personId: activatedPersonIds[0], evidence: mismatch });
    if (!landed) logger.error(`[enroll] Failed to adjust public stock by ${delta} for program ${programId} (${releasedHoldCount} hold(s) released, ${claimantSeatCount} claimant seat(s)) — capacity may be out of sync.`);

    return { activatedCount, releasedHoldCount, claimantSeatCount, ...(refusedPersonIds.length > 0 && { refusedPersonIds }) };
}
