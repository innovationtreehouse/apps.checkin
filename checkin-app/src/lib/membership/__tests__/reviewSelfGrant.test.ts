import prisma from "@/lib/prisma";
import type { TxClient } from "@/lib/db-client";
import { attest, clearBackgroundCheck, ReviewError, SelfGrantRefusedError } from "@/lib/membership/review";
import { SELF_GRANT_REFUSAL_TABLE } from "@/lib/membership/selfGrantGuard";

jest.mock("@/lib/membership/settleHouseholdBg", () => ({ settleAfterEvent: jest.fn(async () => []), blockedByCheckReview: jest.fn(async () => false) }));

jest.mock("@/lib/prisma", () => ({
    __esModule: true,
    default: {
        person: { findUnique: jest.fn(), findMany: jest.fn() },
        orgMembershipProcess: { findUnique: jest.fn(async () => null) },
        auditLog: { create: jest.fn() },
        $transaction: jest.fn(),
    },
}));

const db = prisma as unknown as {
    person: { findUnique: jest.Mock; findMany: jest.Mock };
    orgMembershipProcess: { findUnique: jest.Mock };
    auditLog: { create: jest.Mock };
    $transaction: jest.Mock;
};

const anyState = { where: {} };

const people: Record<number, number | null> = { 1: 10, 2: 10, 3: 20, 4: null }; // person id -> household id

/** A tx double for one process: a PERSON_BG when `subjectPersonId` is set, else a household membership. */
function fakeTx(process: { subjectPersonId: number | null; householdId: number }, householdStatus = "NONE") {
    const tx = {
        $queryRaw: jest.fn(async () => [{ status: householdStatus }]),
        orgMembershipProcess: {
            findFirst: async () => ({ id: 7, status: "PENDING_BG_REVIEW", kind: process.subjectPersonId ? "PERSON_BG" : "INITIAL", paidAt: null, orgMembershipId: process.subjectPersonId ? null : 70, subjectPersonId: process.subjectPersonId, attestations: [] }),
            updateMany: jest.fn(async () => ({ count: 1 })),
            count: async () => 0,
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
    it("refuses a household member's PERSON_BG, stamps nothing, and carries the refusal out of the transaction", async () => {
        const tx = fakeTx({ subjectPersonId: 2, householdId: 10 });
        const err = await clearBackgroundCheck(tx as unknown as TxClient, 7, 1, anyState).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(SelfGrantRefusedError);
        expect((err as SelfGrantRefusedError).refusal).toMatchObject({ actorId: 1, newData: { reason: "own_household" } });
        expect(tx.person.update).not.toHaveBeenCalled();
        expect(tx.person.updateMany).not.toHaveBeenCalled();
        expect(tx.auditLog.create).not.toHaveBeenCalledWith({ data: expect.objectContaining({ tableName: SELF_GRANT_REFUSAL_TABLE }) });
    });

    it("refuses a household application: only a check review clears", async () => {
        const tx = fakeTx({ subjectPersonId: null, householdId: 20 });
        const err = await clearBackgroundCheck(tx as unknown as TxClient, 7, 1, anyState).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ReviewError);
        expect((err as ReviewError).code).toBe("wrong_phase");
        expect(tx.orgMembershipProcess.updateMany).not.toHaveBeenCalled();
    });

    it("refuses an actor whose household can't be resolved", async () => {
        const tx = fakeTx({ subjectPersonId: 3, householdId: 20 });
        await expect(clearBackgroundCheck(tx as unknown as TxClient, 7, 999, anyState)).rejects.toBeInstanceOf(SelfGrantRefusedError);
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
    function attestAs(reviewerId: number, subjectPersonId: number, householdStatus = "NONE") {
        db.person.findUnique.mockImplementation(async ({ where }: { where: { id: number } }) =>
            where.id in people ? { id: where.id, householdId: people[where.id], isBackgroundCheckReviewer: true, isBoardMember: false } : null);
        db.orgMembershipProcess.findUnique.mockResolvedValue({ orgMembershipId: null, subjectPersonId, requestedForHouseholdId: null });
        const attestation = jest.fn();
        const tx = {
            $queryRaw: jest.fn(async () => [{ status: householdStatus }]),
            orgMembershipProcess: {
                findUnique: async () => ({ id: 7, kind: "PERSON_BG", status: "PENDING_BG_REVIEW", bgConsentAt: new Date(), bgClearedAt: null, orgMembershipId: null, subjectPersonId, requestedForHouseholdId: null, attestations: [] }),
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
        ["a check while their household can't be resolved", 4, 3],
        ["their own check", 1, 1],
        ["a household member's check", 1, 2],
    ])("refuses a reviewer attesting %s and records the refusal outside the transaction", async (_label, reviewerId, subjectPersonId) => {
        const { result, attestation } = attestAs(reviewerId, subjectPersonId);
        await expect(result).rejects.toMatchObject({ code: "same_household_applicant" });
        expect(attestation).not.toHaveBeenCalled();
        expect(db.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ actorId: reviewerId, tableName: SELF_GRANT_REFUSAL_TABLE }) });
    });

    it("records an attestation on another household's check", async () => {
        const { result, attestation } = attestAs(1, 3);
        await expect(result).resolves.toMatchObject({ approvals: 1 });
        expect(attestation).toHaveBeenCalled();
    });

    it("refuses an approval while the person's household is denied, saving nothing", async () => {
        const { result, attestation } = attestAs(1, 3, "DENIED");
        await expect(result).rejects.toMatchObject({ code: "wrong_phase", message: expect.stringMatching(/denied/) });
        expect(attestation).not.toHaveBeenCalled();
    });
});
