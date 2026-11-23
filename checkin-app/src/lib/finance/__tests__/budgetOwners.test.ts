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
 * Archive is refused while any library still has unfinished work in the bucket.
 * Naming an owner or treasurer runs the background-check gate in the same
 * transaction; a clear, a removal or an unchanged name does not.
 */
import { archiveBudgetOwner, createBudgetOwner, findQuickBooksClass, listQuickBooksClasses, LOCAL_QUICKBOOKS_CLASSES, setBucketOwner, setBucketTreasurer, updateBudgetOwner, OWN_HOUSEHOLD_MESSAGE } from '../budgetOwners';
import { getQuickBooks } from '@/lib/quickbooks/client';
import { holdBucketLines, unfinishedBucketUses as expenseUses } from '@checkin/expense';
import { ServiceError } from '@checkin/component-kit';
import { unfinishedBucketUses as donationUses } from '@checkin/bulk-donation';
import { unfinishedBucketUses as incomeUses } from '@checkin/income';
import { emailAfterAssignment, gatePositionCheck } from '@/lib/membership/positionCheck';
import { CHECK_ACKNOWLEDGEMENT_CODE } from '@/lib/membership/positionCheckCode';

const households: Record<number, number> = { 1: 10, 2: 10, 3: 20, 4: 30, 5: 40 };
const buckets: Record<number, { isOrgLevel: boolean; ownerId: number | null; archivedAt?: Date }> = {
    7: { isOrgLevel: false, ownerId: null },
    8: { isOrgLevel: true, ownerId: null },
    9: { isOrgLevel: false, ownerId: 2 },
    10: { isOrgLevel: false, ownerId: null, archivedAt: new Date('2026-10-01') },
};
const tx = {
    budgetOwner: { create: jest.fn(), update: jest.fn(), findUnique: jest.fn() },
    budgetOwnerTreasurer: { findUnique: jest.fn(), create: jest.fn(), delete: jest.fn() },
    auditLog: { create: jest.fn() },
    $queryRaw: jest.fn(),
};
const savedList = jest.fn();
jest.mock('@/lib/quickbooks/client', () => ({ getQuickBooks: jest.fn() }));
// The archived-household guard has its own tests; here every household is live.
jest.mock('@/lib/household/archiveGuard', () => ({
    ...jest.requireActual('@/lib/household/archiveGuard'),
    lockLiveHouseholds: jest.fn(),
    lockLiveHouseholdsOf: jest.fn(),
}));
jest.mock('@checkin/expense', () => ({ holdBucketLines: jest.fn(), unfinishedBucketUses: jest.fn() }));
jest.mock('@checkin/bulk-donation', () => ({ unfinishedBucketUses: jest.fn() }));
jest.mock('@checkin/income', () => ({ unfinishedBucketUses: jest.fn() }));
// The gate has its own integration tests; here it passes unless a test says otherwise.
jest.mock('@/lib/membership/positionCheck', () => ({ gatePositionCheck: jest.fn(), emailAfterAssignment: jest.fn() }));
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
        quickBooksList: { findUnique: (args: unknown) => savedList(args) },
        $transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    },
}));

beforeEach(() => {
    jest.clearAllMocks();
    tx.budgetOwnerTreasurer.findUnique.mockResolvedValue(null);
    tx.$queryRaw.mockResolvedValue([{ isOrgLevel: false }]);
    for (const read of [expenseUses, donationUses, incomeUses]) jest.mocked(read).mockResolvedValue([]);
    savedList.mockResolvedValue({ entries: COPY });
    jest.mocked(gatePositionCheck).mockResolvedValue(null);
});

// The copy of QuickBooks' Class list: 12 and 13 active, 14 inactive; 99 is not in it.
const COPY = [
    { id: '12', name: 'Shop', active: true },
    { id: '13', name: 'Robotics', active: true },
    { id: '14', name: 'Retired drive', active: false },
];
const STALE = 'quickbooks-list-stale';
const HINT = 'If you changed it in QuickBooks, press Update now, then save again.';
const inactive = `QuickBooks' list in the app shows Retired drive as inactive. ${HINT}`;
const missing = `QuickBooks' list in the app doesn't have a Class with id 99. ${HINT}`;

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

