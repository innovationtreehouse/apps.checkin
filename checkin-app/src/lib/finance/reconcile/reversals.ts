import prisma from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { systemActor, type SystemActorName } from "@/lib/auditActor";
import { programVariantIds } from "@/lib/programs/variants";
import { adjustProgramInventory } from "@/lib/shopify/stock";
import { isSaleEnded, type SaleRow } from "@/lib/programs/saleState";
import * as mirror from "@/lib/shopifyRead/client";
import type { MirrorOrder } from "@/lib/shopifyRead/client";
import type { Prisma } from "@/generated/prisma/client";
import { recordDeniedStoreRefund } from "@/lib/membership/refund";
import { refundableApplication } from "@/lib/membership/lifecycle";
import { raisePaymentException, recordReversal, recordSettledPaymentException, type PaymentExceptionKind } from "./exceptions";
import { isFullyRefunded, isReversed } from "./orderStatus";
import { membershipVariantYears, usesVolunteerCodeUnentitled } from "./membership";
import { orgToday } from "@/lib/appSettings";

function classifyReversal(o: MirrorOrder, disputed: boolean): PaymentExceptionKind | null {
    if (o.cancelledAt) return "CANCELLED";
    if (disputed) return "CHARGEBACK";
    if (isReversed(o)) return "REFUND";
    return null;
}

/** The same string for every reversal kind, so a further refund on a cancelled or disputed order still reads as new. */
function reversalEvidence(o: MirrorOrder, disputes: number): string {
    return `refunded=${o.totalRefundedCents};disputes=${disputes};cancelled=${o.cancelledAt?.toISOString() ?? ""}`;
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

const DENIED_REFUND_NOTE = "Refund recorded on its own: the household is denied.";

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
    // Restock rows land before the ledger row: a gate that sees the reversal also sees what it restocked.
    if (kind === "REFUND" && refundId) await recordRestock(refundId, orderLegacyId, restocked);
    await recordReversal(orderLegacyId, kind);
    let matched = false;
    const proc = await prisma.orgMembershipProcess.findFirst({ where: { shopifyOrderId: orderLegacyId }, select: { id: true, status: true, paidAt: true } });
    if (proc && kind === "REFUND" && (await mirrorShowsFullRefund(orderLegacyId)) && (await recordDeniedStoreRefund(proc.id, orderLegacyId))) {
        await recordSettledPaymentException("REFUND", { shopifyOrderId: orderLegacyId, processId: proc.id }, DENIED_REFUND_NOTE);
        matched = true;
    } else if (proc) {
        // Paid and still waiting on its check: it must not activate, so the Board hears now.
        const waiting = !!proc.paidAt && (proc.status === "PENDING_BG_CLEARANCE" || proc.status === "PENDING_BG_REVIEW");
        await raisePaymentException(kind, { shopifyOrderId: orderLegacyId, processId: proc.id, ...(waiting ? { severity: "CRITICAL" as const } : {}) });
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
        const programIds = new Set(enrolls.map((e) => e.programId));
        for (const programId of programIds) {
            const onProgram = enrolls.filter((e) => e.programId === programId);
            if (!(await claimRefundSettlement(refundId, orderLegacyId, programId))) continue;
            await settleRestockedSeats(orderLegacyId, programId, onProgram[0].program, onProgram.map((e) => e.personId), restocked);
        }
        await settleUnrecordedRestock(orderLegacyId, refundId, programIds, restocked);
    }
    return matched;
}

/** Seats on `program`'s public variant among these lines. */
function publicSeats(program: { shopifyVariantId: string | null }, lines: { variantId: string; quantity: number }[]): number {
    return lines.filter((l) => program.shopifyVariantId && l.variantId === program.shopifyVariantId).reduce((n, l) => n + l.quantity, 0);
}

/**
 * A restocking refund on an order no row records (withdrawn before it was paid, a
 * stranger's order, or a test order): its restocked public seats go back off sale
 * after the program's sale has ended, and always for a test order whose seats were
 * already given back. Otherwise they stay on sale, as no child holds them.
 */
