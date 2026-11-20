/**
 * @jest-environment node
 */
/**
 * Admission and view for replaying one captured email (registry/receipt.ts):
 * FINANCE and sysadmins only. Auth runs through the real authenticateRequest;
 * only next-auth's getServerSession is stubbed (jest.setup.js mocks it).
 */
import type { NextRequest as NextRequestType } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { getRoute } from '@/security/core';
import { handler } from '@/security/handler';

const { NextRequest } = jest.requireActual<{ NextRequest: typeof NextRequestType }>('next/server');
const mockSession = getServerSession as jest.MockedFunction<typeof getServerSession>;

const POST = 'POST /api/receipts/mail-messages/[id]/replay';

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

async function call() {
    const impl = jest.fn(async () => ({ ReceiptMailReplay: { status: 'expired', message: 'This email’s stored copy expired.' } }));
    const req = new NextRequest('http://localhost/api/receipts/mail-messages/7/replay', { method: 'POST' });
    const res = await handler(POST, impl)(req, { params: Promise.resolve({ id: '7' }) });
    return { res, impl };
}

beforeEach(() => mockSession.mockReset());

describe('receipt mail replay route', () => {
    it('is registered for ReceiptMailReplay', () => {
        expect(getRoute(POST)?.returns).toEqual(['ReceiptMailReplay']);
    });

    it.each([
        ['FINANCE', { isFinance: true }],
        ['a sysadmin', { isSysadmin: true }],
    ] as const)('lets %s replay and read the outcome', async (_who, claims) => {
        signIn(claims);
        const { res } = await call();
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ status: 'expired', message: 'This email’s stored copy expired.' });
    });

    it.each([
        ['a Board-only member', { isBoardMember: true }],
        ['an adult member who submits receipts', { isActiveOrgMember: true, ageBand: 'adult' }],
        ['an inventory manager', { isInventoryManager: true }],
        ['a person with no role', {}],
    ] as const)('403s %s without running the impl', async (_who, claims) => {
        signIn(claims);
        const { res, impl } = await call();
        expect(res.status).toBe(403);
        expect(impl).not.toHaveBeenCalled();
    });

    it('401s a signed-out caller', async () => {
        mockSession.mockResolvedValue(null);
        const { res, impl } = await call();
        expect(res.status).toBe(401);
        expect(impl).not.toHaveBeenCalled();
    });
});
