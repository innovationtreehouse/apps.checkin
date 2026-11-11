import type { TxClient } from "@/lib/db-client";
import type { ProgramParticipant } from "@/generated/prisma/client";
import { deleteAndReleaseHold, withdrawParticipant } from "@/lib/program/capacity";

jest.mock("@/lib/shopify/stock", () => ({
    changeProgramStockWith: async (_program: unknown, _reason: string, change: (tx: TxClient) => Promise<{ result: unknown }>) => {
        const { result } = await change(txStub);
        return { result, landed: true };
    },
}));

const row = { programId: 1, personId: 2, status: "ACTIVE", inventoryHeldAt: null, seatTakenWithoutSaleAt: null } as ProgramParticipant;
const txStub = {
    programParticipant: {
        delete: jest.fn(async () => row),
        updateMany: jest.fn(async () => ({ count: 1 })),
        findUniqueOrThrow: jest.fn(async () => ({ ...row, status: "WITHDRAWN" })),
    },
    program: { count: jest.fn(async () => 0), findUnique: jest.fn(async () => null) },
    rSVP: { deleteMany: jest.fn(async () => ({ count: 0 })) },
} as unknown as TxClient;

describe("participant exits write their audit inside the exit's transaction", () => {
    it.each([
        ["remove", () => deleteAndReleaseHold],
        ["withdraw", () => withdrawParticipant],
    ])("%s hands the audit the transaction client and the row it changed", async (_mode, exitFn) => {
        const audit = jest.fn(async () => undefined);

        await exitFn()(1, 2, {}, undefined, { audit });

        expect(audit).toHaveBeenCalledWith(txStub, expect.objectContaining({ programId: 1, personId: 2 }));
    });

    it.each([
        ["remove", () => deleteAndReleaseHold],
        ["withdraw", () => withdrawParticipant],
    ])("%s fails, and so rolls back, when its audit write fails", async (_mode, exitFn) => {
        const audit = jest.fn(async () => { throw new Error("audit write failed"); });

        await expect(exitFn()(1, 2, {}, undefined, { audit })).rejects.toThrow("audit write failed");
    });
});
