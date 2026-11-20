/**
 * @jest-environment node
 */
/**
 * GET and POST /api/finance/quickbooks/catch-up: finance or board only, a lane the app knows, and
 * the QuickBooksPostingCatchUp fields the registry lets through.
 */
import type { NextRequest as NextRequestType } from 'next/server';
import { getServerSession } from 'next-auth/next';
import type { AuthenticatedUser } from '@/types/auth';
import { catchUpPosting, postingCatchUpState } from '@/lib/finance/quickBooksPosting';
import { GET, POST } from '../route';

jest.mock('@/lib/finance/quickBooksPosting', () => ({
    ...jest.requireActual<object>('@/lib/finance/quickBooksPosting'),
    catchUpPosting: jest.fn(),
    postingCatchUpState: jest.fn(),
}));

const { NextRequest } = jest.requireActual<{ NextRequest: typeof NextRequestType }>('next/server');

const member: Partial<AuthenticatedUser> = {
    id: 5, email: 'member@x.test', isSysadmin: false, isBoardMember: false, isFinance: false, programsLed: [], householdId: 7,
};
const FINANCE = { ...member, isFinance: true };
const BOARD = { ...member, isBoardMember: true };
const UNTIL = new Date('2026-11-18T14:05:00.000Z');
const STATE = { lane: 'in-kind' as const, status: 'queued' as const, heldBy: 'expense' as const, until: UNTIL, queued: ['in-kind' as const], pausedUntil: null, lastRuns: {} };
const STATE_JSON = { ...STATE, until: UNTIL.toISOString() };

function as(user: Partial<AuthenticatedUser>) {
    jest.mocked(getServerSession).mockResolvedValueOnce({ user, expires: '2099-01-01T00:00:00.000Z' });
}
const read = (user: Partial<AuthenticatedUser>, lane = 'in-kind') => {
    as(user);
    return GET(new NextRequest(`http://localhost/api/finance/quickbooks/catch-up?lane=${lane}`));
};
const press = (user: Partial<AuthenticatedUser>, lane: unknown = 'in-kind') => {
    as(user);
    return POST(new NextRequest('http://localhost/api/finance/quickbooks/catch-up', { method: 'POST', body: JSON.stringify({ lane }) }));
};

beforeEach(() => {
    jest.mocked(postingCatchUpState).mockReset().mockResolvedValue(STATE);
    jest.mocked(catchUpPosting).mockReset().mockResolvedValue(STATE);
});

test.each([['FINANCE', FINANCE], ['Board', BOARD]])('%s reads a lane and asks for its catch-up', async (_who, user) => {
    const got = await read(user);
    expect(got.status).toBe(200);
    expect(await got.json()).toEqual(STATE_JSON);
    expect(postingCatchUpState).toHaveBeenCalledWith('in-kind');

    const asked = await press(user);
    expect(asked.status).toBe(200);
    expect(await asked.json()).toEqual(STATE_JSON);
    expect(catchUpPosting).toHaveBeenCalledWith('in-kind', 5);
});

test('a GET with no lane reads the slot and queue alone', async () => {
    as(FINANCE);
    const res = await GET(new NextRequest('http://localhost/api/finance/quickbooks/catch-up'));
    expect(res.status).toBe(200);
    expect(postingCatchUpState).toHaveBeenCalledWith(null);
});

test('a member is refused and nothing is asked', async () => {
    expect((await read(member)).status).toBe(403);
    expect((await press(member)).status).toBe(403);
    expect(catchUpPosting).not.toHaveBeenCalled();
});

test('an unknown lane is a 400', async () => {
    expect((await read(FINANCE, 'toString')).status).toBe(400);
    expect((await press(FINANCE, 'payroll')).status).toBe(400);
    expect(catchUpPosting).not.toHaveBeenCalled();
});
