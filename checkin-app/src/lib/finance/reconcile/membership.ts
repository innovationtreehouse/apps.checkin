import prisma from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { config, DEV_MOCK_MEMBERSHIP_VARIANT_ID } from "@/lib/config";
import { activateByProcessId, type ActivateOutcome } from "@/lib/membership/payment";
import { raiseDeniedHouseholdActivity } from "@/lib/membership/householdStatus";
import * as mirror from "@/lib/shopifyRead/client";
import type { MirrorOrder } from "@/lib/shopifyRead/client";
import { raisePaymentException, recordReversal, type PaymentExceptionKind } from "./exceptions";
import { isPaid, isReversed } from "./orderStatus";

// A recovered payment may come in a cent or two under the recorded membership fee (rounding,
// a stale settings copy). Only a shortfall beyond this is a real mismatch.
export const AMOUNT_TOLERANCE_CENTS = 100;

/**
 * Raise what a membership payment's outcome needs the board to see. Shared by the
 * orders/paid webhook and the forward pass so a missed webhook raises the same row.
 * A DENIED household is raised inside activate() itself.
 */
export async function raiseMembershipPaymentOutcome(
    outcome: ActivateOutcome,
    ref: { shopifyOrderId: string | null; processId: number },
): Promise<void> {
    const kind: PaymentExceptionKind | null =
        outcome === "paid_while_blocked" ? "PAID_WHILE_BLOCKED"
        : outcome === "no_item" ? "NO_ITEM"
        // Duplicate order, both leads paying, payment after close or certify.
        : outcome === "nothing_due" ? "UNMATCHED_ORDER"
        : outcome === "refunded" ? "REVERSED_BEFORE_ACTIVATION"
        : null;
    if (kind) await raisePaymentException(kind, { ...ref, ...(outcome === "refunded" ? { severity: "CRITICAL" as const } : {}) });
}

/**
 * The membership variant-id set (BoardSettings variants + the dev-mock variant
 * when the Shopify mock is active) — the ONE "is this line a membership?" rule.
 * Exported so matchAudit.ts consumes the same set as the #1074 item gate; a
 * variant added here but missed in a private copy would silently VANISH from
 * the audit (filtered out in SQL), not show as a gap.
 */
export function membershipVariantIdSet(settings: {
    orgMembershipVariantId: string | null;
} | null): Set<string> {
    return new Set(
        [
            settings?.orgMembershipVariantId,
            config.shopifyMockActive() ? DEV_MOCK_MEMBERSHIP_VARIANT_ID : null,
        ].filter((v): v is string => !!v),
    );
}

/**
 * Volunteer-coupon entitlement check. Shopify owns the discount ARITHMETIC
 * (variant-backed orders are never amount-gated); checkin owns the POLICY that
 * only volunteer households may use the volunteer-rate code — the #1074 variant
 * gate correctly stopped flagging couponed orders by amount, which also meant a
 * non-volunteer family redeeming the volunteer code activated cleanly with no flag.
 *
 * True iff the order's mirrored coupon list carries the board-configured volunteer
 * code (BoardSettings.volunteerFamilyDiscountCode — the same code the checkout link
 * appends for volunteer households) while the membership is NOT volunteer. Compared
 * case-insensitively (Shopify codes are). An EMPTY discountCodes list is never
 * evidence of anything — rows synced before #1048 mirror no codes — so only a
 * non-empty list can flag. Other codes (promos) are Shopify's business, not ours.
 */
export function usesVolunteerCodeUnentitled(order: MirrorOrder, volunteerCode: string | null | undefined, isVolunteerFamily: boolean): boolean {
    if (isVolunteerFamily || !volunteerCode) return false;
    const vc = volunteerCode.trim().toUpperCase();
    if (!vc) return false;
    return order.discountCodes.some((c) => c.trim().toUpperCase() === vc);
}

type ResolvedProcess = { id: number; orgMembershipId: number | null; awaiting: boolean } | "none" | "ambiguous";

