/**
 * @jest-environment node
 */
import { isFullyRefunded } from "@/lib/finance/reconcile/orderStatus";

describe("isFullyRefunded", () => {
    it.each([
        ["REFUNDED", 5000, 5000, true],
        ["REFUNDED", 5000, 0, true],
        ["PARTIALLY_REFUNDED", 5000, 5000, true],
        ["PARTIALLY_REFUNDED", 5000, 4999, false],
        ["PARTIALLY_REFUNDED", 5000, 100, false],
        ["PAID", 5000, 0, false],
        ["PAID", 0, 0, false],
    ] as const)("%s, total %i, refunded %i → %s", (financialStatus, totalCents, totalRefundedCents, expected) => {
        expect(isFullyRefunded({ financialStatus, totalCents, totalRefundedCents })).toBe(expected);
    });
});
