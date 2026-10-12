/**
 * @jest-environment node
 */
/**
 * Admission and view invariants for the budget-owner bucket and program-treasurer
 * routes (#1280 §6). No DB: next-auth's getServerSession is the jest.setup.js mock.
 *
 * 1. An id-less session holding every flag gets 401 from handler() on every route,
 *    and the route body never runs (boundary rule 6).
 * 2. Bucket reads and the treasurer list admit FINANCE or BOARD; bucket writes
 *    admit FINANCE alone; setting or clearing a treasurer admits BOARD alone.
 *    A sysadmin, a program leader or a plain member is admitted nowhere.
 * 3. No route lists isSysadmin, and no view grants pii or personal.
 */
import type { NextRequest as NextRequestType } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { allRoutes, getRoute, type RegisteredRoute } from '@/security/core';
import { handler } from '@/security/handler';
import { resolveAccess, type ResolverContext } from '@/security/access-resolvers';
import type { AuthResult, AuthenticatedUser } from '@/types/auth';
import '@/security/registry';

const { NextRequest } = jest.requireActual<{ NextRequest: typeof NextRequestType }>('next/server');

const noFlags: AuthenticatedUser = {
    id: 5,
    email: 'member@x.test',
    isSysadmin: false,
    isBoardMember: false,
    isKeyholder: false,
    isBackgroundCheckReviewer: false,
    isOperations: false,
    isInventoryManager: false,
    isFinance: false,
    programsLed: [],
    householdId: 7,
};
const EVERY_FLAG: Partial<AuthenticatedUser> = {
    isSysadmin: true, isBoardMember: true, isKeyholder: true, isBackgroundCheckReviewer: true,
    isOperations: true, isInventoryManager: true, isFinance: true, programsLed: [1],
};

const ctx = (auth: AuthResult): ResolverContext => ({
    auth,
    params: { id: '1', personId: '9' },
    callerContext: {
        selfId: auth.type === 'session' ? auth.user.id : undefined,
        householdId: 7,
        isKeyholder: false,
        isKiosk: false,
        programsLed: new Set<number>(),
        programsCoreVolIn: new Set<number>(),
        participantIdsInScopePrograms: new Set<number>(),
        householdIdsInScopePrograms: new Set<number>(),
        eventIdsInScopePrograms: new Set<number>(),
        activeVisitorIds: new Set<number>(),
        ledHouseholdMemberIds: new Set<number>(),
    },
});

const FINANCE_OR_BOARD = [
    'GET /api/budget-owners',
    'GET /api/budget-owners/program-options',
    'GET /api/programs/[id]/treasurers',
];
const FINANCE_ONLY = [
    'POST /api/budget-owners',
    'PATCH /api/budget-owners/[id]',
    'POST /api/budget-owners/[id]/archive',
];
const BOARD_ONLY = [
    'PUT /api/programs/[id]/treasurers/[personId]',
    'DELETE /api/programs/[id]/treasurers/[personId]',
];
const ENDPOINTS = [...FINANCE_OR_BOARD, ...FINANCE_ONLY, ...BOARD_ONLY];

const route = (endpoint: string): RegisteredRoute => {
    const r = getRoute(endpoint);
    if (!r) throw new Error(`${endpoint} is not registered`);
    return r;
};

const admitted = async (endpoint: string, user: Partial<AuthenticatedUser>) =>
    (await resolveAccess(route(endpoint).authorize, ctx({ type: 'session', user: { ...noFlags, ...user } }))).allowed;

const call = async (endpoint: string, user: Omit<Partial<AuthenticatedUser>, 'id'> & { id: number | undefined }) => {
    jest.mocked(getServerSession).mockResolvedValueOnce({ user: { ...noFlags, ...user }, expires: '2099-01-01T00:00:00.000Z' });
    const body = jest.fn(async () => ({}));
    const [method, path] = endpoint.split(' ');
    const res = await handler(endpoint, body)(new NextRequest(`http://localhost${path}`, { method }));
    return { status: res.status, ran: body.mock.calls.length > 0 };
};

describe('budget-owner admission', () => {
    test('exactly these routes are registered under the bucket and treasurer paths', () => {
        const registered = [...allRoutes()]
            .map(([endpoint]) => endpoint)
            .filter((e) => /^\S+ \/api\/(budget-owners|programs\/\[id\]\/treasurers)(\/|$)/.test(e));
        expect(registered.sort()).toEqual([...ENDPOINTS].sort());
    });

    test.each(ENDPOINTS)('%s answers an id-less session 401 without running the body', async (endpoint) => {
        expect(await call(endpoint, { ...EVERY_FLAG, id: undefined })).toEqual({ status: 401, ran: false });
    });

    test.each(ENDPOINTS)('%s runs the body for the same session with an integer id (control)', async (endpoint) => {
        expect(await call(endpoint, { ...EVERY_FLAG, id: 5 })).toEqual({ status: 200, ran: true });
    });

    test.each(ENDPOINTS)('%s: FINANCE is admitted unless Board-only', async (endpoint) => {
        expect(await admitted(endpoint, { isFinance: true })).toBe(!BOARD_ONLY.includes(endpoint));
    });

    test.each(ENDPOINTS)('%s: BOARD is admitted unless FINANCE-only', async (endpoint) => {
        expect(await admitted(endpoint, { isBoardMember: true })).toBe(!FINANCE_ONLY.includes(endpoint));
    });

    test.each(ENDPOINTS)('%s: a sysadmin, program leader or plain member alone is refused', async (endpoint) => {
        expect(await admitted(endpoint, { isSysadmin: true })).toBe(false);
        expect(await admitted(endpoint, { programsLed: [1] })).toBe(false);
        expect(await admitted(endpoint, {})).toBe(false);
    });

    test('a plain member gets 403 from handler() without running the body', async () => {
        expect(await call('GET /api/budget-owners', { id: 5 })).toEqual({ status: 403, ran: false });
    });
});

describe('budget-owner views', () => {
    test.each(ENDPOINTS)('%s grants internal and public only, never to a sysadmin', (endpoint) => {
        for (const [role, tokens] of route(endpoint).orderedView) {
            expect(role).not.toBe('isSysadmin');
            expect([role, [...tokens].sort()]).toEqual([role, ['everyones:internal', 'public']]);
        }
    });
});
