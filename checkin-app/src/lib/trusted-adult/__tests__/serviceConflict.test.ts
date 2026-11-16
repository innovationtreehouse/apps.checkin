const mockDb = {
    trustedAdultReview: { findUnique: jest.fn() },
    person: { findUnique: jest.fn() },
    auditLog: { create: jest.fn() },
    $transaction: jest.fn(),
};
jest.mock("@/lib/prisma", () => ({ __esModule: true, get default() { return mockDb; } }));

import { decideReview, resetReview } from "@/lib/trusted-adult/service";

const BOARD_MEMBER = 1;
const REVIEW = 9;

// Another family's trusted adult whose email belongs to the board member's spouse.
const review = {
    trustedAdultId: 3,
    proposedEmail: null,
    proposedPhone: null,
    trustedAdult: {
        householdId: 20,
        trustedAdultPersonId: null,
        trustedAdultName: "Sam Spouse",
        trustedAdultEmail: "spouse@example.com",
        trustedAdultPhone: null,
        trustedAdultPerson: null,
    },
};

beforeEach(() => {
    jest.clearAllMocks();
    mockDb.trustedAdultReview.findUnique.mockResolvedValue(review);
    mockDb.person.findUnique.mockResolvedValue({
        householdId: 10,
        household: { householdMembers: [{ email: "me@example.com", phone: null }, { email: "Spouse@example.com", phone: null }] },
    });
});

const refusalAudit = {
    data: {
        actorId: BOARD_MEMBER,
        affectedEntityId: REVIEW,
        action: "EDIT",
        tableName: "SelfGrantRefusal",
        newData: { reason: "household_contact_match", table: "TrustedAdultReview" },
    },
};

describe("trusted-adult review: adult in the deciding board member's household", () => {
    it("decideReview refuses and audits the refusal, writing no decision", async () => {
        await expect(decideReview(REVIEW, BOARD_MEMBER, { decision: "APPROVE", sharedNote: "May pick up." }))
            .rejects.toMatchObject({ code: "forbidden" });
        expect(mockDb.auditLog.create).toHaveBeenCalledWith(refusalAudit);
        expect(mockDb.$transaction).not.toHaveBeenCalled();
    });

    it("resetReview refuses and audits the refusal, writing nothing", async () => {
        await expect(resetReview(REVIEW, BOARD_MEMBER, "Second look."))
            .rejects.toMatchObject({ code: "forbidden" });
        expect(mockDb.auditLog.create).toHaveBeenCalledWith(refusalAudit);
        expect(mockDb.$transaction).not.toHaveBeenCalled();
    });
});
