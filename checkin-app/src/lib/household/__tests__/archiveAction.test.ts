import { archiveHousehold, unarchiveOnSignIn } from "@/lib/household/archiveAction";
import { withArchivedHouseholds } from "@/lib/household/archived";

jest.mock("@/lib/household/archived", () => ({ withArchivedHouseholds: jest.fn() }));
jest.mock("@/lib/email", () => ({ sendEmail: jest.fn() }));
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
        budgetOwnerTreasurer: { findFirst: none() },
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
        expect(tx.budgetOwner.findFirst).toHaveBeenCalledWith({ where: { owner: { householdId: 7 }, archivedAt: null }, select: { id: true } });
        expect(tx.household.updateMany).not.toHaveBeenCalled();
    });

    it("refuses while a member is a treasurer of a bucket, and archives nothing", async () => {
        tx.budgetOwnerTreasurer.findFirst.mockResolvedValue({ personId: 5 });
        await expect(archiveHousehold(7, 1)).rejects.toMatchObject({
            status: 409,
            message: "Someone in this household is a treasurer of a bucket. Remove them as treasurer before archiving the household.",
        });
        expect(tx.budgetOwnerTreasurer.findFirst).toHaveBeenCalledWith({
            where: { person: { householdId: 7 }, budgetOwner: { archivedAt: null } },
            select: { personId: true },
        });
        expect(tx.household.updateMany).not.toHaveBeenCalled();
    });
});

describe("unarchiveOnSignIn", () => {
    const archivedAt = new Date("2025-01-01T00:00:00Z");
    // The membership row, then the household row: the two locks it takes, in that order.
    const rows = (status: string | null, householdArchivedAt: Date | null) => {
        tx.$queryRaw.mockResolvedValueOnce(status ? [{ status }] : []).mockResolvedValueOnce([{ archivedAt: householdArchivedAt }]);
    };

    it("unarchives with a system actor and an audit row naming sign-in, and sends no email", async () => {
        rows("REVOKED", archivedAt);

        await expect(unarchiveOnSignIn(7, 12)).resolves.toBe(true);

        expect(tx.household.updateMany).toHaveBeenCalledWith({ where: { id: 7, archivedAt: { not: null } }, data: { archivedAt: null } });
        expect(tx.auditLog.create).toHaveBeenCalledWith({
            data: {
                actorId: 0,
                actorSystem: "system:sign-in",
                action: "EDIT",
                tableName: "Household",
                affectedEntityId: 7,
                oldData: { archivedAt },
                newData: { archivedAt: null, reason: "sign_in", signedInBy: 12 },
            },
        });
        expect(jest.requireMock("@/lib/email").sendEmail).not.toHaveBeenCalled();
    });

    it("unarchives a household with no membership", async () => {
        rows(null, archivedAt);
        await expect(unarchiveOnSignIn(7, 12)).resolves.toBe(true);
    });

    it("leaves a denied household archived", async () => {
        rows("DENIED", archivedAt);

        await expect(unarchiveOnSignIn(7, 12)).resolves.toBe(false);

        expect(tx.household.updateMany).not.toHaveBeenCalled();
        expect(tx.auditLog.create).not.toHaveBeenCalled();
    });

    it("is a no-op on a household that is already live", async () => {
        rows("ACTIVE", null);

        await expect(unarchiveOnSignIn(7, 12)).resolves.toBe(false);

        expect(tx.household.updateMany).not.toHaveBeenCalled();
        expect(tx.auditLog.create).not.toHaveBeenCalled();
    });
});