/**
 * Which membership process (if any) is this order paying for?
 *
 * Preferred: the `Membership_Process_ID` cart attribute the checkout link itself
 * set — mirrored since #1029, and the exact same key the orders/paid webhook
 * credits. Exact, so no ambiguity.
 *
 * Fallback: customer email → household lead → the family's single PENDING_PAYMENT
 * process. Only reached for orders synced before #1029 shipped (note_attributes is
 * null on those). Fuzzier, so it refuses to guess: zero or several pending
 * processes resolve to "none"/"ambiguous" rather than picking one.
 *
 * Either way the caller checks the order contains a membership variant before
 * activating (amount-gating only pre-#1048 orders). Only PENDING_PAYMENT and BLOCKED
 * processes are `awaiting`; a paid order on any other process is raised, not recovered.
 */
async function resolveMembershipProcess(order: MirrorOrder): Promise<ResolvedProcess> {
    const raw = mirror.orderAttr(order, "Membership_Process_ID");
    if (raw) {
        const id = parseInt(raw, 10);
        if (isNaN(id)) return "ambiguous"; // tagged as a membership order, but unusably
        const p = await prisma.orgMembershipProcess.findUnique({
            where: { id },
            select: { id: true, status: true, orgMembershipId: true },
        });
        // Attribute names a process that doesn't exist — forged/replayed/stale. Never guess.
        if (!p) return "ambiguous";
        // BLOCKED still takes the payment (recorded, refund needed). Any other status
        // means the money landed on nothing awaiting it.
        return { id: p.id, orgMembershipId: p.orgMembershipId, awaiting: p.status === "PENDING_PAYMENT" || p.status === "BLOCKED" };
    }

    const email = order.customerEmail?.toLowerCase().trim();
    if (!email) return "none";
    const leads = await prisma.person.findMany({ where: { email, isHouseholdLead: true }, select: { householdId: true } });
    const householdIds = [...new Set(leads.map((l) => l.householdId))];
    if (householdIds.length === 0) return "none";

    const pending = await prisma.orgMembershipProcess.findMany({
        where: { orgMembership: { householdId: { in: householdIds } }, status: "PENDING_PAYMENT" },
        select: { id: true, orgMembershipId: true },
    });
    if (pending.length === 0) return "none"; // family has no membership awaiting payment.
    if (pending.length > 1) return "ambiguous"; // can't safely pick which one this paid for.
    return { ...pending[0], awaiting: true };
}

/** The Board recorded a refund of this order on this process (refund.ts writes the audit row). */
async function refundRecordedOn(processId: number, orderLegacyId: string): Promise<boolean> {
    const row = await prisma.auditLog.findFirst({
        where: {
            tableName: "OrgMembershipProcess",
            affectedEntityId: processId,
            oldData: { path: ["shopifyOrderId"], equals: orderLegacyId },
            newData: { path: ["refundRecorded"], equals: true },
        },
        select: { id: true },
    });
    return !!row;
}

/**
 * Try to attribute one mirror order to a membership process and act on it. Returns
 * true if the order was claimed (recovered or raised), false if it is not a
 * membership order (so a program pass may still claim it).
 */
