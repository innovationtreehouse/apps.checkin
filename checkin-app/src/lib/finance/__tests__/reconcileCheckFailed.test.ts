/**
 * @jest-environment node
 */
/**
 * An order whose forward pass throws becomes a CHECK_FAILED exception and the cursor
 * moves past it, until 3 within 7 days (resolved ones included) stop the check with
 * one CHECK_STOPPED exception.
 */
const updateMany = jest.fn();
const findUnique = jest.fn();
const ordersChangedSince = jest.fn();
const reconcileReversals = jest.fn();
const reconcileForwardMembership = jest.fn();
const raisePaymentException = jest.fn();

interface StoredException {
    kind: string;
    status: "OPEN" | "RESOLVED";
    detectedAt: Date;
}
let stored: StoredException[] = [];

interface CountArgs {
    where: { kind: string; detectedAt: { gte: Date }; status?: { not: string } };
}

jest.mock("@/lib/prisma", () => {
    const boardSettings = {
        updateMany: (...a: unknown[]) => updateMany(...a),
        findUnique: (...a: unknown[]) => findUnique(...a),
    };
    const paymentException = {
        count: async ({ where }: CountArgs) =>
            stored.filter((r) => r.kind === where.kind && r.detectedAt >= where.detectedAt.gte && r.status !== where.status?.not).length,
    };
    return {
        __esModule: true,
        default: { boardSettings, paymentException, $transaction: (fn: (tx: unknown) => Promise<unknown>) => fn({ boardSettings }) },
    };
});
jest.mock("@/lib/logger", () => ({ logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }));
jest.mock("@/lib/shopifyRead/client", () => ({
    isConfigured: () => true,
    ordersChangedSince: (...a: unknown[]) => ordersChangedSince(...a),
}));
jest.mock("../reconcile/exceptions", () => ({ raisePaymentException: (...a: unknown[]) => raisePaymentException(...a) }));
jest.mock("../reconcile/membership", () => ({ reconcileForwardMembership: (...a: unknown[]) => reconcileForwardMembership(...a) }));
jest.mock("../reconcile/program", () => ({ reconcileForwardProgram: jest.fn() }));
jest.mock("../reconcile/reversals", () => ({ reconcileReversals: (...a: unknown[]) => reconcileReversals(...a) }));

import { runReconcile } from "../reconcile";

const DAY_MS = 24 * 60 * 60_000;
const OLD = new Date("2026-11-20T00:00:00Z");
const order = (n: number) => ({ orderGid: `gid://shopify/Order/${n}`, legacyId: String(n), updatedAt: new Date(OLD.getTime() + n * 60_000) });
const daysAgo = (d: number) => new Date(Date.now() - d * DAY_MS);

const raised = (kind: string) => raisePaymentException.mock.calls.filter(([k]) => k === kind);

/** The cursor written when the lease was freed, or undefined when it was left. */
const writtenCursor = () => updateMany.mock.calls[1][0].data.shopifyReconcileCursorAt;

class StuckOrderError extends Error {
    code = "P2028";
    constructor() {
        super("customer jane@example.com could not be matched");
        this.name = "StuckOrderError";
    }
}

/** Orders 1–3 in the batch; the listed ones throw. */
function batch(failing: number[]) {
    ordersChangedSince.mockResolvedValue([order(1), order(2), order(3)]);
    reconcileForwardMembership.mockImplementation(async (o: { legacyId: string }) => {
        if (failing.includes(Number(o.legacyId))) throw new StuckOrderError();
    });
}

beforeEach(() => {
    jest.clearAllMocks();
    stored = [];
    updateMany.mockResolvedValue({ count: 1 });
    findUnique.mockResolvedValue({ shopifyReconcileCursorAt: OLD });
    reconcileReversals.mockResolvedValue(0);
});

