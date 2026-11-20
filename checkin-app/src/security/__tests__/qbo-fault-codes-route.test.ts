/**
 * @jest-environment node
 */
/**
 * Admission and view for the QuickBooks fault codes page (registry.ts): finance,
 * the Board and sysadmins read the QboFaultCodeSeen rows' six fields and nothing
 * else; every other role is refused. Auth runs through the real
 * authenticateRequest; only next-auth's getServerSession is stubbed
 * (jest.setup.js mocks it).
 */
import type { NextRequest as NextRequestType } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { getRoute, marks } from '@/security/core';
import { handler } from '@/security/handler';

const { NextRequest } = jest.requireActual<{ NextRequest: typeof NextRequestType }>('next/server');
const mockSession = getServerSession as jest.MockedFunction<typeof getServerSession>;

const ENDPOINT = 'GET /api/quickbooks/fault-codes';
const ROW = {
    code: '6000',
    kind: 'data',
    count: 14,
    firstSeenAt: '2026-11-03T10:00:00.000Z',
    lastSeenAt: '2026-11-20T09:12:00.000Z',
    lastLane: 'expense posting',
};

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

async function call(claims: Claims | null, rows: object[] = [ROW]) {
    if (claims) signIn(claims);
    else mockSession.mockResolvedValue(null);
    const impl = jest.fn(async () => ({ QboFaultCodeSeen: rows }));
    const req = new NextRequest('http://localhost/api/quickbooks/fault-codes');
    const res = await handler(ENDPOINT, impl)(req, { params: Promise.resolve({}) });
    return { res, impl };
}

beforeEach(() => mockSession.mockReset());

describe('QuickBooks fault codes route', () => {
    it('is registered for QboFaultCodeSeen alone', () => {
        expect(getRoute(ENDPOINT)?.returns).toEqual(['QboFaultCodeSeen']);
    });

    it('sends no marked field, so the read is not a logged finance view', () => {
        expect(marks.QboFaultCodeSeen ?? []).toEqual([]);
    });

    it.each([
        ['FINANCE', { isFinance: true }],
        ['BOARD', { isBoardMember: true }],
        ['a sysadmin', { isSysadmin: true }],
    ] as const)('lets %s read every row whole', async (_who, claims) => {
        const { res } = await call(claims);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ codes: [ROW] });
    });

    it.each([
        ['FINANCE', { isFinance: true }],
        ['BOARD', { isBoardMember: true }],
        ['a sysadmin', { isSysadmin: true }],
    ] as const)('returns only the six stored fields to %s', async (_who, claims) => {
        const extra = {
            ...ROW,
            detail: 'Business Validation Error: amount 120.00',
            requestId: 'req-1',
            itemId: 42,
            amount: 120,
            vendorName: 'Acme Lumber',
        };
        const { res } = await call(claims, [extra]);
        expect(await res.json()).toEqual({ codes: [ROW] });
    });

    it.each([
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
        const { res, impl } = await call(null);
        expect(res.status).toBe(401);
        expect(impl).not.toHaveBeenCalled();
    });
});
