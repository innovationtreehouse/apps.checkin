import prisma from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { unentitledMemberCodeUse } from "@/lib/programs/memberDiscountCode";
import { fromWhere } from "@/lib/programs/enrollmentState";
import { programVariantIds } from "@/lib/programs/variants";
import { verifyCheckout } from "@/lib/programs/checkoutSignature";
import * as mirror from "@/lib/shopifyRead/client";
import type { MirrorOrder } from "@/lib/shopifyRead/client";
import { raisePaymentException, type PaymentExceptionKind } from "./exceptions";
import { isPaid, isReversed } from "./orderStatus";

/** The order facts a program entitlement is judged on — built from the webhook
 *  payload or the mirror, so both paths judge the same thing. */
export interface EntitlementOrder extends Pick<MirrorOrder, "financialStatus" | "cancelledAt" | "totalRefundedCents" | "legacyId"> {
    /** `quantity` is the original count; `currentQuantity` excludes units an edit or refund took off. */
    lines: { variantId: string; quantity: number; currentQuantity: number }[];
    /** The order's CheckMeIn_Checkout_Sig cart attribute (lib/programs/checkoutSignature). */
    checkoutSig: string | null;
}

/** A paid seat no pending enrollment consumes, raised for the board alongside (or instead of) activation. */
export interface Surplus {
    kind: "DUPLICATE_PAYMENT" | "UNCLAIMED_SEATS";
    personId?: number;
}

/**
 * ok, or the exception to raise; `kind: null` = nothing to do yet, raise nothing.
 * `spent`: every seat the order carries already paid for an earlier enrollment, so it is a replay.
 */
export type Entitlement =
    | { ok: true; surplus?: Surplus }
    | { ok: false; kind: PaymentExceptionKind | null; personId?: number; nothingAwaiting?: true; spent?: true };

/**
 * Does this order pay for activating these people in this program? Paid and not
 * reversed, names people from one household only (else MIXED_HOUSEHOLDS), carries
 * one of the program's variants (public or claimant), has a checkout signature that
 * household's own checkout made for exactly these people (else UNMATCHED_ORDER),
 * and has at least one unspent seat per person still awaiting payment. A seat the order already activated
 * someone with is spent, whether that person is still enrolled or has since left.
 * An order with every seat spent is a replay: it activates nobody and raises
 * nothing. A shortfall of unspent seats activates nobody: the order cannot say
 * which of the household it was meant for, so the board decides.
 *
 * Unspent seats beyond those awaiting payment are a surplus for the board:
 * DUPLICATE_PAYMENT when a person named is already enrolled (paid, comped or
 * approved), else UNCLAIMED_SEATS (withdrawn, expired, or extra quantity).
 * Matched per person, so siblings paying on separate orders never trip it.
 * Inventory is never adjusted.
 */
export async function orderEntitlesEnrollment(order: EntitlementOrder, programId: number, personIds: number[]): Promise<Entitlement> {
    const awaiting = await prisma.programParticipant.count({ where: { programId, personId: { in: personIds }, ...fromWhere("PENDING_UNPAID") } });
    if (awaiting === 0 && !isPaid(order)) return { ok: false, kind: null, nothingAwaiting: true };
    if (isReversed(order)) return { ok: false, kind: "REVERSED_BEFORE_ACTIVATION" };
    if (!isPaid(order)) return { ok: false, kind: null };
    const households = await householdsOf(personIds);
    if (households.length > 1) return { ok: false, kind: "MIXED_HOUSEHOLDS" };

    const program = await prisma.program.findUnique({ where: { id: programId }, select: { shopifyVariantId: true, claimantShopifyVariantId: true } });
    const variantIds = new Set(program ? programVariantIds(program) : []);
    const seats = order.lines.filter((l) => variantIds.has(l.variantId)).reduce((n, l) => n + l.currentQuantity, 0);
    const unspent = Math.max(0, seats - await seatsSpentBy(order, programId));
    if (awaiting === 0) {
        const surplus = await surplusSeats(order, programId, personIds, unspent);
        return { ok: false, kind: surplus?.kind ?? null, personId: surplus?.personId, nothingAwaiting: true };
    }
    if (seats === 0) return { ok: false, kind: "NO_ITEM" };
    if (unspent === 0) return { ok: false, kind: null, spent: true };
    if (households.length === 0 || !verifyCheckout(programId, personIds, households[0], order.checkoutSig)) {
        return { ok: false, kind: "UNMATCHED_ORDER" };
    }
    if (unspent < awaiting) return { ok: false, kind: "AMOUNT_MISMATCH" };
    return { ok: true, surplus: await surplusSeats(order, programId, personIds, unspent - awaiting) };
}

