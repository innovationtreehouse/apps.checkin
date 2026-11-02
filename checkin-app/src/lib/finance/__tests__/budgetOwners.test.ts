/**
 * @jest-environment node
 */
/**
 * A bucket's owner and treasurers follow the own-household rule: nobody names
 * or removes themself or anyone in their household, and a refusal writes
 * nothing. A permitted change writes the row and one audit row together. An
 * unknown person is refused as not found, and an org-level bucket takes no
 * approvers. Whether a bucket is org-level changes only when no approver or
 * awaited Board seat depends on it, and a restore brings an archived bucket back.
 */
import { createBudgetOwner, listQuickBooksClasses, LOCAL_QUICKBOOKS_CLASSES, setBucketOwner, setBucketTreasurer, updateBudgetOwner, OWN_HOUSEHOLD_MESSAGE } from '../budgetOwners';
import { getQuickBooks } from '@/lib/quickbooks/client';
import { linesAwaitingBoardSeat } from '@checkin/expense';

const households: Record<number, number> = { 1: 10, 2: 10, 3: 20, 4: 30, 5: 40 };
const buckets: Record<number, { isOrgLevel: boolean; ownerId: number | null }> = {
    7: { isOrgLevel: false, ownerId: null },
    8: { isOrgLevel: true, ownerId: null },
    9: { isOrgLevel: false, ownerId: 2 },
};
const tx = {
    budgetOwner: { create: jest.fn(), update: jest.fn(), findUnique: jest.fn() },
    budgetOwnerTreasurer: { findUnique: jest.fn(), create: jest.fn(), delete: jest.fn() },
    auditLog: { create: jest.fn() },
};
jest.mock('@/lib/quickbooks/client', () => ({ getQuickBooks: jest.fn() }));
jest.mock('@checkin/expense', () => ({ linesAwaitingBoardSeat: jest.fn() }));
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        person: {
            findUnique: ({ where }: { where: { id: number } }) =>
                Promise.resolve(where.id in households ? { householdId: households[where.id] } : null),
            findFirst: ({ where }: { where: { id: number } }) =>
                Promise.resolve(where.id in households ? { householdId: households[where.id] } : null),
        },
        budgetOwner: {
            findUnique: ({ where, select }: { where: { id: number }; select: Record<string, unknown> }) => {
                const b = buckets[where.id];
                if (!b) return Promise.resolve(null);
                if ('treasurers' in select) return Promise.resolve({ owner: null, treasurers: [] });
                return Promise.resolve(b);
            },
        },
        $transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    },
}));

beforeEach(() => {
    jest.clearAllMocks();
    tx.budgetOwnerTreasurer.findUnique.mockResolvedValue(null);
});

const nothingWritten = () => {
    expect(tx.budgetOwner.update).not.toHaveBeenCalled();
    expect(tx.budgetOwnerTreasurer.create).not.toHaveBeenCalled();
    expect(tx.budgetOwnerTreasurer.delete).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
};

describe('setBucketTreasurer', () => {
    test.each([
        ['themself', 1],
        ['their own household', 2],
    ])('refuses an actor setting %s, writing nothing', async (_label, target) => {
        await expect(setBucketTreasurer(1, 7, target, true)).rejects.toMatchObject({ status: 403, message: OWN_HOUSEHOLD_MESSAGE });
        await expect(setBucketTreasurer(1, 7, target, false)).rejects.toMatchObject({ status: 403 });
        nothingWritten();
    });

    test('adds a treasurer from another household and audits it', async () => {
        await setBucketTreasurer(1, 7, 3, true);
        expect(tx.budgetOwnerTreasurer.create).toHaveBeenCalledWith({ data: { budgetOwnerId: 7, personId: 3 } });
        expect(tx.auditLog.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                actorId: 1, action: 'CREATE', tableName: 'BudgetOwnerTreasurer', affectedEntityId: 3, secondaryAffectedEntity: 7,
            }),
        });
    });

    test('removes a treasurer and audits it', async () => {
        tx.budgetOwnerTreasurer.findUnique.mockResolvedValue({ personId: 3 });
        await setBucketTreasurer(1, 7, 3, false);
        expect(tx.budgetOwnerTreasurer.delete).toHaveBeenCalledWith({ where: { budgetOwnerId_personId: { budgetOwnerId: 7, personId: 3 } } });
        expect(tx.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: 'DELETE', tableName: 'BudgetOwnerTreasurer' }) });
    });

    test('an unchanged treasurer writes nothing', async () => {
        await setBucketTreasurer(1, 7, 3, false);
        nothingWritten();
    });

    test.each([true, false])('refuses an unknown person as not found (on=%s), writing nothing', async (on) => {
        await expect(setBucketTreasurer(1, 7, 99, on)).rejects.toMatchObject({ status: 404, message: 'Person not found' });
        nothingWritten();
    });

    test('refuses an org-level bucket', async () => {
        await expect(setBucketTreasurer(1, 8, 3, true)).rejects.toMatchObject({ status: 409 });
        nothingWritten();
    });
});