export async function reconcileForwardMembership(order: MirrorOrder): Promise<boolean> {
    // Already recorded on a process? Then it is not a missed payment.
    if (order.legacyId) {
        const known = await prisma.orgMembershipProcess.findFirst({ where: { shopifyOrderId: order.legacyId }, select: { id: true } });
        if (known) return true;
    }

    const proc = await resolveMembershipProcess(order);
    if (proc === "none") return false; // not a membership order — a program pass may claim it.
    if (proc === "ambiguous") {
        await raisePaymentException("UNMATCHED_ORDER", { shopifyOrderId: order.legacyId });
        return true;
    }
    // Refunded off this process? A re-payment overwrites its shopifyOrderId, so the refund's audit row is the record.
    if (order.legacyId && (await refundRecordedOn(proc.id, order.legacyId))) return true;

    if (!proc.awaiting) {
        if (!isPaid(order)) return true;
        // Parity with settle(): money reaching a DENIED household goes to the Board as DENIED activity.
        const membership = proc.orgMembershipId
            ? await prisma.orgMembership.findUnique({ where: { id: proc.orgMembershipId }, select: { status: true, householdId: true } })
            : null;
        if (membership?.status === "DENIED") {
            await raiseDeniedHouseholdActivity({
                householdId: membership.householdId,
                processId: proc.id,
                what: `Shopify membership payment (order ${order.legacyId || "?"}) on application #${proc.id}, found by the nightly reconcile`,
            });
        } else {
            await raiseMembershipPaymentOutcome("nothing_due", { shopifyOrderId: order.legacyId, processId: proc.id });
        }
        return true;
    }

    // Paid then reversed before we ever activated — keep it PENDING, tell the board.
    if (isReversed(order)) {
        if (order.legacyId) await recordReversal(order.legacyId, "REVERSED_BEFORE_ACTIVATION");
        await raisePaymentException("REVERSED_BEFORE_ACTIVATION", { shopifyOrderId: order.legacyId, processId: proc.id, severity: "CRITICAL" });
        return true;
    }
    if (!isPaid(order)) return true; // pending/authorized/etc — nothing to do yet, but it IS this family's order.

    // Membership-item gate, parity with the orders/paid webhook: recover only if the
    // order actually CONTAINS a membership product (its variant id), the same
    // membershipVariantIdSet the webhook builds — mirrored
    // onto order lines since #1048. A variant id is stable and can't drift; the old
    // total-price gate false-raised AMOUNT_MISMATCH on every couponed order (volunteer
    // rate, promo), whose sub-fee total is indistinguishable from an underpayment by
    // amount alone. See the H2 note in payment.ts and the webhook route.
    const settings = await prisma.boardSettings.findUnique({
        where: { id: 1 },
        select: {
            orgMembershipVariantId: true,
            standardMembershipFeeCents: true,
            volunteerMembershipFeeCents: true,
            volunteerFamilyDiscountCode: true,
        },
    });
    const membershipVariantIds = membershipVariantIdSet(settings ?? null);
    const lineVariantIds = await mirror.orderLineVariantIds(order.orderGid);
    // Both branches below need the membership's volunteer flag: the amount-gate
    // fallback for the expected membership fee, the coupon entitlement check for volunteerOnly.
    const membership = proc.orgMembershipId
        ? await prisma.orgMembership.findUnique({ where: { id: proc.orgMembershipId }, select: { isVolunteerFamily: true } })
        : null;

    if (lineVariantIds.length > 0) {
        // Variant ids are mirrored, so the item check is authoritative.
        if (!lineVariantIds.some((v) => membershipVariantIds.has(v))) {
            // Attributed to a pending process, paid, but no membership product on it —
            // the webhook's NO_ITEM case (activate() fails closed there).
            await raisePaymentException("NO_ITEM", { shopifyOrderId: order.legacyId, processId: proc.id });
            return true;
        }
    } else {
        // No mirrored variant ids (a row synced before variant mirroring, or only custom or
        // deleted products), so the item check can't run: compare the gross total to the fee.
        const expected = membership?.isVolunteerFamily ? settings?.volunteerMembershipFeeCents ?? 0 : settings?.standardMembershipFeeCents ?? 0;
        if (expected > 0 && order.totalCents + order.discountCents + AMOUNT_TOLERANCE_CENTS < expected) {
            await raisePaymentException("AMOUNT_MISMATCH", { shopifyOrderId: order.legacyId, processId: proc.id });
            return true;
        }
    }

    // Coupon entitlement: the item gates above prove the order carries the membership
    // product, but not that the family was ALLOWED the code that priced it. Volunteer
    // code on a non-volunteer membership → tell the board, do NOT activate (parity
    // with the NO_ITEM branch). Sits after both gates so a backfilled pre-#1048 row
    // with codes is covered too; pre-backfill rows mirror [] and pass through unjudged.
    if (usesVolunteerCodeUnentitled(order, settings?.volunteerFamilyDiscountCode, membership?.isVolunteerFamily ?? false)) {
        logger.warn(`[reconcile] volunteer discount code on non-volunteer order ${order.legacyId} (process ${proc.id})`);
        await raisePaymentException("DISCOUNT_UNAUTHORIZED", { shopifyOrderId: order.legacyId, processId: proc.id });
        return true;
    }

    // Recover: advance past the paid checkpoint. hasMembershipItem=true — the order
    // contains a known membership variant (or, for a pre-backfill order, covers the membership fee)
    // and is matched to this specific pending process (honest missed-webhook
    // assumption; the reconciler is not the attack surface the public webhook is, and
    // it leaves a full AuditLog trail via activate()).
    const { outcome } = await activateByProcessId(proc.id, order.legacyId ?? "", true);
    logger.info(`[reconcile] recovered missed payment: process ${proc.id} ← order ${order.legacyId} (${outcome})`);
    await raiseMembershipPaymentOutcome(outcome, { shopifyOrderId: order.legacyId, processId: proc.id });
    return true;
}