/** The households the people an order names live in; one order pays for one household. */
async function householdsOf(personIds: number[]): Promise<number[]> {
    const rows = await prisma.person.findMany({
        where: { id: { in: personIds } },
        select: { householdId: true },
        distinct: ["householdId"],
    });
    return rows.map((r) => r.householdId);
}

/** `unspent` is already net of the seats the order spent; what is left beyond those awaiting is surplus. */
async function surplusSeats(order: EntitlementOrder, programId: number, personIds: number[], unspent: number): Promise<Surplus | undefined> {
    if (unspent <= 0) return undefined;
    const active = await prisma.programParticipant.findMany({
        where: { programId, personId: { in: personIds }, status: "ACTIVE" },
        select: { personId: true, shopifyOrderId: true },
    });
    const otherwisePaid = active.filter((r) => !order.legacyId || r.shopifyOrderId !== order.legacyId);
    return otherwisePaid.length > 0 ? { kind: "DUPLICATE_PAYMENT", personId: otherwisePaid[0].personId } : { kind: "UNCLAIMED_SEATS" };
}

/**
 * Distinct people this order activated in this program: those still active on it
 * and those who have since left (removed or withdrawn). Each spent one of its seats.
 * Scoped by order, not by the people a caller names, because the seats belong to the order.
 */
async function seatsSpentBy(order: EntitlementOrder, programId: number): Promise<number> {
    if (!order.legacyId) return 0;
    // A withdrawn row still carries the order until a re-enrolment clears it; the audit keeps it after.
    const holders = await prisma.programParticipant.findMany({
        where: { programId, shopifyOrderId: order.legacyId, OR: [fromWhere("ACTIVE"), fromWhere("WITHDRAWN")] },
        select: { personId: true },
    });
    const left = await prisma.auditLog.findMany({
        where: {
            tableName: "ProgramParticipant",
            secondaryAffectedEntity: programId,
            OR: [
                { action: "DELETE", oldData: { path: ["shopifyOrderId"], equals: order.legacyId } },
                {
                    action: "EDIT",
                    AND: [
                        { newData: { path: ["status"], equals: "WITHDRAWN" } },
                        { newData: { path: ["shopifyOrderId"], equals: order.legacyId } },
                    ],
                },
            ],
        },
        select: { affectedEntityId: true },
    });
    return new Set([...holders.map((h) => h.personId), ...left.map((d) => d.affectedEntityId)]).size;
}

/**
 * Program forward recovery: a paid order whose enrollments are still PENDING is a
 * missed webhook. Judged by orderEntitlesEnrollment, the same check the webhook
 * makes. Returns true if claimed.
 */