async function settleUnrecordedRestock(orderLegacyId: string, refundId: string, recorded: Set<number>, restocked: RestockedLine[]): Promise<void> {
    if (restocked.length === 0) return;
    const programs = await prisma.program.findMany({
        where: { shopifyVariantId: { in: restocked.map((l) => l.variantId) }, id: { notIn: [...recorded] } },
        select: { id: true, shopifyVariantId: true, startAt: true, offSaleAt: true, saleEndedAt: true },
    });
    const today = await orgToday();
    for (const program of programs) {
        const testOrder = await testOrderStockReturned(orderLegacyId, program.id);
        if (!testOrder && !isSaleEnded(program, today)) continue;
        if (!(await claimRefundSettlement(refundId, orderLegacyId, program.id))) continue;
        const k = publicSeats(program, restocked);
        if (testOrder) {
            logger.info(`[reconcile] refund on test order ${orderLegacyId} restocked ${k} seat(s) of program ${program.id} already given back: taking them back off sale`);
            await adjustProgramInventory(program, -k, "refund-test-order", { deferred: true });
        } else {
            await takeBackAfterSale(orderLegacyId, program, k);
        }
    }
}

async function takeBackAfterSale(orderLegacyId: string, program: { id: number; shopifyVariantId: string | null }, k: number): Promise<void> {
    logger.warn(`[reconcile] refund on order ${orderLegacyId} restocked ${k} seat(s) of program ${program.id} after its sale ended: taking them back off sale`);
    await adjustProgramInventory(program, -k, "refund-after-sale", { deferred: true });
}

const testOrderKey = (orderLegacyId: string, programId: number) => `test-order:${orderLegacyId}:${programId}`;

/** Whether returnTestOrderStock gave back this order's seats on this program. */
async function testOrderStockReturned(orderLegacyId: string, programId: number): Promise<boolean> {
    const claim = await prisma.auditLog.findFirst({
        where: { tableName: TEST_ORDER_STOCK_TABLE, secondaryAffectedEntity: programId, newData: { path: ["key"], equals: testOrderKey(orderLegacyId, programId) } },
        select: { id: true },
    });
    return claim !== null;
}

/**
 * Shopify takes stock for a test-mode order like any other, but a test order moves
 * no stock in the app's books: give back the public seats it took, less those an
 * earlier refund already restocked, once per order and program (Shopify redelivers
 * webhooks). The claimant variant tracks no stock.
 */
export async function returnTestOrderStock(orderLegacyId: string, lines: { variantId: string; quantity: number }[]): Promise<void> {
    if (lines.length === 0) return;
    const programs = await prisma.program.findMany({
        where: { shopifyVariantId: { in: lines.map((l) => l.variantId) } },
        select: { id: true, shopifyVariantId: true },
    });
    for (const program of programs) {
        const k = publicSeats(program, lines);
        if (k === 0) continue;
        if (!(await claimOnce(TEST_ORDER_STOCK_TABLE, "webhook:shopify-order", testOrderKey(orderLegacyId, program.id), program.id, { orderLegacyId, programId: program.id }))) continue;
        const owed = k - await claimRecordedRestocks(orderLegacyId, program);
        logger.info(`[reconcile] test order ${orderLegacyId} took ${k} seat(s) of program ${program.id}: giving back ${owed}`);
        if (owed > 0) await adjustProgramInventory(program, owed, "test-order", { deferred: true });
    }
}

const REFUND_SETTLEMENT_TABLE = "ShopifyRefundSettlement";
const TEST_ORDER_STOCK_TABLE = "ShopifyTestOrderStock";
/** Two-argument advisory-lock class, apart from per-person 1-arg locks and FACILITY_ADVISORY_CLASS. */
export const REFUND_SETTLEMENT_ADVISORY_CLASS = 2;

/**
 * Record that this refund's restock is being settled for this program; false when
 * an earlier delivery already did.
 */
