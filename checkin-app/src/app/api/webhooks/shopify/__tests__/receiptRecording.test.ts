/**
 * @jest-environment node
 */
/**
 * Unit tests for the delivery-receipt recording wired into
 * POST /api/webhooks/shopify (settings → Shopify Webhook tab):
 *   - a valid delivery is recorded (hmacValid true, outcome from the branch taken),
 *   - a failed-HMAC or unsigned delivery writes nothing and is rejected with 401,
 *   - a failed receipt insert never breaks settlement,
 *   - Shopify's "Send test notification" sample is flagged test: true.
 * Settlement/DB behavior itself is covered by webhookShopify.integration.test.ts.
 */
import crypto from 'crypto';
import { POST } from '../route';
import prisma from '@/lib/prisma';
import { activateByProcessId } from '@/lib/membership/payment';

jest.mock('@/lib/membership/payment', () => ({
    activateByProcessId: jest.fn(),
}));
jest.mock('@/lib/finance/reconcile/reversals', () => ({
    returnTestOrderStock: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('@/lib/shopify/stock', () => ({
    adjustProgramInventory: jest.fn().mockResolvedValue(true),
    changeProgramStockWith: jest.fn((...a: unknown[]) => jest.requireActual('@/test-helpers/stockWith').forwardStockWith(...a)),
}));
jest.mock('@/lib/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    logIntegrationError: jest.fn(),
}));

const SECRET = 'receipt-test-secret';
const activate = activateByProcessId as jest.Mock;
const auditCreate = jest.fn();
const boardSettingsFindUnique = jest.fn();

function sign(body: string, secret = SECRET): string {
    return crypto.createHmac('sha256', secret).update(body, 'utf8').digest('base64');
}

function webhookReq(body: string, signature: string | null) {
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'x-shopify-topic': 'orders/paid',
        'x-shopify-shop-domain': 'test-store.example.com',
        // Distinct per-file IP keeps this suite clear of the shared rate-limit bucket.
        'x-forwarded-for': '10.99.99.1',
    };
    if (signature !== null) headers['x-shopify-hmac-sha256'] = signature;
    return new Request('http://localhost/api/webhooks/shopify', { method: 'POST', headers, body });
}

// The failure-path recording is fire-and-forget from the synchronous HMAC
// verify — flush the microtask/immediate queue before asserting on it.
const flush = () => new Promise((resolve) => setImmediate(resolve));

const MEMBERSHIP_BODY = JSON.stringify({
    financial_status: 'paid',
    id: 999001,
    note_attributes: [{ name: 'Membership_Process_ID', value: '12' }],
    line_items: [],
});

beforeAll(() => {
    process.env.SHOPIFY_WEBHOOK_SECRET = SECRET;
});

afterAll(() => {
    delete process.env.SHOPIFY_WEBHOOK_SECRET;
});

beforeEach(() => {
    jest.clearAllMocks();
    auditCreate.mockResolvedValue({});
    boardSettingsFindUnique.mockResolvedValue(null);
    activate.mockResolvedValue({ outcome: 'active', process: { status: 'ACTIVE' } });
    prisma.auditLog.create = auditCreate as unknown as typeof prisma.auditLog.create;
    prisma.boardSettings.findUnique = boardSettingsFindUnique as unknown as typeof prisma.boardSettings.findUnique;
    prisma.membershipYearVariant.findMany = jest.fn().mockResolvedValue([]) as unknown as typeof prisma.membershipYearVariant.findMany;
});

describe('POST /api/webhooks/shopify — delivery receipts', () => {
    it('never settles a membership from a Shopify test order', async () => {
        const body = JSON.stringify({ ...JSON.parse(MEMBERSHIP_BODY), test: true });
        const res = await POST(webhookReq(body, sign(body)));
        expect(res.status).toBe(200);
        expect(activate).not.toHaveBeenCalled();
        expect(auditCreate.mock.calls[0][0].data.newData).toMatchObject({ test: true, outcome: 'test order for process 12 — ignored' });
    });

    it('records a valid membership delivery with hmacValid true and a settled outcome', async () => {
        const res = await POST(webhookReq(MEMBERSHIP_BODY, sign(MEMBERSHIP_BODY)));
        expect(res.status).toBe(200);
        expect(activate).toHaveBeenCalledWith(12, '999001', null);
        expect(auditCreate).toHaveBeenCalledTimes(1);
        const { data } = auditCreate.mock.calls[0][0];
        expect(data.tableName).toBe('ShopifyWebhookReceipt');
        expect(data.actorId).toBe(0);
        expect(data.newData).toMatchObject({
            topic: 'orders/paid',
            shopDomain: 'test-store.example.com',
            hmacValid: true,
            test: false,
            orderId: '999001',
            outcome: 'process 12: active',
        });
    });

    it('writes nothing for a failed-HMAC delivery and rejects with 401', async () => {
        const res = await POST(webhookReq(MEMBERSHIP_BODY, 'bogus-signature'));
        expect(res.status).toBe(401);
        await flush();
        expect(auditCreate).not.toHaveBeenCalled();
        expect(activate).not.toHaveBeenCalled();
    });

    it('writes nothing for a missing-signature delivery and rejects with 401', async () => {
        const res = await POST(webhookReq(MEMBERSHIP_BODY, null));
        expect(res.status).toBe(401);
        await flush();
        expect(auditCreate).not.toHaveBeenCalled();
        expect(activate).not.toHaveBeenCalled();
    });

    it('a failed receipt insert does not break settlement (still 200, still activates)', async () => {
        auditCreate.mockRejectedValueOnce(new Error('db down'));
        const res = await POST(webhookReq(MEMBERSHIP_BODY, sign(MEMBERSHIP_BODY)));
        expect(res.status).toBe(200);
        expect((await res.json()).success).toBe(true);
        expect(activate).toHaveBeenCalledWith(12, '999001', null);
    });

    it('flags Shopify\'s "Send test notification" sample as test: true', async () => {
        // Raw string, not JSON.stringify: the sample order id exceeds 2^53, and the
        // detection must survive JSON.parse rounding it. No cart attributes, like
        // the real sample payload.
        const body = '{"id":820982911946154508,"test":true,"financial_status":"paid","line_items":[]}';
        const res = await POST(webhookReq(body, sign(body)));
        expect(res.status).toBe(200);
        expect(auditCreate).toHaveBeenCalledTimes(1);
        expect(auditCreate.mock.calls[0][0].data.newData).toMatchObject({
            hmacValid: true,
            test: true,
            outcome: 'no membership or program attributes — ignored',
        });
        expect(activate).not.toHaveBeenCalled();
    });

    it('flags the sample order id as test even without the test flag', async () => {
        const body = '{"id":820982911946154508,"line_items":[]}';
        const res = await POST(webhookReq(body, sign(body)));
        expect(res.status).toBe(200);
        expect(auditCreate.mock.calls[0][0].data.newData).toMatchObject({ test: true });
    });
});
