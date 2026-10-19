import prisma from "@/lib/prisma";
import { adjustProgramInventory } from "@/lib/shopify/stock";
import { isOrderReversed, raisePaymentException, recordReversal } from "@/lib/finance/reconcile/exceptions";
import { takeBackRestockedSeats } from "@/lib/finance/reconcile/reversals";
import { activateProgramEnrollment, publicStockDelta } from "../activateEnrollment";

type Row = { personId: number; status: "PENDING" | "ACTIVE"; inventoryHeldAt: Date | null };
// The participant rows the guarded writes act on; findUnique serves a separate
// snapshot so a test can make a read go stale.
const mockRows = new Map<number, Row>();
const mockSnapshots = new Map<number, Row>();
const mockStock: number[] = [];

jest.mock("@/lib/prisma", () => {
    const client = {
        program: { findUnique: jest.fn() },
        programParticipant: {
            findUnique: jest.fn(async ({ where }: { where: { programId_personId: { personId: number } } }) => {
                const id = where.programId_personId.personId;
                return mockSnapshots.get(id) ?? mockRows.get(id) ?? null;
            }),
            updateMany: jest.fn(async ({ where, data }: { where: { personId: number; status?: unknown; inventoryHeldAt?: unknown }; data: Partial<Row> }) => {
                const row = mockRows.get(where.personId);
                if (!row || row.status !== "PENDING") return { count: 0 };
                if ("inventoryHeldAt" in where && (where.inventoryHeldAt === null) !== (row.inventoryHeldAt === null)) return { count: 0 };
                Object.assign(row, { status: data.status, inventoryHeldAt: data.inventoryHeldAt });
                return { count: 1 };
            }),
        },
    };
    return { __esModule: true, default: client };
});

// Records each order's stock delta; the change runs on the mocked client as its transaction.
jest.mock("@/lib/shopify/stock", () => ({
    adjustProgramInventory: jest.fn(async (_p: unknown, delta: number) => { mockStock.push(delta); return true; }),
    changeProgramStockWith: jest.fn(async (_p: unknown, _r: string, change: (tx: unknown) => Promise<{ result: unknown; delta: number }>) => {
        const { result, delta } = await change(jest.requireMock("@/lib/prisma").default);
        if (delta !== 0) mockStock.push(delta);
        return { result, landed: true };
    }),
}));

jest.mock("@/lib/finance/reconcile/exceptions", () => ({
    isOrderReversed: jest.fn().mockResolvedValue(false),
    raisePaymentException: jest.fn(),
    recordReversal: jest.fn(),
}));

jest.mock("@/lib/finance/reconcile/reversals", () => ({
    takeBackRestockedSeats: jest.fn().mockResolvedValue(0),
}));

const program = {
    id: 7,
    maxParticipants: 10,
    shopifyVariantId: "pub",
    claimantShopifyVariantId: "claim",
};

function seat(personId: number, held: boolean) {
    mockRows.set(personId, { personId, status: "PENDING", inventoryHeldAt: held ? new Date() : null });
}

describe("publicStockDelta", () => {
    it("leaves every filled seat exactly one unit out of public stock", () => {
        expect(publicStockDelta(1, 0)).toBe(1);  // held, paid public: the sale took a second unit
        expect(publicStockDelta(1, 1)).toBe(0);  // held, paid claimant: the hold already took it
        expect(publicStockDelta(0, 0)).toBe(0);  // unheld, paid public: the sale took it
        expect(publicStockDelta(0, 1)).toBe(-1); // unheld, paid claimant: nothing took it yet
    });
});