function claimRefundSettlement(refundId: string, orderLegacyId: string, programId: number): Promise<boolean> {
    const key = `${refundId}:${programId}`;
    return claimOnce(REFUND_SETTLEMENT_TABLE, "webhook:shopify-refund", key, programId, { refundId, orderLegacyId, programId });
}

/**
 * Record a one-time stock settlement under `key`; false when an earlier delivery
 * already did. The advisory lock serialises concurrent deliveries between the
 * check and the insert.
 */
async function claimOnce(tableName: string, actor: SystemActorName, key: string, programId: number, data: Record<string, string | number>): Promise<boolean> {
    return prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${REFUND_SETTLEMENT_ADVISORY_CLASS}::int, hashtext(${key}))`;
        const seen = await tx.auditLog.findFirst({
            where: { tableName, secondaryAffectedEntity: programId, newData: { path: ["key"], equals: key } },
            select: { id: true },
        });
        if (seen) return false;
        // ponytail: claimed before settling, so a crash mid-settlement never changes stock
        // twice but loses the settlement. A recorded enrollment still has its REFUND flag;
        // an unrecorded order or a test order leaves no flag.
        await tx.auditLog.create({
            data: {
                ...systemActor(actor),
                action: "CREATE",
                tableName,
                affectedEntityId: programId,
                secondaryAffectedEntity: programId,
                newData: { key, ...data },
            },
        });
        return true;
    });
}

const REFUND_RESTOCK_TABLE = "ShopifyRefundRestock";

/**
 * Remember what a refund put back in stock, one row per restocked line, so an
 * activation that arrives after the refund can take those seats back off sale.
 */
async function recordRestock(refundId: string, orderLegacyId: string, restocked: RestockedLine[]): Promise<void> {
    if (restocked.length === 0) return;
    const key = `restock:${refundId}`;
    // The lock serialises concurrent deliveries of one refund, so its lines are recorded once.
    await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${REFUND_SETTLEMENT_ADVISORY_CLASS}::int, hashtext(${key}))`;
        const seen = await tx.auditLog.findFirst({ where: { tableName: REFUND_RESTOCK_TABLE, newData: { path: ["refundId"], equals: refundId } }, select: { id: true } });
        if (seen) return;
        await tx.auditLog.createMany({
            data: restocked.map((l) => ({
                ...systemActor("webhook:shopify-refund"),
                action: "CREATE",
                tableName: REFUND_RESTOCK_TABLE,
                affectedEntityId: 0,
                newData: { refundId, orderLegacyId, variantId: l.variantId, quantity: l.quantity },
            })),
        });
    });
}

function restockRow(data: Prisma.JsonValue): { refundId: string; variantId: string; quantity: number } | null {
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    const { refundId, variantId, quantity } = data;
    return typeof refundId === "string" && typeof variantId === "string" && typeof quantity === "number" ? { refundId, variantId, quantity } : null;
}

/**
 * Claim this order's recorded refunds not yet settled on `program` and return the
 * public seats they restocked. Each refund is settled once per program, shared with
 * settleRestockedSeats.
 */
async function claimRecordedRestocks(orderLegacyId: string, program: { id: number; shopifyVariantId: string | null }): Promise<number> {
    const rows = await prisma.auditLog.findMany({
        where: { tableName: REFUND_RESTOCK_TABLE, newData: { path: ["orderLegacyId"], equals: orderLegacyId } },
        select: { newData: true },
    });
    const byRefund = new Map<string, number>();
    for (const row of rows) {
        const r = restockRow(row.newData);
        if (r && r.variantId === program.shopifyVariantId) byRefund.set(r.refundId, (byRefund.get(r.refundId) ?? 0) + r.quantity);
    }
    let k = 0;
    for (const [refundId, seats] of byRefund) {
        if (await claimRefundSettlement(refundId, orderLegacyId, program.id)) k += seats;
    }
    return k;
}

/**
 * Take back off sale the public seats a refund restocked on an order that was
 * refused activation. Returns the seats taken back.
 *
 * ponytail: reads only refunds already recorded; a refund webhook arriving after
 * the refusal finds no enrolled row, so its restock stays on sale while the sale is
 * open. The Board still has the CRITICAL flag.
 */
