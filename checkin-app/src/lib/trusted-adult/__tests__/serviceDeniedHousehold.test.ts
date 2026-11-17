const tx = {
    $queryRaw: jest.fn(),
    person: { findUnique: jest.fn() },
    orgMembership: { count: jest.fn() },
    trustedAdult: { create: jest.fn() },
    trustedAdultReview: { findUnique: jest.fn(), aggregate: jest.fn(), findMany: jest.fn(), update: jest.fn() },
    auditLog: { create: jest.fn() },
};
const mockDb = {
    household: { findUnique: jest.fn() },
    trustedAdultReview: { findUnique: jest.fn(), findFirst: jest.fn() },
    person: { findUnique: jest.fn() },
    $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
};
jest.mock("@/lib/prisma", () => ({ __esModule: true, get default() { return mockDb; } }));
jest.mock("@/lib/emailRecipients", () => ({ emailBoardMembers: jest.fn(), emailHouseholdLeads: jest.fn() }));

import { createTrustedAdult, decideReview } from "@/lib/trusted-adult/service";

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
    tx.person.findUnique.mockResolvedValue({ householdId: ADULT_HOUSEHOLD });
    tx.trustedAdult.create.mockResolvedValue({ id: 3, reviews: [] });
    tx.trustedAdultReview.findUnique.mockResolvedValue({
        id: 9, trustedAdultId: 3, householdId: HOUSEHOLD, kind: "INITIAL", status: "PENDING_BOARD_REVIEW", createdAt: new Date(),
    });
    tx.trustedAdultReview.aggregate.mockResolvedValue({ _max: { reviewBy: null } });
    tx.trustedAdultReview.findMany.mockResolvedValue([]);
    tx.trustedAdultReview.update.mockResolvedValue({ id: 9, status: "APPROVED" });
    mockDb.household.findUnique.mockResolvedValue({ id: HOUSEHOLD });
    mockDb.trustedAdultReview.findUnique.mockResolvedValue(head);
    mockDb.person.findUnique.mockResolvedValue({ householdId: 99, household: { householdMembers: [] } });
});

const deniedCheck = { where: { householdId: { in: [HOUSEHOLD, ADULT_HOUSEHOLD] }, status: "DENIED" } };

describe("trusted adult whose household's membership is denied", () => {
    it("createTrustedAdult refuses and creates nothing", async () => {
        tx.$queryRaw.mockResolvedValue([{ status: "DENIED" }]);
        await expect(createTrustedAdult(createInput)).rejects.toMatchObject({ code: "wrong_phase" });
        // A membership-row lock on each of the two households.
        expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
        expect(tx.trustedAdult.create).not.toHaveBeenCalled();
    });

    it("decideReview refuses an approval and writes no decision", async () => {
        tx.orgMembership.count.mockResolvedValue(1);
        await expect(decideReview(9, 2, { decision: "APPROVE", sharedNote: "May pick up." }))
            .rejects.toMatchObject({ code: "wrong_phase" });
        expect(tx.orgMembership.count).toHaveBeenCalledWith(deniedCheck);
        expect(tx.trustedAdultReview.update).not.toHaveBeenCalled();
    });

    it("decideReview still lets the board deny", async () => {
        tx.orgMembership.count.mockResolvedValue(1);
        tx.trustedAdultReview.update.mockResolvedValue({ id: 9, status: "DENIED" });
        await expect(decideReview(9, 2, { decision: "DENY" })).resolves.toMatchObject({ status: "DENIED" });
    });
});

describe("trusted adult whose household is not denied", () => {
    beforeEach(() => tx.orgMembership.count.mockResolvedValue(0));

    it("createTrustedAdult creates the adult", async () => {
        await expect(createTrustedAdult(createInput)).resolves.toMatchObject({ id: 3 });
        expect(tx.trustedAdult.create).toHaveBeenCalled();
    });

    it("decideReview approves", async () => {
        await expect(decideReview(9, 2, { decision: "APPROVE", sharedNote: "May pick up." }))
            .resolves.toMatchObject({ status: "APPROVED" });
    });
});
