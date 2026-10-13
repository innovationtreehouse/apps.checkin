import prisma from "@/lib/prisma";
import { adjustProgramInventory } from "@/lib/shopify";
import { activateProgramEnrollment, publicStockDelta } from "../activateEnrollment";

jest.mock("@/lib/prisma", () => ({
    __esModule: true,
    default: {
        program: { findUnique: jest.fn() },
        programParticipant: { findUnique: jest.fn(), updateMany: jest.fn() },
    },
}));

jest.mock("@/lib/shopify", () => ({
    adjustProgramInventory: jest.fn().mockResolvedValue(true),
}));

const program = {
    id: 7,
    maxParticipants: 10,
    shopifyVariantId: "pub",
    claimantShopifyVariantId: "claim",
};

function seat(held: boolean) {
    (prisma.programParticipant.findUnique as jest.Mock).mockResolvedValueOnce({
        programId: 7, personId: 1, status: "PENDING", inventoryHeldAt: held ? new Date() : null,
    });
    (prisma.programParticipant.updateMany as jest.Mock).mockResolvedValueOnce({ count: 1 });
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
        (prisma.program.findUnique as jest.Mock).mockResolvedValue(program);
    });

    it("held seat paid on the public variant: releases the hold (+1), as before", async () => {
        seat(true);
        const res = await activateProgramEnrollment({ programId: 7, personIds: [1], shopifyOrderId: "1", lines: [{ variantId: "pub", quantity: 1 }] });
        expect(res).toEqual({ activatedCount: 1, releasedHoldCount: 1, claimantSeatCount: 0 });
        expect(adjustProgramInventory).toHaveBeenCalledWith({ shopifyVariantId: "pub" }, 1);
    });

    it("held seat paid on the claimant variant: no stock change, the hold already took the seat", async () => {
        seat(true);
        const res = await activateProgramEnrollment({ programId: 7, personIds: [1], shopifyOrderId: "1", lines: [{ variantId: "claim", quantity: 1 }] });
        expect(res).toEqual({ activatedCount: 1, releasedHoldCount: 1, claimantSeatCount: 1 });
        expect(adjustProgramInventory).not.toHaveBeenCalled();
    });

    it("unheld seats paid on the claimant variant: take them out of public stock", async () => {
        seat(false);
        seat(false);
        const res = await activateProgramEnrollment({ programId: 7, personIds: [1, 2], shopifyOrderId: "1", lines: [{ variantId: "claim", quantity: 2 }] });
        expect(res.claimantSeatCount).toBe(2);
        expect(adjustProgramInventory).toHaveBeenCalledWith({ shopifyVariantId: "pub" }, -2);
    });

    it("unheld seat paid on the public variant: no stock change", async () => {
        seat(false);
        await activateProgramEnrollment({ programId: 7, personIds: [1], shopifyOrderId: "1", lines: [{ variantId: "pub", quantity: 1 }] });
        expect(adjustProgramInventory).not.toHaveBeenCalled();
    });

    it("a redelivery activates nobody and moves no stock", async () => {
        (prisma.programParticipant.findUnique as jest.Mock).mockResolvedValueOnce({ programId: 7, personId: 1, status: "ACTIVE", inventoryHeldAt: null });
        (prisma.programParticipant.updateMany as jest.Mock).mockResolvedValueOnce({ count: 0 });
        const res = await activateProgramEnrollment({ programId: 7, personIds: [1], shopifyOrderId: "1", lines: [{ variantId: "claim", quantity: 1 }] });
        expect(res).toEqual({ activatedCount: 0, releasedHoldCount: 0, claimantSeatCount: 0 });
        expect(adjustProgramInventory).not.toHaveBeenCalled();
    });

    it("an uncapped program tracks no public stock to take a claimant seat from", async () => {
        (prisma.program.findUnique as jest.Mock).mockResolvedValue({ ...program, maxParticipants: null });
        seat(false);
        await activateProgramEnrollment({ programId: 7, personIds: [1], shopifyOrderId: "1", lines: [{ variantId: "claim", quantity: 1 }] });
        expect(adjustProgramInventory).not.toHaveBeenCalled();
    });
});