export async function takeBackRestockedSeats(orderLegacyId: string, program: { id: number; shopifyVariantId: string | null }): Promise<number> {
    if (!program.shopifyVariantId) return 0;
    const k = await claimRecordedRestocks(orderLegacyId, program);
    if (k === 0) return 0;
    logger.warn(`[reconcile] refunded order ${orderLegacyId} restocked ${k} seat(s) of program ${program.id} before activation: taking them back off sale, the board decides`);
    await adjustProgramInventory(program, -k, "refund-before-activation", { deferred: true });
    return k;
}

/**
 * Keep public stock equal to the seats children hold after a restocking refund.
 * Only public-variant lines count: the claimant variant tracks no stock, so its
 * restock puts nothing back on sale and stays flag-only. A refund removes nobody:
 * every child stays enrolled under their REFUND flag until the Board acts. Of the
 * k public seats Shopify restocked, a seat goes back on sale only when the order
 * ties it to a child who no longer holds it (every seat the order bought for the
 * program came back, or a fully restocked line names its children). Every other
 * seat is taken back off sale with -k. After the program's sale has ended every
 * restocked seat is taken back off sale: the off-sale rule wins over putting a
 * refunded seat back on sale.
 */
async function settleRestockedSeats(
    orderLegacyId: string,
    programId: number,
    program: { shopifyVariantId: string | null; claimantShopifyVariantId: string | null } & Pick<SaleRow, 'startAt' | 'offSaleAt' | 'saleEndedAt'>,
    personIds: number[],
    restocked: RestockedLine[],
): Promise<void> {
    const lines = restocked.filter((l) => program.shopifyVariantId && l.variantId === program.shopifyVariantId);
    const k = publicSeats(program, restocked);
    if (k === 0) return;

    // ponytail: the payload doesn't carry earlier refunds, so "every seat" compares
    // against what the order bought, not what is still unrefunded.
    const variantIds = new Set(programVariantIds(program));
    const seats = (await mirror.orderLines(`gid://shopify/Order/${orderLegacyId}`))
        .filter((l) => variantIds.has(l.variantId))
        .reduce((n, l) => n + l.quantity, 0);
    let held = 0;
    if (seats > 0 && k >= seats && personIds.length <= k) {
        for (const personId of personIds) held += await keepRefundedEnrollment(programId, personId, orderLegacyId);
    } else {
        for (const l of lines) {
            const named = [...new Set(l.personIds ?? [])].filter((id) => personIds.includes(id));
            if (l.quantity === l.lineQuantity && named.length === l.quantity) {
                for (const personId of named) held += await keepRefundedEnrollment(programId, personId, orderLegacyId);
            } else {
                held += l.quantity;
            }
        }
    }
    const variant = { id: programId, shopifyVariantId: program.shopifyVariantId };
    if (isSaleEnded(program, await orgToday())) {
        await takeBackAfterSale(orderLegacyId, variant, k);
        return;
    }
    if (held === 0) return;
    logger.warn(`[reconcile] refund on order ${orderLegacyId} restocked ${held} seat(s) of program ${programId} still held: taking them back off sale, the board decides who leaves`);
    await adjustProgramInventory(variant, -held, "refund-restocked", { deferred: true });
}

/**
 * A restocking refund on an enrollment removes nobody: the refund is raised for
 * the Board, which alone removes a paid place. Scoped to the refunded order, so a
 * row since re-paid on another order is left alone. Returns the seats to take back
 * off sale: 1 for an ACTIVE row, whose child still holds the seat; for a WITHDRAWN
 * row, 1 only when the withdrawal already put the seat back, so the restock would
 * offer it twice. A WITHDRAWN row is history: the refund is recorded against it.
 */
