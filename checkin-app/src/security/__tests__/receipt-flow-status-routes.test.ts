/**
 * @jest-environment node
 */
/**
 * Admission and view for GET /api/receipt-flow/status (registry/receipt.ts):
 * FINANCE and BOARD read every section, INVENTORY_MANAGER reads receiving only,
 * and nobody else is admitted. Auth runs through the real authenticateRequest;
 * only next-auth's getServerSession is stubbed (jest.setup.js mocks it).
 */
import type { NextRequest as NextRequestType } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { getRoute } from '@/security/core';
import { handler } from '@/security/handler';

const { NextRequest } = jest.requireActual<{ NextRequest: typeof NextRequestType }>('next/server');
const mockSession = getServerSession as jest.MockedFunction<typeof getServerSession>;

const ENDPOINT = 'GET /api/receipt-flow/status';

type Flag = 'isFinance' | 'isBoardMember' | 'isInventoryManager' | 'isSysadmin' | 'isOperations' | 'isKeyholder';

function signIn(flags: Partial<Record<Flag, boolean>>) {
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
            ...flags,
        },
        expires: '2099-01-01',
    });
}

const section = (state: string) => ({ states: [{ state, label: state, count: 2 }] });
const FULL = {
    asOf: '2026-10-23T12:00:00.000Z',
    receipt: { ...section('uploaded'), notDelivered: 1 },
    receiving: section('applying'),
    expense: section('qb_pending'),
};

async function call(flags: Partial<Record<Flag, boolean>>) {
    signIn(flags);
    const impl = jest.fn(async () => ({ ReceiptFlowStatus: FULL }));
    const res = await handler(ENDPOINT, impl)(new NextRequest('http://localhost/api/receipt-flow/status'), { params: Promise.resolve({}) });
    return { res, impl };
}

beforeEach(() => mockSession.mockReset());

describe('receipt flow status route', () => {
    it('is registered', () => {
        expect(getRoute(ENDPOINT)?.returns).toEqual(['ReceiptFlowStatus']);
    });

    it.each([
        ['FINANCE', { isFinance: true }],
        ['BOARD', { isBoardMember: true }],
        ['FINANCE who also manages inventory', { isFinance: true, isInventoryManager: true }],
    ] as const)('gives %s every section', async (_who, flags) => {
        const { res } = await call(flags);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual(FULL);
    });

    it('gives an inventory manager the receiving section and the time only', async () => {
        const { res } = await call({ isInventoryManager: true });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ asOf: FULL.asOf, receiving: FULL.receiving });
    });

    it.each([
        ['a sysadmin', { isSysadmin: true }],
        ['an operations volunteer', { isOperations: true }],
        ['a keyholder', { isKeyholder: true }],
        ['a person with no role', {}],
    ] as const)('403s %s without running the impl', async (_who, flags) => {
        const { res, impl } = await call(flags);
        expect(res.status).toBe(403);
        expect(impl).not.toHaveBeenCalled();
    });

    it('401s a signed-out caller', async () => {
        mockSession.mockResolvedValue(null);
        const impl = jest.fn(async () => ({}));
        const res = await handler(ENDPOINT, impl)(new NextRequest('http://localhost/api/receipt-flow/status'), { params: Promise.resolve({}) });
        expect(res.status).toBe(401);
        expect(impl).not.toHaveBeenCalled();
    });
});
