import prisma from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { adjustProgramInventory } from "@/lib/shopify";
import { fromWhere } from "@/lib/programs/enrollmentState";

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
 * (orderEntitlesEnrollment in lib/finance/reconcile.ts); this function does not.
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

export async function activateProgramEnrollment(input: ActivateEnrollmentInput): Promise<ActivateEnrollmentResult> {
    const { programId, personIds, shopifyOrderId, lines = [] } = input;
    const program = await prisma.program.findUnique({ where: { id: programId } });

    let activatedCount = 0;
    let releasedHoldCount = 0;

    for (const personId of personIds) {
        const existing = await prisma.programParticipant.findUnique({ where: { programId_personId: { programId, personId } } });
        if (!existing) {
            logger.warn(`[enroll] Participant ${personId} not found in program ${programId} — ignoring payment.`);
            continue;
        }

        // Guarded PENDING → ACTIVE in ONE atomic write: status flip AND hold release
        // together, so the row is never committed as ACTIVE-with-held (invariant I1 —
        // the crash window that stranded a −1 that never came back). The single
        // status:'PENDING' guard makes this idempotent: a webhook redelivery / reconciler
        // re-run finds the row already ACTIVE → matches 0 rows → no double-activate, and
        // (since the flip and the release are the same write) no double-release either.
        const activated = await prisma.programParticipant.updateMany({
            // T4 activate CAS from-state (any PENDING; sourced from the definition, #1080).
            where: { programId, personId, ...fromWhere("PENDING_UNPAID") },
            data: { status: "ACTIVE", pendingSince: null, shopifyOrderId, inventoryHeldAt: null },
        });
        activatedCount += activated.count;
        if (activated.count > 0) logger.info(`[enroll] Marked participant ${personId} ACTIVE for program ${programId}`);

        // A hold was released iff THIS activation flipped a row that had one set (the pre-read
        // held stamp + a real 0→1 flip). The compensating Shopify +1 stays a separate call below.
        if (existing.inventoryHeldAt && activated.count > 0) releasedHoldCount += 1;
    }

    const claimantVariantId = program?.claimantShopifyVariantId;
    const claimantPaid = claimantVariantId
        ? lines.filter((l) => l.variantId === claimantVariantId).reduce((n, l) => n + l.quantity, 0)
        : 0;
    // Uncapped programs don't track public stock, so there is nothing to take a claimant seat from.
    const claimantSeatCount = program?.maxParticipants != null ? Math.min(claimantPaid, activatedCount) : 0;

    // One stock call for the whole order. Never fatal.
    const delta = publicStockDelta(releasedHoldCount, claimantSeatCount);
    if (delta !== 0) {
        const ok = await adjustProgramInventory({ shopifyVariantId: program?.shopifyVariantId ?? null }, delta);
        if (!ok) logger.error(`[enroll] Failed to adjust public stock by ${delta} for program ${programId} (${releasedHoldCount} hold(s) released, ${claimantSeatCount} claimant seat(s)) — capacity may be out of sync.`);
    }

    return { activatedCount, releasedHoldCount, claimantSeatCount };
}
