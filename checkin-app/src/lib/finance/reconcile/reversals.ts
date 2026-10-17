import prisma from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { systemActor } from "@/lib/auditActor";
import { programVariantIds } from "@/lib/programs/variants";
import { adjustProgramInventory } from "@/lib/shopify";
import { isSaleEnded, type SaleRow } from "@/lib/programs/saleState";
import * as mirror from "@/lib/shopifyRead/client";
import type { MirrorOrder } from "@/lib/shopifyRead/client";
import { raisePaymentException, type PaymentExceptionKind } from "./exceptions";
import { isReversed } from "./orderStatus";
import { AMOUNT_TOLERANCE_CENTS, usesVolunteerCodeUnentitled } from "./membership";

function classifyReversal(o: MirrorOrder, disputed: boolean): PaymentExceptionKind | null {
    if (o.cancelledAt) return "CANCELLED";
    if (disputed) return "CHARGEBACK";
    if (isReversed(o)) return "REFUND";
    return null;
}

/** A refunded order line Shopify put back in stock (refund_line_items with a restock_type other than no_restock). */
export interface RestockedLine {
    variantId: string;
    /** Seats this refund restocked. */
    quantity: number;
    /** Seats the order line bought. */
    lineQuantity: number;
    /** Children the line names in its CheckMeIn_Account_ID line property; empty when it names none. */
    personIds?: number[];
}

/**
 * Fast-path entry for the reversal webhooks (refunds/create, orders/cancelled,
 * disputes/*): map a Shopify order id to the membership process and/or program
 * enrollment it activated and raise the given problem. Returns true if anything
 * matched. Shares the same idempotent raise as the daily reconciler. Only the
 * refunds/create payload says whether a refund restocked; the daily pass can't
 * see it and only flags. A REFUND that restocked public seats is settled per
 * program by settleRestockedSeats, once per refund id: Shopify redelivers
 * webhooks, and a second settlement would take the same seats back again.
 */
export async function raiseReversalByOrderId(
    orderLegacyId: string,
    kind: PaymentExceptionKind,
    restocked: RestockedLine[] = [],
    refundId: string | null = null,
): Promise<boolean> {
    let matched = false;
    const proc = await prisma.orgMembershipProcess.findFirst({ where: { shopifyOrderId: orderLegacyId }, select: { id: true } });
    if (proc) {
        await raisePaymentException(kind, { shopifyOrderId: orderLegacyId, processId: proc.id });
        matched = true;
    }
    const enrolls = await prisma.programParticipant.findMany({
        where: { shopifyOrderId: orderLegacyId },
        select: { programId: true, personId: true, program: { select: { shopifyVariantId: true, claimantShopifyVariantId: true, startAt: true, offSaleAt: true, saleEndedAt: true } } },
    });
    for (const e of enrolls) {
        await raisePaymentException(kind, { shopifyOrderId: orderLegacyId, programId: e.programId, personId: e.personId });
        matched = true;
    }
    if (kind === "REFUND" && refundId) {
        for (const programId of new Set(enrolls.map((e) => e.programId))) {
            const onProgram = enrolls.filter((e) => e.programId === programId);
            if (!(await claimRefundSettlement(refundId, orderLegacyId, programId))) continue;
            await settleRestockedSeats(orderLegacyId, programId, onProgram[0].program, onProgram.map((e) => e.personId), restocked);
        }
    }
    return matched;
}

const REFUND_SETTLEMENT_TABLE = "ShopifyRefundSettlement";
/** Two-argument advisory-lock class, apart from per-person 1-arg locks and FACILITY_ADVISORY_CLASS. */
export const REFUND_SETTLEMENT_ADVISORY_CLASS = 2;

/**
 * Record that this refund's restock is being settled for this program; false when
 * an earlier delivery already did. The advisory lock serialises concurrent
 * deliveries of the same refund between the check and the insert.
 */