export async function reconcileForwardProgram(order: MirrorOrder): Promise<boolean> {
    if (order.legacyId) {
        const known = await prisma.programParticipant.findFirst({ where: { shopifyOrderId: order.legacyId }, select: { programId: true } });
        if (known) return true;
    }

    // Preferred: the cart attributes the enroll flow's checkout link set — the same
    // keys the orders/paid webhook credits. CheckMeIn_Account_ID is a comma-separated
    // person list, matching the webhook's own parse.
    const programRaw = mirror.orderAttr(order, "Program_ID");
    const accountRaw = mirror.orderAttr(order, "CheckMeIn_Account_ID");
    if (programRaw && accountRaw) {
        const programId = parseInt(programRaw, 10);
        const ids = accountRaw.split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n));
        if (isNaN(programId) || ids.length === 0) {
            if (isPaid(order)) await raisePaymentException("UNMATCHED_ORDER", { shopifyOrderId: order.legacyId });
            return true;
        }
        return activateProgramFromOrder(order, programId, ids);
    }

    // Fallback for orders without attributes: the purchaser (household lead) and
    // everyone in their household. Claims the order only when it carries a pending
    // program's variant (public or claimant) — anything else (merch, a donation)
    // passes untouched. Such an order carries no checkout signature, so the shared
    // check raises it for the board instead of activating.
    if (!isPaid(order)) return false;
    const email = order.customerEmail?.toLowerCase().trim();
    if (!email) return false;
    const leads = await prisma.person.findMany({ where: { email, isHouseholdLead: true }, select: { householdId: true } });
    const householdIds = [...new Set(leads.map((l) => l.householdId))];
    if (householdIds.length === 0) return false;

    const pending = await prisma.programParticipant.findMany({
        where: { person: { householdId: { in: householdIds } }, status: "PENDING" },
        select: { programId: true, personId: true, program: { select: { shopifyVariantId: true, claimantShopifyVariantId: true } } },
    });
    if (pending.length === 0) return false;

    const orderVariants = new Set((await mirror.orderLines(order.orderGid)).map((l) => l.variantId));
    const matched = pending.filter((p) => programVariantIds(p.program).some((v) => orderVariants.has(v)));
    const programs = [...new Set(matched.map((p) => p.programId))];
    if (programs.length === 0) return false;
    if (programs.length > 1) {
        await raisePaymentException("UNMATCHED_ORDER", { shopifyOrderId: order.legacyId });
        return true;
    }

    return activateProgramFromOrder(order, programs[0], matched.map((p) => p.personId));
}

/** Shared tail for both program-matching paths: judge, then activate through the one choke point. */
async function activateProgramFromOrder(order: MirrorOrder, programId: number, personIds: number[]): Promise<boolean> {
    const lines = await mirror.orderLines(order.orderGid);
    const checkoutSig = mirror.orderAttr(order, "CheckMeIn_Checkout_Sig");
    const entitlement = await orderEntitlesEnrollment({ ...order, lines, checkoutSig }, programId, personIds);
    const { activateProgramEnrollment, refuseReversedActivation } = await import("@/lib/programs/activateEnrollment");
    if (!entitlement.ok && entitlement.kind === "REVERSED_BEFORE_ACTIVATION" && order.legacyId) {
        await refuseReversedActivation(programId, personIds, order.legacyId);
        return true;
    }
    if (!entitlement.ok) {
        if (entitlement.spent) {
            logger.info(`[reconcile] program order ${order.legacyId} (program ${programId}): order already spent on earlier enrollments — not activated`);
        } else if (entitlement.kind) {
            logger.warn(`[reconcile] program order ${order.legacyId} not entitled (${entitlement.kind}, program ${programId}) — NOT activated`);
            await raisePaymentException(entitlement.kind, { shopifyOrderId: order.legacyId, programId, personId: entitlement.personId ?? personIds[0] ?? null });
        }
        return true;
    }
    if (entitlement.surplus) {
        await raisePaymentException(entitlement.surplus.kind, { shopifyOrderId: order.legacyId, programId, personId: entitlement.surplus.personId ?? personIds[0] ?? null });
    }

    // Coupon entitlement, parity with the membership forward pass: the order
    // may well contain the program's product, but the member code on it is only honest
    // on the household it was minted for, settled through the program's coverage date.
    // This IS the money event for a missed webhook — same judgement the webhook makes,
    // asked once. None entitled → tell the board, do NOT activate.
    if (await unentitledMemberCodeUse(programId, personIds, order.discountCodes, order.legacyId ?? null)) {
        logger.warn(`[reconcile] program member discount code on non-member order ${order.legacyId} (program ${programId})`);
        await raisePaymentException("DISCOUNT_UNAUTHORIZED", { shopifyOrderId: order.legacyId, programId, personId: personIds[0] ?? null });
        return true;
    }

    const res = await activateProgramEnrollment({ programId, personIds, shopifyOrderId: order.legacyId ?? "", lines });
    if (res.reversed) logger.warn(`[reconcile] program order ${order.legacyId} was reversed (program ${programId}) — NOT activated, raised to the board`);
    else logger.info(`[reconcile] recovered program payment: program ${programId} ← order ${order.legacyId} (${res.activatedCount} activated)`);
    return true;
}
