import type { MirrorOrder } from "@/lib/shopifyRead/client";

/**
 * Shopify displayFinancialStatus that means "money is in" and not reversed.
 * Exported: matchAudit.ts must apply the SAME predicate, or the audit and the
 * reconciler disagree about which orders count as paid.
 */
export function isPaid(o: Pick<MirrorOrder, "financialStatus" | "cancelledAt" | "totalRefundedCents">): boolean {
    return (o.financialStatus ?? "").toUpperCase() === "PAID" && !o.cancelledAt && o.totalRefundedCents === 0;
}

/** Any sign the money came back out. Exported so matchAudit.ts marks reversed activations
 *  with the SAME predicate the reversal pass raises exceptions on. */
export function isReversed(o: Pick<MirrorOrder, "financialStatus" | "cancelledAt" | "totalRefundedCents">): boolean {
    const s = (o.financialStatus ?? "").toUpperCase();
    return !!o.cancelledAt || o.totalRefundedCents > 0 || s === "REFUNDED" || s === "PARTIALLY_REFUNDED" || s === "VOIDED";
}

/**
 * Shopify reports the whole order refunded. Amounts cannot say so: the mirror's
 * total is after returns, so a partial return can refund more than it shows.
 */
export function isFullyRefunded(o: Pick<MirrorOrder, "financialStatus">): boolean {
    return (o.financialStatus ?? "").toUpperCase() === "REFUNDED";
}