describe('setBucketOwner', () => {
    test('names an owner from another household and audits it', async () => {
        await setBucketOwner(1, 7, 3);
        expect(tx.budgetOwner.update).toHaveBeenCalledWith({ where: { id: 7 }, data: { ownerId: 3 } });
        expect(tx.auditLog.create).toHaveBeenCalledWith({
            data: expect.objectContaining({ action: 'EDIT', tableName: 'BudgetOwner', affectedEntityId: 7, oldData: { ownerId: null }, newData: { ownerId: 3 } }),
        });
    });

    test('refuses naming the actor or their household', async () => {
        await expect(setBucketOwner(1, 7, 1)).rejects.toMatchObject({ status: 403 });
        await expect(setBucketOwner(1, 7, 2)).rejects.toMatchObject({ status: 403 });
        nothingWritten();
    });

    test("refuses replacing or clearing an owner in the actor's household", async () => {
        await expect(setBucketOwner(1, 9, 3)).rejects.toMatchObject({ status: 403 });
        await expect(setBucketOwner(1, 9, null)).rejects.toMatchObject({ status: 403 });
        nothingWritten();
    });

    test('lets someone outside both households replace the owner', async () => {
        await setBucketOwner(5, 9, 3);
        expect(tx.budgetOwner.update).toHaveBeenCalledWith({ where: { id: 9 }, data: { ownerId: 3 } });
    });

    test('refuses an org-level bucket', async () => {
        await expect(setBucketOwner(1, 8, 3)).rejects.toMatchObject({ status: 409 });
        nothingWritten();
    });
});

