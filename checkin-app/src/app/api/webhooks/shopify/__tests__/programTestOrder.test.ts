/**
 * @jest-environment node
 */
/**
 * POST /api/webhooks/shopify, program branch: a Shopify test order activates no
 * seat and moves no stock, and is still acked 200; a real order still activates.
 */
import crypto from 'crypto';
import { POST } from '../route';
import prisma from '@/lib/prisma';
import { activateProgramEnrollment } from '@/lib/programs/activateEnrollment';
import { adjustProgramInventory } from '@/lib/shopify';
import { orderEntitlesEnrollment } from '@/lib/finance/reconcile';

jest.mock('@/lib/programs/activateEnrollment', () => ({
    activateProgramEnrollment: jest.fn(),
}));
jest.mock('@/lib/programs/memberDiscountCode', () => ({
    unentitledMemberCodeUse: jest.fn().mockResolvedValue(false),
}));
jest.mock('@/lib/finance/reconcile', () => ({
    ...jest.requireActual('@/lib/finance/reconcile'),
    orderEntitlesEnrollment: jest.fn(),
    raisePaymentException: jest.fn(),
}));
jest.mock('@/lib/shopify', () => ({
    adjustProgramInventory: jest.fn().mockResolvedValue(true),
}));
jest.mock('@/lib/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    logIntegrationError: jest.fn(),
}));

const SECRET = 'program-test-order-secret';
const activate = activateProgramEnrollment as jest.Mock;
const entitles = orderEntitlesEnrollment as jest.Mock;
const auditCreate = jest.fn();

function signedReq(body: string) {
    const signature = crypto.createHmac('sha256', SECRET).update(body, 'utf8').digest('base64');
    return new Request('http://localhost/api/webhooks/shopify', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-shopify-topic': 'orders/paid',
            'x-shopify-hmac-sha256': signature,
            // Distinct per-file IP keeps this suite clear of the shared rate-limit bucket.
            'x-forwarded-for': '10.99.99.2',
        },
        body,
    });
}

const PROGRAM_ORDER = {
    id: 777001,
    financial_status: 'paid',
    note_attributes: [
        { name: 'CheckMeIn_Account_ID', value: '41' },
        { name: 'Program_ID', value: '7' },
    ],
    line_items: [{ variant_id: 5551, quantity: 1 }],
};

beforeAll(() => {
    process.env.SHOPIFY_WEBHOOK_SECRET = SECRET;
});

afterAll(() => {
    delete process.env.SHOPIFY_WEBHOOK_SECRET;
});

beforeEach(() => {
    jest.clearAllMocks();
    auditCreate.mockResolvedValue({});
    entitles.mockResolvedValue({ ok: true });
    activate.mockResolvedValue({ activatedCount: 1 });
    prisma.auditLog.create = auditCreate as unknown as typeof prisma.auditLog.create;
});

describe('POST /api/webhooks/shopify — program test orders', () => {
    it('a test order activates no program seat and moves no stock, but is acked', async () => {
        const res = await POST(signedReq(JSON.stringify({ ...PROGRAM_ORDER, test: true })));
        expect(res.status).toBe(200);
        expect((await res.json()).success).toBe(true);
        expect(entitles).not.toHaveBeenCalled();
        expect(activate).not.toHaveBeenCalled();
        expect(adjustProgramInventory).not.toHaveBeenCalled();
        expect(auditCreate.mock.calls[0][0].data.newData).toMatchObject({ test: true, outcome: 'test order for program 7 — ignored' });
    });

    it('a real order still activates', async () => {
        const res = await POST(signedReq(JSON.stringify(PROGRAM_ORDER)));
        expect(res.status).toBe(200);
        expect(activate).toHaveBeenCalledWith(expect.objectContaining({ programId: 7, personIds: [41], shopifyOrderId: '777001' }));
        expect(auditCreate.mock.calls[0][0].data.newData).toMatchObject({ test: false, outcome: 'program 7: activated 1 of 1 participant(s)' });
    });
});
