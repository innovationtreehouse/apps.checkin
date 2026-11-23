const tx = {
    $queryRaw: jest.fn(),
    person: { findUnique: jest.fn() },
    orgMembership: { count: jest.fn() },
    trustedAdult: { create: jest.fn(), findUniqueOrThrow: jest.fn() },
    trustedAdultReview: { findUnique: jest.fn(), findFirst: jest.fn(), aggregate: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn() },
    auditLog: { create: jest.fn() },
};
const mockDb = {
    household: { findUnique: jest.fn(), count: jest.fn() },
    trustedAdult: { findUnique: jest.fn() },
    trustedAdultReview: { findUnique: jest.fn(), findFirst: jest.fn() },
    person: { findUnique: jest.fn(), findFirst: jest.fn() },
    auditLog: { create: jest.fn() },
    $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
};
jest.mock("@/lib/prisma", () => ({ __esModule: true, get default() { return mockDb; } }));
jest.mock("@/lib/emailRecipients", () => ({ emailBoardMembers: jest.fn(), emailHouseholdLeads: jest.fn() }));

import { emailBoardMembers, emailHouseholdLeads } from "@/lib/emailRecipients";
import { answerInfoRequest, createTrustedAdult, decideReview, renewTrustedAdult, resubmitWithChanges } from "@/lib/trusted-adult/service";

const HOUSEHOLD = 20;
const ADULT_PERSON = 7;
const ADULT_HOUSEHOLD = 30;

const createInput = {
    householdId: HOUSEHOLD,
    trustedAdultPersonId: ADULT_PERSON,
    trustedAdultName: "Gran",
    trustedAdultEmail: "gran@example.com",
    familyContext: "May pick up the kids.",
    disclosedById: 1,
};

const head = {
    trustedAdultId: 3,
    proposedEmail: null,
    proposedPhone: null,
    trustedAdult: {
        householdId: HOUSEHOLD,
        trustedAdultPersonId: ADULT_PERSON,
        trustedAdultName: "Gran",
        trustedAdultEmail: "gran@example.com",
        trustedAdultPhone: null,
        trustedAdultPerson: { householdId: ADULT_HOUSEHOLD },
    },
};

beforeEach(() => {
    jest.clearAllMocks();
    tx.$queryRaw.mockResolvedValue([{ archivedAt: null }]);
    tx.person.findUnique.mockImplementation(({ where }: { where: { id: number } }) => Promise.resolve(
        where.id === ADULT_PERSON ? { householdId: ADULT_HOUSEHOLD } : { householdId: 99, household: { householdMembers: [] } },
    ));
    tx.trustedAdult.create.mockResolvedValue({ id: 3, reviews: [] });
    tx.trustedAdultReview.findUnique.mockResolvedValue({
        ...head, id: 9, householdId: HOUSEHOLD, kind: "INITIAL", status: "PENDING_BOARD_REVIEW", createdAt: new Date(),
    });
    tx.trustedAdultReview.aggregate.mockResolvedValue({ _max: { reviewBy: null } });
    tx.trustedAdultReview.findMany.mockResolvedValue([]);
    tx.trustedAdultReview.update.mockResolvedValue({ id: 9, status: "APPROVED" });
    mockDb.household.findUnique.mockResolvedValue({ id: HOUSEHOLD });
    mockDb.trustedAdultReview.findUnique.mockResolvedValue(head);
    mockDb.person.findUnique.mockResolvedValue({ householdId: 99, household: { householdMembers: [] } });
    mockDb.trustedAdult.findUnique.mockResolvedValue({ id: 3, householdId: HOUSEHOLD, trustedAdultPersonId: ADULT_PERSON });
    mockDb.person.findFirst.mockResolvedValue({ id: 1 });
    mockDb.household.count.mockResolvedValue(1);
    tx.trustedAdultReview.findFirst.mockResolvedValue({ id: 9, status: "REVOKED" });
    tx.trustedAdultReview.create.mockResolvedValue({ id: 10, status: "PENDING_BOARD_REVIEW" });
    tx.trustedAdult.findUniqueOrThrow.mockResolvedValue({
        trustedAdultName: "Gran", trustedAdultPhone: null, trustedAdultEmail: "gran@example.com", familyContext: "May pick up the kids.",
    });
});

const resubmitInput = { trustedAdultName: "Gran B", trustedAdultEmail: "gran@example.com", familyContext: "May pick up the kids." };

const deniedCheck = { where: { householdId: { in: [HOUSEHOLD, ADULT_HOUSEHOLD] }, status: "DENIED" } };

const awaitingInfo = { id: 9, status: "PENDING_SUBJECT_ACTION", proposedName: null };
const answerInput = { ...resubmitInput, reply: "Weekdays only." };

