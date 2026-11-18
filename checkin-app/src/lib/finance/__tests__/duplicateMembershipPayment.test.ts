import { DUPLICATE_MEMBERSHIP_WORDING, settledByFrom } from "@/lib/finance/reconcile/membership";

const paidAt = new Date("2026-11-01T00:00:00Z");

describe("settledByFrom: how a membership year was already settled", () => {
    it("is the store when the application records a store order", () => {
        expect(settledByFrom({ paidAt, shopifyOrderId: "1001", manualPaymentById: null }, false)).toBe("store");
    });

    it("is a certified plan when the Board recorded the payment without a granted year", () => {
        expect(settledByFrom({ paidAt, shopifyOrderId: null, manualPaymentById: 7 }, false)).toBe("certified");
    });

    it("is a grant when the Board's settlement recorded the year it granted", () => {
        expect(settledByFrom({ paidAt, shopifyOrderId: null, manualPaymentById: 7 }, true)).toBe("granted");
    });

    it("is nothing when the application was never paid", () => {
        expect(settledByFrom({ paidAt: null, shopifyOrderId: null, manualPaymentById: null }, false)).toBeNull();
        expect(settledByFrom({ paidAt: null, shopifyOrderId: "1001", manualPaymentById: 7 }, true)).toBeNull();
    });

    it("is nothing when a paid application names neither an order nor a Board member", () => {
        expect(settledByFrom({ paidAt, shopifyOrderId: null, manualPaymentById: null }, false)).toBeNull();
    });
});

describe("DUPLICATE_MEMBERSHIP_WORDING", () => {
    it("names how the year was settled and that a refund may be needed", () => {
        expect(DUPLICATE_MEMBERSHIP_WORDING).toEqual({
            store: "the household paid twice in the store for the same year: a refund may be needed",
            certified: "the household paid after the Board certified a plan: a refund may be needed",
            granted: "the household paid after the Board granted the year: a refund may be needed",
        });
    });
});
