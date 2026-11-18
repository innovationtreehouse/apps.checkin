/**
 * @jest-environment node
 */
/**
 * The books map lists every role, set or not, and every live bucket's Class. A
 * role edit writes the row and one audit row together; a no-op writes nothing;
 * an unknown role, a non-numeric id, or an account the app's QuickBooks list lacks
 * or lists under a type the role does not accept is refused, without reading QuickBooks. A Class edit goes through the bucket's own
 * audited update. The port drops rows whose role is unknown.
 */
import { BOOKS_MAP_ROLES, QUICKBOOKS_LIST_STALE, UPDATE_NOW_HINT } from '@checkin/quickbooks';
import { booksMap, listBooksMap, listQuickBooksAccounts, LOCAL_QUICKBOOKS_ACCOUNTS, misTypedRoleAccounts, setBooksMapAccount, setBooksMapClass } from '../booksMap';
import { updateBudgetOwner } from '../budgetOwners';
import { getQuickBooks } from '@/lib/quickbooks/client';

const tx = {
    booksMapRoleAccount: { findUnique: jest.fn(), upsert: jest.fn(), deleteMany: jest.fn() },
    auditLog: { create: jest.fn() },
};
const accountRows = jest.fn();
const bucketRows = jest.fn();
const savedList = jest.fn();
jest.mock('@/lib/quickbooks/client', () => ({ getQuickBooks: jest.fn() }));
jest.mock('../budgetOwners', () => ({ updateBudgetOwner: jest.fn() }));
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        booksMapRoleAccount: { findMany: () => accountRows() },
        budgetOwner: { findMany: () => bucketRows() },
        quickBooksList: { findUnique: (args: unknown) => savedList(args) },
        $transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    },
}));

const qbAccounts = [
    { Id: '8001', FullyQualifiedName: 'Checking', AccountType: 'Bank', Active: true },
    { Id: '8002', FullyQualifiedName: 'Sales:Shop sales', AccountType: 'Income', Active: true },
    { Id: '8004', FullyQualifiedName: 'Merchant fees', AccountType: 'Expense', Active: true },
    { Id: '8009', FullyQualifiedName: 'Kit materials', AccountType: 'Cost of Goods Sold', Active: true },
];

beforeEach(() => {
    jest.clearAllMocks();
    savedList.mockResolvedValue({ entries: qbAccounts.map((a) => ({ id: a.Id, name: a.FullyQualifiedName, accountType: a.AccountType, active: a.Active })) });
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

    it('does not re-check an unchanged account against the list', async () => {
        tx.booksMapRoleAccount.findUnique.mockResolvedValue({ quickBooksAccountId: '8004' });
        savedList.mockResolvedValue(null);
        await expect(setBooksMapAccount(1, 'SHOPIFY_FEES', { quickBooksAccountId: '8004' })).resolves.toEqual({ role: 'SHOPIFY_FEES', quickBooksAccountId: '8004' });
        expect(savedList).not.toHaveBeenCalled();
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

    it.each([
        ['an Income account for Shopify: fees', 'SHOPIFY_FEES', '8002', "Shopify: fees takes an Expense or Other Expense account; QuickBooks' list in the app shows Sales:Shop sales as Income"],
        ['a Cost of Goods Sold account for Shopify: fees', 'SHOPIFY_FEES', '8009', "Shopify: fees takes an Expense or Other Expense account; QuickBooks' list in the app shows Kit materials as Cost of Goods Sold"],
        ['an Expense account for a bank role', 'BENEVITY_BANK', '8004', "Benevity disbursements: bank account takes a Bank account; QuickBooks' list in the app shows Merchant fees as Expense"],
        ['an account the copy does not list', 'SHOPIFY_FEES', '8099', "QuickBooks' list in the app doesn't have an account with id 8099"],
    ])('refuses %s with a 400 and the stale-list code, writes nothing and reads no QuickBooks', async (_label, role, id, error) => {
        await expect(setBooksMapAccount(1, role, { quickBooksAccountId: id })).rejects.toMatchObject({ status: 400, code: QUICKBOOKS_LIST_STALE, message: `${error}. ${UPDATE_NOW_HINT}` });
        nothingWritten();
        expect(getQuickBooks).not.toHaveBeenCalled();
    });

    it('refuses every pick while the copy is empty, without reading QuickBooks', async () => {
        savedList.mockResolvedValue(null);
        await expect(setBooksMapAccount(1, 'SHOPIFY_FEES', { quickBooksAccountId: '8004' })).rejects.toMatchObject({ status: 400, code: QUICKBOOKS_LIST_STALE });
        nothingWritten();
        expect(getQuickBooks).not.toHaveBeenCalled();
    });

    it('saves a pick the copy holds under an accepted type without reading QuickBooks', async () => {
        await setBooksMapAccount(1, 'SHOPIFY_FEES', { quickBooksAccountId: '8004' });
        expect(tx.booksMapRoleAccount.upsert).toHaveBeenCalled();
        expect(getQuickBooks).not.toHaveBeenCalled();
        expect(savedList).toHaveBeenCalledWith(expect.objectContaining({ where: { list: 'account' } }));
    });

    it('clears a role without reading QuickBooks', async () => {
        tx.booksMapRoleAccount.findUnique.mockResolvedValue({ quickBooksAccountId: '8004' });
        tx.booksMapRoleAccount.deleteMany.mockResolvedValue({ count: 1 });
        await expect(setBooksMapAccount(1, 'SHOPIFY_FEES', { quickBooksAccountId: null })).resolves.toEqual({ role: 'SHOPIFY_FEES', quickBooksAccountId: null });
    });
});

describe('misTypedRoleAccounts', () => {
    it('names each stored role whose account is of a type the role does not accept, or is gone, and rewrites nothing', async () => {
        accountRows.mockResolvedValue([
            { role: 'SHOPIFY_BANK', quickBooksAccountId: '8001' },
            { role: 'SHOPIFY_FEES', quickBooksAccountId: '8002' },
            { role: 'BENEVITY_BANK', quickBooksAccountId: '8099' },
        ]);
        await expect(misTypedRoleAccounts(qbAccounts)).resolves.toEqual([
            'Shopify: fees (Sales:Shop sales is Income; takes Expense or Other Expense)',
            'Benevity disbursements: bank account (id 8099 is not in QuickBooks; takes Bank)',
        ]);
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
