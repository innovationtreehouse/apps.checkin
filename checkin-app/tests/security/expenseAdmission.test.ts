/**
 * @jest-environment node
 */
/**
 * Admission and view invariants for the expense routes (#1272 §5/§6). No DB:
 * next-auth's getServerSession is the jest.setup.js mock, and the bucket
 * approver lookup is stubbed per test.
 *
 * 1. An id-less session holding every flag gets 401 from handler() on every
 *    expense route, and the route body never runs: authenticateRequest turns a
 *    session without an integer id into 'unauthenticated' (boundary rule 6).
 *    Every expense gate also denies it at resolveAccess on its own.
 * 2. `expense-approver` admits FINANCE, BOARD or an approver of some bucket
 *    (one directory read), never a plain member, a sysadmin alone, or a program
 *    leader who approves no bucket. It gates the ten approver routes.
 * 3. Sign-off is `expense-signer`: anyone `receipt-submitter` (the submitter seat)
 *    or `expense-approver` (every other seat) admits. The library picks the seat.
 * 4. No expense route lists isSysadmin in its orderedView, and pii/personal go to
 *    FINANCE and BOARD alone.
 */
import type { NextRequest as NextRequestType } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { allRoutes, type Authorize } from '@/security/core';
import { handler } from '@/security/handler';
import { resolveAccess, type ResolverContext } from '@/security/access-resolvers';
import type { AuthResult, AuthenticatedUser } from '@/types/auth';
import { bucketsApprovedBy } from '@/lib/finance/bucketApprovers';
import '@/security/registry';

jest.mock('@/lib/finance/bucketApprovers', () => ({ bucketsApprovedBy: jest.fn() }));

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
const session = (user: Partial<AuthenticatedUser>): AuthResult => ({ type: 'session', user: { ...noFlags, ...user } });
const EVERY_FLAG: Partial<AuthenticatedUser> = {
    isSysadmin: true, isBoardMember: true, isKeyholder: true, isBackgroundCheckReviewer: true,
    isOperations: true, isInventoryManager: true, isFinance: true, programsLed: [1],
};
const idless: AuthResult = { type: 'session', user: Object.assign({ ...noFlags, ...EVERY_FLAG }, { id: undefined }) };

