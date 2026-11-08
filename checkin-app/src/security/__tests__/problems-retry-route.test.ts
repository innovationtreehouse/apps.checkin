/**
 * @jest-environment node
 */
/**
 * Admission and view for Retry on the System Status Problems list
 * (registry.ts): sysadmins and the Board retry stuck items and read whether
 * each step ran. Error text never leaves: a library's error can be personal,
 * and the item's own page shows it under that page's access. Auth runs through the real
 * authenticateRequest; only next-auth's getServerSession is stubbed
 * (jest.setup.js mocks it).
 */
import type { NextRequest as NextRequestType } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { getRoute } from '@/security/core';
import { handler } from '@/security/handler';

const { NextRequest } = jest.requireActual<{ NextRequest: typeof NextRequestType }>('next/server');
const mockSession = getServerSession as jest.MockedFunction<typeof getServerSession>;

const ENDPOINT = 'POST /api/system-status/problems/retry';
const RESULTS = [
    { step: 'expense-post', id: 41, ok: true },
    { step: 'receipt-push', id: 7, ok: false, error: 'Inventory did not answer' },
];
const STRIPPED = [
    { step: 'expense-post', id: 41, ok: true },
    { step: 'receipt-push', id: 7, ok: false },
];

type Flag = 'isFinance' | 'isBoardMember' | 'isInventoryManager' | 'isSysadmin' | 'isOperations' | 'isKeyholder';
type Claims = Partial<Record<Flag, boolean>> & { isActiveOrgMember?: boolean; ageBand?: string };

function signIn(claims: Claims) {
    mockSession.mockResolvedValue({
        user: {
            id: 5,
            isSysadmin: false,
            isBoardMember: false,
            isKeyholder: false,
            isBackgroundCheckReviewer: false,
            isOperations: false,
            isInventoryManager: false,
            isFinance: false,
            ...claims,
        },
        expires: '2099-01-01',
    });
}

async function call(claims: Claims) {
    signIn(claims);
    const impl = jest.fn(async () => ({ ProblemRetryResult: RESULTS }));
    const req = new NextRequest('http://localhost/api/system-status/problems/retry', { method: 'POST' });
    const res = await handler(ENDPOINT, impl)(req, { params: Promise.resolve({}) });
    return { res, impl };
}

beforeEach(() => mockSession.mockReset());

describe('Problems list retry route', () => {
    it('is registered for ProblemRetryResult', () => {
        expect(getRoute(ENDPOINT)?.returns).toEqual(['ProblemRetryResult']);
    });

    it.each([
        ['a sysadmin', { isSysadmin: true }],
        ['BOARD', { isBoardMember: true }],
    ] as const)('lets %s retry and read each outcome without its error text', async (_who, claims) => {
        const { res } = await call(claims);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ results: STRIPPED });
    });

    it.each([
        ['FINANCE', { isFinance: true }],
        ['an inventory manager', { isInventoryManager: true }],
        ['an operations volunteer', { isOperations: true }],
        ['a keyholder', { isKeyholder: true }],
        ['an adult member', { isActiveOrgMember: true, ageBand: 'adult' }],
        ['a person with no role', {}],
    ] as const)('403s %s without running the impl', async (_who, claims) => {
        const { res, impl } = await call(claims);
        expect(res.status).toBe(403);
        expect(impl).not.toHaveBeenCalled();
    });

    it('401s a signed-out caller', async () => {
        mockSession.mockResolvedValue(null);
        const impl = jest.fn(async () => ({}));
        const req = new NextRequest('http://localhost/api/system-status/problems/retry', { method: 'POST' });
        const res = await handler(ENDPOINT, impl)(req, { params: Promise.resolve({}) });
        expect(res.status).toBe(401);
        expect(impl).not.toHaveBeenCalled();
    });
});