async function keepRefundedEnrollment(programId: number, personId: number, orderLegacyId: string): Promise<number> {
    const where = { programId, personId, shopifyOrderId: orderLegacyId };
    const withdrawn = await prisma.programParticipant.findFirst({ where: { ...where, status: "WITHDRAWN" } });
    if (withdrawn) {
        await prisma.auditLog.create({
            data: {
                ...systemActor("webhook:shopify-refund"),
                action: "EDIT",
                tableName: "ProgramParticipant",
                affectedEntityId: personId,
                secondaryAffectedEntity: programId,
                newData: { ...withdrawn, reason: `refund restocked the seat on order ${orderLegacyId} after withdrawal` },
            },
        });
        return withdrawn.seatTakenWithoutSaleAt ? 1 : 0;
    }
    const active = await prisma.programParticipant.count({ where: { ...where, status: "ACTIVE" } });
    return active > 0 ? 1 : 0;
}

/**
 * Whether the mirror already shows the order fully refunded. The mirror can lag the
 * webhook; a refund it does not show yet is raised, and the daily pass records it.
 */
async function mirrorShowsFullRefund(orderLegacyId: string): Promise<boolean> {
    const [o] = await mirror.ordersByLegacyIds([orderLegacyId]);
    return !!o && isFullyRefunded(o);
}

/**
 * A full store refund on a DENIED household's paid application records itself; a
 * partial one stays with the Board. The daily pass for a refund whose webhook never
 * arrived, one the mirror did not yet show, or one that arrived before the denial.
 */
async function recordDeniedStoreRefunds(): Promise<number> {
    const procs = await prisma.orgMembershipProcess.findMany({
        where: { AND: [refundableApplication.where, { shopifyOrderId: { not: null }, orgMembership: { status: "DENIED" } }] },
        select: { id: true, shopifyOrderId: true, status: true },
    });
    if (procs.length === 0) return 0;
    const orders = await mirror.ordersByLegacyIds([...new Set(procs.map((p) => p.shopifyOrderId!))]);
    const byLegacy = new Map(orders.map((o) => [o.legacyId ?? "", o]));
    const disputes = await mirror.orderDisputeCounts(orders.map((o) => o.orderGid));
    let raised = 0;
    for (const proc of procs) {
        const o = byLegacy.get(proc.shopifyOrderId!);
        if (!o || classifyReversal(o, disputes.has(o.orderGid)) !== "REFUND") continue;
        const ref = { shopifyOrderId: proc.shopifyOrderId!, processId: proc.id, evidence: reversalEvidence(o, disputes.get(o.orderGid) ?? 0) };
        await recordReversal(proc.shopifyOrderId!, "REFUND");
        if (isFullyRefunded(o)) {
            // False when the Board recorded it first: nothing is left to raise.
            if (await recordDeniedStoreRefund(proc.id, proc.shopifyOrderId!)) await recordSettledPaymentException("REFUND", ref, DENIED_REFUND_NOTE);
        } else if (proc.status !== "PENDING_BG_CLEARANCE") {
            // A partial refund the main pass below does not read goes to the Board here.
            await raisePaymentException("REFUND", { ...ref, ...(proc.status === "PENDING_BG_REVIEW" ? { severity: "CRITICAL" as const } : {}) });
            raised++;
        }
    }
    return raised;
}