const ctx = (auth: AuthResult): ResolverContext => ({
    auth,
    params: { id: 'e-1' },
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

const expense = [...allRoutes()].filter(([endpoint]) => endpoint.split(' ')[1].startsWith('/api/expense/'));
const expenseRoute = (endpoint: string) => {
    const route = expense.find(([e]) => e === endpoint)?.[1];
    if (!route) throw new Error(`${endpoint} is not registered`);
    return route;
};
const byGate = (a: Authorize) => expense.filter(([, r]) => r.authorize === a).map(([e]) => e);

const SIGN_OFF = 'POST /api/expense/expenses/[id]/line-items/[lineItemId]/signoffs';
const APPROVER_ROUTES = [
    'GET /api/expense/counts',
    'GET /api/expense/expenses',
    'GET /api/expense/expenses/[id]',
    'GET /api/expense/expenses/[id]/line-item-approvals',
    'GET /api/expense/expenses/[id]/signoffs',
    'GET /api/expense/expenses/count',
    'GET /api/expense/queue',
    'POST /api/expense/expenses/[id]/approve-lines',
    'POST /api/expense/expenses/[id]/line-item-approvals/[approvalId]/approve',
    'POST /api/expense/expenses/[id]/line-item-approvals/[approvalId]/raise-exception',
];

let approvedBuckets: number[];
const approverLookup = jest.mocked(bucketsApprovedBy);

beforeEach(() => {
    approvedBuckets = [];
    approverLookup.mockReset();
    approverLookup.mockImplementation(async () => approvedBuckets);
});

const admitted = async (route: { authorize: Authorize }, user: Partial<AuthenticatedUser>) =>
    (await resolveAccess(route.authorize, ctx(session(user)))).allowed;

const call = async (endpoint: string, user: Omit<Partial<AuthenticatedUser>, 'id'> & { id: number | undefined }) => {
    jest.mocked(getServerSession).mockResolvedValueOnce({ user: { ...noFlags, ...user }, expires: '2099-01-01T00:00:00.000Z' });
    const body = jest.fn(async () => ({}));
    const [method, path] = endpoint.split(' ');
    const res = await handler(endpoint, body)(new NextRequest(`http://localhost${path}`, { method }));
    return { status: res.status, ran: body.mock.calls.length > 0 };
};

describe('expense admission', () => {
    test('every expense route uses an expected gate', () => {
        expect(expense.length).toBeGreaterThan(0);
        for (const [endpoint, r] of expense) {
            expect([endpoint, r.authorize]).toEqual([
                endpoint,
                expect.stringMatching(/^(finance|finance-or-board|expense-approver|expense-signer)$/),
            ]);
        }
    });

    test('the approver routes are exactly the expense-approver ones; sign-off alone is expense-signer', () => {
        expect(byGate('expense-approver').sort()).toEqual([...APPROVER_ROUTES].sort());
        expect(byGate('expense-signer')).toEqual([SIGN_OFF]);
    });

    test('setReimbursee is FINANCE only', () => {
        expect(byGate('finance')).toContain('PUT /api/expense/expenses/[id]/reimbursee');
    });

    test.each(expense)('%s denies an id-less session holding every flag at resolveAccess', async (_e, route) => {
        approvedBuckets = [1];
        expect((await resolveAccess(route.authorize, ctx(idless))).allowed).toBe(false);
    });

    test.each(expense)('%s answers an id-less session 401 without running the body', async (endpoint) => {
        expect(await call(endpoint, { ...EVERY_FLAG, id: undefined })).toEqual({ status: 401, ran: false });
    });

    test.each(expense)('%s runs the body for the same session with an integer id (control)', async (endpoint) => {
        expect(await call(endpoint, { ...EVERY_FLAG, id: 5 })).toEqual({ status: 200, ran: true });
    });

    test.each(expense)('%s: FINANCE is admitted', async (_e, route) => {
        expect(await admitted(route, { isFinance: true })).toBe(true);
    });

    test.each(expense)('%s: BOARD is admitted unless FINANCE-only', async (_e, route) => {
        expect(await admitted(route, { isBoardMember: true })).toBe(route.authorize !== 'finance');
    });

    test.each(expense)('%s: a sysadmin alone is admitted only on sign-off', async (endpoint, route) => {
        expect(await admitted(route, { isSysadmin: true })).toBe(endpoint === SIGN_OFF);
    });

    test.each(expense)('%s: a bucket approver is admitted on approver routes and sign-off', async (endpoint, route) => {
        approvedBuckets = [1];
        expect(await admitted(route, {})).toBe(APPROVER_ROUTES.includes(endpoint) || endpoint === SIGN_OFF);
    });

    test.each(expense)('%s: a program leader who approves no bucket is admitted nowhere', async (_e, route) => {
        expect(await admitted(route, { programsLed: [1] })).toBe(false);
    });

    test.each(expense)('%s: a plain member is admitted nowhere', async (_e, route) => {
        expect(await admitted(route, {})).toBe(false);
    });

    test('an adult with an ACTIVE membership and no role is admitted on sign-off only', async () => {
        for (const [endpoint, route] of expense) {
            expect([endpoint, await admitted(route, { ageBand: 'adult', isActiveOrgMember: true })]).toEqual([endpoint, endpoint === SIGN_OFF]);
        }
    });

    test('an adult with no role and no ACTIVE membership is admitted nowhere', async () => {
        for (const [endpoint, route] of expense) {
            expect([endpoint, await admitted(route, { ageBand: 'adult' })]).toEqual([endpoint, false]);
        }
    });

    test('a youth with no role is admitted nowhere, even with an ACTIVE Volunteer Family membership', async () => {
        for (const [endpoint, route] of expense) {
            expect([endpoint, await admitted(route, { ageBand: 'youth', isVolunteerFamily: true, isActiveOrgMember: true })]).toEqual([endpoint, false]);
        }
    });

    // Whatever receipt-submitter requires (an adult member), a bucket approver
    // still reaches sign-off through the approver leg.
    test('sign-off admits a bucket approver on the approver leg', async () => {
        approvedBuckets = [1];
        expect(await admitted({ authorize: 'expense-approver' }, {})).toBe(true);
        expect(await admitted(expenseRoute(SIGN_OFF), {})).toBe(true);
    });

    test('sign-off admits exactly the union of receipt-submitter and expense-approver', async () => {
        const callers: Array<[string, Partial<AuthenticatedUser>, number[]]> = [
            ['plain member', {}, []],
            ['bucket approver', {}, [1]],
            ['program leader approving no bucket', { programsLed: [1] }, []],
            ['FINANCE', { isFinance: true }, []],
            ['BOARD', { isBoardMember: true }, []],
            ['keyholder', { isKeyholder: true }, []],
            ['adult with no role', { ageBand: 'adult' }, []],
            ['adult member with no role', { ageBand: 'adult', isActiveOrgMember: true }, []],
            ['youth Volunteer Family member', { ageBand: 'youth', isVolunteerFamily: true, isActiveOrgMember: true }, []],
        ];
        for (const [who, user, buckets] of callers) {
            approvedBuckets = buckets;
            const union = (await admitted({ authorize: 'receipt-submitter' }, user)) || (await admitted({ authorize: 'expense-approver' }, user));
            expect([who, await admitted(expenseRoute(SIGN_OFF), user)]).toEqual([who, union]);
        }
    });

    test.each(['GET /api/expense/queue', 'GET /api/expense/counts', SIGN_OFF])(
        '%s answers a plain member 403 without running the body',
        async (endpoint) => {
            expect(await call(endpoint, { id: 5 })).toEqual({ status: 403, ran: false });
        },
    );

    test('the approver leg runs the lookup once, for the caller, only when no flag admits', async () => {
        approvedBuckets = [1];
        expect(await admitted({ authorize: 'expense-approver' }, {})).toBe(true);
        expect(approverLookup).toHaveBeenCalledTimes(1);
        expect(approverLookup).toHaveBeenCalledWith(5);

        approverLookup.mockClear();
        expect(await admitted({ authorize: 'expense-approver' }, { isFinance: true })).toBe(true);
        expect(await admitted({ authorize: 'expense-approver' }, { isBoardMember: true })).toBe(true);
        expect(approverLookup).not.toHaveBeenCalled();
    });
});

describe('expense views', () => {
    test('no expense route lists isSysadmin', () => {
        expect(expense.filter(([, r]) => r.orderedView.some(([role]) => role === 'isSysadmin')).map(([e]) => e)).toEqual([]);
    });

    test.each(expense)('%s: only FINANCE and BOARD get pii or personal', (_e, route) => {
        for (const [role, tokens] of route.orderedView) {
            if (role === 'isFinance' || role === 'isBoardMember') continue;
            expect([role, tokens]).toEqual([role, ['everyones:internal']]);
        }
    });
});
