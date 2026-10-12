/**
 * @jest-environment node
 */
/**
 * POST /api/webhooks/shopify/reversals passes the refund's restocked lines
 * (restock_type other than no_restock) to raiseReversalByOrderId. The removal
 * itself is covered by reconcile.integration.test.ts.
 */
import crypto from 'crypto';
import { POST } from '../route';
import { raiseReversalByOrderId } from '@/lib/finance/reconcile';

jest.mock('@/lib/finance/reconcile', () => ({
    raiseReversalByOrderId: jest.fn().mockResolvedValue(true),
}));
jest.mock('@/lib/shopifyWebhookReceipt', () => ({
    recordShopifyWebhookReceipt: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('@/lib/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    logIntegrationError: jest.fn(),
}));

const SECRET = 'reversals-test-secret';
const raise = raiseReversalByOrderId as jest.Mock;

function req(topic: string, payload: unknown) {
    const body = JSON.stringify(payload);
    return new Request('http://localhost/api/webhooks/shopify/reversals', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-shopify-topic': topic,
            'x-shopify-hmac-sha256': crypto.createHmac('sha256', SECRET).update(body, 'utf8').digest('base64'),
            'x-forwarded-for': '10.99.98.1',
        },
        body,
    });
}

beforeAll(() => {
    process.env.SHOPIFY_WEBHOOK_SECRET = SECRET;
});
afterAll(() => {
    delete process.env.SHOPIFY_WEBHOOK_SECRET;
});
beforeEach(() => jest.clearAllMocks());

describe('POST /api/webhooks/shopify/reversals — restocked lines', () => {
    it('passes only restocked lines on refunds/create', async () => {
        const res = await POST(req('refunds/create', {
            order_id: 555,
            refund_line_items: [
                { quantity: 2, restock_type: 'return', line_item: { variant_id: 111 } },
                { quantity: 1, restock_type: 'no_restock', line_item: { variant_id: 222 } },
                { quantity: 1, restock_type: 'cancel', line_item: { variant_id: 333 } },
                { quantity: 1, restock_type: 'return', line_item: {} },
            ],
        }));
        expect(res.status).toBe(200);
        expect(raise).toHaveBeenCalledWith('555', 'REFUND', [
            { variantId: '111', quantity: 2 },
            { variantId: '333', quantity: 1 },
        ]);
    });

    it('passes no lines for a cancellation', async () => {
        await POST(req('orders/cancelled', { id: 777 }));
        expect(raise).toHaveBeenCalledWith('777', 'CANCELLED', []);
    });
});
