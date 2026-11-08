/**
 * @jest-environment node
 */
/**
 * Admission and view for the automatic-reading switch (registry/receipt.ts):
 * sysadmin, FINANCE and BOARD turn it off and on; any receipt submitter reads
 * it. Auth runs through the real authenticateRequest; only next-auth's
 * getServerSession is stubbed (jest.setup.js mocks it).
 */
import type { NextRequest as NextRequestType } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { getRoute } from '@/security/core';
import { handler } from '@/security/handler';

const { NextRequest } = jest.requireActual<{ NextRequest: typeof NextRequestType }>('next/server');
const mockSession = getServerSession as jest.MockedFunction<typeof getServerSession>;

const PUT = 'PUT /api/receipts/settings/ocr';
const GET = 'GET /api/receipts/settings/ocr';

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

async function call(endpoint: string, claims: Claims) {
    signIn(claims);
    const impl = jest.fn(async () => ({ ReceiptOcrSwitch: { ocrEnabled: false } }));
    const res = await handler(endpoint, impl)(new NextRequest('http://localhost/api/receipts/settings/ocr'), { params: Promise.resolve({}) });
    return { res, impl };
}

const SWITCHERS = [
    ['a sysadmin', { isSysadmin: true }],
    ['FINANCE', { isFinance: true }],
    ['BOARD', { isBoardMember: true }],
] as const;
const MEMBER = { isActiveOrgMember: true, ageBand: 'adult' };

beforeEach(() => mockSession.mockReset());

describe('receipt automatic-reading switch routes', () => {
    it.each([PUT, GET])('%s is registered for ReceiptOcrSwitch', (endpoint) => {
        expect(getRoute(endpoint)?.returns).toEqual(['ReceiptOcrSwitch']);
    });

    it.each(SWITCHERS)('lets %s turn reading off and on', async (_who, claims) => {
        const { res } = await call(PUT, claims);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ocrEnabled: false });
    });

    it.each([
        ['an adult member who submits receipts', MEMBER],
        ['an operations volunteer', { isOperations: true }],
        ['an inventory manager', { isInventoryManager: true }],
        ['a person with no role', {}],
    ] as const)('403s %s on the switch without running the impl', async (_who, claims) => {
        const { res, impl } = await call(PUT, claims);
        expect(res.status).toBe(403);
        expect(impl).not.toHaveBeenCalled();
    });

    it.each([...SWITCHERS, ['an adult member who submits receipts', MEMBER]] as const)(
        'lets %s read whether reading is on',
        async (_who, claims) => {
            const { res } = await call(GET, claims);
            expect(res.status).toBe(200);
            expect(await res.json()).toEqual({ ocrEnabled: false });
        },
    );

    it('403s a non-member with no role on the read', async () => {
        const { res, impl } = await call(GET, {});
        expect(res.status).toBe(403);
        expect(impl).not.toHaveBeenCalled();
    });

    it.each([PUT, GET])('401s a signed-out caller on %s', async (endpoint) => {
        mockSession.mockResolvedValue(null);
        const impl = jest.fn(async () => ({}));
        const res = await handler(endpoint, impl)(new NextRequest('http://localhost/api/receipts/settings/ocr'), { params: Promise.resolve({}) });
        expect(res.status).toBe(401);
        expect(impl).not.toHaveBeenCalled();
    });
});
