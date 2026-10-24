/**
 * @jest-environment node
 */
/**
 * Unit tests for the Shopify webhook receipt helper: test-notification
 * detection (the "Send test notification" sample id survives JSON.parse's
 * precision loss), defensive payload reads, and the never-throws guarantee —
 * a failed receipt insert must not break settlement.
 */
import prisma from '@/lib/prisma';
import { logger } from '@/lib/logger';
import {
    SHOPIFY_WEBHOOK_RECEIPT_TABLE,
    isShopifyTestNotification,
    recordShopifyWebhookReceipt,
    logRejectedShopifyWebhook,
} from '../shopifyWebhookReceipt';

jest.mock('@/lib/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const auditCreate = jest.fn();
const auditFindFirst = jest.fn();

beforeEach(() => {
    jest.clearAllMocks();
    auditCreate.mockResolvedValue({});
    auditFindFirst.mockResolvedValue(null);
    prisma.auditLog.create = auditCreate as unknown as typeof prisma.auditLog.create;
    prisma.auditLog.findFirst = auditFindFirst as unknown as typeof prisma.auditLog.findFirst;
});

function req(headers: Record<string, string> = {}) {
    return new Request('http://localhost/api/webhooks/shopify', { method: 'POST', headers });
}

describe('isShopifyTestNotification', () => {
    it('detects the explicit test flag', () => {
        expect(isShopifyTestNotification({ test: true, id: 123 })).toBe(true);
    });

    it('detects the sample order id as a string', () => {
        expect(isShopifyTestNotification({ id: '820982911946154508' })).toBe(true);
    });

    it('detects the sample order id through JSON.parse precision loss (> 2^53)', () => {
        // Shopify sends the id as a bare JSON number; JSON.parse rounds it to the
        // nearest double, so a strict string compare of the parsed value would miss.
        expect(isShopifyTestNotification(JSON.parse('{"id":820982911946154508}'))).toBe(true);
    });

    it('is false for real orders and junk payloads', () => {
        expect(isShopifyTestNotification({ id: 999001, test: false })).toBe(false);
        expect(isShopifyTestNotification({ id: 999001 })).toBe(false);
        expect(isShopifyTestNotification(null)).toBe(false);
        expect(isShopifyTestNotification('not an order')).toBe(false);
        expect(isShopifyTestNotification([])).toBe(false);
        expect(isShopifyTestNotification({})).toBe(false);
    });
});

describe('logRejectedShopifyWebhook', () => {
    it('logs at most once a minute, counts the rejections between, and never writes', () => {
        const t0 = 10_000_000;
        logRejectedShopifyWebhook('signature mismatch', t0);
        logRejectedShopifyWebhook('signature mismatch', t0 + 1_000);
        logRejectedShopifyWebhook('missing signature', t0 + 59_000);
        expect(logger.warn).toHaveBeenCalledTimes(1);

        logRejectedShopifyWebhook('signature mismatch', t0 + 60_000);
        expect(logger.warn).toHaveBeenCalledTimes(2);
        expect((logger.warn as jest.Mock).mock.calls[1][0]).toContain('3 rejected');
        expect(auditCreate).not.toHaveBeenCalled();
    });
});

describe('recordShopifyWebhookReceipt', () => {
    it('writes one system AuditLog row with the delivery fields', async () => {
        await recordShopifyWebhookReceipt(
            req({ 'x-shopify-topic': 'orders/paid', 'x-shopify-shop-domain': 'test-store.example.com' }),
            { id: 999001, test: false },
            { hmacValid: true, outcome: 'settled process 12' },
        );
        expect(auditCreate).toHaveBeenCalledTimes(1);
        const { data } = auditCreate.mock.calls[0][0];
        expect(data.actorId).toBe(0);
        expect(data.action).toBe('CREATE');
        expect(data.tableName).toBe(SHOPIFY_WEBHOOK_RECEIPT_TABLE);
        expect(data.newData).toMatchObject({
            topic: 'orders/paid',
            shopDomain: 'test-store.example.com',
            hmacValid: true,
            test: false,
            orderId: '999001',
            outcome: 'settled process 12',
        });
        expect(typeof data.newData.receivedAt).toBe('string');
    });

    it('records null topic/shopDomain/orderId/delivery fields when headers and payload are missing', async () => {
        await recordShopifyWebhookReceipt(req(), null, { hmacValid: false, outcome: 'rejected: bad hmac' });
        expect(auditFindFirst).not.toHaveBeenCalled();
        expect(auditCreate.mock.calls[0][0].data.newData).toMatchObject({
            topic: null,
            shopDomain: null,
            deliveryId: null,
            triggeredAt: null,
            retry: null,
            orderId: null,
            hmacValid: false,
            test: false,
        });
    });

    it('records the delivery id and trigger time, and marks a first delivery as not a retry', async () => {
        await recordShopifyWebhookReceipt(
            req({ 'x-shopify-webhook-id': 'delivery-1', 'x-shopify-triggered-at': '2026-10-21T12:00:00.000Z' }),
            { id: 999001 },
            { hmacValid: true, outcome: 'settled process 12' },
        );
        const { where } = auditFindFirst.mock.calls[0][0];
        expect(where.tableName).toBe(SHOPIFY_WEBHOOK_RECEIPT_TABLE);
        expect(where.newData).toEqual({ path: ['deliveryId'], equals: 'delivery-1' });
        const receivedAt = Date.parse(auditCreate.mock.calls[0][0].data.newData.receivedAt);
        expect(receivedAt - where.timestamp.gte.getTime()).toBe(48 * 60 * 60 * 1000);
        expect(auditCreate.mock.calls[0][0].data.newData).toMatchObject({
            deliveryId: 'delivery-1',
            triggeredAt: '2026-10-21T12:00:00.000Z',
            retry: false,
        });
    });

    it('marks a receipt as a retry when an earlier receipt has the same delivery id', async () => {
        auditFindFirst.mockResolvedValueOnce({ id: 7 });
        await recordShopifyWebhookReceipt(
            req({ 'x-shopify-webhook-id': 'delivery-1' }),
            { id: 999001 },
            { hmacValid: true, outcome: 'already settled' },
        );
        expect(auditCreate.mock.calls[0][0].data.newData).toMatchObject({ deliveryId: 'delivery-1', triggeredAt: null, retry: true });
    });

    it('still records the receipt, with retry unknown, when the retry lookup fails', async () => {
        auditFindFirst.mockRejectedValueOnce(new Error('db hiccup'));
        await recordShopifyWebhookReceipt(
            req({ 'x-shopify-webhook-id': 'delivery-1' }),
            { id: 999001 },
            { hmacValid: true, outcome: 'settled process 12' },
        );
        expect(auditCreate).toHaveBeenCalledTimes(1);
        expect(auditCreate.mock.calls[0][0].data.newData).toMatchObject({ deliveryId: 'delivery-1', retry: null });
        expect(logger.warn).toHaveBeenCalled();
    });

    it('never throws when the insert fails — logs and moves on', async () => {
        auditCreate.mockRejectedValueOnce(new Error('db down'));
        await expect(
            recordShopifyWebhookReceipt(req(), { id: 1 }, { hmacValid: true, outcome: 'x' }),
        ).resolves.toBeUndefined();
        expect(logger.error).toHaveBeenCalled();
    });
});
