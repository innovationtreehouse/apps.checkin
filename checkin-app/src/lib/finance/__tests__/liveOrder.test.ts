import { recordUnreportedReversal } from "@/lib/finance/reconcile/liveOrder";
import { recordReversal } from "@/lib/finance/reconcile/exceptions";
import { getAccessToken, shopifyFetch } from "@/lib/shopify/client";

jest.mock("@/lib/finance/reconcile/exceptions", () => ({ recordReversal: jest.fn() }));
jest.mock("@/lib/shopify/client", () => ({
    SHOPIFY_API_VERSION: "2026-01",
    getAccessToken: jest.fn(),
    shopifyFetch: jest.fn(),
}));

const order = (over: Record<string, unknown> = {}) => ({
    displayFinancialStatus: "PAID",
    cancelledAt: null,
    totalRefundedSet: { shopMoney: { amount: "0.00" } },
    ...over,
});
const answer = (body: unknown, ok = true) =>
    (shopifyFetch as jest.Mock).mockResolvedValue({ ok, status: ok ? 200 : 502, json: async () => body });

describe("recordUnreportedReversal", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        process.env.SHOPIFY_STORE_DOMAIN = "store.example.com";
        process.env.SHOPIFY_CLIENT_ID = "id";
        process.env.SHOPIFY_CLIENT_SECRET = "secret";
        (getAccessToken as jest.Mock).mockResolvedValue("token");
    });
    afterAll(() => {
        delete process.env.SHOPIFY_STORE_DOMAIN;
        delete process.env.SHOPIFY_CLIENT_ID;
        delete process.env.SHOPIFY_CLIENT_SECRET;
    });

    it("asks for the order by its Shopify id", async () => {
        answer({ data: { order: order() } });
        await recordUnreportedReversal("123");
        const body = JSON.parse((shopifyFetch as jest.Mock).mock.calls[0][1].body);
        expect(body.variables).toEqual({ id: "gid://shopify/Order/123" });
    });

    it("records nothing on an order that still stands", async () => {
        answer({ data: { order: order() } });
        await recordUnreportedReversal("123");
        expect(recordReversal).not.toHaveBeenCalled();
    });

    it.each([
        ["a full refund", { displayFinancialStatus: "REFUNDED", totalRefundedSet: { shopMoney: { amount: "50.00" } } }, "REFUND"],
        ["a partial refund", { displayFinancialStatus: "PARTIALLY_REFUNDED", totalRefundedSet: { shopMoney: { amount: "1.00" } } }, "REFUND"],
        ["a void", { displayFinancialStatus: "VOIDED" }, "REFUND"],
        ["a cancellation", { cancelledAt: "2026-10-31T00:00:00Z" }, "CANCELLED"],
    ])("records %s", async (_label, over, kind) => {
        answer({ data: { order: order(over) } });
        await recordUnreportedReversal("123");
        expect(recordReversal).toHaveBeenCalledWith("123", kind);
    });

    it.each([
        ["an HTTP failure", () => answer({}, false)],
        ["a GraphQL error", () => answer({ errors: [{ message: "denied" }] })],
        ["no token", () => (getAccessToken as jest.Mock).mockResolvedValue(null)],
    ])("throws on %s", async (_label, arrange) => {
        arrange();
        await expect(recordUnreportedReversal("123")).rejects.toThrow();
    });

    it("judges on the ledger alone when Shopify returns no order, or the store is not configured", async () => {
        answer({ data: { order: null } });
        await expect(recordUnreportedReversal("123")).resolves.toBeUndefined();
        delete process.env.SHOPIFY_STORE_DOMAIN;
        await expect(recordUnreportedReversal("123")).resolves.toBeUndefined();
        expect(recordReversal).not.toHaveBeenCalled();
    });
});
