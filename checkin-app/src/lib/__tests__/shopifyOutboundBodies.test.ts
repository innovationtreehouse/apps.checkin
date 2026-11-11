/**
 * Pins the exact request body of every Shopify product, price and discount write
 * for a known Program row, and checks that pii / personal / internal fields put in
 * a writer's outbound bag never reach the wire. The stock writes are pinned in
 * programStock.test.ts.
 */
import crypto from 'crypto';
import { resetTokenCache } from '../shopify/client';
import { createShopifySingleVariantProgram, createClaimantProduct, programProductHandle } from '../shopify/products';
import { syncProgramPrice, setProgramProductOffSale } from '../shopify/stock';
import { mintMemberDiscountCode } from '../shopify/discounts';
import { LEAK, outboundLeak } from '@/test-helpers/outboundLeak';

jest.mock('@/security/outbound', () =>
    jest.requireActual<typeof import('@/test-helpers/outboundLeak')>('@/test-helpers/outboundLeak').leakingOutboundModule());
jest.mock('../email', () => ({ sendEmail: jest.fn().mockResolvedValue(true) }));
jest.mock('../prisma', () => ({ __esModule: true, default: { person: { findMany: jest.fn().mockResolvedValue([]) } } }));
jest.mock('../logger', () => ({ logIntegrationError: jest.fn().mockResolvedValue(undefined) }));

const PROGRAM = {
    id: 7,
    name: 'Robotics',
    nonOrgMemberPriceCents: 3500,
    maxParticipants: 10,
    shopifyProductId: '4242',
    shopifyVariantId: '111',
    claimantShopifyVariantId: '222',
};
const NOW = new Date('2026-10-21T12:00:00.000Z');

/** Every Shopify write's [url, method, body], the query text masked (it is a constant). */
let writes: [string, string, string][];

