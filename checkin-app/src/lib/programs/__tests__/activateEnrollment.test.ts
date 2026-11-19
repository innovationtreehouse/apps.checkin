import prisma from "@/lib/prisma";
import { adjustProgramInventory } from "@/lib/shopify/stock";
import { isOrderReversed, raisePaymentException, recordReversal } from "@/lib/finance/reconcile/exceptions";
import { takeBackRestockedSeats } from "@/lib/finance/reconcile/reversals";
import { activateProgramEnrollment, priceMismatch, publicStockDelta } from "../activateEnrollment";

type Row = { personId: number; status: "PENDING" | "ACTIVE"; inventoryHeldAt: Date | null; shopifyOrderId?: string | null };
// The participant rows the guarded writes act on; findUnique serves a separate
// snapshot so a test can make a read go stale.
const mockRows = new Map<number, Row>();
const mockSnapshots = new Map<number, Row>();
const mockStock: number[] = [];
// People an earlier activation of the order seated: what seatsSpentBy reads back.
const mockSpent: { personId: number }[] = [];

jest.mock("@/lib/prisma", () => {
    const client = {
        program: { findUnique: jest.fn() },
        auditLog: { findMany: jest.fn(async () => []) },
        programParticipant: {
            // peopleSpentBy asks by order; surplusSeats asks for the named people who are active.
            findMany: jest.fn(async ({ where }: { where: { shopifyOrderId?: string; personId?: { in: number[] } } }) =>
                where.shopifyOrderId !== undefined
                    ? mockSpent
                    : [...mockRows.values()]
                        .filter((r) => r.status === "ACTIVE" && where.personId?.in.includes(r.personId))
                        .map((r) => ({ personId: r.personId, shopifyOrderId: r.shopifyOrderId ?? null }))),
            findUnique: jest.fn(async ({ where }: { where: { programId_personId: { personId: number } } }) => {
                const id = where.programId_personId.personId;
                return mockSnapshots.get(id) ?? mockRows.get(id) ?? null;
            }),
            updateMany: jest.fn(async ({ where, data }: { where: { personId: number; status?: unknown; inventoryHeldAt?: unknown }; data: Partial<Row> }) => {
                const row = mockRows.get(where.personId);
                if (!row || row.status !== "PENDING") return { count: 0 };
                if ("inventoryHeldAt" in where && (where.inventoryHeldAt === null) !== (row.inventoryHeldAt === null)) return { count: 0 };
                Object.assign(row, { status: data.status, inventoryHeldAt: data.inventoryHeldAt, shopifyOrderId: data.shopifyOrderId });
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
        mockSpent.length = 0;
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
        mockRows.set(1, { personId: 1, status: "ACTIVE", inventoryHeldAt: null, shopifyOrderId: "1" });
        mockSpent.push({ personId: 1 });
        const res = await activateProgramEnrollment({ programId: 7, personIds: [1], shopifyOrderId: "1", lines: [{ variantId: "claim", quantity: 1 }] });
        expect(res).toMatchObject({ activatedCount: 0, releasedHoldCount: 0, claimantSeatCount: 0 });
        expect(mockStock).toEqual([]);
        expect(raisePaymentException).not.toHaveBeenCalledWith("UNCLAIMED_SEATS", expect.anything());
        expect(raisePaymentException).not.toHaveBeenCalledWith("DUPLICATE_PAYMENT", expect.anything());
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

    it("activates no more people than the order has unspent seats, and raises the rest for the Board", async () => {
        seat(1, false);
        seat(2, false);
        const res = await activateProgramEnrollment({ programId: 7, personIds: [1, 2], shopifyOrderId: "5", lines: [{ variantId: "pub", quantity: 1 }] });
        expect(res).toMatchObject({ activatedCount: 1, refusedPersonIds: [2] });
        expect(mockRows.get(2)).toMatchObject({ status: "PENDING" });
        expect(raisePaymentException).toHaveBeenCalledWith("AMOUNT_MISMATCH", { shopifyOrderId: "5", programId: 7, personId: 2 });
    });

    it("an order whose seat another activation already spent seats nobody", async () => {
        mockSpent.push({ personId: 9 });
        seat(1, false);
        const res = await activateProgramEnrollment({ programId: 7, personIds: [1], shopifyOrderId: "5", lines: [{ variantId: "pub", quantity: 1 }] });
        expect(res).toMatchObject({ activatedCount: 0, refusedPersonIds: [1] });
        expect(mockRows.get(1)).toMatchObject({ status: "PENDING" });
    });

    it("does not re-seat a person the order already paid for, who left and came back", async () => {
        mockSpent.push({ personId: 1 });
        seat(1, false);
        seat(2, false);
        const res = await activateProgramEnrollment({ programId: 7, personIds: [1, 2], shopifyOrderId: "5", lines: [{ variantId: "pub", quantity: 2 }] });
        expect(res).toMatchObject({ activatedCount: 1, refusedPersonIds: [1] });
        expect(mockRows.get(1)).toMatchObject({ status: "PENDING" });
        expect(mockRows.get(2)).toMatchObject({ status: "ACTIVE" });
    });

    it("counts the order's current quantity, not the units an edit took off", async () => {
        seat(1, false);
        seat(2, false);
        const res = await activateProgramEnrollment({ programId: 7, personIds: [1, 2], shopifyOrderId: "5", lines: [{ variantId: "pub", quantity: 2, currentQuantity: 1 }] });
        expect(res.activatedCount).toBe(1);
    });

    it("takes no claimant seat from public stock for a claimant line refunded to nothing", async () => {
        seat(1, false);
        const res = await activateProgramEnrollment({
            programId: 7,
            personIds: [1],
            shopifyOrderId: "5",
            lines: [{ variantId: "pub", quantity: 1, currentQuantity: 1 }, { variantId: "claim", quantity: 1, currentQuantity: 0 }],
        });
        expect(res).toEqual({ activatedCount: 1, releasedHoldCount: 0, claimantSeatCount: 0 });
        expect(mockStock).toEqual([]);
    });

    it("raises the seat it leaves unspent when someone it names was activated another way meanwhile", async () => {
        mockRows.set(1, { personId: 1, status: "ACTIVE", inventoryHeldAt: null, shopifyOrderId: null }); // approved by the Board
        seat(2, true);
        const res = await activateProgramEnrollment({ programId: 7, personIds: [1, 2], shopifyOrderId: "5", lines: [{ variantId: "pub", quantity: 2 }] });
        expect(res.activatedCount).toBe(1);
        expect(raisePaymentException).toHaveBeenCalledWith("DUPLICATE_PAYMENT", { shopifyOrderId: "5", programId: 7, personId: 1 });
    });

    it("raises nothing when every seat it was paid for is filled", async () => {
        seat(1, false);
        seat(2, false);
        await activateProgramEnrollment({ programId: 7, personIds: [1, 2], shopifyOrderId: "5", lines: [{ variantId: "pub", quantity: 2 }] });
        expect(raisePaymentException).not.toHaveBeenCalled();
    });
});

describe("a seat paid at a price other than the program's", () => {
    const priced = { ...program, nonOrgMemberPriceCents: 8000 };

    beforeEach(() => {
        jest.clearAllMocks();
        mockRows.clear();
        mockSnapshots.clear();
        mockStock.length = 0;
        mockSpent.length = 0;
        (prisma.program.findUnique as jest.Mock).mockResolvedValue(priced);
    });

    it("seats the family and raises the difference for the Board", async () => {
        seat(1, false);
        seat(2, false);
        const res = await activateProgramEnrollment({ programId: 7, personIds: [1, 2], shopifyOrderId: "5", lines: [{ variantId: "claim", quantity: 2, unitPriceCents: 7500 }] });
        expect(res.activatedCount).toBe(2);
        expect(raisePaymentException).toHaveBeenCalledTimes(1);
        expect(raisePaymentException).toHaveBeenCalledWith("AMOUNT_MISMATCH", {
            shopifyOrderId: "5", programId: 7, personId: 1, evidence: expect.stringContaining("$75.00 per seat; the program's price is $80.00"),
        });
    });

    it("raises nothing when the order pays the program's price", async () => {
        seat(1, false);
        await activateProgramEnrollment({ programId: 7, personIds: [1], shopifyOrderId: "5", lines: [{ variantId: "pub", quantity: 1, unitPriceCents: 8000 }] });
        expect(raisePaymentException).not.toHaveBeenCalled();
    });

    it("raises nothing when nobody was seated (a redelivery)", async () => {
        mockRows.set(1, { personId: 1, status: "ACTIVE", inventoryHeldAt: null });
        await activateProgramEnrollment({ programId: 7, personIds: [1], shopifyOrderId: "5", lines: [{ variantId: "pub", quantity: 1, unitPriceCents: 7500 }] });
        expect(raisePaymentException).not.toHaveBeenCalled();
    });
});

describe("priceMismatch", () => {
    const p = { shopifyVariantId: "pub", claimantShopifyVariantId: "claim", nonOrgMemberPriceCents: 8000 };

    it("ignores lines that are not this program's seats, and lines with no known price", () => {
        expect(priceMismatch(p, [{ variantId: "merch", quantity: 1, unitPriceCents: 100 }, { variantId: "pub", quantity: 1 }])).toBeNull();
    });

    it("is null when the program has no full price", () => {
        expect(priceMismatch({ ...p, nonOrgMemberPriceCents: null }, [{ variantId: "pub", quantity: 1, unitPriceCents: 7500 }])).toBeNull();
    });
});
