/**
 * @jest-environment node
 */
/**
 * The treasurer flag's own-household rule: nobody sets or clears it on
 * themself or anyone in their household, and a refusal writes nothing. A
 * permitted change writes the flag and one audit row together.
 */
import { setProgramTreasurer, OWN_HOUSEHOLD_MESSAGE } from '../budgetOwners';

const households: Record<number, number> = { 1: 10, 2: 10, 3: 20 };
const tx = {
    programVolunteer: { findUnique: jest.fn(), update: jest.fn() },
    auditLog: { create: jest.fn() },
};
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        person: {
            findUnique: ({ where }: { where: { id: number } }) =>
                Promise.resolve(where.id in households ? { householdId: households[where.id] } : null),
        },
        $transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    },
}));

beforeEach(() => {
    jest.clearAllMocks();
    tx.programVolunteer.findUnique.mockResolvedValue({ programId: 7, personId: 3, isTreasurer: false });
    tx.programVolunteer.update.mockResolvedValue({ programId: 7, personId: 3, isTreasurer: true });
});

describe('setProgramTreasurer', () => {
    test.each([
        ['themself', 1],
        ['their own household', 2],
    ])('refuses an actor setting %s, writing nothing', async (_label, target) => {
        await expect(setProgramTreasurer(1, 7, target, true)).rejects.toMatchObject({ status: 403, message: OWN_HOUSEHOLD_MESSAGE });
        await expect(setProgramTreasurer(1, 7, target, false)).rejects.toMatchObject({ status: 403 });
        expect(tx.programVolunteer.update).not.toHaveBeenCalled();
        expect(tx.auditLog.create).not.toHaveBeenCalled();
    });

    test('sets the flag on another household and audits the change', async () => {
        await expect(setProgramTreasurer(1, 7, 3, true)).resolves.toMatchObject({ isTreasurer: true });
        expect(tx.programVolunteer.update).toHaveBeenCalledTimes(1);
        expect(tx.auditLog.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                actorId: 1, action: 'EDIT', tableName: 'ProgramVolunteer', affectedEntityId: 3, secondaryAffectedEntity: 7,
                oldData: { isTreasurer: false }, newData: { isTreasurer: true },
            }),
        });
    });

    test('an unchanged flag writes nothing', async () => {
        await setProgramTreasurer(1, 7, 3, false);
        expect(tx.programVolunteer.update).not.toHaveBeenCalled();
        expect(tx.auditLog.create).not.toHaveBeenCalled();
    });
});
