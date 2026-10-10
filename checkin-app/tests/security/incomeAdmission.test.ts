/**
 * @jest-environment node
 *
 * Income route admission (#1283 §6): the exact endpoint set and gates, the
 * FINANCE/BOARD views with no sysadmin, and the persona matrix — including an
 * id-less session, which the handler answers 401 before any income code runs.
 */
import type { NextRequest as NextRequestType } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { allRoutes } from '@/security/core';
import { resolveAccess, type ResolverContext } from '@/security/access-resolvers';
import { handler } from '@/security/handler';
import type { AuthResult, AuthenticatedUser } from '@/types/auth';
import '@/security/registry';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));
jest.mock('@/lib/auth-options', () => ({ authOptions: {} }));
const { NextRequest } = jest.requireActual<{ NextRequest: typeof NextRequestType }>('next/server');
const mockSession = getServerSession as jest.Mock;

const FINANCE_OR_BOARD = [
    'GET /api/income/payouts',
    'GET /api/income/payouts/[gid]',
    'GET /api/income/reconciliation',
    'GET /api/income/reconciliation/count',
    'GET /api/income/items',
    'GET /api/income/qb-exclusions',
];
const FINANCE_ONLY = [
    'GET /api/income/reconciliation/[id]/candidates',
    'POST /api/income/reconciliation/[id]/resolve',
    'POST /api/income/reconciliation/run',
    'PUT /api/income/items/[variantId]/category',
    'DELETE /api/income/items/[variantId]/category',
    'POST /api/income/qb-exclusions',
];
const INTERNAL_VIEW = ['everyones:internal', 'public'];

const income = [...allRoutes()].filter(([endpoint]) => endpoint.split(' ')[1].startsWith('/api/income/'));
const incomeEndpoints = income.map(([endpoint]) => endpoint);

const noFlags: AuthenticatedUser = {
    id: 1,
    email: 'p@x.test',
    isSysadmin: false,
    isBoardMember: false,
    isKeyholder: false,
    isBackgroundCheckReviewer: false,
    isOperations: false,
    isInventoryManager: false,
    isFinance: false,
};
const session = (flags: Partial<AuthenticatedUser>): AuthResult => ({ type: 'session', user: { ...noFlags, ...flags } });

const ctx = (auth: AuthResult): ResolverContext => ({
    auth,
    params: {},
    callerContext: {
        selfId: undefined,
        householdId: undefined,
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

describe('income registry', () => {
    test('registers exactly the §6 endpoints', () => {
        expect([...incomeEndpoints].sort()).toEqual([...FINANCE_OR_BOARD, ...FINANCE_ONLY].sort());
    });

    test('QB exclusions have no DELETE', () => {
        expect(incomeEndpoints.filter(e => e.endsWith('/qb-exclusions') && e.startsWith('DELETE'))).toEqual([]);
    });

    test.each(FINANCE_OR_BOARD)('%s: finance-or-board, FINANCE then BOARD internal view', (endpoint) => {
        const route = income.find(([e]) => e === endpoint)![1];
        expect(route.authorize).toBe('finance-or-board');
        expect(route.orderedView).toEqual([['isFinance', INTERNAL_VIEW], ['isBoardMember', INTERNAL_VIEW]]);
    });

    test.each(FINANCE_ONLY)('%s: finance, FINANCE internal view', (endpoint) => {
        const route = income.find(([e]) => e === endpoint)![1];
        expect(route.authorize).toBe('finance');
        expect(route.orderedView).toEqual([['isFinance', INTERNAL_VIEW]]);
    });
});

describe('income admission by persona', () => {
    const personas: [string, AuthResult, (e: string) => boolean][] = [
        ['finance', session({ isFinance: true }), () => true],
        ['board', session({ isBoardMember: true }), e => FINANCE_OR_BOARD.includes(e)],
        ['sysadmin', session({ isSysadmin: true }), () => false],
        ['inventory manager', session({ isInventoryManager: true }), () => false],
        ['no-flag session', session({}), () => false],
        ['unauthenticated', { type: 'unauthenticated' }, () => false],
        ['id-less session holding finance+board',
            { type: 'session', user: Object.assign({ ...noFlags, isFinance: true, isBoardMember: true }, { id: undefined }) },
            () => false],
    ];

    test.each(personas)('%s', async (_label, auth, admitted) => {
        for (const [endpoint, route] of income) {
            const { allowed } = await resolveAccess(route.authorize, ctx(auth));
            expect({ endpoint, allowed }).toEqual({ endpoint, allowed: admitted(endpoint) });
        }
    });
});

describe('income handler with an id-less session', () => {
    // NextAuth still builds session.user from the empty token a missed jwt re-sync returns.
    test.each(incomeEndpoints)('%s answers 401 without running the handler body', async (endpoint) => {
        mockSession.mockResolvedValue({ user: { isFinance: true, isBoardMember: true } });
        const body = jest.fn();
        const route = handler(endpoint, body);
        const res = await route(new NextRequest('http://localhost' + endpoint.split(' ')[1], { method: endpoint.split(' ')[0] }));
        expect(res.status).toBe(401);
        expect(body).not.toHaveBeenCalled();
    });
});