export async function reconcileReversals(): Promise<number> {
    const deniedRaised = await recordDeniedStoreRefunds();
    // App-side activated orders: money recorded (paidAt) with an order id. BLOCKED
    // stays out — a refund on a paid-while-blocked application is the expected fix.
    const procs = await prisma.orgMembershipProcess.findMany({
        where: { shopifyOrderId: { not: null }, paidAt: { not: null }, status: { in: ["ACTIVE", "PENDING_BG_CLEARANCE"] } },
        select: { id: true, shopifyOrderId: true, orgMembershipId: true, status: true },
    });
    // A withdrawn row keeps its order, so a late reversal is raised against it.
    const enrolls = await prisma.programParticipant.findMany({
        where: { shopifyOrderId: { not: null }, status: { not: "PENDING" } },
        select: { programId: true, personId: true, shopifyOrderId: true, status: true },
    });

    const orderIds = [
        ...procs.map((p) => p.shopifyOrderId!),
        ...enrolls.map((e) => e.shopifyOrderId!),
    ];
    if (orderIds.length === 0) return 0;

    const orders = await mirror.ordersByLegacyIds([...new Set(orderIds)]);
    const byLegacy = new Map(orders.map((o) => [o.legacyId ?? "", o]));
    const disputes = await mirror.orderDisputeCounts(orders.map((o) => o.orderGid));

    const settings = await prisma.boardSettings.findUnique({
        where: { id: 1 },
        select: { orgMembershipYearBoundary: true, volunteerFamilyDiscountCode: true },
    });
    const memberIds = procs.map((p) => p.orgMembershipId).filter((v): v is number => v != null);
    const members = memberIds.length
        ? await prisma.orgMembership.findMany({ where: { id: { in: memberIds } }, select: { id: true, isVolunteerFamily: true } })
        : [];
    const isVolunteerFamilyById = new Map(members.map((m) => [m.id, m.isVolunteerFamily]));
    const unreversedMembershipGids = procs
        .map((p) => byLegacy.get(p.shopifyOrderId!))
        .filter((o): o is MirrorOrder => !!o && !classifyReversal(o, disputes.has(o.orderGid)))
        .map((o) => o.orderGid);
    const membershipVariants = new Set((await membershipVariantYears(settings ?? null, new Date())).keys());
    const droppedMembership = await ordersDroppingMembershipLine([...new Set(unreversedMembershipGids)], membershipVariants);

    let raised = deniedRaised;
    for (const proc of procs) {
        const o = byLegacy.get(proc.shopifyOrderId!);
        if (!o) continue; // pre-cutover / not yet mirrored — can't judge.
        let kind = classifyReversal(o, disputes.has(o.orderGid));
        // Judged by item, never by total.
        if (!kind && droppedMembership.has(o.orderGid)) {
            logger.warn(`[reconcile] activated order ${proc.shopifyOrderId} no longer carries the membership item (process ${proc.id})`);
            kind = "AMOUNT_MISMATCH";
        }
        if (!kind && usesVolunteerCodeUnentitled(o, settings?.volunteerFamilyDiscountCode, isVolunteerFamilyById.get(proc.orgMembershipId ?? -1) ?? false)) {
            // Coupon entitlement, shared with the forward pass — and load-bearing here:
            // orders the webhook activated in real time never reach the forward pass
            // (already recorded on the process → early return), so this loop over
            // activated memberships is the daily audit that catches a volunteer code
            // a non-volunteer family redeemed. Order + volunteer flag already in hand.
            logger.warn(`[reconcile] volunteer discount code on non-volunteer activated order ${proc.shopifyOrderId} (process ${proc.id})`);
            kind = "DISCOUNT_UNAUTHORIZED";
        }
        if (kind) {
            const reversed = kind !== "AMOUNT_MISMATCH" && kind !== "DISCOUNT_UNAUTHORIZED";
            if (reversed) await recordReversal(proc.shopifyOrderId!, kind);
            const waiting = reversed && proc.status === "PENDING_BG_CLEARANCE";
            const evidence = reversed ? reversalEvidence(o, disputes.get(o.orderGid) ?? 0) : undefined;
            await raisePaymentException(kind, { shopifyOrderId: proc.shopifyOrderId, processId: proc.id, evidence, ...(waiting ? { severity: "CRITICAL" as const } : {}) });
            raised++;
        }
    }
    const unreversed = new Map<string, MirrorOrder>();
    for (const e of enrolls) {
        const o = byLegacy.get(e.shopifyOrderId!);
        if (!o) continue;
        // Money-out only. Member-code entitlement is NOT re-asked here: it was judged
        // when the money moved (webhook / forward pass), and this loop has no bound on
        // time — re-deriving it from live household state would raise a fresh flag on
        // every past member-priced order the morning after an ordinary deactivation.
        const kind = classifyReversal(o, disputes.has(o.orderGid));
        if (kind) {
            await raisePaymentException(kind, { shopifyOrderId: e.shopifyOrderId, programId: e.programId, personId: e.personId, evidence: reversalEvidence(o, disputes.get(o.orderGid) ?? 0) });
            raised++;
        } else {
            unreversed.set(e.shopifyOrderId!, o);
        }
    }
    raised += await raiseUnderSeatedOrders(enrolls.filter((e) => e.status === "ACTIVE" && unreversed.has(e.shopifyOrderId!)), unreversed);
    return raised;
}

