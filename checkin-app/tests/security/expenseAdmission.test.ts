/**
 * @jest-environment node
 */
/**
 * Admission and view invariants for the expense routes (#1272 §5/§6). No DB;
 * next-auth's getServerSession is the jest.setup.js mock.
 *
 * 1. An id-less session holding every flag gets 401 from handler() on every
 *    expense route, and the route body never runs: authenticateRequest turns a
 *    session without an integer id into 'unauthenticated' (boundary rule 6).
 *    The finance gates also deny it at resolveAccess on their own.
 * 2. The approver routes are exactly the `authenticated` ones.
 * 3. No expense route lists isSysadmin in its orderedView.
 * 4. The approver role sees `everyones:internal` only; pii and personal go to
 *    FINANCE and BOARD alone.
 * 5. Admission matches the persona: FINANCE passes everything, BOARD passes all
 *    but the FINANCE-only actions, an approver with no flag passes only the
 *    approver routes.
 */
import type { NextRequest as NextRequestType } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { allRoutes, type Authorize } from '@/security/core';
import { handler } from '@/security/handler';
import { resolveAccess, type ResolverContext } from '@/security/access-resolvers';
import type { AuthResult, AuthenticatedUser } from '@/types/auth';
import '@/security/registry';

const { NextRequest } = jest.requireActual<{ NextRequest: typeof NextRequestType }>('next/server');

const noFlags: AuthenticatedUser = {
    id: 5,
    email: 'approver@x.test',
    isSysadmin: false,
    isBoardMember: false,
    isKeyholder: false,
    isBackgroundCheckReviewer: false,
    isOperations: false,
    isInventoryManager: false,
    isFinance: false,
    programsLed: [1],
    householdId: 7,
};
const session = (user: Partial<AuthenticatedUser>): AuthResult => ({ type: 'session', user: { ...noFlags, ...user } });
const EVERY_FLAG: Partial<AuthenticatedUser> = {
    isSysadmin: true, isBoardMember: true, isKeyholder: true, isBackgroundCheckReviewer: true,
    isOperations: true, isInventoryManager: true, isFinance: true,
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
        programsLed: new Set([1]),
        programsCoreVolIn: new Set<number>(),
        participantIdsInScopePrograms: new Set<number>(),
        householdIdsInScopePrograms: new Set<number>(),
        eventIdsInScopePrograms: new Set<number>(),
        activeVisitorIds: new Set<number>(),
        ledHouseholdMemberIds: new Set<number>(),
    },
});

const expense = [...allRoutes()].filter(([endpoint]) => / \/api\/expense\//.test(endpoint));
const byGate = (a: Authorize) => expense.filter(([, r]) => r.authorize === a).map(([e]) => e);
const flagGated = expense.filter(([, r]) => r.authorize !== 'authenticated');

const APPROVER_ROUTES = [
    'GET /api/expense/counts',
    'GET /api/expense/expenses',
    'GET /api/expense/expenses/[id]',
    'GET /api/expense/expenses/[id]/line-item-approvals',
    'GET /api/expense/expenses/[id]/signoffs',
    'GET /api/expense/expenses/count',
    'GET /api/expense/queue',
    'POST /api/expense/expenses/[id]/line-item-approvals/[approvalId]/approve',
    'POST /api/expense/expenses/[id]/line-item-approvals/[approvalId]/raise-exception',
    'POST /api/expense/expenses/[id]/line-items/[lineItemId]/signoffs',
];

describe('expense admission', () => {
    test('every expense route uses finance, finance-or-board or authenticated', () => {
        expect(expense.length).toBeGreaterThan(0);
        for (const [endpoint, r] of expense) {
            expect([endpoint, r.authorize]).toEqual([endpoint, expect.stringMatching(/^(finance|finance-or-board|authenticated)$/)]);
        }
    });

    test.each(flagGated)('%s denies an id-less session holding every flag at resolveAccess', async (_e, route) => {
        expect((await resolveAccess(route.authorize, ctx(idless))).allowed).toBe(false);
    });

    test.each(expense)('%s answers an id-less session 401 without running the body', async (endpoint) => {
        jest.mocked(getServerSession).mockResolvedValueOnce({
            user: { ...noFlags, ...EVERY_FLAG, id: undefined },
            expires: '2099-01-01T00:00:00.000Z',
        });
        const body = jest.fn(async () => ({}));
        const [method, path] = endpoint.split(' ');
        const res = await handler(endpoint, body)(new NextRequest(`http://localhost${path}`, { method }));
        expect(res.status).toBe(401);
        expect(body).not.toHaveBeenCalled();
    });

    test.each(expense)('%s runs the body for the same session with an integer id (control)', async (endpoint) => {
        jest.mocked(getServerSession).mockResolvedValueOnce({
            user: { ...noFlags, ...EVERY_FLAG },
            expires: '2099-01-01T00:00:00.000Z',
        });
        const body = jest.fn(async () => ({}));
        const [method, path] = endpoint.split(' ');
        const res = await handler(endpoint, body)(new NextRequest(`http://localhost${path}`, { method }));
        expect(res.status).toBe(200);
        expect(body).toHaveBeenCalledTimes(1);
    });

    test('the approver routes are exactly the authenticated ones', () => {
        expect(byGate('authenticated').sort()).toEqual([...APPROVER_ROUTES].sort());
    });

    test('setReimbursee is FINANCE only', () => {
        expect(byGate('finance')).toContain('PUT /api/expense/expenses/[id]/reimbursee');
    });

    test.each(expense)('%s: FINANCE is admitted', async (_e, route) => {
        expect((await resolveAccess(route.authorize, ctx(session({ isFinance: true })))).allowed).toBe(true);
    });

    test.each(expense)('%s: BOARD is admitted unless FINANCE-only', async (_e, route) => {
        const allowed = (await resolveAccess(route.authorize, ctx(session({ isBoardMember: true })))).allowed;
        expect(allowed).toBe(route.authorize !== 'finance');
    });

    test.each(expense)('%s: a sysadmin alone is admitted only where any session is', async (_e, route) => {
        const allowed = (await resolveAccess(route.authorize, ctx(session({ isSysadmin: true })))).allowed;
        expect(allowed).toBe(route.authorize === 'authenticated');
    });

    test.each(expense)('%s: an approver with no flag is admitted only on approver routes', async (endpoint, route) => {
        const allowed = (await resolveAccess(route.authorize, ctx(session({})))).allowed;
        expect(allowed).toBe(APPROVER_ROUTES.includes(endpoint));
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