describe('the background-check gate', () => {
    const needsAck = new ServiceError(409, "This person isn't current on their background check", CHECK_ACKNOWLEDGEMENT_CODE);

    test('gates a new owner in the transaction and emails after it commits', async () => {
        jest.mocked(gatePositionCheck).mockResolvedValue(41);
        await setBucketOwner(5, 9, 3, true);
        expect(gatePositionCheck).toHaveBeenCalledWith(tx, { personId: 3, position: 'BUDGET_OWNER', actorId: 5, acknowledged: true });
        expect(emailAfterAssignment).toHaveBeenCalledWith([41], 5);
    });

    test('gates a new treasurer in the transaction and emails after it commits', async () => {
        jest.mocked(gatePositionCheck).mockResolvedValue(42);
        await setBucketTreasurer(1, 7, 3, true, true);
        expect(gatePositionCheck).toHaveBeenCalledWith(tx, { personId: 3, position: 'BUDGET_TREASURER', actorId: 1, acknowledged: true });
        expect(emailAfterAssignment).toHaveBeenCalledWith([42], 1);
    });

    test('sends no email when the gate passes on a current check', async () => {
        await setBucketOwner(1, 7, 3);
        await setBucketTreasurer(1, 7, 3, true);
        expect(gatePositionCheck).toHaveBeenCalledTimes(2);
        expect(emailAfterAssignment).not.toHaveBeenCalled();
    });

    test.each([
        ['an owner', () => setBucketOwner(1, 7, 3)],
        ['a treasurer', () => setBucketTreasurer(1, 7, 3, true)],
    ])('answers naming %s without the acknowledgement with its code, writing nothing', async (_label, save) => {
        jest.mocked(gatePositionCheck).mockRejectedValue(needsAck);
        await expect(save()).rejects.toMatchObject({ status: 409, code: CHECK_ACKNOWLEDGEMENT_CODE });
        expect(tx.budgetOwner.update).not.toHaveBeenCalled();
        expect(tx.budgetOwnerTreasurer.create).not.toHaveBeenCalled();
        expect(emailAfterAssignment).not.toHaveBeenCalled();
    });

    test('never gates a cleared owner, a removed treasurer or an unchanged one', async () => {
        await setBucketOwner(5, 9, null);
        tx.budgetOwnerTreasurer.findUnique.mockResolvedValue({ personId: 3 });
        await setBucketTreasurer(1, 7, 3, false);
        await setBucketTreasurer(1, 7, 3, true);
        await setBucketOwner(5, 9, 2);
        expect(gatePositionCheck).not.toHaveBeenCalled();
        expect(emailAfterAssignment).not.toHaveBeenCalled();
    });
});

describe('approvers and the org-level flag, changed at once', () => {
    beforeEach(() => tx.$queryRaw.mockResolvedValue([{ isOrgLevel: true }]));
    const refused = { status: 409, message: 'An org-level bucket has no owner or treasurers.' };

    test('refuses an owner once the locked bucket is org-level, writing nothing', async () => {
        await expect(setBucketOwner(5, 7, 3)).rejects.toMatchObject(refused);
        nothingWritten();
    });

    test('refuses a treasurer once the locked bucket is org-level, writing nothing', async () => {
        await expect(setBucketTreasurer(5, 7, 3, true)).rejects.toMatchObject(refused);
        nothingWritten();
    });
});