async function claimRefundSettlement(refundId: string, orderLegacyId: string, programId: number): Promise<boolean> {
    const key = `${refundId}:${programId}`;
    return prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${REFUND_SETTLEMENT_ADVISORY_CLASS}::int, hashtext(${key}))`;
        const seen = await tx.auditLog.findFirst({
            where: { tableName: REFUND_SETTLEMENT_TABLE, secondaryAffectedEntity: programId, newData: { path: ["key"], equals: key } },
            select: { id: true },
        });
        if (seen) return false;
        // ponytail: claimed before settling, so a crash mid-settlement leaves the rest to
        // the board's REFUND flags rather than risking a second take-back.
        await tx.auditLog.create({
            data: {
                ...systemActor("webhook:shopify-refund"),
                action: "CREATE",
                tableName: REFUND_SETTLEMENT_TABLE,
                affectedEntityId: programId,
                secondaryAffectedEntity: programId,
                newData: { key, refundId, orderLegacyId, programId },
            },
        });
        return true;
    });
}

/**
 * Keep public stock equal to the seats children hold after a restocking refund.
 * Only public-variant lines count: the claimant variant tracks no stock, so its
 * restock puts nothing back on sale and stays flag-only. Of the k public seats
 * Shopify restocked, a child is removed only when the order says which: every
 * seat the order bought for the program came back, or a fully restocked line
 * names its children. Seats nobody can be matched to are taken back off sale
 * with -k, and the children stay enrolled under their REFUND flags for the board.
 * After the program's sale has ended every restocked seat is taken back off sale:
 * the off-sale rule wins over putting a refunded seat back on sale.
 */
async function settleRestockedSeats(
    orderLegacyId: string,
    programId: number,
    program: { shopifyVariantId: string | null; claimantShopifyVariantId: string | null } & Pick<SaleRow, 'startAt' | 'offSaleAt' | 'saleEndedAt'>,
    personIds: number[],
    restocked: RestockedLine[],
): Promise<void> {
    const lines = restocked.filter((l) => program.shopifyVariantId && l.variantId === program.shopifyVariantId);
    const k = lines.reduce((n, l) => n + l.quantity, 0);
    if (k === 0) return;

    // ponytail: the payload doesn't carry earlier refunds, so "every seat" compares
    // against what the order bought, not what is still unrefunded.
    const variantIds = new Set(programVariantIds(program));
    const seats = (await mirror.orderLines(`gid://shopify/Order/${orderLegacyId}`))
        .filter((l) => variantIds.has(l.variantId))
        .reduce((n, l) => n + l.quantity, 0);
    let unmatched = 0;
    if (seats > 0 && k >= seats && personIds.length <= k) {
        for (const personId of personIds) await removeRefundedEnrollment(programId, personId, orderLegacyId);
    } else {
        for (const l of lines) {
            const named = [...new Set(l.personIds ?? [])].filter((id) => personIds.includes(id));
            if (l.quantity === l.lineQuantity && named.length === l.quantity) {
                for (const personId of named) await removeRefundedEnrollment(programId, personId, orderLegacyId);
            } else {
                unmatched += l.quantity;
            }
        }
    }
    const variant = { id: programId, shopifyVariantId: program.shopifyVariantId };
    if (isSaleEnded(program)) {
        logger.warn(`[reconcile] refund on order ${orderLegacyId} restocked ${k} seat(s) of program ${programId} after its sale ended: taking them back off sale`);
        await adjustProgramInventory(variant, -k, "refund-after-sale", { deferred: true });
        return;
    }
    if (unmatched === 0) return;
    logger.warn(`[reconcile] refund on order ${orderLegacyId} restocked ${unmatched} seat(s) of program ${programId} that no child can be matched to: taking them back off sale, the board decides who leaves`);
    await adjustProgramInventory(variant, -unmatched, "refund-unmatched", { deferred: true });
}

/**
 * Remove an enrollment whose seat a restocking refund already put back on sale.
 * No hold release and no Shopify call: Shopify restocked the unit itself. Scoped to
 * the refunded order, so a row since re-paid on another order is left alone.
 */
async function removeRefundedEnrollment(programId: number, personId: number, orderLegacyId: string): Promise<void> {
    const where = { programId, personId, shopifyOrderId: orderLegacyId };
    const removed = await prisma.$transaction(async (tx) => {
        const row = await tx.programParticipant.findFirst({ where });
        if (!row) return false;
        const { count } = await tx.programParticipant.deleteMany({ where });
        if (count === 0) return false;
        await tx.auditLog.create({
            data: {
                ...systemActor("webhook:shopify-refund"),
                action: "DELETE",
                tableName: "ProgramParticipant",
                affectedEntityId: personId,
                secondaryAffectedEntity: programId,
                oldData: { ...row, reason: `refund restocked the seat on order ${orderLegacyId}` },
            },
        });
        return true;
    });
    if (!removed) return;
    logger.info(`[reconcile] removed enrollment program ${programId} / person ${personId}: refund on order ${orderLegacyId} restocked the seat`);
}