function fakeShopify(): void {
    writes = [];
    global.fetch = jest.fn(async (url: string, init: RequestInit) => {
        if (url.includes('/oauth/access_token')) {
            return { ok: true, status: 200, json: async () => ({ access_token: 't', expires_in: 86400 }) };
        }
        if (init.method === 'GET') return { ok: true, status: 200, json: async () => ({ products: [] }) };
        const body = String(init.body);
        writes.push([url, String(init.method), body.replace(/^\{"query":"(?:[^"\\]|\\.)*"/, '{"query":"…"')]);
        if (body.includes('UnlistClaimantProduct')) {
            return { ok: true, status: 200, json: async () => ({ data: { productUpdate: { product: { id: 'x', status: 'UNLISTED' }, userErrors: [] } } }) };
        }
        if (body.includes('MintMemberDiscount')) {
            return { ok: true, status: 200, json: async () => ({ data: { discountCodeBasicCreate: { codeDiscountNode: { id: 'd' }, userErrors: [] } } }) };
        }
        return { ok: true, status: 200, json: async () => ({ product: { id: 710, variants: [{ id: 810 }] } }) };
    }) as unknown as typeof fetch;
}

/** Every write the cases below make, through the writers' public entry points. */
async function writeAll(): Promise<void> {
    await createShopifySingleVariantProgram(PROGRAM.name, PROGRAM.nonOrgMemberPriceCents, PROGRAM.maxParticipants, programProductHandle(PROGRAM, 'public'));
    await createClaimantProduct(PROGRAM.name, PROGRAM.nonOrgMemberPriceCents);
    await syncProgramPrice(PROGRAM, 12500);
    await setProgramProductOffSale(PROGRAM);
    await mintMemberDiscountCode(PROGRAM, 9, 1000);
}

let originalEnv: NodeJS.ProcessEnv;

beforeEach(() => {
    originalEnv = { ...process.env };
    process.env.CHECKIN_ENV = 'dev';
    process.env.SHOPIFY_STORE_DOMAIN = 'test.myshopify.com';
    process.env.SHOPIFY_CLIENT_ID = 'id';
    process.env.SHOPIFY_CLIENT_SECRET = 'secret';
    resetTokenCache();
    fakeShopify();
    outboundLeak.inject = false;
    outboundLeak.sent = [];
    jest.useFakeTimers({ now: NOW, doNotFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'nextTick', 'queueMicrotask'] });
    jest.spyOn(crypto, 'randomBytes').mockImplementation(() => Buffer.from('a1b2c3d4', 'hex'));
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    process.env = originalEnv;
    jest.useRealTimers();
    jest.restoreAllMocks();
});

const API = 'https://test.myshopify.com/admin/api/2026-01';

describe('Shopify write request bodies', () => {
    it('createShopifySingleVariantProgram', async () => {
        await createShopifySingleVariantProgram(PROGRAM.name, PROGRAM.nonOrgMemberPriceCents, PROGRAM.maxParticipants, programProductHandle(PROGRAM, 'public'));
        expect(writes).toEqual([[
            `${API}/products.json`, 'POST',
            '{"product":{"title":"Robotics Program Enrollment","handle":"checkin-program-7-robotics","status":"active","product_type":"Educational Services","variants":[{"price":"35.00","requires_shipping":false,"inventory_management":"shopify","inventory_policy":"deny"}]}}',
        ]]);
    });

    it('createShopifySingleVariantProgram, uncapped and without a handle', async () => {
        await createShopifySingleVariantProgram(PROGRAM.name, PROGRAM.nonOrgMemberPriceCents);
        expect(writes).toEqual([[
            `${API}/products.json`, 'POST',
            '{"product":{"title":"Robotics Program Enrollment","status":"active","product_type":"Educational Services","variants":[{"price":"35.00","requires_shipping":false,"inventory_management":null,"inventory_policy":"continue"}]}}',
        ]]);
    });

    it('createClaimantProduct: the create, then the unlist', async () => {
        await createClaimantProduct(PROGRAM.name, PROGRAM.nonOrgMemberPriceCents, programProductHandle(PROGRAM, 'claimant'));
        expect(writes).toEqual([
            [
                `${API}/products.json`, 'POST',
                '{"product":{"title":"Robotics Program Enrollment (reserved seat)","handle":"checkin-program-7-robotics-reserved-seat","status":"draft","published":true,"product_type":"Educational Services","variants":[{"price":"35.00","requires_shipping":false,"inventory_management":null,"inventory_policy":"continue"}]}}',
            ],
            [`${API}/graphql.json`, 'POST', '{"query":"…","variables":{"product":{"id":"gid://shopify/Product/710","status":"UNLISTED"}}}'],
        ]);
    });

    it('syncProgramPrice: one PUT per variant', async () => {
        await syncProgramPrice(PROGRAM, 12500);
        expect(writes).toEqual([
            [`${API}/variants/111.json`, 'PUT', '{"variant":{"id":111,"price":"125.00"}}'],
            [`${API}/variants/222.json`, 'PUT', '{"variant":{"id":222,"price":"125.00"}}'],
        ]);
    });

    it('setProgramProductOffSale', async () => {
        await setProgramProductOffSale(PROGRAM);
        expect(writes).toEqual([[`${API}/products/4242.json`, 'PUT', '{"product":{"id":4242,"status":"draft"}}']]);
    });

    it('mintMemberDiscountCode: on the checkout (claimant) variant', async () => {
        expect(await mintMemberDiscountCode(PROGRAM, 9, 1000)).toBe('PRG7-H9-A1B2C3D4');
        expect(writes).toEqual([[
            `${API}/graphql.json`, 'POST',
            '{"query":"…","variables":{"discount":{"title":"PRG7-H9-A1B2C3D4","code":"PRG7-H9-A1B2C3D4","startsAt":"2026-10-21T12:00:00.000Z","endsAt":"2026-10-23T12:00:00.000Z","usageLimit":1,"appliesOncePerCustomer":true,"customerSelection":{"all":true},"customerGets":{"value":{"discountAmount":{"amount":"10.00","appliesOnEachItem":true}},"items":{"products":{"productVariantsToAdd":["gid://shopify/ProductVariant/222"]}}}}}}',
        ]]);
    });

    it('mintMemberDiscountCode: on the public variant when there is no claimant one', async () => {
        await mintMemberDiscountCode({ ...PROGRAM, claimantShopifyVariantId: null }, 9, 1000);
        expect(writes[0][2]).toContain('"productVariantsToAdd":["gid://shopify/ProductVariant/111"]');
    });

    it('every write goes through outboundCall on its surface', async () => {
        await writeAll();
        expect(outboundLeak.sent.map((s) => s.surface)).toEqual([
            'shopify.product.create',
            'shopify.product.create',
            'shopify.product.update',
            'shopify.product.update',
            'shopify.product.update',
            'shopify.discount.create',
        ]);
        expect(writes).toHaveLength(7);
    });
});

describe('fields above a surface tier never reach Shopify', () => {
    it('pii, personal and internal fields added to each bag are stripped before send and absent from every body', async () => {
        await writeAll();
        const clean = writes.map((w) => w.join(' '));
        outboundLeak.sent = [];
        resetTokenCache();
        fakeShopify();
        outboundLeak.inject = true;

        await writeAll();

        expect(outboundLeak.sent).toHaveLength(6);
        for (const { stripped } of outboundLeak.sent) {
            const seen = JSON.stringify(stripped);
            expect(seen).not.toContain(LEAK.pii);
            expect(seen).not.toContain(LEAK.personal);
            expect(seen).not.toContain(LEAK.internal);
        }
        expect(writes.map((w) => w.join(' '))).toEqual(clean);
    });
});
