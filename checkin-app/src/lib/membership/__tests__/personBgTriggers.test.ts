import prisma from "@/lib/prisma";
import { openPersonBg } from "@/lib/membership/personBgTriggers";

jest.mock("@/lib/prisma", () => ({ __esModule: true, default: { $transaction: jest.fn() } }));

describe("openPersonBg — the per-person transaction", () => {
    it("runs with the explicit 15-second timeout", async () => {
        const transaction = jest.mocked(prisma.$transaction);
        transaction.mockResolvedValue(null as never);

        await openPersonBg(1, new Date(), new Date());

        expect(transaction.mock.calls[0]?.[1]).toEqual({ maxWait: 5_000, timeout: 15_000 });
    });
});
