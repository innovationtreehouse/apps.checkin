/**
 * @jest-environment node
 */
/**
 * Admission and view for replaying one captured email (registry/receipt.ts):
 * FINANCE only, like the mail catch-up button. Auth runs through the real authenticateRequest;
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

const EXPIRED = { status: 'expired', message: "This email's stored copy expired 90 days after capture." };

async function call(outcome: Record<string, string> = EXPIRED) {
    const impl = jest.fn(async () => ({ ReceiptMailReplay: outcome }));
    const req = new NextRequest('http://localhost/api/receipts/mail-messages/7/replay', { method: 'POST' });
    const res = await handler(POST, impl)(req, { params: Promise.resolve({ id: '7' }) });
    return { res, impl };
}

beforeEach(() => mockSession.mockReset());

describe('receipt mail replay route', () => {
    it('is registered for ReceiptMailReplay', () => {
        expect(getRoute(POST)?.returns).toEqual(['ReceiptMailReplay']);
    });

    it.each([{ status: 'processed' }, { status: 'waiting' }, EXPIRED])('lets FINANCE replay and read the outcome %j', async (outcome) => {
        signIn({ isFinance: true });
        const { res } = await call(outcome);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual(outcome);
    });

    it.each([
        ['a sysadmin', { isSysadmin: true }],
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
