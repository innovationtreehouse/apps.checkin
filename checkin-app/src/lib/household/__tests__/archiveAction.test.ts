import { archiveHousehold } from "@/lib/household/archiveAction";
import { withArchivedHouseholds } from "@/lib/household/archived";

jest.mock("@/lib/household/archived", () => ({ withArchivedHouseholds: jest.fn() }));
jest.mock("@/lib/membership/archive", () => ({
    closeForRestore: jest.fn(),
    countOpenApplications: jest.fn().mockResolvedValue(0),
    lockOpenApplications: jest.fn().mockResolvedValue([]),
}));

const none = () => jest.fn().mockResolvedValue(null);

function fakeTx() {
    return {
        household: {
            findUnique: jest.fn().mockResolvedValue({ archivedAt: null }),
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 7 }),
        },
        orgMembership: { findUnique: none() },
        programParticipant: { findFirst: none() },
        personRole: { findFirst: none() },
        programVolunteer: { findFirst: none() },
        program: { findFirst: none() },
        programInstance: { findFirst: none() },
        budgetOwner: { findFirst: none() },
        trustedAdultReview: { findFirst: none() },
        auditLog: { create: jest.fn() },
        $queryRaw: jest.fn().mockResolvedValue([]),
    };
}

let tx: ReturnType<typeof fakeTx>;

beforeEach(() => {
    tx = fakeTx();
    (withArchivedHouseholds as jest.Mock).mockImplementation((fn: (t: typeof tx) => unknown) => fn(tx));
});

describe("archiveHousehold bucket refusals", () => {
    it("archives a household with no bucket position", async () => {
        await expect(archiveHousehold(7, 1)).resolves.toEqual({ id: 7 });
    });

    it("refuses while a member owns a bucket, and archives nothing", async () => {
        tx.budgetOwner.findFirst.mockResolvedValue({ id: 3 });
        await expect(archiveHousehold(7, 1)).rejects.toMatchObject({
            status: 409,
            message: "Someone in this household owns a bucket. Name a new owner before archiving the household.",
        });
        expect(tx.budgetOwner.findFirst).toHaveBeenCalledWith({ where: { owner: { householdId: 7 } }, select: { id: true } });
        expect(tx.household.updateMany).not.toHaveBeenCalled();
    });
});
