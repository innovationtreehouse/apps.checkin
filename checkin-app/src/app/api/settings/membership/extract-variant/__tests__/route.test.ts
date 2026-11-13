/**
 * @jest-environment node
 */
/**
 * POST /api/settings/membership/extract-variant — the whole flow, with the
 * Shopify Admin client mocked: URL validation (https, /products/<handle>,
 * rejected BEFORE any Shopify call), the handle lookup on the configured store
 * domain whatever host was pasted, and the answer the page shows for the
 * Board to confirm or pick from ({ productTitle, variants }).
 */
import { POST } from '../route';
import { getServerSession } from 'next-auth/next';
import { getAccessToken, shopifyFetch } from '@/lib/shopify/client';
import { logIntegrationError } from '@/lib/logger';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));
jest.mock('@/lib/shopify/client', () => ({
    ...jest.requireActual('@/lib/shopify/client'),
    getAccessToken: jest.fn(),
    shopifyFetch: jest.fn(),
}));
jest.mock('@/lib/logger', () => ({
    ...jest.requireActual('@/lib/logger'),
    logIntegrationError: jest.fn(),
}));

const STORE = 'test-store.myshopify.com';
const GOOD_URL = `https://${STORE}/products/annual-membership`;

const fetchMock = shopifyFetch as jest.Mock;