describe('updateBudgetOwner: org-level and restore', () => {
    const awaiting = linesAwaitingBoardSeat as jest.Mock;
    const stored = (over: Record<string, unknown> = {}) => ({
        name: 'Shop', quickBooksClassId: '12', isOrgLevel: false, archivedAt: null, ownerId: null, _count: { treasurers: 0 }, ...over,
    });

    beforeEach(() => {
        awaiting.mockResolvedValue(0);
        tx.budgetOwner.update.mockResolvedValue({ id: 7 });
    });

    test.each([
        ['an owner', { ownerId: 2 }],
        ['a treasurer', { _count: { treasurers: 1 } }],
    ])('refuses to make a bucket holding %s org-level, writing nothing', async (_name, over) => {
        tx.budgetOwner.findUnique.mockResolvedValue(stored(over));
        await expect(updateBudgetOwner(1, 7, { isOrgLevel: true })).rejects.toMatchObject({
            status: 409,
            message: "The Board must remove this bucket's owner and treasurers first.",
        });
        nothingWritten();
    });

    test('makes a bucket with no approvers org-level and audits the change', async () => {
        tx.budgetOwner.findUnique.mockResolvedValue(stored());
        await updateBudgetOwner(1, 7, { isOrgLevel: true });
        expect(tx.budgetOwner.update).toHaveBeenCalledWith(expect.objectContaining({ data: { isOrgLevel: true } }));
        expect(tx.auditLog.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                action: 'EDIT',
                tableName: 'BudgetOwner',
                affectedEntityId: 7,
                oldData: expect.objectContaining({ isOrgLevel: false }),
                newData: { isOrgLevel: true },
            }),
        });
        expect(awaiting).not.toHaveBeenCalled();
    });

    test('refuses to make an org-level bucket a program bucket while a Board seat is awaited, writing nothing', async () => {
        tx.budgetOwner.findUnique.mockResolvedValue(stored({ isOrgLevel: true }));
        awaiting.mockResolvedValue(2);
        await expect(updateBudgetOwner(1, 8, { isOrgLevel: false })).rejects.toMatchObject({
            status: 409,
            message: 'Open expenses in this bucket still need a Board signature; have them signed or recorded first.',
        });
        expect(awaiting).toHaveBeenCalledWith(8);
        nothingWritten();
    });

    test('makes an org-level bucket a program bucket with no Board seat awaited, and audits the change', async () => {
        tx.budgetOwner.findUnique.mockResolvedValue(stored({ isOrgLevel: true }));
        await updateBudgetOwner(1, 8, { isOrgLevel: false });
        expect(tx.auditLog.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                action: 'EDIT',
                oldData: expect.objectContaining({ isOrgLevel: true }),
                newData: { isOrgLevel: false },
            }),
        });
    });

    test('an edit that keeps the flag checks neither approvers nor seats', async () => {
        tx.budgetOwner.findUnique.mockResolvedValue(stored({ ownerId: 2 }));
        await updateBudgetOwner(1, 9, { name: 'Renamed', isOrgLevel: false });
        expect(awaiting).not.toHaveBeenCalled();
        expect(tx.budgetOwner.update).toHaveBeenCalled();
    });

    test('rejects a flag that is not a boolean', async () => {
        await expect(updateBudgetOwner(1, 7, { isOrgLevel: 'yes' })).rejects.toMatchObject({ status: 400 });
        nothingWritten();
    });

    test('restores an archived bucket and audits it', async () => {
        const archivedAt = new Date('2026-10-01');
        tx.budgetOwner.findUnique.mockResolvedValue(stored({ archivedAt }));
        await updateBudgetOwner(1, 7, { archived: false });
        expect(tx.budgetOwner.update).toHaveBeenCalledWith(expect.objectContaining({ data: { archivedAt: null } }));
        expect(tx.auditLog.create).toHaveBeenCalledWith({
            data: expect.objectContaining({ action: 'EDIT', oldData: expect.objectContaining({ archivedAt }), newData: { archivedAt: null } }),
        });
    });

    test('archives only through the archive route', async () => {
        await expect(updateBudgetOwner(1, 7, { archived: true })).rejects.toMatchObject({ status: 400 });
        nothingWritten();
    });
});

describe('createBudgetOwner', () => {
    test('records whether the bucket is org-level', async () => {
        tx.budgetOwner.create.mockResolvedValue({ id: 11 });
        await createBudgetOwner(1, { name: 'Facility', isOrgLevel: true });
        expect(tx.budgetOwner.create).toHaveBeenCalledWith(expect.objectContaining({ data: { name: 'Facility', isOrgLevel: true, quickBooksClassId: null } }));
    });

    test('refuses a non-boolean isOrgLevel', async () => {
        await expect(createBudgetOwner(1, { name: 'Facility', isOrgLevel: 'yes' })).rejects.toMatchObject({ status: 400 });
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

    describe('by CHECKIN_ENV', () => {
        const saved = process.env.CHECKIN_ENV;
        afterEach(() => { process.env.CHECKIN_ENV = saved; });

        test('local lists the stand-in Classes without asking QuickBooks', async () => {
            process.env.CHECKIN_ENV = 'local';
            jest.mocked(getQuickBooks).mockClear();
            await expect(listQuickBooksClasses()).resolves.toEqual(LOCAL_QUICKBOOKS_CLASSES);
            expect(getQuickBooks).not.toHaveBeenCalled();
        });

        test.each(['prod', 'dev', '', 'stg'])('%p asks QuickBooks and never lists the stand-ins', async (env) => {
            process.env.CHECKIN_ENV = env;
            jest.mocked(getQuickBooks).mockResolvedValue(null);
            await expect(listQuickBooksClasses()).rejects.toMatchObject({ status: 503, message: 'QuickBooks is not connected.' });
            expect(getQuickBooks).toHaveBeenCalled();
        });
    });

    test('an empty company lists no Classes', async () => {
        const classes = jest.fn().mockResolvedValue([]);
        jest.mocked(getQuickBooks).mockResolvedValue({ classes } as unknown as Awaited<ReturnType<typeof getQuickBooks>>);
        await expect(listQuickBooksClasses()).resolves.toEqual([]);
    });
});