describe("trusted adult whose household's membership is denied", () => {
    it("createTrustedAdult refuses and creates nothing", async () => {
        tx.$queryRaw.mockResolvedValue([{ status: "DENIED" }]);
        await expect(createTrustedAdult(createInput)).rejects.toMatchObject({ code: "wrong_phase" });
        // A membership-row lock on each of the two households.
        expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
        expect(tx.trustedAdult.create).not.toHaveBeenCalled();
        expect(tx.auditLog.create).not.toHaveBeenCalled();
        expect(emailBoardMembers).not.toHaveBeenCalled();
    });

    it("decideReview refuses an approval and writes no decision", async () => {
        tx.orgMembership.count.mockResolvedValue(1);
        await expect(decideReview(9, 2, { decision: "APPROVE", sharedNote: "May pick up." }))
            .rejects.toMatchObject({ code: "wrong_phase" });
        expect(tx.orgMembership.count).toHaveBeenCalledWith(deniedCheck);
        expect(tx.trustedAdultReview.update).not.toHaveBeenCalled();
        expect(tx.auditLog.create).not.toHaveBeenCalled();
    });

    it("renewTrustedAdult refuses and opens no review", async () => {
        tx.orgMembership.count.mockResolvedValue(1);
        await expect(renewTrustedAdult(3, 1)).rejects.toMatchObject({ code: "wrong_phase" });
        expect(tx.orgMembership.count).toHaveBeenCalledWith(deniedCheck);
        expect(tx.trustedAdultReview.create).not.toHaveBeenCalled();
        expect(tx.auditLog.create).not.toHaveBeenCalled();
        expect(emailBoardMembers).not.toHaveBeenCalled();
    });

    it("resubmitWithChanges refuses and opens no review", async () => {
        tx.orgMembership.count.mockResolvedValue(1);
        await expect(resubmitWithChanges(3, 1, resubmitInput)).rejects.toMatchObject({ code: "wrong_phase" });
        expect(tx.orgMembership.count).toHaveBeenCalledWith(deniedCheck);
        expect(tx.trustedAdultReview.create).not.toHaveBeenCalled();
        expect(tx.auditLog.create).not.toHaveBeenCalled();
        expect(emailBoardMembers).not.toHaveBeenCalled();
    });

    it("answerInfoRequest refuses and leaves the review with the family", async () => {
        tx.orgMembership.count.mockResolvedValue(1);
        tx.trustedAdultReview.findFirst.mockResolvedValue(awaitingInfo);
        await expect(answerInfoRequest(3, 1, answerInput)).rejects.toMatchObject({ code: "wrong_phase" });
        expect(tx.orgMembership.count).toHaveBeenCalledWith(deniedCheck);
        expect(tx.trustedAdultReview.update).not.toHaveBeenCalled();
        expect(tx.auditLog.create).not.toHaveBeenCalled();
        expect(emailBoardMembers).not.toHaveBeenCalled();
    });

    it("decideReview still lets the board deny", async () => {
        tx.orgMembership.count.mockResolvedValue(1);
        tx.trustedAdultReview.update.mockResolvedValue({ id: 9, status: "DENIED" });
        await expect(decideReview(9, 2, { decision: "DENY" })).resolves.toMatchObject({ status: "DENIED" });
        expect(tx.auditLog.create).toHaveBeenCalled();
        expect(emailHouseholdLeads).toHaveBeenCalledWith(HOUSEHOLD, "trustedAdult.notApproved", expect.anything(), expect.any(String));
    });
});

describe("trusted adult whose household is not denied", () => {
    beforeEach(() => tx.orgMembership.count.mockResolvedValue(0));

    it("createTrustedAdult creates the adult", async () => {
        await expect(createTrustedAdult(createInput)).resolves.toMatchObject({ id: 3 });
        expect(tx.trustedAdult.create).toHaveBeenCalled();
        expect(tx.auditLog.create).toHaveBeenCalled();
        expect(emailBoardMembers).toHaveBeenCalled();
    });

    it("decideReview approves", async () => {
        await expect(decideReview(9, 2, { decision: "APPROVE", sharedNote: "May pick up." }))
            .resolves.toMatchObject({ status: "APPROVED" });
        expect(tx.trustedAdultReview.update).toHaveBeenCalled();
        expect(tx.auditLog.create).toHaveBeenCalled();
    });

    it("renewTrustedAdult opens a renewal", async () => {
        await expect(renewTrustedAdult(3, 1)).resolves.toMatchObject({ id: 10 });
        expect(tx.auditLog.create).toHaveBeenCalled();
        expect(emailBoardMembers).toHaveBeenCalled();
    });

    it("resubmitWithChanges opens a change", async () => {
        await expect(resubmitWithChanges(3, 1, resubmitInput)).resolves.toMatchObject({ id: 10 });
        expect(tx.auditLog.create).toHaveBeenCalled();
        expect(emailBoardMembers).toHaveBeenCalled();
    });

    it("answerInfoRequest sends the answer to the board", async () => {
        tx.trustedAdultReview.findFirst.mockResolvedValue(awaitingInfo);
        await expect(answerInfoRequest(3, 1, answerInput)).resolves.toMatchObject({ id: 9 });
        expect(tx.auditLog.create).toHaveBeenCalled();
        expect(emailBoardMembers).toHaveBeenCalled();
    });
});
