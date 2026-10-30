import prisma from "@/lib/prisma";
import { ownRejectedProcessIds } from "@/lib/membership/review";

jest.mock("@/lib/prisma", () => ({
    __esModule: true,
    default: {
        person: { findUnique: jest.fn() },
        orgMembershipProcess: { findMany: jest.fn() },
    },
}));

const db = prisma as unknown as {
    person: { findUnique: jest.Mock };
    orgMembershipProcess: { findMany: jest.Mock };
};

const householdRow = (id: number, status: string) => ({ id, subjectPersonId: null, subjectPerson: null, orgMembership: { status } });
const personBgRow = (id: number, status: string | null) => ({
    id,
    subjectPersonId: 50 + id,
    subjectPerson: { household: status ? { orgMembership: { status } } : null },
    orgMembership: null,
});

beforeEach(() => {
    jest.clearAllMocks();
    db.person.findUnique.mockResolvedValue({ id: 1, householdId: 10, isBackgroundCheckReviewer: true, isBoardMember: false });
});

describe("ownRejectedProcessIds", () => {
    it("leaves out applications whose household is denied", async () => {
        db.orgMembershipProcess.findMany.mockResolvedValue([
            householdRow(1, "NONE"),
            householdRow(2, "DENIED"),
            personBgRow(3, "ACTIVE"),
            personBgRow(4, "DENIED"),
            personBgRow(5, null),
        ]);

        await expect(ownRejectedProcessIds(1)).resolves.toEqual([1, 3, 5]);
        expect(db.orgMembershipProcess.findMany).toHaveBeenCalledWith(expect.objectContaining({
            where: { status: "BLOCKED", attestations: { some: { reviewerId: 1, result: "REJECT" } } },
        }));
    });

    it("judges a PERSON_BG by its subject's household, not a membership on the row", async () => {
        db.orgMembershipProcess.findMany.mockResolvedValue([
            { ...personBgRow(1, "ACTIVE"), orgMembership: { status: "DENIED" } },
        ]);

        await expect(ownRejectedProcessIds(1)).resolves.toEqual([1]);
    });

    it("returns nothing for someone who is not a reviewer", async () => {
        db.person.findUnique.mockResolvedValue({ id: 1, householdId: 10, isBackgroundCheckReviewer: false, isBoardMember: false });

        await expect(ownRejectedProcessIds(1)).resolves.toEqual([]);
        expect(db.orgMembershipProcess.findMany).not.toHaveBeenCalled();
    });
});