/**
 * Orders whose membership line an edit removed or took to zero: the mirror shows a
 * membership variant on the order, but no line still carrying one. An order the
 * mirror never showed a membership line on carries no evidence and is not judged.
 */
async function ordersDroppingMembershipLine(orderGids: string[], membershipVariants: Set<string>): Promise<Set<string>> {
    if (orderGids.length === 0 || membershipVariants.size === 0) return new Set();
    const carrying = new Set(
        (await mirror.incomeOrderLines(orderGids))
            .filter((l) => l.variantId !== null && membershipVariants.has(l.variantId) && l.currentQuantity > 0)
            .map((l) => l.orderGid),
    );
    const dropped = new Set<string>();
    for (const gid of orderGids) {
        if (carrying.has(gid)) continue;
        if ((await mirror.orderLineVariantIds(gid)).some((v) => membershipVariants.has(v))) dropped.add(gid);
    }
    return dropped;
}

/**
 * An unreversed program order edited down to fewer seats than the people ACTIVE on
 * it: someone holds a seat the order no longer pays for. Raised once per order and
 * program as AMOUNT_MISMATCH, against its lowest-id holder; nobody is removed, as the
 * order cannot say which seat it dropped. An order with no mirrored line variant ids
 * carries no seat evidence and is not judged.
 */
async function raiseUnderSeatedOrders(
    enrolls: { programId: number; personId: number; shopifyOrderId: string | null }[],
    orders: Map<string, MirrorOrder>,
): Promise<number> {
    if (enrolls.length === 0) return 0;
    const lines = await mirror.incomeOrderLines([...orders.values()].map((o) => o.orderGid));
    const linesByGid = new Map<string, { variantId: string; currentQuantity: number }[]>();
    for (const l of lines) {
        if (!l.variantId) continue;
        linesByGid.set(l.orderGid, [...(linesByGid.get(l.orderGid) ?? []), { variantId: l.variantId, currentQuantity: l.currentQuantity }]);
    }
    const programs = await prisma.program.findMany({
        where: { id: { in: [...new Set(enrolls.map((e) => e.programId))] } },
        select: { id: true, shopifyVariantId: true, claimantShopifyVariantId: true },
    });
    const variantsByProgram = new Map(programs.map((p) => [p.id, new Set(programVariantIds(p))]));

    const holders = new Map<string, { orderId: string; programId: number; personIds: number[] }>();
    for (const e of enrolls) {
        const key = `${e.shopifyOrderId}:${e.programId}`;
        const group = holders.get(key) ?? { orderId: e.shopifyOrderId!, programId: e.programId, personIds: [] };
        group.personIds.push(e.personId);
        holders.set(key, group);
    }

    let raised = 0;
    for (const { orderId, programId, personIds } of holders.values()) {
        const orderLines = linesByGid.get(orders.get(orderId)!.orderGid);
        if (!orderLines) continue;
        const variants = variantsByProgram.get(programId) ?? new Set<string>();
        const seats = orderLines.filter((l) => variants.has(l.variantId)).reduce((n, l) => n + l.currentQuantity, 0);
        if (seats >= personIds.length) continue;
        logger.warn(`[reconcile] program order ${orderId} pays for ${seats} seat(s) of program ${programId} but ${personIds.length} people hold them — raised, nobody removed`);
        await raisePaymentException("AMOUNT_MISMATCH", { shopifyOrderId: orderId, programId, personId: Math.min(...personIds), evidence: `seats=${seats}` });
        raised++;
    }
    return raised;
}
