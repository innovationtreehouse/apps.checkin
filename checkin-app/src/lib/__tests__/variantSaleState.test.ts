/**
 * @jest-environment node
 *
 * The membership checkout's Shopify lookup: a variant Shopify has no record of is missing,
 * one whose product is archived is retired, and a failed lookup throws rather than saying either.
 */
import { resetTokenCache } from '../shopify/client';
import { variantSaleState } from '../shopify/products';

jest.mock('../logger', () => ({ logIntegrationError: jest.fn().mockResolvedValue(undefined) }));

let originalEnv: NodeJS.ProcessEnv;
let lookup: jest.Mock;

function answer(res: { ok: boolean; status: number; body?: unknown }) {
    lookup = jest.fn(async (url: string) =>
        url.includes('/oauth/access_token')
            ? { ok: true, status: 200, json: async () => ({ access_token: 't', expires_in: 86400 }) }
            : { ok: res.ok, status: res.status, json: async () => res.body });
    global.fetch = lookup as unknown as typeof fetch;
}

beforeEach(() => {
    originalEnv = { ...process.env };
    process.env.SHOPIFY_STORE_DOMAIN = 'test.myshopify.com';
    process.env.SHOPIFY_CLIENT_ID = 'id';
    process.env.SHOPIFY_CLIENT_SECRET = 'secret';
    resetTokenCache();
});
afterEach(() => { process.env = originalEnv; });

it('asks for the variant by its GraphQL id', async () => {
    answer({ ok: true, status: 200, body: { data: { productVariant: { id: 'v', product: { status: 'ACTIVE' } } } } });
    await expect(variantSaleState('4242')).resolves.toBe('sellable');
    const [url, init] = lookup.mock.calls.at(-1)!;
    expect(url).toBe('https://test.myshopify.com/admin/api/2026-01/graphql.json');
    expect(JSON.parse(String(init.body)).variables).toEqual({ id: 'gid://shopify/ProductVariant/4242' });
});

it('is missing when Shopify has no such variant', async () => {
    answer({ ok: true, status: 200, body: { data: { productVariant: null } } });
    await expect(variantSaleState('4242')).resolves.toBe('missing');
});

it('is archived when its product is archived', async () => {
    answer({ ok: true, status: 200, body: { data: { productVariant: { id: 'v', product: { status: 'ARCHIVED' } } } } });
    await expect(variantSaleState('4242')).resolves.toBe('archived');
});

it('throws on an error answer or GraphQL errors, never reporting a retired product', async () => {
    answer({ ok: false, status: 503 });
    await expect(variantSaleState('4242')).rejects.toThrow();
    answer({ ok: true, status: 200, body: { errors: [{ message: 'Throttled' }] } });
    await expect(variantSaleState('4242')).rejects.toThrow(/Throttled/);
});
