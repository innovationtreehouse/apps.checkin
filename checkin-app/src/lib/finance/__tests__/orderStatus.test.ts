/**
 * @jest-environment node
 */
import { isFullyRefunded } from "@/lib/finance/reconcile/orderStatus";
import type { MirrorOrder } from "@/lib/shopifyRead/client";

describe("isFullyRefunded", () => {
    it.each([
        ["REFUNDED", 5000, 5000, true],
        ["REFUNDED", 5000, 0, true],
        ["PARTIALLY_REFUNDED", 5000, 4999, false],
        ["PARTIALLY_REFUNDED", 5000, 100, false],
        // A $50 membership and a $20 item, the membership line returned for $25: the
        // mirror's total is after returns, so the refund exceeds it and is still partial.
        ["PARTIALLY_REFUNDED", 2000, 2500, false],
        ["PAID", 5000, 0, false],
    ] as const)("%s, total %i, refunded %i → %s", (financialStatus, totalCents, totalRefundedCents, expected) => {
        const row: Pick<MirrorOrder, "financialStatus" | "totalCents" | "totalRefundedCents"> = { financialStatus, totalCents, totalRefundedCents };
        expect(isFullyRefunded(row)).toBe(expected);
    });
});