describe("activateProgramEnrollment public stock", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockRows.clear();
        mockSnapshots.clear();
        mockStock.length = 0;
        (prisma.program.findUnique as jest.Mock).mockResolvedValue(program);
    });

    it("held seat paid on the public variant: releases the hold (+1)", async () => {
        seat(1, true);
        const res = await activateProgramEnrollment({ programId: 7, personIds: [1], shopifyOrderId: "1", lines: [{ variantId: "pub", quantity: 1 }] });
        expect(res).toEqual({ activatedCount: 1, releasedHoldCount: 1, claimantSeatCount: 0 });
        expect(mockStock).toEqual([1]);
        expect(mockRows.get(1)).toMatchObject({ status: "ACTIVE", inventoryHeldAt: null });
    });

    it("held seat paid on the claimant variant: no stock change, the hold already took the seat", async () => {
        seat(1, true);
        const res = await activateProgramEnrollment({ programId: 7, personIds: [1], shopifyOrderId: "1", lines: [{ variantId: "claim", quantity: 1 }] });
        expect(res).toEqual({ activatedCount: 1, releasedHoldCount: 1, claimantSeatCount: 1 });
        expect(mockStock).toEqual([]);
    });

    it("unheld seats paid on the claimant variant: take them out of public stock", async () => {
        seat(1, false);
        seat(2, false);
        const res = await activateProgramEnrollment({ programId: 7, personIds: [1, 2], shopifyOrderId: "1", lines: [{ variantId: "claim", quantity: 2 }] });
        expect(res.claimantSeatCount).toBe(2);
        expect(mockStock).toEqual([-2]);
    });

    it("unheld seat paid on the public variant: no stock change", async () => {
        seat(1, false);
        await activateProgramEnrollment({ programId: 7, personIds: [1], shopifyOrderId: "1", lines: [{ variantId: "pub", quantity: 1 }] });
        expect(mockStock).toEqual([]);
    });

    it("a redelivery activates nobody and moves no stock", async () => {
        mockRows.set(1, { personId: 1, status: "ACTIVE", inventoryHeldAt: null });
        const res = await activateProgramEnrollment({ programId: 7, personIds: [1], shopifyOrderId: "1", lines: [{ variantId: "claim", quantity: 1 }] });
        expect(res).toEqual({ activatedCount: 0, releasedHoldCount: 0, claimantSeatCount: 0 });
        expect(mockStock).toEqual([]);
    });

    it("an uncapped program tracks no public stock to take a claimant seat from", async () => {
        (prisma.program.findUnique as jest.Mock).mockResolvedValue({ ...program, maxParticipants: null });
        seat(1, false);
        await activateProgramEnrollment({ programId: 7, personIds: [1], shopifyOrderId: "1", lines: [{ variantId: "claim", quantity: 1 }] });
        expect(mockStock).toEqual([]);
    });

    // F4 (programs TLA+ model): a's hold is stamped after activation first looks at
    // the row. The release must be counted from the write that clears it.
    it("counts a hold stamped after any earlier read of the row", async () => {
        seat(1, true);
        mockSnapshots.set(1, { personId: 1, status: "PENDING", inventoryHeldAt: null }); // the stale read
        const res = await activateProgramEnrollment({ programId: 7, personIds: [1], shopifyOrderId: "1", lines: [{ variantId: "pub", quantity: 1 }] });
        expect(res.releasedHoldCount).toBe(1);
        expect(mockStock).toEqual([1]);
    });

    it("a reversed order activates nobody, raises each pending child CRITICAL and takes back the restocked seat", async () => {
        (isOrderReversed as jest.Mock).mockResolvedValueOnce(true);
        (prisma.programParticipant.findUnique as jest.Mock).mockResolvedValueOnce({ personId: 1 }).mockResolvedValueOnce({ personId: 2 }).mockResolvedValueOnce(null);
        const res = await activateProgramEnrollment({ programId: 7, personIds: [1, 2, 3], shopifyOrderId: "9", lines: [{ variantId: "pub", quantity: 2 }] });
        expect(res).toEqual({ activatedCount: 0, releasedHoldCount: 0, claimantSeatCount: 0, reversed: true });
        expect(prisma.programParticipant.updateMany).not.toHaveBeenCalled();
        expect(raisePaymentException).toHaveBeenCalledTimes(2);
        expect(raisePaymentException).toHaveBeenCalledWith("REVERSED_BEFORE_ACTIVATION", { shopifyOrderId: "9", programId: 7, personId: 2, severity: "CRITICAL" });
        expect(takeBackRestockedSeats).toHaveBeenCalledWith("9", { id: 7, shopifyVariantId: "pub" });
        expect(recordReversal).toHaveBeenCalledWith("9", "REVERSED_BEFORE_ACTIVATION");
        expect(adjustProgramInventory).not.toHaveBeenCalled();
    });
});
