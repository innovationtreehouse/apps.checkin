/**
 * @jest-environment node
 */
/**
 * The refresh reads both QuickBooks lists and writes both rows in one transaction, trimmed and
 * sorted; it writes nothing while QuickBooks is off, under CHECKIN_ENV=local, or when a read fails.
 * The readers return the copy and never call QuickBooks.
 */
import { refreshQuickBooksLists, savedQuickBooksAccounts, savedQuickBooksClasses } from '../quickBooksLists';
import { getQuickBooks } from '@/lib/quickbooks/client';

const upsert = jest.fn((args: unknown) => args);
const transaction = jest.fn(async (ops: unknown[]) => ops);
const findUnique = jest.fn();
jest.mock('@/lib/quickbooks/client', () => ({ getQuickBooks: jest.fn() }));
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        quickBooksList: { upsert: (args: unknown) => upsert(args), findUnique: (args: unknown) => findUnique(args) },
        $transaction: (ops: unknown[]) => transaction(ops),
    },
}));

type Client = Awaited<ReturnType<typeof getQuickBooks>>;
const client = (accounts: () => Promise<unknown[]>, classes: () => Promise<unknown[]>) =>
    jest.mocked(getQuickBooks).mockResolvedValue({ accounts, classes } as unknown as Client);

const env = process.env.CHECKIN_ENV;
beforeEach(() => {
    jest.clearAllMocks();
    process.env.CHECKIN_ENV = 'prod';
});
afterAll(() => { process.env.CHECKIN_ENV = env; });

describe('refreshQuickBooksLists', () => {
    it('writes both lists, trimmed and sorted by full name, in one transaction', async () => {
        client(
            async () => [
                { Id: '2', Name: 'Sales', FullyQualifiedName: 'Sales:Shop', AccountType: 'Income', Active: true, extra: 'x' },
                { Id: '1', Name: 'Checking', FullyQualifiedName: 'Checking', AccountType: 'Bank' },
            ],
            async () => [
                { Id: '9', Name: 'Robotics', FullyQualifiedName: 'Programs:Robotics' },
                { Id: '4', Name: 'Old', FullyQualifiedName: 'Old', Active: false },
            ],
        );
        const result = await refreshQuickBooksLists();
        expect(result).toMatchObject({ accounts: 2, classes: 2 });
        expect(transaction).toHaveBeenCalledTimes(1);
        expect(transaction.mock.calls[0][0]).toHaveLength(2);
        const written = upsert.mock.calls.map(([args]) => args as { where: { list: string }; update: { entries: unknown; refreshedAt: Date } });
        expect(written.map((w) => w.where.list)).toEqual(['account', 'class']);
        expect(written[0].update.entries).toEqual([
            { id: '1', name: 'Checking', accountType: 'Bank', active: true },
            { id: '2', name: 'Sales:Shop', accountType: 'Income', active: true },
        ]);
        expect(written[1].update.entries).toEqual([
            { id: '4', name: 'Old', active: false },
            { id: '9', name: 'Programs:Robotics', active: true },
        ]);
        expect(written[0].update.refreshedAt).toBe(written[1].update.refreshedAt);
    });

    it('writes nothing and rethrows when a read fails', async () => {
        const failure = new Error('QuickBooks query failed');
        client(async () => [], async () => { throw failure; });
        await expect(refreshQuickBooksLists()).rejects.toBe(failure);
        expect(transaction).not.toHaveBeenCalled();
    });

    it('answers null and writes nothing while QuickBooks is off', async () => {
        jest.mocked(getQuickBooks).mockResolvedValue(null);
        await expect(refreshQuickBooksLists()).resolves.toBeNull();
        expect(transaction).not.toHaveBeenCalled();
    });

    it('answers null without asking QuickBooks under CHECKIN_ENV=local', async () => {
        process.env.CHECKIN_ENV = 'local';
        await expect(refreshQuickBooksLists()).resolves.toBeNull();
        expect(getQuickBooks).not.toHaveBeenCalled();
        expect(transaction).not.toHaveBeenCalled();
    });
});

describe('the readers', () => {
    it('return the copy without asking QuickBooks, skipping malformed entries', async () => {
        findUnique.mockImplementation(async ({ where }: { where: { list: string } }) =>
            where.list === 'account'
                ? { entries: [{ id: '1', name: 'Checking', accountType: 'Bank', active: true }, { id: 2 }, 'junk'] }
                : { entries: [{ id: '9', name: 'Robotics', active: false }] },
        );
        await expect(savedQuickBooksAccounts()).resolves.toEqual([{ id: '1', name: 'Checking', accountType: 'Bank', active: true }]);
        await expect(savedQuickBooksClasses()).resolves.toEqual([{ id: '9', name: 'Robotics', active: false }]);
        expect(getQuickBooks).not.toHaveBeenCalled();
    });

    it('return nothing before the first refresh', async () => {
        findUnique.mockResolvedValue(null);
        await expect(savedQuickBooksAccounts()).resolves.toEqual([]);
        await expect(savedQuickBooksClasses()).resolves.toEqual([]);
    });
});
