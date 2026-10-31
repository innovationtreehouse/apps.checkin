import prisma from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { config, DEV_MOCK_MEMBERSHIP_VARIANT_ID } from "@/lib/config";
import { activateByProcessId, type ActivateOutcome, type MembershipLine } from "@/lib/membership/payment";
import { raiseDeniedHouseholdActivity } from "@/lib/membership/householdStatus";
import * as mirror from "@/lib/shopifyRead/client";
import type { MirrorOrder } from "@/lib/shopifyRead/client";
import { raisePaymentException, recordReversal, type PaymentExceptionKind } from "./exceptions";
import { isPaid, isReversed } from "./orderStatus";

// An activated order may total a cent or two under the recorded membership fee (rounding,
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
 * Membership variant id → the year it sells: the ONE "is this line a membership?"
 * rule. Exported so matchAudit.ts consumes the same keys as the item gate; a variant
 * missed in a private copy would silently VANISH from the audit (filtered out in
 * SQL), not show as a gap. The BoardSettings variant and the dev-mock variant (when
 * the Shopify mock is active) sell the live year at `paidAt` unless a row claims them.
 */
export async function membershipVariantYears(
    settings: { orgMembershipVariantId: string | null; orgMembershipYearBoundary: Date | null } | null,
    paidAt: Date,
): Promise<Map<string, number | null>> {
    const rows = await prisma.membershipYearVariant.findMany({ select: { shopifyVariantId: true, membershipYear: true } });
    const years = new Map<string, number | null>(rows.map((r) => [r.shopifyVariantId, r.membershipYear]));
    const liveYear = liveMembershipYear(settings?.orgMembershipYearBoundary, paidAt);
    for (const variantId of [settings?.orgMembershipVariantId, config.shopifyMockActive() ? DEV_MOCK_MEMBERSHIP_VARIANT_ID : null]) {
        if (variantId && !years.has(variantId)) years.set(variantId, liveYear);
    }
    return years;
}

/** The order's membership line, or null when no line's variant sells a membership year. */
export function findMembershipLine(years: Map<string, number | null>, lineVariantIds: string[]): MembershipLine | null {
    const variantId = lineVariantIds.find((v) => years.has(v));
    return variantId === undefined ? null : { appliesToYear: years.get(variantId) ?? null };
}

/**
 * Volunteer-coupon entitlement check. Shopify owns the discount ARITHMETIC
 * (membership orders are never amount-gated); checkin owns the POLICY that
 * only volunteer households may use the volunteer-rate code. The variant gate
 * doesn't flag couponed orders by amount, so without this check a non-volunteer
 * family redeeming the volunteer code would activate cleanly with no flag.
 *
 * True iff the order's mirrored coupon list carries the board-configured volunteer
 * code (BoardSettings.volunteerFamilyDiscountCode — the same code the checkout link
 * appends for volunteer households) while the membership is NOT volunteer. Compared
 * case-insensitively (Shopify codes are). An EMPTY discountCodes list is never
 * evidence of anything — rows synced before code mirroring hold none — so only a
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
 * set — mirrored on the order, and the exact same key the orders/paid webhook
 * credits. Exact, so no ambiguity.
 *
 * Fallback: customer email → household lead → the family's single PENDING_PAYMENT
 * process. Only reached for orders synced before attribute mirroring (note_attributes is
 * null on those). Fuzzier, so it refuses to guess: zero or several pending
 * processes resolve to "none"/"ambiguous" rather than picking one.
 *
 * Either way the caller checks the order contains a membership variant before
 * activating. Only PENDING_PAYMENT and BLOCKED
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
    // membershipVariantYears the webhook builds — mirrored onto order lines. A variant
    // id is stable and can't drift; the order total never decides (docs/rules/revenue.md).
    const settings = await prisma.boardSettings.findUnique({
        where: { id: 1 },
        select: { orgMembershipVariantId: true, orgMembershipYearBoundary: true, volunteerFamilyDiscountCode: true },
    });
    const variantYears = await membershipVariantYears(settings ?? null, order.processedAt ?? new Date());
    const line = findMembershipLine(variantYears, await mirror.orderLineVariantIds(order.orderGid));
    if (!line) {
        // Attributed to a pending process, paid, but no membership product on it (including an
        // order of only custom or deleted products) — the webhook's NO_ITEM case.
        await raisePaymentException("NO_ITEM", { shopifyOrderId: order.legacyId, processId: proc.id });
        return true;
    }

    // Coupon entitlement: the item gate proves the order carries the membership product,
    // but not that the family was ALLOWED the code that priced it. Volunteer code on a
    // non-volunteer membership → tell the board, do NOT activate (parity with NO_ITEM).
    const membership = proc.orgMembershipId
        ? await prisma.orgMembership.findUnique({ where: { id: proc.orgMembershipId }, select: { isVolunteerFamily: true } })
        : null;
    if (usesVolunteerCodeUnentitled(order, settings?.volunteerFamilyDiscountCode, membership?.isVolunteerFamily ?? false)) {
        logger.warn(`[reconcile] volunteer discount code on non-volunteer order ${order.legacyId} (process ${proc.id})`);
        await raisePaymentException("DISCOUNT_UNAUTHORIZED", { shopifyOrderId: order.legacyId, processId: proc.id });
        return true;
    }

    // Recover: advance past the paid checkpoint, with the line found above — the order
    // contains a known membership variant and is matched to this specific pending
    // process (honest missed-webhook assumption; the reconciler is not the attack surface the public webhook is, and
    // it leaves a full AuditLog trail via activate()).
    const { outcome } = await activateByProcessId(proc.id, order.legacyId ?? "", line);
    logger.info(`[reconcile] recovered missed payment: process ${proc.id} ← order ${order.legacyId} (${outcome})`);
    await raiseMembershipPaymentOutcome(outcome, { shopifyOrderId: order.legacyId, processId: proc.id });
    return true;
}
