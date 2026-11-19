import { lockProgramForClaim, PROGRAM_ENDED_NO_CLAIMS, ProgramCapacityError } from "@/lib/program/capacity";
import type { Prisma } from "@/generated/prisma/client";

/**
 * A minimal TransactionClient: the FOR UPDATE lock is recorded, the program row
 * and participant count are fixed. `order` records the calls, so a test can see
 * the row was read after the lock.
 */
function mockTx(count: number, program: { phase: string; maxParticipants: number | null } | null) {
    const order: string[] = [];
    const tx = {
        $queryRaw: jest.fn(async () => { order.push("lock"); return [{ id: 1 }]; }),
        program: { findUnique: jest.fn(async () => { order.push("read"); return program; }) },
        programParticipant: { count: jest.fn(async () => { order.push("count"); return count; }) },
    };
    return { tx: tx as unknown as Prisma.TransactionClient, mocks: tx, order };
}

const running = (maxParticipants: number | null) => ({ phase: "RUNNING", maxParticipants });

describe("lockProgramForClaim", () => {
    it("throws ProgramCapacityError when a multi-seat request overflows the cap", async () => {
        expect.assertions(2);
        try {
            await lockProgramForClaim(mockTx(0, running(2)).tx, 1, 3, true);
        } catch (e) {
            expect(e).toBeInstanceOf(ProgramCapacityError);
            expect((e as ProgramCapacityError).spotsLeft).toBe(2);
        }
    });

    it("returns without throwing when seats fit", async () => {
        await expect(lockProgramForClaim(mockTx(0, running(2)).tx, 1, 2, true)).resolves.toBeUndefined();
    });

    it("judges the cap read under the lock, not one the caller read earlier", async () => {
        // The caller saw a cap of 2; a cut to 1 committed before the lock was taken.
        const { tx, order } = mockTx(1, running(1));
        await expect(lockProgramForClaim(tx, 1, 1, true)).rejects.toBeInstanceOf(ProgramCapacityError);
        expect(order).toEqual(["lock", "read", "count"]);
    });

    it("is a no-op on capacity for an uncapped program", async () => {
        const { tx, mocks } = mockTx(99, running(null));
        await expect(lockProgramForClaim(tx, 1, 5, true)).resolves.toBeUndefined();
        expect(mocks.programParticipant.count).not.toHaveBeenCalled();
    });

    it("skips capacity when the caller does not enforce it", async () => {
        const { tx, mocks } = mockTx(5, running(1));
        await expect(lockProgramForClaim(tx, 1, 1, false)).resolves.toBeUndefined();
        expect(mocks.programParticipant.count).not.toHaveBeenCalled();
    });

    it("refuses any claim on an ended program, even one that skips capacity", async () => {
        for (const enforce of [true, false]) {
            await expect(lockProgramForClaim(mockTx(0, { phase: "FINISHED", maxParticipants: null }).tx, 1, 1, enforce))
                .rejects.toMatchObject({ status: 409, message: PROGRAM_ENDED_NO_CLAIMS });
        }
    });
});
