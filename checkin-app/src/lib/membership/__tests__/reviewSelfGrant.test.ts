import prisma from "@/lib/prisma";
import type { TxClient } from "@/lib/db-client";
import { clearBackgroundCheck, ReviewError } from "@/lib/membership/review";
import { SELF_GRANT_REFUSAL_TABLE } from "@/lib/membership/selfGrantGuard";

jest.mock("@/lib/prisma", () => ({
    __esModule: true,
    default: {
        person: { findUnique: jest.fn(), findMany: jest.fn() },
        auditLog: { create: jest.fn() },
    },
}));

const db = prisma as unknown as {
    person: { findUnique: jest.Mock; findMany: jest.Mock };
    auditLog: { create: jest.Mock };
};

const people: Record<number, number | null> = { 1: 10, 2: 10, 3: 20 }; // person id -> household id

/** A tx double for one process: a PERSON_BG when `subjectPersonId` is set, else a household membership. */
function fakeTx(process: { subjectPersonId: number | null; householdId: number }) {
    const tx = {
        orgMembershipProcess: {
            findUnique: async () => ({ id: 7, status: "PENDING_BG_REVIEW", kind: "INITIAL", paidAt: null, orgMembershipId: 70, subjectPersonId: process.subjectPersonId, attestations: [] }),
            update: jest.fn(),
        },
        orgMembership: { findUnique: async () => ({ householdId: process.householdId }), update: jest.fn() },
        person: {
            findUnique: async ({ where }: { where: { id: number } }) => ({ householdId: people[where.id] ?? null }),
            findMany: async () => [],
            update: jest.fn(),
            updateMany: jest.fn(),
        },
        volunteerDesignation: { findMany: async () => [] },
        auditLog: { create: jest.fn() },
    };
    return tx;
}

beforeEach(() => {
    jest.clearAllMocks();
    db.person.findUnique.mockImplementation(async ({ where }: { where: { id: number } }) => (where.id in people ? { householdId: people[where.id] } : null));
    db.person.findMany.mockResolvedValue([]);
});

describe("clearBackgroundCheck self-grant guard", () => {
    it.each([
        ["a household member's PERSON_BG", { subjectPersonId: 2, householdId: 10 }],
        ["the actor's own household", { subjectPersonId: null, householdId: 10 }],
    ])("refuses %s, stamps nothing, and audits the refusal", async (_label, process) => {
        const tx = fakeTx(process);
        await expect(clearBackgroundCheck(tx as unknown as TxClient, 7, 1)).rejects.toBeInstanceOf(ReviewError);
        expect(tx.person.update).not.toHaveBeenCalled();
        expect(tx.person.updateMany).not.toHaveBeenCalled();
        expect(db.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ tableName: SELF_GRANT_REFUSAL_TABLE }) });
    });

    it("refuses an actor whose household can't be resolved", async () => {
        const tx = fakeTx({ subjectPersonId: 3, householdId: 20 });
        await expect(clearBackgroundCheck(tx as unknown as TxClient, 7, 999)).rejects.toBeInstanceOf(ReviewError);
        expect(tx.person.update).not.toHaveBeenCalled();
    });

    it("clears another household's PERSON_BG", async () => {
        const tx = fakeTx({ subjectPersonId: 3, householdId: 20 });
        await clearBackgroundCheck(tx as unknown as TxClient, 7, 1);
        expect(tx.person.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 3 } }));
        expect(db.auditLog.create).not.toHaveBeenCalled();
    });
});