export async function reconcileReversals(): Promise<number> {
    // App-side activated orders: money recorded (paidAt) with an order id. BLOCKED
    // stays out — a refund on a paid-while-blocked application is the expected fix.
    const procs = await prisma.orgMembershipProcess.findMany({
        where: { shopifyOrderId: { not: null }, paidAt: { not: null }, status: { in: ["ACTIVE", "PENDING_BG_CLEARANCE"] } },
        select: { id: true, shopifyOrderId: true, orgMembershipId: true },
    });
    const enrolls = await prisma.programParticipant.findMany({
        where: { shopifyOrderId: { not: null }, status: "ACTIVE" },
        select: { programId: true, personId: true, shopifyOrderId: true },
    });

    const orderIds = [
        ...procs.map((p) => p.shopifyOrderId!),
        ...enrolls.map((e) => e.shopifyOrderId!),
    ];
    if (orderIds.length === 0) return 0;

    const orders = await mirror.ordersByLegacyIds([...new Set(orderIds)]);
    const byLegacy = new Map(orders.map((o) => [o.legacyId ?? "", o]));
    const disputed = await mirror.disputedOrderGids(orders.map((o) => o.orderGid));

    // Expected membership fee per membership (for the "order edited down below the membership fee" case).
    const settings = await prisma.boardSettings.findUnique({
        where: { id: 1 },
        select: { standardMembershipFeeCents: true, volunteerMembershipFeeCents: true, volunteerDiscountCode: true },
    });
    const memberIds = procs.map((p) => p.orgMembershipId).filter((v): v is number => v != null);
    const members = memberIds.length
        ? await prisma.orgMembership.findMany({ where: { id: { in: memberIds } }, select: { id: true, isVolunteer: true } })
        : [];
    const isVolunteerById = new Map(members.map((m) => [m.id, m.isVolunteer]));

    let raised = 0;
    for (const proc of procs) {
        const o = byLegacy.get(proc.shopifyOrderId!);
        if (!o) continue; // pre-cutover / not yet mirrored — can't judge.
        let kind = classifyReversal(o, disputed.has(o.orderGid));
        if (!kind) {
            // Not reversed — but was the order edited down below the membership fee after activation?
            // Discount-aware: add the coupon back so an ordinary couponed order (volunteer
            // rate, promo) isn't mistaken for a post-activation edit-down — only a real
            // shortfall below the GROSS membership fee counts. Keeps the "edited down" purpose intact.
            const expected = isVolunteerById.get(proc.orgMembershipId ?? -1) ? settings?.volunteerMembershipFeeCents ?? 0 : settings?.standardMembershipFeeCents ?? 0;
            if (expected > 0 && o.totalCents + o.discountCents + AMOUNT_TOLERANCE_CENTS < expected) kind = "AMOUNT_MISMATCH";
        }
        if (!kind && usesVolunteerCodeUnentitled(o, settings?.volunteerDiscountCode, isVolunteerById.get(proc.orgMembershipId ?? -1) ?? false)) {
            // Coupon entitlement, shared with the forward pass — and load-bearing here:
            // orders the webhook activated in real time never reach the forward pass
            // (already recorded on the process → early return), so this loop over
            // activated memberships is the daily audit that catches a volunteer code
            // a non-volunteer family redeemed. Order + volunteer flag already in hand.
            logger.warn(`[reconcile] volunteer discount code on non-volunteer activated order ${proc.shopifyOrderId} (process ${proc.id})`);
            kind = "DISCOUNT_UNAUTHORIZED";
        }
        if (kind) {
            await raisePaymentException(kind, { shopifyOrderId: proc.shopifyOrderId, processId: proc.id });
            raised++;
        }
    }
    for (const e of enrolls) {
        const o = byLegacy.get(e.shopifyOrderId!);
        if (!o) continue;
        // Money-out only. Member-code entitlement is NOT re-asked here: it was judged
        // when the money moved (webhook / forward pass), and this loop has no bound on
        // time — re-deriving it from live household state would raise a fresh flag on
        // every past member-priced order the morning after an ordinary deactivation.
        const kind = classifyReversal(o, disputed.has(o.orderGid));
        if (kind) {
            await raisePaymentException(kind, { shopifyOrderId: e.shopifyOrderId, programId: e.programId, personId: e.personId });
            raised++;
        }
    }
    return raised;
}
