import prisma from "@/lib/prisma";
import type { TxClient } from "@/lib/db-client";
import { attest, clearBackgroundCheck, ReviewError } from "@/lib/membership/review";
import { SELF_GRANT_REFUSAL_TABLE } from "@/lib/membership/selfGrantGuard";

jest.mock("@/lib/prisma", () => ({
    __esModule: true,
    default: {
        person: { findUnique: jest.fn(), findMany: jest.fn() },
        auditLog: { create: jest.fn() },
        $transaction: jest.fn(),
    },
}));

const db = prisma as unknown as {
    person: { findUnique: jest.Mock; findMany: jest.Mock };
    auditLog: { create: jest.Mock };
    $transaction: jest.Mock;
};

const anyState = { where: {} };

const people: Record<number, number | null> = { 1: 10, 2: 10, 3: 20, 4: null }; // person id -> household id

/** A tx double for one process: a PERSON_BG when `subjectPersonId` is set, else a household membership. */
function fakeTx(process: { subjectPersonId: number | null; householdId: number }) {
    const tx = {
        $queryRaw: jest.fn(),
        orgMembershipProcess: {
            findFirst: async () => ({ id: 7, status: "PENDING_BG_REVIEW", kind: "INITIAL", paidAt: null, orgMembershipId: 70, subjectPersonId: process.subjectPersonId, attestations: [] }),
            updateMany: jest.fn(async () => ({ count: 1 })),
        },
        orgMembership: { findUnique: async () => ({ householdId: process.householdId, status: "NONE" }) },
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
        await expect(clearBackgroundCheck(tx as unknown as TxClient, 7, 1, anyState)).rejects.toBeInstanceOf(ReviewError);
        expect(tx.person.update).not.toHaveBeenCalled();
        expect(tx.person.updateMany).not.toHaveBeenCalled();
        expect(tx.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ tableName: SELF_GRANT_REFUSAL_TABLE }) });
    });

    it("refuses an actor whose household can't be resolved", async () => {
        const tx = fakeTx({ subjectPersonId: 3, householdId: 20 });
        await expect(clearBackgroundCheck(tx as unknown as TxClient, 7, 999, anyState)).rejects.toBeInstanceOf(ReviewError);
        expect(tx.person.update).not.toHaveBeenCalled();
    });

    it("clears another household's PERSON_BG", async () => {
        const tx = fakeTx({ subjectPersonId: 3, householdId: 20 });
        await clearBackgroundCheck(tx as unknown as TxClient, 7, 1, anyState);
        expect(tx.person.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 3 } }));
        expect(tx.auditLog.create).not.toHaveBeenCalledWith({ data: expect.objectContaining({ tableName: SELF_GRANT_REFUSAL_TABLE }) });
    });
});

describe("attest on a PERSON_BG", () => {
    /** Runs attest with reviewer `reviewerId` against a PERSON_BG whose subject is `subjectPersonId`. */
    function attestAs(reviewerId: number, subjectPersonId: number) {
        db.person.findUnique.mockImplementation(async ({ where }: { where: { id: number } }) =>
            where.id in people ? { id: where.id, householdId: people[where.id], isBackgroundCheckReviewer: true, isBoardMember: false } : null);
        const attestation = jest.fn();
        const tx = {
            $queryRaw: jest.fn(),
            orgMembershipProcess: {
                findUnique: async () => ({ id: 7, status: "PENDING_BG_REVIEW", bgConsentAt: null, bgClearedAt: null, orgMembershipId: null, subjectPersonId, attestations: [] }),
                update: jest.fn(),
            },
            person: { findUnique: async ({ where }: { where: { id: number } }) => ({ householdId: people[where.id] ?? null }) },
            backgroundCheckAttestation: { create: attestation },
            auditLog: { create: jest.fn() },
        };
        db.$transaction.mockImplementation((fn: (t: typeof tx) => unknown) => fn(tx));
        return { result: attest(reviewerId, 7, { result: "APPROVE" }), attestation };
    }

    it.each([
        ["their own check, with no household", 4, 4],
        ["their own check", 1, 1],
        ["a household member's check", 1, 2],
    ])("refuses a reviewer attesting %s", async (_label, reviewerId, subjectPersonId) => {
        const { result, attestation } = attestAs(reviewerId, subjectPersonId);
        await expect(result).rejects.toMatchObject({ code: "same_household_applicant" });
        expect(attestation).not.toHaveBeenCalled();
    });

    it("records an attestation on another household's check", async () => {
        const { result, attestation } = attestAs(4, 3);
        await expect(result).resolves.toMatchObject({ approvals: 1 });
        expect(attestation).toHaveBeenCalled();
    });
});
