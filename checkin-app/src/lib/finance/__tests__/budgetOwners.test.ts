/**
 * @jest-environment node
 */
/**
 * The treasurer flag's own-household rule: nobody sets or clears it on
 * themself or anyone in their household, and a refusal writes nothing. A
 * permitted change writes the flag and one audit row together. A merged-away
 * (tombstoned) person is refused as not found.
 */
import { createBudgetOwner, listQuickBooksClasses, setProgramTreasurer, updateBudgetOwner, OWN_HOUSEHOLD_MESSAGE } from '../budgetOwners';
import { getQuickBooks } from '@/lib/quickbooks/client';

const households: Record<number, number> = { 1: 10, 2: 10, 3: 20, 4: 30 };
const mergedInto: Record<number, number> = { 4: 3 };
const tx = {
    programVolunteer: { findUnique: jest.fn(), update: jest.fn() },
    auditLog: { create: jest.fn() },
};
jest.mock('@/lib/quickbooks/client', () => ({ getQuickBooks: jest.fn() }));
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        person: {
            findUnique: ({ where }: { where: { id: number } }) =>
                Promise.resolve(where.id in households ? { householdId: households[where.id] } : null),
            findFirst: ({ where }: { where: { id: number; mergedIntoId?: null } }) => {
                const isMatch = where.id in households && !(where.mergedIntoId === null && where.id in mergedInto);
                return Promise.resolve(isMatch ? { householdId: households[where.id] } : null);
            },
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

    test.each([true, false])('refuses a merged-away person as not found (on=%s), writing nothing', async (on) => {
        await expect(setProgramTreasurer(1, 7, 4, on)).rejects.toMatchObject({ status: 404, message: 'Person not found' });
        expect(tx.programVolunteer.update).not.toHaveBeenCalled();
        expect(tx.auditLog.create).not.toHaveBeenCalled();
    });

    test('an unchanged flag writes nothing', async () => {
        await setProgramTreasurer(1, 7, 3, false);
        expect(tx.programVolunteer.update).not.toHaveBeenCalled();
        expect(tx.auditLog.create).not.toHaveBeenCalled();
    });
});

describe('QuickBooks Class id', () => {
    test.each(['abc', '12a', 'class-7', '1 2'])('refuses a non-numeric id %p on create and update', async (classId) => {
        await expect(createBudgetOwner(1, { name: 'Robotics', quickBooksClassId: classId })).rejects.toMatchObject({ status: 400 });
        await expect(updateBudgetOwner(1, 5, { quickBooksClassId: classId })).rejects.toMatchObject({ status: 400 });
        expect(tx.auditLog.create).not.toHaveBeenCalled();
    });
});

describe('listQuickBooksClasses', () => {
    test('lists every Class by full name, sorted, with inactive ones flagged', async () => {
        const classes = jest.fn().mockResolvedValue([
            { Id: '9', Name: 'Robotics', FullyQualifiedName: 'Programs:Robotics' }, // no Active field: active
            { Id: '3', Name: 'Facility', FullyQualifiedName: 'Facility', Active: true },
            { Id: '4', Name: 'Old', FullyQualifiedName: 'Old', Active: false },
        ]);
        jest.mocked(getQuickBooks).mockResolvedValue({ classes } as unknown as Awaited<ReturnType<typeof getQuickBooks>>);
        await expect(listQuickBooksClasses()).resolves.toEqual([
            { id: '3', name: 'Facility', active: true },
            { id: '4', name: 'Old', active: false },
            { id: '9', name: 'Programs:Robotics', active: true },
        ]);
    });

    test('answers 503 while QuickBooks is off', async () => {
        jest.mocked(getQuickBooks).mockResolvedValue(null);
        await expect(listQuickBooksClasses()).rejects.toMatchObject({ status: 503 });
    });

    test('answers 503, not 500, when QuickBooks fails the request', async () => {
        const classes = jest.fn().mockRejectedValue(new Error('QuickBooks query failed: codes 3200'));
        jest.mocked(getQuickBooks).mockResolvedValue({ classes } as unknown as Awaited<ReturnType<typeof getQuickBooks>>);
        jest.spyOn(console, 'error').mockImplementation(() => {});
        await expect(listQuickBooksClasses()).rejects.toMatchObject({ status: 503, message: 'QuickBooks did not return its Classes. Try again shortly.' });
    });

    test('an empty company lists no Classes', async () => {
        const classes = jest.fn().mockResolvedValue([]);
        jest.mocked(getQuickBooks).mockResolvedValue({ classes } as unknown as Awaited<ReturnType<typeof getQuickBooks>>);
        await expect(listQuickBooksClasses()).resolves.toEqual([]);
    });
});
