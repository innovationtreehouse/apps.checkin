/**
 * @jest-environment node
 */
/**
 * Admission and view for resetting one person's automatic-reading allowance
 * (registry/receipt.ts): FINANCE and BOARD reset it; nobody else. Auth runs
 * through the real authenticateRequest; only next-auth's getServerSession is
 * stubbed (jest.setup.js mocks it).
 */
import type { NextRequest as NextRequestType } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { getRoute } from '@/security/core';
import { handler } from '@/security/handler';

const { NextRequest } = jest.requireActual<{ NextRequest: typeof NextRequestType }>('next/server');
const mockSession = getServerSession as jest.MockedFunction<typeof getServerSession>;

const RESET = 'POST /api/receipts/allowance/[personId]/reset';
const URL = 'http://localhost/api/receipts/allowance/7/reset';

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
    const impl = jest.fn(async () => ({ ReceiptOcrAllowance: { personId: 7 } }));
    const res = await handler(RESET, impl)(new NextRequest(URL, { method: 'POST' }), { params: Promise.resolve({ personId: '7' }) });
    return { res, impl };
}

beforeEach(() => mockSession.mockReset());

describe('receipt reading-allowance reset route', () => {
    it('is registered for ReceiptOcrAllowance, FINANCE and BOARD only', () => {
        const spec = getRoute(RESET);
        expect(spec?.returns).toEqual(['ReceiptOcrAllowance']);
        expect(spec?.authorize).toBe('finance-or-board');
    });

    it.each([
        ['FINANCE', { isFinance: true }],
        ['BOARD', { isBoardMember: true }],
    ] as const)('lets %s reset a person\'s allowance', async (_who, claims) => {
        const { res } = await call(claims);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ personId: 7 });
    });

    it.each([
        ['a sysadmin', { isSysadmin: true }],
        ['an adult member who submits receipts', { isActiveOrgMember: true, ageBand: 'adult' }],
        ['an operations volunteer', { isOperations: true }],
        ['an inventory manager', { isInventoryManager: true }],
        ['a person with no role', {}],
    ] as const)('403s %s without running the impl', async (_who, claims) => {
        const { res, impl } = await call(claims);
        expect(res.status).toBe(403);
        expect(impl).not.toHaveBeenCalled();
    });

    it('401s a signed-out caller', async () => {
        mockSession.mockResolvedValue(null);
        const impl = jest.fn(async () => ({}));
        const res = await handler(RESET, impl)(new NextRequest(URL, { method: 'POST' }), { params: Promise.resolve({ personId: '7' }) });
        expect(res.status).toBe(401);
        expect(impl).not.toHaveBeenCalled();
    });
});
