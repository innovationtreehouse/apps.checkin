/**
 * @jest-environment node
 */
/**
 * POST /api/webhooks/shopify, program branch: a paid order activates its children
 * only when it carries a checkout signature their own household's checkout made;
 * any other order is raised as UNVERIFIED_CHECKOUT and activates nobody.
 */
import crypto from 'crypto';
import { POST } from '../route';
import prisma from '@/lib/prisma';
import { activateProgramEnrollment } from '@/lib/programs/activateEnrollment';
import { signCheckout } from '@/lib/programs/checkoutSignature';

jest.mock('@/lib/prisma', () => ({ __esModule: true, default: {} }));
jest.mock('@/lib/programs/activateEnrollment', () => ({
    activateProgramEnrollment: jest.fn(),
}));
jest.mock('@/lib/programs/memberDiscountCode', () => ({
    unentitledMemberCodeUse: jest.fn().mockResolvedValue(false),
}));
jest.mock('@/lib/membership/boardAlerts', () => ({ notifyBoardPaymentException: jest.fn() }));
jest.mock('@/lib/shopify/stock', () => ({ adjustProgramInventory: jest.fn() }));
jest.mock('@/lib/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    logIntegrationError: jest.fn(),
}));

const SECRET = 'checkout-ownership-webhook-secret';
const PROGRAM = 7;
const CHILD = 41;
const OWN_HOUSEHOLD = 3;
const OTHER_HOUSEHOLD = 9;

const activate = activateProgramEnrollment as jest.Mock;
const exceptionCreate = jest.fn();
const childHouseholds = jest.fn();

function signedReq(body: string) {
    const signature = crypto.createHmac('sha256', SECRET).update(body, 'utf8').digest('base64');
    return new Request('http://localhost/api/webhooks/shopify', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-shopify-topic': 'orders/paid',
            'x-shopify-hmac-sha256': signature,
            // Distinct per-file IP keeps this suite clear of the shared rate-limit bucket.
            'x-forwarded-for': '10.99.99.3',
        },
        body,
    });
}

function order(sig: string | null) {
    return {
        id: 777002,
        financial_status: 'paid',
        note_attributes: [
            { name: 'CheckMeIn_Account_ID', value: String(CHILD) },
            { name: 'Program_ID', value: String(PROGRAM) },
            ...(sig ? [{ name: 'CheckMeIn_Checkout_Sig', value: sig }] : []),
        ],
        line_items: [{ variant_id: 5551, quantity: 1 }],
    };
}

async function deliver(sig: string | null, householdOfChild: number) {
    childHouseholds.mockResolvedValue([{ householdId: householdOfChild }]);
    const res = await POST(signedReq(JSON.stringify(order(sig))));
    expect(res.status).toBe(200);
}

const raisedKinds = () => exceptionCreate.mock.calls.map((c) => c[0].data.kind);

const prevSecret = process.env.NEXTAUTH_SECRET;
beforeAll(() => {
    process.env.SHOPIFY_WEBHOOK_SECRET = SECRET;
    process.env.NEXTAUTH_SECRET = 'checkout-ownership-test';
});

afterAll(() => {
    delete process.env.SHOPIFY_WEBHOOK_SECRET;
    if (prevSecret === undefined) delete process.env.NEXTAUTH_SECRET; else process.env.NEXTAUTH_SECRET = prevSecret;
});

beforeEach(() => {
    jest.clearAllMocks();
    activate.mockResolvedValue({ activatedCount: 1 });
    exceptionCreate.mockResolvedValue({ id: 1 });
    Object.assign(prisma, {
        auditLog: { create: jest.fn().mockResolvedValue({}), findMany: jest.fn().mockResolvedValue([]) },
        programParticipant: { count: jest.fn().mockResolvedValue(1), findMany: jest.fn().mockResolvedValue([]) },
        person: { findMany: childHouseholds },
        program: { findUnique: jest.fn().mockResolvedValue({ shopifyVariantId: '5551', claimantShopifyVariantId: null }) },
        paymentException: { findFirst: jest.fn().mockResolvedValue(null), create: exceptionCreate },
    });
});

describe('POST /api/webhooks/shopify — program checkout ownership', () => {
    it("activates a child named by their own household's signed checkout", async () => {
        await deliver(signCheckout(PROGRAM, [CHILD], OWN_HOUSEHOLD), OWN_HOUSEHOLD);
        expect(activate).toHaveBeenCalledWith(expect.objectContaining({ programId: PROGRAM, personIds: [CHILD] }));
        expect(raisedKinds()).toEqual([]);
    });

    it('raises and activates nobody when the child belongs to another household', async () => {
        await deliver(signCheckout(PROGRAM, [CHILD], OWN_HOUSEHOLD), OTHER_HOUSEHOLD);
        expect(activate).not.toHaveBeenCalled();
        expect(raisedKinds()).toEqual(['UNVERIFIED_CHECKOUT']);
    });

    it('raises and activates nobody when the order carries no signature', async () => {
        await deliver(null, OWN_HOUSEHOLD);
        expect(activate).not.toHaveBeenCalled();
        expect(raisedKinds()).toEqual(['UNVERIFIED_CHECKOUT']);
    });
});