function asBoard() {
    (getServerSession as jest.Mock).mockResolvedValue({ user: { id: 1, isSysadmin: false, isBoardMember: true } });
}
function req(body?: unknown) {
    return new Request('http://localhost:4000/api/settings/membership/extract-variant', {
        method: 'POST',
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
}
function jsonResponse(status: number, body: unknown) {
    return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}
const variant = (id: number, title: string, price: string) => ({ id, title, price });
const products = (...list: unknown[]) => jsonResponse(200, { products: list });

describe('POST /api/settings/membership/extract-variant', () => {
    const prevDomain = process.env.SHOPIFY_STORE_DOMAIN;

    beforeEach(() => {
        jest.clearAllMocks();
        process.env.SHOPIFY_STORE_DOMAIN = STORE;
        (getAccessToken as jest.Mock).mockResolvedValue('shpat_test');
        asBoard();
    });

    afterAll(() => {
        if (prevDomain === undefined) delete process.env.SHOPIFY_STORE_DOMAIN;
        else process.env.SHOPIFY_STORE_DOMAIN = prevDomain;
    });

    it('401 when unauthenticated, and never calls Shopify', async () => {
        (getServerSession as jest.Mock).mockResolvedValue(null);
        const res = await POST(req({ productUrl: GOOD_URL }));
        expect(res.status).toBe(401);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('403 for a plain member, and never calls Shopify', async () => {
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: 2, isSysadmin: false, isBoardMember: false } });
        const res = await POST(req({ productUrl: GOOD_URL }));
        expect(res.status).toBe(403);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('400 when productUrl is missing or blank', async () => {
        expect((await POST(req({}))).status).toBe(400);
        expect((await POST(req({ productUrl: '   ' }))).status).toBe(400);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('extracts the id of a single-variant product via the Admin API, ignoring query/hash/trailing slash', async () => {
        fetchMock.mockResolvedValue(products({ id: 8819108249771, title: 'Annual Membership', variants: [variant(45678901234, 'Default Title', '150.00')] }));
        const res = await POST(req({ productUrl: `${GOOD_URL}/?utm_source=admin#reviews` }));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
            productTitle: 'Annual Membership',
            variants: [{ id: '45678901234', title: 'Default Title', priceCents: 15000 }],
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe(`https://${STORE}/admin/api/2026-01/products.json?handle=annual-membership&fields=id,title,variants`);
        expect(init.headers['X-Shopify-Access-Token']).toBe('shpat_test');
    });

    it("reads the configured store, not the pasted host, for the store's custom domain", async () => {
        fetchMock.mockResolvedValue(products({ id: 1, variants: [variant(555, 'Default Title', '150.00')] }));
        const res = await POST(req({ productUrl: 'https://shop.example.org/products/annual-membership' }));
        expect(res.status).toBe(200);
        expect((await res.json()).variants).toEqual([{ id: '555', title: 'Default Title', priceCents: 15000 }]);
        expect(fetchMock.mock.calls[0][0]).toMatch(new RegExp(`^https://${STORE}/admin/api/`));
    });

    it('lists every variant of a multi-variant product, falling back to the handle for a missing title', async () => {
        fetchMock.mockResolvedValue(products({
            id: 1,
            variants: [variant(111, 'Member', '150.00'), variant(222, 'Non-Member', '250.00'), { id: 333, title: 'Odd', price: null }],
        }));
        const res = await POST(req({ productUrl: GOOD_URL }));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
            productTitle: 'annual-membership',
            variants: [
                { id: '111', title: 'Member', priceCents: 15000 },
                { id: '222', title: 'Non-Member', priceCents: 25000 },
                { id: '333', title: 'Odd', priceCents: null },
            ],
        });
    });

    // ── URL validation: each rejection happens BEFORE any Shopify call ─────

    const rejectedBeforeFetch: Array<[string, string]> = [
        ['not a URL at all', 'annual-membership'],
        ['http, not https', `http://${STORE}/products/annual-membership`],
        ['non-product path', `https://${STORE}/cart/12345:1`],
        ['nested path under products', `https://${STORE}/products/annual-membership/extra`],
        ['path traversal in the handle', `https://${STORE}/products/..%2Fadmin`],
    ];
    it.each(rejectedBeforeFetch)('400 without calling Shopify: %s', async (_label, url) => {
        const res = await POST(req({ productUrl: url }));
        expect(res.status).toBe(400);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('400 without calling Shopify when SHOPIFY_STORE_DOMAIN is not configured', async () => {
        delete process.env.SHOPIFY_STORE_DOMAIN;
        const res = await POST(req({ productUrl: GOOD_URL }));
        expect(res.status).toBe(400);
        expect((await res.json()).error).toMatch(/not configured/);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('400 without calling Shopify when no access token can be obtained', async () => {
        (getAccessToken as jest.Mock).mockResolvedValue(null);
        const res = await POST(req({ productUrl: GOOD_URL }));
        expect(res.status).toBe(400);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    // ── Shopify answers ─────────────────────────────────────────────────────

    it('404 with a clear message when Shopify has no product with that handle', async () => {
        fetchMock.mockResolvedValue(products());
        const res = await POST(req({ productUrl: GOOD_URL }));
        expect(res.status).toBe(404);
        expect((await res.json()).error).toMatch(/no product with the handle "annual-membership"/);
    });

    it('400 when the product has zero variants', async () => {
        fetchMock.mockResolvedValue(products({ id: 1, variants: [] }));
        const res = await POST(req({ productUrl: GOOD_URL }));
        expect(res.status).toBe(400);
        expect((await res.json()).error).toMatch(/no variants/);
    });

    it('502, logged as a Shopify integration error, when the Admin API returns an error status', async () => {
        fetchMock.mockResolvedValue(jsonResponse(500, {}));
        const res = await POST(req({ productUrl: GOOD_URL }));
        expect(res.status).toBe(502);
        expect((await res.json()).error).toMatch(/Could not read the product from Shopify/);
        expect(logIntegrationError).toHaveBeenCalledWith('shopify', expect.any(Error), expect.objectContaining({ handle: 'annual-membership' }));
    });

    it('502 when the Admin API call itself fails (network error or timeout)', async () => {
        fetchMock.mockRejectedValue(new Error('Shopify find product by handle timed out after 20000ms'));
        const res = await POST(req({ productUrl: GOOD_URL }));
        expect(res.status).toBe(502);
        expect(logIntegrationError).toHaveBeenCalled();
    });
});
