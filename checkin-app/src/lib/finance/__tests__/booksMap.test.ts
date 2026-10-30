/**
 * @jest-environment node
 */
/**
 * The books map lists every role, set or not, and every live bucket's Class. A
 * role edit writes the row and one audit row together; a no-op writes nothing;
 * an unknown role or a non-numeric id is refused. A Class edit goes through the
 * bucket's own audited update. The port drops rows whose role is unknown.
 */
import { BOOKS_MAP_ROLES } from '@checkin/quickbooks';
import { booksMap, listBooksMap, listQuickBooksAccounts, LOCAL_QUICKBOOKS_ACCOUNTS, setBooksMapAccount, setBooksMapClass } from '../booksMap';
import { updateBudgetOwner } from '../budgetOwners';
import { getQuickBooks } from '@/lib/quickbooks/client';

const tx = {
    booksMapRoleAccount: { findUnique: jest.fn(), upsert: jest.fn(), deleteMany: jest.fn() },
    auditLog: { create: jest.fn() },
};
const accountRows = jest.fn();
const bucketRows = jest.fn();
jest.mock('@/lib/quickbooks/client', () => ({ getQuickBooks: jest.fn() }));
jest.mock('../budgetOwners', () => ({ updateBudgetOwner: jest.fn() }));
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        booksMapRoleAccount: { findMany: () => accountRows() },
        budgetOwner: { findMany: () => bucketRows() },
        $transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    },
}));

beforeEach(() => {
    jest.clearAllMocks();
    tx.booksMapRoleAccount.findUnique.mockResolvedValue(null);
    accountRows.mockResolvedValue([]);
    bucketRows.mockResolvedValue([]);
});

const nothingWritten = () => {
    expect(tx.booksMapRoleAccount.upsert).not.toHaveBeenCalled();
    expect(tx.booksMapRoleAccount.deleteMany).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
};

describe('listBooksMap', () => {
    it('lists every role, null while unset, and each bucket with its Class', async () => {
        accountRows.mockResolvedValue([{ role: 'SHOPIFY_BANK', quickBooksAccountId: '35' }]);
        bucketRows.mockResolvedValue([{ id: 2, name: 'Robotics', quickBooksClassId: '9003' }]);
        const map = await listBooksMap();
        expect(map.BooksMapAccount.map((r) => r.role)).toEqual([...BOOKS_MAP_ROLES]);
        expect(map.BooksMapAccount.find((r) => r.role === 'SHOPIFY_BANK')?.quickBooksAccountId).toBe('35');
        expect(map.BooksMapAccount.find((r) => r.role === 'BENEVITY_BANK')?.quickBooksAccountId).toBeNull();
        expect(map.BooksMapClass).toEqual([{ budgetOwnerId: 2, budgetOwnerName: 'Robotics', quickBooksClassId: '9003' }]);
    });
});

describe('setBooksMapAccount', () => {
    it('creates an unset role with one audit row', async () => {
        await expect(setBooksMapAccount(1, 'SHOPIFY_FEES', { quickBooksAccountId: ' 8004 ' })).resolves.toEqual({ role: 'SHOPIFY_FEES', quickBooksAccountId: '8004' });
        expect(tx.booksMapRoleAccount.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: { role: 'SHOPIFY_FEES', quickBooksAccountId: '8004' } }));
        expect(tx.auditLog.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                action: 'CREATE',
                tableName: 'BooksMapRoleAccount',
                oldData: { role: 'SHOPIFY_FEES', quickBooksAccountId: null },
                newData: { role: 'SHOPIFY_FEES', quickBooksAccountId: '8004' },
            }),
        });
    });

    it('clears a set role by deleting its row, audited', async () => {
        tx.booksMapRoleAccount.findUnique.mockResolvedValue({ quickBooksAccountId: '8004' });
        tx.booksMapRoleAccount.deleteMany.mockResolvedValue({ count: 1 });
        await setBooksMapAccount(1, 'SHOPIFY_FEES', { quickBooksAccountId: null });
        expect(tx.booksMapRoleAccount.deleteMany).toHaveBeenCalledWith({ where: { role: 'SHOPIFY_FEES' } });
        expect(tx.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: 'DELETE' }) });
    });

    it('a clear that loses the race to another clear writes nothing and succeeds', async () => {
        tx.booksMapRoleAccount.findUnique.mockResolvedValue({ quickBooksAccountId: '8004' });
        tx.booksMapRoleAccount.deleteMany.mockResolvedValue({ count: 0 });
        await expect(setBooksMapAccount(1, 'SHOPIFY_FEES', { quickBooksAccountId: null })).resolves.toEqual({ role: 'SHOPIFY_FEES', quickBooksAccountId: null });
        expect(tx.auditLog.create).not.toHaveBeenCalled();
    });

    it('writes nothing when the account is unchanged', async () => {
        tx.booksMapRoleAccount.findUnique.mockResolvedValue({ quickBooksAccountId: '8004' });
        await setBooksMapAccount(1, 'SHOPIFY_FEES', { quickBooksAccountId: '8004' });
        nothingWritten();
    });

    it.each([
        ['an unknown role', 'NOT_A_ROLE', { quickBooksAccountId: '1' }],
        ['a missing id', 'SHOPIFY_FEES', {}],
        ['a non-numeric id', 'SHOPIFY_FEES', { quickBooksAccountId: 'Checking' }],
        ['a non-string id', 'SHOPIFY_FEES', { quickBooksAccountId: 35 }],
    ])('refuses %s with a 400 and writes nothing', async (_label, role, body) => {
        await expect(setBooksMapAccount(1, role, body)).rejects.toMatchObject({ status: 400 });
        nothingWritten();
    });
});

describe('setBooksMapClass', () => {
    it("goes through the bucket's audited update and answers the map row", async () => {
        (updateBudgetOwner as jest.Mock).mockResolvedValue({ id: 2, name: 'Robotics', quickBooksClassId: '9003' });
        await expect(setBooksMapClass(1, 2, { quickBooksClassId: '9003' })).resolves.toEqual({ budgetOwnerId: 2, budgetOwnerName: 'Robotics', quickBooksClassId: '9003' });
        expect(updateBudgetOwner).toHaveBeenCalledWith(1, 2, { quickBooksClassId: '9003' });
    });

    it('refuses a body without quickBooksClassId', async () => {
        await expect(setBooksMapClass(1, 2, { name: 'Renamed' })).rejects.toMatchObject({ status: 400 });
        expect(updateBudgetOwner).not.toHaveBeenCalled();
    });
});

describe('listQuickBooksAccounts', () => {
    const env = process.env;
    afterEach(() => { process.env = env; });

    it('serves the local stand-ins in local mode', async () => {
        process.env = { ...env, CHECKIN_ENV: 'local' };
        await expect(listQuickBooksAccounts()).resolves.toEqual(LOCAL_QUICKBOOKS_ACCOUNTS);
        expect(getQuickBooks).not.toHaveBeenCalled();
    });
});

describe('booksMap port', () => {
    it('answers set roles only and every bucket with a Class', async () => {
        accountRows.mockResolvedValue([{ role: 'BENEVITY_BANK', quickBooksAccountId: '35' }, { role: 'RETIRED', quickBooksAccountId: '1' }]);
        bucketRows.mockResolvedValue([{ id: 2, quickBooksClassId: '9003' }]);
        await expect(booksMap.accounts()).resolves.toEqual({ BENEVITY_BANK: '35' });
        await expect(booksMap.classes()).resolves.toEqual(new Map([[2, '9003']]));
    });
});
