/**
 * @jest-environment node
 */
/**
 * Unit tests for GET /api/settings/shopify-webhook — the deny paths (401 anon /
 * 403 plain member, through the REAL withAuth with a mocked session) and the
 * payload shape the Shopify Webhook settings tab renders. Referenced by the
 * authz drift guard (authzRegistry.test.ts).
 */
import { GET } from '../route';
import prisma from '@/lib/prisma';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const mockSession = require('next-auth/next').getServerSession;

const findMany = jest.fn();

function req() {
    return new Request('http://localhost/api/settings/shopify-webhook');
}

beforeAll(() => {
    process.env.NEXTAUTH_URL = 'https://checkin.example.org';
    process.env.SHOPIFY_STORE_DOMAIN = 'test-store.example.com';
});

beforeEach(() => {
    jest.clearAllMocks();
    findMany.mockResolvedValue([]);
    prisma.auditLog.findMany = findMany as unknown as typeof prisma.auditLog.findMany;
});

describe('GET /api/settings/shopify-webhook', () => {
    it('401 when unauthenticated', async () => {
        mockSession.mockResolvedValue(null);
        const res = await GET(req());
        expect(res.status).toBe(401);
        expect(findMany).not.toHaveBeenCalled();
    });

    it('403 for a signed-in member without board or sysadmin role', async () => {
        mockSession.mockResolvedValue({ user: { id: 5, isSysadmin: false, isBoardMember: false } });
        const res = await GET(req());
        expect(res.status).toBe(403);
        expect(findMany).not.toHaveBeenCalled();
    });

    it('200 for a board member with the endpoint URL, store domain, and latest receipts', async () => {
        mockSession.mockResolvedValue({ user: { id: 5, isBoardMember: true } });
        findMany.mockResolvedValue([
            {
                id: 42,
                newData: {
                    topic: 'orders/paid',
                    shopDomain: 'test-store.example.com',
                    hmacValid: false,
                    test: true,
                    orderId: '820982911946154508',
                    outcome: 'rejected: bad hmac',
                    receivedAt: '2026-07-15T12:00:00.000Z',
                },
            },
        ]);

        const res = await GET(req());
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.webhookUrl).toBe('https://checkin.example.org/api/webhooks/shopify');
        expect(body.storeDomain).toBe('test-store.example.com');
        expect(body.receipts).toEqual([
            {
                id: 42,
                topic: 'orders/paid',
                shopDomain: 'test-store.example.com',
                hmacValid: false,
                test: true,
                orderId: '820982911946154508',
                outcome: 'rejected: bad hmac',
                receivedAt: '2026-07-15T12:00:00.000Z',
                deliveryId: null,
                triggeredAt: null,
                retry: null,
            },
        ]);

        // Queries the receipt rows only, newest first, capped.
        expect(findMany).toHaveBeenCalledWith({
            where: { tableName: 'ShopifyWebhookReceipt' },
            orderBy: { id: 'desc' },
            take: 20,
        });
    });

    it('passes the delivery id, trigger time, and retry flag through', async () => {
        mockSession.mockResolvedValue({ user: { id: 5, isBoardMember: true } });
        findMany.mockResolvedValue([
            {
                id: 43,
                newData: {
                    topic: 'orders/paid',
                    shopDomain: 'test-store.example.com',
                    deliveryId: 'b54557e4-bdd9-4b37-8a5f-bf7d70bcd043',
                    triggeredAt: '2026-07-15T11:59:58.000Z',
                    retry: true,
                    hmacValid: true,
                    test: false,
                    orderId: '999001',
                    outcome: 'already settled',
                    receivedAt: '2026-07-15T12:00:00.000Z',
                },
            },
        ]);

        const body = await (await GET(req())).json();
        expect(body.receipts[0]).toMatchObject({
            deliveryId: 'b54557e4-bdd9-4b37-8a5f-bf7d70bcd043',
            triggeredAt: '2026-07-15T11:59:58.000Z',
            retry: true,
        });
    });

    it('200 for a sysadmin', async () => {
        mockSession.mockResolvedValue({ user: { id: 5, isSysadmin: true } });
        const res = await GET(req());
        expect(res.status).toBe(200);
    });
});
