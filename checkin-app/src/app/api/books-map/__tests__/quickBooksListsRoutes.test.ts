/**
 * @jest-environment node
 */
/**
 * GET /api/books-map/quickbooks-lists and POST /api/books-map/quickbooks-lists/refresh: who the registry admits,
 * the 503 wording when QuickBooks is off or fails its read, the status rows a success answers with, and the 30 s gap between QuickBooks reads.
 */
import type { NextRequest as NextRequestType } from 'next/server';
import { getServerSession } from 'next-auth/next';
import type { AuthenticatedUser } from '@/types/auth';
import { quickBooksListsStatus, refreshQuickBooksLists } from '@/lib/finance/quickBooksLists';
import { GET } from '../quickbooks-lists/route';
import { POST } from '../quickbooks-lists/refresh/route';

jest.mock('@/lib/finance/quickBooksLists', () => ({ quickBooksListsStatus: jest.fn(), refreshQuickBooksLists: jest.fn() }));

const { NextRequest } = jest.requireActual<{ NextRequest: typeof NextRequestType }>('next/server');

const member: Partial<AuthenticatedUser> = {
    id: 5, email: 'member@x.test', isSysadmin: false, isBoardMember: false, isFinance: false, programsLed: [], householdId: 7,
};
const FINANCE = { ...member, isFinance: true };
const BOARD = { ...member, isBoardMember: true };
const SYSADMIN = { ...member, isSysadmin: true };

const AT = new Date('2026-11-14T06:00:00.000Z');
const STATUS = [{ list: 'account', refreshedAt: AT, entries: 42 }, { list: 'class', refreshedAt: AT, entries: 7 }];
const STATUS_JSON = STATUS.map((s) => ({ ...s, refreshedAt: AT.toISOString() }));

const status = jest.mocked(quickBooksListsStatus);
const refresh = jest.mocked(refreshQuickBooksLists);

function as(user: Partial<AuthenticatedUser>) {
    jest.mocked(getServerSession).mockResolvedValueOnce({ user, expires: '2099-01-01T00:00:00.000Z' });
}
const read = (user: Partial<AuthenticatedUser>) => {
    as(user);
    return GET(new NextRequest('http://localhost/api/books-map/quickbooks-lists'));
};
const press = (user: Partial<AuthenticatedUser>) => {
    as(user);
    return POST(new NextRequest('http://localhost/api/books-map/quickbooks-lists/refresh', { method: 'POST' }));
};

beforeEach(() => {
    status.mockReset().mockResolvedValue(STATUS);
    refresh.mockReset().mockResolvedValue({ refreshedAt: AT, accounts: 42, classes: 7 });
    jest.spyOn(console, 'info').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
});

describe('GET /api/books-map/quickbooks-lists', () => {
    test.each([['FINANCE', FINANCE], ['Board', BOARD]])('%s reads when each list was refreshed and its count', async (_who, user) => {
        const res = await read(user);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual(STATUS_JSON);
    });

    test.each([['a member', member], ['a sysadmin', SYSADMIN]])('%s is refused', async (_who, user) => {
        expect((await read(user)).status).toBe(403);
        expect(status).not.toHaveBeenCalled();
    });
});

describe('POST /api/books-map/quickbooks-lists/refresh', () => {
    test.each([['FINANCE', FINANCE], ['Board', BOARD]])('%s refreshes and gets the new status', async (_who, user) => {
        const res = await press(user);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual(STATUS_JSON);
        expect(refresh).toHaveBeenCalledTimes(1);
    });

    test.each([['a member', member], ['a sysadmin', SYSADMIN]])('%s is refused before any refresh', async (_who, user) => {
        expect((await press(user)).status).toBe(403);
        expect(refresh).not.toHaveBeenCalled();
    });

    test('answers 503 "not connected" while QuickBooks is off', async () => {
        refresh.mockResolvedValue(null);
        const res = await press(FINANCE);
        expect(res.status).toBe(503);
        expect((await res.json()).error).toBe('QuickBooks is not connected.');
        expect(status).toHaveBeenCalledTimes(1);
    });

    test('a press within 30 s of the last refresh answers with the saved status and never calls QuickBooks', async () => {
        const recent = new Date(Date.now() - 10_000);
        status.mockResolvedValue(STATUS.map((s) => ({ ...s, refreshedAt: recent })));
        const res = await press(FINANCE);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual(STATUS.map((s) => ({ ...s, refreshedAt: recent.toISOString() })));
        expect(refresh).not.toHaveBeenCalled();
    });

    test('a press calls QuickBooks when one list is fresh and the other is 30 s or older', async () => {
        status.mockResolvedValue([{ ...STATUS[0], refreshedAt: new Date(Date.now() - 10_000) }, { ...STATUS[1], refreshedAt: new Date(Date.now() - 40_000) }]);
        expect((await press(FINANCE)).status).toBe(200);
        expect(refresh).toHaveBeenCalledTimes(1);
    });

    test('a press 30 s or more after the last refresh calls QuickBooks', async () => {
        status.mockResolvedValue(STATUS.map((s) => ({ ...s, refreshedAt: new Date(Date.now() - 31_000) })));
        expect((await press(FINANCE)).status).toBe(200);
        expect(refresh).toHaveBeenCalledTimes(1);
    });

    test('answers 503 "try again" when QuickBooks fails its read, and never its exception text', async () => {
        refresh.mockRejectedValue(new Error('QBO 500: realm 123 token abc'));
        const res = await press(FINANCE);
        expect(res.status).toBe(503);
        const body = await res.json();
        expect(body.error).toBe('QuickBooks did not return its lists. Try again shortly.');
        expect(JSON.stringify(body)).not.toContain('realm');
    });
});
