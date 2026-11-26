/**
 * @jest-environment node
 */
/**
 * One reconcile pass at a time: a pass that finds the lease held scans nothing, and
 * only the lease holder moves the cursor, in the statement that frees the lease.
 */
const updateMany = jest.fn();
const findUnique = jest.fn();
const ordersChangedSince = jest.fn();
const reconcileReversals = jest.fn();

jest.mock("@/lib/prisma", () => {
    const boardSettings = {
        updateMany: (...a: unknown[]) => updateMany(...a),
        findUnique: (...a: unknown[]) => findUnique(...a),
    };
    return {
        __esModule: true,
        default: { boardSettings, $transaction: (fn: (tx: unknown) => Promise<unknown>) => fn({ boardSettings }) },
    };
});
jest.mock("@/lib/shopifyRead/client", () => ({
    isConfigured: () => true,
    ordersChangedSince: (...a: unknown[]) => ordersChangedSince(...a),
}));
jest.mock("../reconcile/membership", () => ({ reconcileForwardMembership: jest.fn() }));
jest.mock("../reconcile/program", () => ({ reconcileForwardProgram: jest.fn() }));
jest.mock("../reconcile/reversals", () => ({ reconcileReversals: (...a: unknown[]) => reconcileReversals(...a) }));

import { runReconcile } from "../reconcile";

const OLD = new Date("2026-11-20T00:00:00Z");
const NEW = new Date("2026-11-22T00:00:00Z");

/** The `data` of the statement that freed the lease. */
const released = () => updateMany.mock.calls[1][0];

beforeEach(() => {
    jest.clearAllMocks();
    findUnique.mockResolvedValue({ shopifyReconcileCursorAt: OLD });
    ordersChangedSince.mockResolvedValue([{ orderGid: "gid://shopify/Order/1", legacyId: "1", updatedAt: NEW }]);
    reconcileReversals.mockResolvedValue(0);
});

describe("runReconcile lease", () => {
    it("scans nothing when another pass holds the lease", async () => {
        updateMany.mockResolvedValueOnce({ count: 0 });

        expect(await runReconcile()).toEqual({ configured: true, ordersScanned: 0, reversalsRaised: 0, failed: 0, leaseHeld: true });
        expect(ordersChangedSince).not.toHaveBeenCalled();
        expect(updateMany).toHaveBeenCalledTimes(1);
    });

    it("takes a free or expired lease, then frees it with the new cursor", async () => {
        updateMany.mockResolvedValue({ count: 1 });

        expect(await runReconcile()).toEqual({ configured: true, ordersScanned: 1, reversalsRaised: 0, failed: 0 });
        const taken = updateMany.mock.calls[0][0];
        expect(taken.where.OR).toEqual([{ shopifyReconcileLeaseUntil: null }, { shopifyReconcileLeaseUntil: { lt: expect.any(Date) } }]);
        const token = taken.data.shopifyReconcileLeaseToken;
        expect(released()).toEqual({
            where: { id: 1, shopifyReconcileLeaseToken: token },
            data: { shopifyReconcileLeaseUntil: null, shopifyReconcileLeaseToken: null, shopifyReconcileCursorAt: NEW },
        });
    });

    it("frees the lease without moving the cursor when the pass throws", async () => {
        updateMany.mockResolvedValue({ count: 1 });
        reconcileReversals.mockRejectedValue(new Error("mirror down"));

        await expect(runReconcile()).rejects.toThrow("mirror down");
        expect(released().data).toEqual({ shopifyReconcileLeaseUntil: null, shopifyReconcileLeaseToken: null });
    });

    it("returns the finished pass when freeing the lease fails", async () => {
        const consoleError = jest.spyOn(console, "error").mockImplementation(() => undefined);
        updateMany.mockResolvedValueOnce({ count: 1 }).mockRejectedValueOnce(new Error("db blip"));

        expect(await runReconcile()).toEqual({ configured: true, ordersScanned: 1, reversalsRaised: 0, failed: 0 });
        expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("failed to free the lease"), expect.any(Error));
        consoleError.mockRestore();
    });

    it("reports the pass's own error when freeing the lease also fails", async () => {
        const consoleError = jest.spyOn(console, "error").mockImplementation(() => undefined);
        updateMany.mockResolvedValueOnce({ count: 1 }).mockRejectedValueOnce(new Error("db blip"));
        reconcileReversals.mockRejectedValue(new Error("mirror down"));

        await expect(runReconcile()).rejects.toThrow("mirror down");
        consoleError.mockRestore();
    });

    it("writes the caller's start record only when it takes the lease", async () => {
        const recordStart = jest.fn();
        updateMany.mockResolvedValueOnce({ count: 0 });
        await runReconcile(recordStart);
        expect(recordStart).not.toHaveBeenCalled();

        updateMany.mockResolvedValue({ count: 1 });
        await runReconcile(recordStart);
        expect(recordStart).toHaveBeenCalledTimes(1);
    });
});
