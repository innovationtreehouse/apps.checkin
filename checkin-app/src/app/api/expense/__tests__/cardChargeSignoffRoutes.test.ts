/**
 * @jest-environment node
 */
/**
 * The card-charge sign-off routes through checkin's handler(): who the registry admits, and
 * that the library's refusals reach the caller with their status. The expense library is
 * stubbed; its own tests cover the refusals against a real database.
 */
import type { NextRequest as NextRequestType } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { httpError } from '@checkin/component-kit';
import { routes } from '@checkin/expense';
import type { AuthenticatedUser } from '@/types/auth';
import { POST as boardAuthorization } from '../expenses/[id]/board-authorization/route';
import { POST as notEveryday } from '../expenses/[id]/not-everyday/route';

jest.mock('@checkin/expense', () => ({ routes: { expenses: { boardAuthorization: jest.fn(), notEveryday: jest.fn() } } }));

const { NextRequest } = jest.requireActual<{ NextRequest: typeof NextRequestType }>('next/server');

const member: Partial<AuthenticatedUser> = {
    id: 5, email: 'member@x.test', isSysadmin: false, isBoardMember: false, isFinance: false, programsLed: [], householdId: 7,
};
const FINANCE = { ...member, isFinance: true };
const BOARD = { ...member, isBoardMember: true };
const STATUS = { ExpenseLineSignoffStatus: [{ lineItemId: 1, filled: ['SUBMITTER'], missing: [], blocked: [] }] };

const boardFactory = jest.mocked(routes.expenses.boardAuthorization);
const notEverydayFactory = jest.mocked(routes.expenses.notEveryday);

async function post(route: typeof boardAuthorization, path: string, user: Partial<AuthenticatedUser>, body: unknown) {
    jest.mocked(getServerSession).mockResolvedValueOnce({ user, expires: '2099-01-01T00:00:00.000Z' });
    const req = new NextRequest(`http://localhost/api/expense/expenses/e-1/${path}`, { method: 'POST', body: JSON.stringify(body) });
    return route(req, { params: Promise.resolve({ id: 'e-1' }) });
}

beforeEach(() => {
    boardFactory.mockReset().mockResolvedValue(STATUS);
    notEverydayFactory.mockReset().mockResolvedValue(STATUS);
});

describe('POST /api/expense/expenses/[id]/board-authorization', () => {
    const call = (user: Partial<AuthenticatedUser>, body: unknown = { authorization: 'Board vote, 2026-10-01' }) =>
        post(boardAuthorization, 'board-authorization', user, body);

    test.each([['FINANCE', FINANCE], ['Board', BOARD]])('%s is admitted and gets the sign-off status', async (_who, user) => {
        const res = await call(user);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual(STATUS.ExpenseLineSignoffStatus);
        expect(boardFactory).toHaveBeenCalledWith(expect.objectContaining({ params: { id: 'e-1' } }));
    });

    test('anyone else is refused before the library runs', async () => {
        expect((await call(member)).status).toBe(403);
        expect(boardFactory).not.toHaveBeenCalled();
    });

    test('blank text is refused with 400', async () => {
        boardFactory.mockRejectedValue(httpError(400, 'Say what the Board authorized'));
        expect((await call(FINANCE, { authorization: '   ' })).status).toBe(400);
    });

    test('a conflicted recorder is refused with 403', async () => {
        boardFactory.mockRejectedValue(httpError(403, 'conflicted'));
        expect((await call(FINANCE)).status).toBe(403);
    });
});

describe('POST /api/expense/expenses/[id]/not-everyday', () => {
    const call = (user: Partial<AuthenticatedUser>) => post(notEveryday, 'not-everyday', user, { reason: 'single_source' });

    test('FINANCE is admitted and gets the sign-off status', async () => {
        const res = await call(FINANCE);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual(STATUS.ExpenseLineSignoffStatus);
    });

    test.each([['Board', BOARD], ['a plain member', member]])('%s is refused before the library runs', async (_who, user) => {
        expect((await call(user)).status).toBe(403);
        expect(notEverydayFactory).not.toHaveBeenCalled();
    });
});