describe('updateBudgetOwner: org-level and restore', () => {
    const held = holdBucketLines as jest.Mock;
    const awaiting = jest.fn();
    const stored = (over: Record<string, unknown> = {}) => ({
        name: 'Shop', quickBooksClassId: '12', isOrgLevel: false, archivedAt: null, ownerId: null, _count: { treasurers: 0 }, ...over,
    });

    beforeEach(() => {
        awaiting.mockResolvedValue(0);
        held.mockImplementation((_id: number, _orgLevel: boolean, change: (count: () => Promise<number>) => Promise<unknown>) => change(awaiting));
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
        expect(tx.$queryRaw).toHaveBeenCalled();
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
        expect(held).toHaveBeenCalledWith(7, true, expect.any(Function));
    });

    test('refuses to make an org-level bucket a program bucket while a Board seat is awaited, writing nothing', async () => {
        tx.budgetOwner.findUnique.mockResolvedValue(stored({ isOrgLevel: true }));
        awaiting.mockResolvedValue(2);
        await expect(updateBudgetOwner(1, 8, { isOrgLevel: false })).rejects.toMatchObject({
            status: 409,
            message: 'Open expenses in this bucket still need a Board signature; have them signed or recorded first.',
        });
        expect(held).toHaveBeenCalledWith(8, false, expect.any(Function));
        expect(awaiting).toHaveBeenCalled();
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

    test('takes the line hold before the bucket row lock and keeps it until the flag change commits', async () => {
        const events: string[] = [];
        held.mockImplementation(async (_id: number, _orgLevel: boolean, change: (count: () => Promise<number>) => Promise<unknown>) => {
            events.push('hold');
            const bucket = await change(awaiting);
            events.push('release');
            return bucket;
        });
        tx.$queryRaw.mockImplementation(async () => {
            events.push('row lock');
            return [{ isOrgLevel: true }];
        });
        tx.budgetOwner.update.mockImplementation(async () => {
            events.push('flag written');
            return { id: 8 };
        });
        tx.budgetOwner.findUnique.mockResolvedValue(stored({ isOrgLevel: true }));
        await updateBudgetOwner(1, 8, { isOrgLevel: false });
        expect(events).toEqual(['hold', 'row lock', 'flag written', 'release']);
    });

    test('an edit that keeps the flag checks neither approvers nor seats', async () => {
        tx.budgetOwner.findUnique.mockResolvedValue(stored({ ownerId: 2 }));
        await updateBudgetOwner(1, 9, { name: 'Renamed', isOrgLevel: false });
        expect(awaiting).not.toHaveBeenCalled();
        expect(tx.budgetOwner.update).toHaveBeenCalled();
    });

    test("answers the expense library's refusal of the flip with its status, writing nothing", async () => {
        held.mockRejectedValue(new ServiceError(409, "The expense's capital review has opened; it cannot go back"));
        await expect(updateBudgetOwner(1, 8, { isOrgLevel: false })).rejects.toMatchObject({
            status: 409,
            message: "The expense's capital review has opened; it cannot go back",
        });
        nothingWritten();
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

    test.each([['an active', null], ['an archived', new Date('2026-10-01')]])('refuses clearing the Class of %s bucket, writing nothing', async (_name, archivedAt) => {
        tx.budgetOwner.findUnique.mockResolvedValue(stored({ archivedAt }));
        await expect(updateBudgetOwner(1, 7, { quickBooksClassId: null })).rejects.toMatchObject({
            status: 400,
            message: "A bucket's QuickBooks Class can be changed but not cleared.",
        });
        nothingWritten();
        expect(tx.auditLog.create).not.toHaveBeenCalled();
    });

    test('changes a bucket to another Class', async () => {
        tx.budgetOwner.findUnique.mockResolvedValue(stored());
        await updateBudgetOwner(1, 7, { quickBooksClassId: '13' });
        expect(tx.budgetOwner.update).toHaveBeenCalledWith(expect.objectContaining({ data: { quickBooksClassId: '13' } }));
    });

    test('saves a bucket that has no Class without one', async () => {
        tx.budgetOwner.findUnique.mockResolvedValue(stored({ quickBooksClassId: null }));
        await updateBudgetOwner(1, 7, { name: 'Shop floor', quickBooksClassId: null });
        expect(tx.budgetOwner.update).toHaveBeenCalledWith(expect.objectContaining({ data: { name: 'Shop floor', quickBooksClassId: null } }));
    });

    test.each([['an inactive', '14', inactive], ['a missing', '99', missing]])('refuses changing to %s Class, writing nothing', async (_name, classId, message) => {
        tx.budgetOwner.findUnique.mockResolvedValue(stored());
        await expect(updateBudgetOwner(1, 7, { quickBooksClassId: classId })).rejects.toMatchObject({ status: 400, code: STALE, message });
        nothingWritten();
    });

    test('renames a bucket whose Class is inactive, the unchanged Class unchecked', async () => {
        tx.budgetOwner.findUnique.mockResolvedValue(stored({ quickBooksClassId: '14' }));
        await updateBudgetOwner(1, 7, { name: 'Old shop', quickBooksClassId: '14', isOrgLevel: false });
        expect(tx.budgetOwner.update).toHaveBeenCalledWith(expect.objectContaining({ data: { name: 'Old shop', quickBooksClassId: '14', isOrgLevel: false } }));
    });

    test.each([['inactive', '14', inactive], ['missing', '99', missing]])('refuses restoring a bucket whose Class is %s, writing nothing', async (_name, classId, message) => {
        tx.budgetOwner.findUnique.mockResolvedValue(stored({ quickBooksClassId: classId, archivedAt: new Date('2026-10-01') }));
        await expect(updateBudgetOwner(1, 7, { archived: false })).rejects.toMatchObject({ status: 400, code: STALE, message });
        nothingWritten();
    });

    test('restores a bucket whose Class is inactive when the same save picks an active one', async () => {
        tx.budgetOwner.findUnique.mockResolvedValue(stored({ quickBooksClassId: '14', archivedAt: new Date('2026-10-01') }));
        await updateBudgetOwner(1, 7, { archived: false, quickBooksClassId: '13' });
        expect(tx.budgetOwner.update).toHaveBeenCalledWith(expect.objectContaining({ data: { archivedAt: null, quickBooksClassId: '13' } }));
    });

    test('refuses a restore that picks an inactive Class, writing nothing', async () => {
        tx.budgetOwner.findUnique.mockResolvedValue(stored({ archivedAt: new Date('2026-10-01') }));
        await expect(updateBudgetOwner(1, 7, { archived: false, quickBooksClassId: '14' })).rejects.toMatchObject({ status: 400, code: STALE, message: inactive });
        nothingWritten();
    });

    test('archives only through the archive route', async () => {
        await expect(updateBudgetOwner(1, 7, { archived: true })).rejects.toMatchObject({ status: 400 });
        nothingWritten();
    });
});

describe('createBudgetOwner', () => {
    test('records whether the bucket is org-level', async () => {
        tx.budgetOwner.create.mockResolvedValue({ id: 11 });
        await createBudgetOwner(1, { name: 'Facility', isOrgLevel: true, quickBooksClassId: '12' });
        expect(tx.budgetOwner.create).toHaveBeenCalledWith(expect.objectContaining({ data: { name: 'Facility', isOrgLevel: true, quickBooksClassId: '12' } }));
    });

    test('refuses a non-boolean isOrgLevel', async () => {
        await expect(createBudgetOwner(1, { name: 'Facility', isOrgLevel: 'yes', quickBooksClassId: '12' })).rejects.toMatchObject({ status: 400 });
    });

    test.each([['no', {}], ['a null', { quickBooksClassId: null }], ['a blank', { quickBooksClassId: ' ' }]])(
        'refuses a bucket with %s QuickBooks Class, writing nothing',
        async (_name, body) => {
            await expect(createBudgetOwner(1, { name: 'Shop', ...body })).rejects.toMatchObject({
                status: 400,
                message: 'A bucket needs a QuickBooks Class.',
            });
            expect(tx.budgetOwner.create).not.toHaveBeenCalled();
            expect(tx.auditLog.create).not.toHaveBeenCalled();
        },
    );

    test('creates a bucket with its QuickBooks Class and audits it', async () => {
        tx.budgetOwner.create.mockResolvedValue({ id: 11 });
        await createBudgetOwner(1, { name: 'Shop', quickBooksClassId: '12' });
        expect(tx.budgetOwner.create).toHaveBeenCalledWith(expect.objectContaining({ data: { name: 'Shop', isOrgLevel: false, quickBooksClassId: '12' } }));
        expect(tx.auditLog.create).toHaveBeenCalledWith({
            data: expect.objectContaining({ action: 'CREATE', newData: { name: 'Shop', isOrgLevel: false, quickBooksClassId: '12' } }),
        });
    });

    test.each([['an inactive', '14', inactive], ['a missing', '99', missing]])('refuses a bucket with %s Class, writing nothing', async (_name, classId, message) => {
        await expect(createBudgetOwner(1, { name: 'Shop', quickBooksClassId: classId })).rejects.toMatchObject({ status: 400, code: STALE, message });
        expect(tx.budgetOwner.create).not.toHaveBeenCalled();
        expect(tx.auditLog.create).not.toHaveBeenCalled();
    });

    test('local refuses an inactive stand-in Class and takes an id the stand-ins lack', async () => {
        const saved = process.env.CHECKIN_ENV;
        process.env.CHECKIN_ENV = 'local';
        try {
            await expect(createBudgetOwner(1, { name: 'Old', quickBooksClassId: '9005' })).rejects.toMatchObject({ status: 400, code: STALE });
            tx.budgetOwner.create.mockResolvedValue({ id: 11 });
            await createBudgetOwner(1, { name: 'Wood', quickBooksClassId: '9004' });
            await createBudgetOwner(1, { name: 'Flow bucket', quickBooksClassId: '1794787200123' });
            expect(tx.budgetOwner.create).toHaveBeenCalledTimes(2);
            expect(savedList).not.toHaveBeenCalled();
        } finally {
            process.env.CHECKIN_ENV = saved;
        }
    });

    test('answers 409 when another bucket holds the Class', async () => {
        tx.budgetOwner.create.mockRejectedValue({ code: 'P2002', meta: { target: ['quickBooksClassId'] } });
        await expect(createBudgetOwner(1, { name: 'Shop', quickBooksClassId: '12' })).rejects.toMatchObject({
            status: 409,
            message: 'That QuickBooks Class is already mapped to another bucket.',
        });
    });
});

describe('QuickBooks Class id', () => {
    test.each(['abc', '12a', 'class-7', '1 2'])('refuses a non-numeric id %p on create and update', async (classId) => {
        await expect(createBudgetOwner(1, { name: 'Robotics', quickBooksClassId: classId })).rejects.toMatchObject({ status: 400 });
        await expect(updateBudgetOwner(1, 5, { quickBooksClassId: classId })).rejects.toMatchObject({ status: 400 });
        expect(tx.auditLog.create).not.toHaveBeenCalled();
    });
});

describe('findQuickBooksClass', () => {
    const saved = process.env.CHECKIN_ENV;
    afterEach(() => { process.env.CHECKIN_ENV = saved; });

    test('local treats an id the stand-ins lack as active and 9005 as inactive', async () => {
        process.env.CHECKIN_ENV = 'local';
        await expect(findQuickBooksClass('1794787200123')).resolves.toMatchObject({ active: true });
        await expect(findQuickBooksClass('9005')).resolves.toMatchObject({ name: 'Retired', active: false });
        expect(savedList).not.toHaveBeenCalled();
    });

    test('prod reads the copy: an id it lacks is not found', async () => {
        process.env.CHECKIN_ENV = 'prod';
        await expect(findQuickBooksClass('99')).resolves.toBeUndefined();
        await expect(findQuickBooksClass('14')).resolves.toMatchObject({ active: false });
    });
});

describe('listQuickBooksClasses', () => {
    const saved = process.env.CHECKIN_ENV;
    afterEach(() => { process.env.CHECKIN_ENV = saved; });

    test('local lists the stand-in Classes without asking QuickBooks or the copy', async () => {
        process.env.CHECKIN_ENV = 'local';
        await expect(listQuickBooksClasses()).resolves.toEqual(LOCAL_QUICKBOOKS_CLASSES);
        expect(getQuickBooks).not.toHaveBeenCalled();
        expect(savedList).not.toHaveBeenCalled();
    });

    test.each(['prod', 'dev', '', 'stg'])('%p lists the copy\'s Classes and never asks QuickBooks', async (env) => {
        process.env.CHECKIN_ENV = env;
        savedList.mockResolvedValue({ entries: [{ id: '3', name: 'Facility', active: true }, { id: '4', name: 'Old', active: false }] });
        await expect(listQuickBooksClasses()).resolves.toEqual([{ id: '3', name: 'Facility', active: true }, { id: '4', name: 'Old', active: false }]);
        expect(savedList).toHaveBeenCalledWith(expect.objectContaining({ where: { list: 'class' } }));
        expect(getQuickBooks).not.toHaveBeenCalled();
    });

    test('an empty copy lists no Classes', async () => {
        process.env.CHECKIN_ENV = 'prod';
        savedList.mockResolvedValue(null);
        await expect(listQuickBooksClasses()).resolves.toEqual([]);
    });
});

describe('archiveBudgetOwner', () => {
    test('refuses a bucket with unfinished work, naming every kind, and writes nothing', async () => {
        jest.mocked(expenseUses).mockResolvedValue([
            { what: 'open expense lines', count: 3, where: 'Finance › Expenses' },
            { what: 'parts mapped to it for future receipts', count: 2, where: 'Finance › Part Buckets' },
        ]);
        jest.mocked(donationUses).mockResolvedValue([{ what: 'gifts of goods not yet booked', count: 1, where: 'Donations › Queue' }]);
        jest.mocked(incomeUses).mockResolvedValue([{ what: 'store items mapped to it', count: 4, where: 'Income › Item Categories' }]);
        await expect(archiveBudgetOwner(1, 7)).rejects.toMatchObject({
            status: 409,
            message:
                'This bucket still has unfinished work. Move it to another bucket first: open expense lines: 3 (Finance › Expenses); ' +
                'parts mapped to it for future receipts: 2 (Finance › Part Buckets); gifts of goods not yet booked: 1 (Donations › Queue); ' +
                'store items mapped to it: 4 (Income › Item Categories).',
        });
        for (const read of [expenseUses, donationUses, incomeUses]) expect(read).toHaveBeenCalledWith(7);
        nothingWritten();
    });

    test('archives a bucket nothing unfinished uses and audits it', async () => {
        const archivedAt = new Date('2026-11-15');
        tx.budgetOwner.findUnique.mockResolvedValue({ archivedAt: null });
        tx.budgetOwner.update.mockResolvedValue({ id: 7, archivedAt });
        await archiveBudgetOwner(1, 7);
        expect(tx.budgetOwner.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 7 }, data: { archivedAt: expect.any(Date) } }));
        expect(tx.auditLog.create).toHaveBeenCalledWith({
            data: expect.objectContaining({ action: 'EDIT', tableName: 'BudgetOwner', affectedEntityId: 7, oldData: { archivedAt: null }, newData: { archivedAt } }),
        });
    });

    test('refuses with 503 when a library cannot be read, and writes nothing', async () => {
        jest.spyOn(console, 'error').mockImplementation(() => {});
        jest.mocked(donationUses).mockRejectedValue(new Error('connection refused'));
        await expect(archiveBudgetOwner(1, 7)).rejects.toMatchObject({ status: 503, message: "Can't check what still uses this bucket; try again." });
        nothingWritten();
    });

    test('answers an archived bucket as it is, reading no library', async () => {
        await expect(archiveBudgetOwner(1, 10)).resolves.toMatchObject({ archivedAt: new Date('2026-10-01') });
        for (const read of [expenseUses, donationUses, incomeUses]) expect(read).not.toHaveBeenCalled();
        nothingWritten();
    });

    test('refuses an unknown bucket as not found', async () => {
        await expect(archiveBudgetOwner(1, 404)).rejects.toMatchObject({ status: 404 });
        nothingWritten();
    });
});