describe("reconcile CHECK_FAILED budget", () => {
    it("raises an exception for one failure and moves the cursor past it", async () => {
        batch([3]);

        expect(await runReconcile()).toMatchObject({ failed: 1 });
        expect(raisePaymentException).toHaveBeenCalledWith("CHECK_FAILED", { shopifyOrderId: "3", evidence: "StuckOrderError P2028" });
        expect(raised("CHECK_STOPPED")).toHaveLength(0);
        expect(writtenCursor()).toEqual(order(3).updatedAt);
    });

    it("raises an exception for each of two failures and moves the cursor past both", async () => {
        batch([1, 2]);

        expect(await runReconcile()).toMatchObject({ failed: 2 });
        expect(raised("CHECK_FAILED")).toHaveLength(2);
        expect(raised("CHECK_STOPPED")).toHaveLength(0);
        expect(reconcileForwardMembership).toHaveBeenCalledTimes(3);
        expect(writtenCursor()).toEqual(order(3).updatedAt);
    });

    it("stops at the third failure in 7 days with one CHECK_STOPPED, no CHECK_FAILED for it and the cursor held", async () => {
        stored = [{ kind: "CHECK_FAILED", status: "OPEN", detectedAt: daysAgo(2) }];
        batch([1, 2, 3]);

        expect(await runReconcile()).toMatchObject({ failed: 2, reversalsRaised: 0 });
        expect(raised("CHECK_FAILED")).toEqual([["CHECK_FAILED", expect.objectContaining({ shopifyOrderId: "1" })]]);
        expect(raised("CHECK_STOPPED")).toEqual([["CHECK_STOPPED", { shopifyOrderId: "2", evidence: "StuckOrderError P2028" }]]);
        expect(reconcileForwardMembership).toHaveBeenCalledTimes(2);
        expect(reconcileReversals).not.toHaveBeenCalled();
        expect(writtenCursor()).toEqual(order(1).updatedAt);
    });

    it("stops again on a later run that hits the same count", async () => {
        stored = [
            { kind: "CHECK_FAILED", status: "OPEN", detectedAt: daysAgo(3) },
            { kind: "CHECK_FAILED", status: "OPEN", detectedAt: daysAgo(1) },
        ];
        batch([1]);

        await runReconcile();
        expect(raised("CHECK_FAILED")).toHaveLength(0);
        expect(raised("CHECK_STOPPED")).toEqual([["CHECK_STOPPED", expect.objectContaining({ shopifyOrderId: "1" })]]);
        expect(updateMany.mock.calls[1][0].data).not.toHaveProperty("shopifyReconcileCursorAt");
    });

    it("does not count exceptions older than 7 days", async () => {
        stored = [
            { kind: "CHECK_FAILED", status: "OPEN", detectedAt: daysAgo(8) },
            { kind: "CHECK_FAILED", status: "OPEN", detectedAt: daysAgo(10) },
        ];
        batch([3]);

        await runReconcile();
        expect(raised("CHECK_FAILED")).toHaveLength(1);
        expect(raised("CHECK_STOPPED")).toHaveLength(0);
        expect(writtenCursor()).toEqual(order(3).updatedAt);
    });

    it("counts resolved exceptions within 7 days", async () => {
        stored = [
            { kind: "CHECK_FAILED", status: "RESOLVED", detectedAt: daysAgo(1) },
            { kind: "CHECK_FAILED", status: "RESOLVED", detectedAt: daysAgo(6) },
        ];
        batch([3]);

        await runReconcile();
        expect(raised("CHECK_FAILED")).toHaveLength(0);
        expect(raised("CHECK_STOPPED")).toHaveLength(1);
        expect(writtenCursor()).toEqual(order(2).updatedAt);
    });

    it("does not count other kinds, CHECK_STOPPED included", async () => {
        stored = [
            { kind: "CHECK_STOPPED", status: "OPEN", detectedAt: daysAgo(1) },
            { kind: "REFUND", status: "OPEN", detectedAt: daysAgo(1) },
        ];
        batch([3]);

        await runReconcile();
        expect(raised("CHECK_FAILED")).toHaveLength(1);
        expect(raised("CHECK_STOPPED")).toHaveLength(0);
    });
});
