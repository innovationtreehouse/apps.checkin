/**
 * @jest-environment node
 */
/**
 * Admission and view for listing the captured emails a replay can act on
 * (registry/receipt.ts): FINANCE only, like replay itself. Each row leaves as its
 * id, times and expired flag; the storage key and processing error never do.
 * Auth runs through the real authenticateRequest; only next-auth's
 * getServerSession is stubbed (jest.setup.js mocks it).
 */
import type { NextRequest as NextRequestType } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { getRoute } from '@/security/core';
import { handler } from '@/security/handler';

const { NextRequest } = jest.requireActual<{ NextRequest: typeof NextRequestType }>('next/server');
const mockSession = getServerSession as jest.MockedFunction<typeof getServerSession>;

const GET = 'GET /api/receipts/mail-messages';

const ROWS = [
    {
        id: 7,
        receivedAt: '2026-11-20T09:00:00.000Z',
        capturedAt: '2026-11-20T09:05:00.000Z',
        expired: false,
        rawKey: 'mail/org-1/jane@example.com/7.eml',
        processError: 'system: no amount from jane@example.com',
        gmailMessageId: '18c2f0a1b2',
        rawSha256: 'ab12',
        orgId: 'org-1',
    },
    {
        id: 3,
        receivedAt: '2026-08-01T09:00:00.000Z',
        capturedAt: '2026-08-01T09:05:00.000Z',
        expired: true,
        rawKey: 'mail/org-1/3.eml',
        processError: null,
    },
];
const STRIPPED = [
    { id: 7, receivedAt: '2026-11-20T09:00:00.000Z', capturedAt: '2026-11-20T09:05:00.000Z', expired: false },
    { id: 3, receivedAt: '2026-08-01T09:00:00.000Z', capturedAt: '2026-08-01T09:05:00.000Z', expired: true },
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

async function call() {
    const impl = jest.fn(async () => ({ ReceiptMailMessageView: ROWS }));
    const req = new NextRequest('http://localhost/api/receipts/mail-messages', { method: 'GET' });
    const res = await handler(GET, impl)(req, { params: Promise.resolve({}) });
    return { res, impl };
}

beforeEach(() => mockSession.mockReset());

describe('receipt mail messages route', () => {
    it('is registered for ReceiptMailMessageView', () => {
        expect(getRoute(GET)?.returns).toEqual(['ReceiptMailMessageView']);
    });

    it('lets FINANCE list captured emails as id, times and expired only', async () => {
        signIn({ isFinance: true });
        const { res } = await call();
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual(STRIPPED);
    });

    it.each([
        ['a sysadmin', { isSysadmin: true }],
        ['a Board-only member', { isBoardMember: true }],
        ['an adult member who submits receipts', { isActiveOrgMember: true, ageBand: 'adult' }],
        ['an inventory manager', { isInventoryManager: true }],
        ['an operations volunteer', { isOperations: true }],
        ['a keyholder', { isKeyholder: true }],
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
