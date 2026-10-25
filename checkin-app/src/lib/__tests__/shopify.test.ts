import { resetTokenCache } from '../shopify/client';
import { createShopifySingleVariantProgram, createClaimantProduct } from '../shopify/products';
import { syncProgramPrice, setProgramProductOffSale } from '../shopify/stock';
import { mintMemberDiscountCode } from '../shopify/discounts';
import { sendEmail } from '../email';
import prisma from '../prisma';

jest.mock('../email', () => ({
    sendEmail: jest.fn().mockResolvedValue(true)
}));

jest.mock('../prisma', () => ({
    __esModule: true,
    default: {
        person: {
            findMany: jest.fn()
        }
    }
}));

jest.mock('../logger', () => ({
    logIntegrationError: jest.fn().mockResolvedValue(undefined),
}));
import { logIntegrationError } from '../logger';

// Helper: mock a successful token response
function mockTokenResponse(fetchMock: jest.Mock) {
    fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'test_token', scope: 'write_products,write_inventory,read_locations,read_orders', expires_in: 86400 })
    });
}

describe('setProgramProductOffSale', () => {
    let originalEnv: NodeJS.ProcessEnv;
    let fetchMock: jest.Mock;

    beforeEach(() => {
        originalEnv = { ...process.env };
        fetchMock = jest.fn();
        global.fetch = fetchMock;
        jest.clearAllMocks();
        resetTokenCache();
    });

    afterEach(() => {
        process.env = originalEnv;
        jest.restoreAllMocks();
    });

    it('returns false and emails admins when credentials are missing, so the sweep retries', async () => {
        delete process.env.SHOPIFY_STORE_DOMAIN;
        delete process.env.SHOPIFY_CLIENT_ID;
        delete process.env.SHOPIFY_CLIENT_SECRET;
        (prisma.person.findMany as jest.Mock).mockResolvedValueOnce([{ email: 'admin@test.com' }]);

        const result = await setProgramProductOffSale({ shopifyProductId: '4242' });

        expect(result).toBe(false);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(logIntegrationError).toHaveBeenCalledWith('shopify', expect.any(Error), expect.objectContaining({ operation: 'setProgramProductOffSale' }));
        expect(sendEmail).toHaveBeenCalledWith('admin@test.com', 'Shopify Integration Error', expect.stringContaining('retried on the next daily run'));
    });
});

describe('createShopifySingleVariantProgram', () => {
    let originalEnv: NodeJS.ProcessEnv;
    let fetchMock: jest.Mock;

    beforeEach(() => {
        originalEnv = { ...process.env };
        process.env.SHOPIFY_STORE_DOMAIN = 'test.myshopify.com';
        process.env.SHOPIFY_CLIENT_ID = 'test_client_id';
        process.env.SHOPIFY_CLIENT_SECRET = 'test_client_secret';

        fetchMock = jest.fn();
        global.fetch = fetchMock;

        jest.clearAllMocks();
        resetTokenCache();
    });

    afterEach(() => {
        process.env = originalEnv;
        jest.restoreAllMocks();
    });

    it('returns null for a free program (no base price) without calling fetch', async () => {
        const result = await createShopifySingleVariantProgram('Free Prog', null);
        expect(result).toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('returns null and emails admins if credentials are missing in prod', async () => {
        // In prod, unconfigured Shopify fails closed to null (no mock stand-in).
        process.env.CHECKIN_ENV = 'prod';
        delete process.env.SHOPIFY_STORE_DOMAIN;
        (prisma.person.findMany as jest.Mock).mockResolvedValueOnce([{ email: 'admin@test.com' }]);

        const result = await createShopifySingleVariantProgram('Test Program', 3500);

        expect(result).toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
        expect(sendEmail).toHaveBeenCalledWith(
            'admin@test.com',
            'Shopify Integration Error',
            expect.stringContaining('credentials are missing'),
        );
    });

    it('returns null and emails admins when the token request fails', async () => {
        fetchMock.mockResolvedValueOnce({ ok: false, status: 401, text: async () => '{"error":"invalid_client"}' });
        (prisma.person.findMany as jest.Mock).mockResolvedValueOnce([{ email: 'admin@test.com' }]);

        const result = await createShopifySingleVariantProgram('Test Program', 3500);

        expect(result).toBeNull();
        expect(fetchMock).toHaveBeenCalledTimes(1); // only the token request
        expect(sendEmail).toHaveBeenCalledWith('admin@test.com', 'Shopify Integration Error', expect.stringContaining('no access token'));
    });

    it('emails admins when the product fetch throws', async () => {
        mockTokenResponse(fetchMock);
        fetchMock.mockRejectedValueOnce(new Error('Network error'));
        (prisma.person.findMany as jest.Mock).mockResolvedValueOnce([{ email: 'admin@test.com' }]);

        const result = await createShopifySingleVariantProgram('Test Network Error', 3500);

        expect(result).toBeNull();
        expect(sendEmail).toHaveBeenCalledWith(
            'admin@test.com',
            'Shopify Integration Error',
            expect.stringContaining('Network error'),
        );
    });

    it('times out a hung product request and emails admins (does not hang)', async () => {
        mockTokenResponse(fetchMock); // token succeeds (its own AbortSignal.timeout is untouched)...
        // ...then the product create hangs: a fetch that only settles on abort stands in for a
        // hung TCP connection. We drive the deadline by replacing AbortSignal.timeout for that
        // one call with a controller we fire ourselves; without the timeout it never resolves.
        const deadline = new AbortController();
        const timeoutSpy = jest.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
        fetchMock.mockImplementationOnce((_url: string, init: RequestInit) =>
            new Promise((_resolve, reject) => {
                const signal = init.signal as AbortSignal;
                if (signal.aborted) return reject(signal.reason);
                signal.addEventListener('abort', () => reject(signal.reason));
            }),
        );
        (prisma.person.findMany as jest.Mock).mockResolvedValueOnce([{ email: 'admin@test.com' }]);

        const p = createShopifySingleVariantProgram('Test Hang', 3500);
        deadline.abort(new DOMException('The operation timed out', 'TimeoutError'));
        const result = await p;

        expect(result).toBeNull();
        expect(sendEmail).toHaveBeenCalledWith(
            'admin@test.com',
            'Shopify Integration Error',
            expect.stringContaining('timed out after 20000ms'),
        );
        timeoutSpy.mockRestore();
    });

    it('returns a synthetic single variant id on local (mock active)', async () => {
        process.env.CHECKIN_ENV = 'local';
        delete process.env.SHOPIFY_STORE_DOMAIN;
        delete process.env.SHOPIFY_CLIENT_ID;
        delete process.env.SHOPIFY_CLIENT_SECRET;

        const result = await createShopifySingleVariantProgram('Test Program', 3500, 10);
        expect(result).not.toBeNull();
        expect(result?.shopifyProductId).toMatch(/^dev-mock-product-/);
        expect(result?.shopifyVariantId).toMatch(/^dev-mock-variant-/);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('creates the product with its ONE variant inline (non-physical, base price) and leaves stock to the caller', async () => {
        mockTokenResponse(fetchMock);
        fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ product: { id: 700, variants: [{ id: 800, inventory_item_id: 900 }] } }) });

        const result = await createShopifySingleVariantProgram('Single Pool Program', 3500, 10);

        expect(result).toEqual({ shopifyProductId: '700', shopifyVariantId: '800' });
        expect(fetchMock).toHaveBeenCalledTimes(2); // token + product (variant inline); stock goes through adjustProgramInventory

        // The variant MUST ride inside the product create: a bare create mints a
        // physical $0 "Default Title" variant that 422s the follow-up variant
        // POST (no variant stored) and makes checkout ask for shipping.
        const productCall = fetchMock.mock.calls[1];
        expect(String(productCall[0])).toContain('/products.json');
        expect(JSON.parse((productCall[1] as RequestInit).body as string)).toMatchObject({
            product: { variants: [{ price: '35.00', requires_shipping: false, inventory_management: 'shopify', inventory_policy: 'deny' }] },
        });
    });

    it.each([[0, 'shopify', 'deny'], [null, null, 'continue']])('a cap of %s creates the variant with inventory_management %s and policy %s', async (cap, management, policy) => {
        mockTokenResponse(fetchMock);
        fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ product: { id: 700, variants: [{ id: 800 }] } }) });

        await createShopifySingleVariantProgram('Capped Program', 3500, cap);

        const body = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
        expect(body.product.variants[0]).toMatchObject({ inventory_management: management, inventory_policy: policy });
    });

    it('returns null and emails admins when product creation fails', async () => {
        mockTokenResponse(fetchMock);
        fetchMock.mockResolvedValueOnce({ ok: false, status: 422, statusText: 'Unprocessable Entity', text: async () => '{"errors":"bad variant"}' });
        (prisma.person.findMany as jest.Mock).mockResolvedValueOnce([{ email: 'admin@test.com' }]);

        const result = await createShopifySingleVariantProgram('Broken Program', 3500);

        expect(result).toBeNull();
        expect(sendEmail).toHaveBeenCalledWith(
            'admin@test.com',
            'Shopify Integration Error',
            expect.stringContaining('Shopify API responded with status: 422'),
        );
    });

    it('returns null and emails admins when the created product comes back without a variant', async () => {
        mockTokenResponse(fetchMock);
        fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ product: { id: 702, variants: [] } }) });
        (prisma.person.findMany as jest.Mock).mockResolvedValueOnce([{ email: 'admin@test.com' }]);

        const result = await createShopifySingleVariantProgram('Variantless Program', 3500);

        expect(result).toBeNull();
        expect(sendEmail).toHaveBeenCalledWith(
            'admin@test.com',
            'Shopify Integration Error',
            expect.stringContaining('missing the created variant'),
        );
    });

});

describe('mintMemberDiscountCode', () => {
    let originalEnv: NodeJS.ProcessEnv;
    let fetchMock: jest.Mock;

    beforeEach(() => {
        originalEnv = { ...process.env };
        process.env.SHOPIFY_STORE_DOMAIN = 'test.myshopify.com';
        process.env.SHOPIFY_CLIENT_ID = 'test_client_id';
        process.env.SHOPIFY_CLIENT_SECRET = 'test_client_secret';

        fetchMock = jest.fn();
        global.fetch = fetchMock;

        jest.clearAllMocks();
        resetTokenCache();
    });

    afterEach(() => {
        process.env = originalEnv;
        jest.restoreAllMocks();
    });

    it('returns null for a zero/negative discount without calling fetch', async () => {
        const result = await mintMemberDiscountCode({ id: 1, shopifyVariantId: 'variant-1' }, 7, 0);
        expect(result).toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('returns a synthesized code on local (mock active), no network', async () => {
        process.env.CHECKIN_ENV = 'local';
        delete process.env.SHOPIFY_STORE_DOMAIN;
        delete process.env.SHOPIFY_CLIENT_ID;
        delete process.env.SHOPIFY_CLIENT_SECRET;

        const result = await mintMemberDiscountCode({ id: 42, shopifyVariantId: '999888' }, 7, 1000);
        expect(result).toMatch(/^PRG42-H7-[0-9A-F]{8}$/);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('creates the discount via GraphQL discountCodeBasicCreate and returns the code', async () => {
        mockTokenResponse(fetchMock);
        fetchMock.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ data: { discountCodeBasicCreate: { codeDiscountNode: { id: 'gid://shopify/DiscountCodeNode/1' }, userErrors: [] } } }),
        });

        const result = await mintMemberDiscountCode({ id: 42, shopifyVariantId: '999888' }, 7, 1000);

        expect(result).toMatch(/^PRG42-H7-[0-9A-F]{8}$/);
        expect(fetchMock).toHaveBeenCalledTimes(2); // token + one GraphQL mutation
        const gqlCall = fetchMock.mock.calls[1];
        expect(String(gqlCall[0])).toContain('/graphql.json');
        const body = JSON.parse((gqlCall[1] as RequestInit).body as string);
        expect(body.query).toContain('discountCodeBasicCreate');
        expect(body.variables.discount).toMatchObject({
            usageLimit: 1,
            appliesOncePerCustomer: true,
            customerSelection: { all: true },
            customerGets: {
                // appliesOnEachItem carries the 'each' per-unit semantics (multi-child carts).
                value: { discountAmount: { amount: '10.00', appliesOnEachItem: true } },
                items: { products: { productVariantsToAdd: ['gid://shopify/ProductVariant/999888'] } },
            },
        });
        expect(body.variables.discount.title).toBe(result);
        expect(body.variables.discount.code).toBe(result);
    });

    it('returns null and does NOT email admins when minting fails (quiet fallback, never blocks checkout)', async () => {
        mockTokenResponse(fetchMock);
        fetchMock.mockResolvedValueOnce({ ok: false, status: 422, text: async () => '{"errors":"bad request"}' });

        const result = await mintMemberDiscountCode({ id: 42, shopifyVariantId: '999888' }, 7, 1000);

        expect(result).toBeNull();
        expect(sendEmail).not.toHaveBeenCalled();
    });

    it('returns null (quiet fallback) when the mutation reports userErrors', async () => {
        mockTokenResponse(fetchMock);
        fetchMock.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ data: { discountCodeBasicCreate: { codeDiscountNode: null, userErrors: [{ field: ['basicCodeDiscount'], message: 'nope' }] } } }),
        });

        const result = await mintMemberDiscountCode({ id: 42, shopifyVariantId: '999888' }, 7, 1000);

        expect(result).toBeNull();
        expect(sendEmail).not.toHaveBeenCalled();
        expect(logIntegrationError).toHaveBeenCalled();
    });

    it('returns null without calling fetch when credentials are missing', async () => {
        delete process.env.SHOPIFY_STORE_DOMAIN;
        delete process.env.SHOPIFY_CLIENT_ID;
        delete process.env.SHOPIFY_CLIENT_SECRET;

        const result = await mintMemberDiscountCode({ id: 42, shopifyVariantId: '999888' }, 7, 1000);
        expect(result).toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

describe('createClaimantProduct', () => {
    let originalEnv: NodeJS.ProcessEnv;
    let fetchMock: jest.Mock;

    beforeEach(() => {
        originalEnv = { ...process.env };
        process.env.SHOPIFY_STORE_DOMAIN = 'test.myshopify.com';
        process.env.SHOPIFY_CLIENT_ID = 'test_client_id';
        process.env.SHOPIFY_CLIENT_SECRET = 'test_client_secret';
        fetchMock = jest.fn();
        global.fetch = fetchMock;
        jest.clearAllMocks();
        resetTokenCache();
    });

    afterEach(() => {
        process.env = originalEnv;
        jest.restoreAllMocks();
    });

    function unlistResponse(status: string) {
        return { ok: true, json: async () => ({ data: { productUpdate: { product: { id: 'gid://shopify/Product/710', status }, userErrors: [] } } }) };
    }

    it('returns null for a free program without calling fetch', async () => {
        expect(await createClaimantProduct('Free', null)).toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('returns a synthetic claimant variant id on local (mock active)', async () => {
        process.env.CHECKIN_ENV = 'local';
        delete process.env.SHOPIFY_STORE_DOMAIN;
        delete process.env.SHOPIFY_CLIENT_ID;
        delete process.env.SHOPIFY_CLIENT_SECRET;
        const result = await createClaimantProduct('Test Program', 3500);
        expect(result?.claimantShopifyVariantId).toMatch(/^dev-mock-claimant-variant-/);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('creates an untracked draft via REST, then sets UNLISTED via GraphQL', async () => {
        mockTokenResponse(fetchMock);
        fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ product: { id: 710, variants: [{ id: 810 }] } }) });
        fetchMock.mockResolvedValueOnce(unlistResponse('UNLISTED'));

        const result = await createClaimantProduct('Robotics', 3500);

        expect(result).toEqual({ claimantShopifyProductId: '710', claimantShopifyVariantId: '810' });
        const productBody = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
        expect(productBody).toMatchObject({
            product: {
                title: 'Robotics Program Enrollment (reserved seat)',
                status: 'draft',
                published: true,
                variants: [{ price: '35.00', requires_shipping: false, inventory_management: null, inventory_policy: 'continue' }],
            },
        });
        expect(String(fetchMock.mock.calls[2][0])).toContain('/graphql.json');
        const gql = JSON.parse((fetchMock.mock.calls[2][1] as RequestInit).body as string);
        expect(gql.variables).toEqual({ product: { id: 'gid://shopify/Product/710', status: 'UNLISTED' } });
    });

    it('returns null and names the orphan when the status does not come back UNLISTED', async () => {
        mockTokenResponse(fetchMock);
        fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ product: { id: 711, variants: [{ id: 811 }] } }) });
        fetchMock.mockResolvedValueOnce(unlistResponse('ACTIVE'));
        (prisma.person.findMany as jest.Mock).mockResolvedValueOnce([]);

        expect(await createClaimantProduct('Old API', 3500)).toBeNull();
        expect(logIntegrationError).toHaveBeenCalledWith('shopify', expect.any(Error), expect.objectContaining({ operation: 'createClaimantProduct', orphanedProductId: '711' }));
    });
});

describe('syncProgramPrice', () => {
    let originalEnv: NodeJS.ProcessEnv;
    let fetchMock: jest.Mock;

    const program = { id: 7, name: 'Robotics', shopifyVariantId: '111', claimantShopifyVariantId: '222' };

    beforeEach(() => {
        originalEnv = { ...process.env };
        delete process.env.CHECKIN_ENV;
        process.env.SHOPIFY_STORE_DOMAIN = 'test.myshopify.com';
        process.env.SHOPIFY_CLIENT_ID = 'test_client_id';
        process.env.SHOPIFY_CLIENT_SECRET = 'test_client_secret';

        fetchMock = jest.fn();
        global.fetch = fetchMock;

        jest.clearAllMocks();
        resetTokenCache();
    });

    afterEach(() => {
        process.env = originalEnv;
        jest.restoreAllMocks();
    });

    it('sets the base price on both the public and the claimant variant', async () => {
        mockTokenResponse(fetchMock);
        fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });

        const result = await syncProgramPrice(program, 12500);

        expect(result).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(3); // token + 2 variant PUTs
        const puts = fetchMock.mock.calls.slice(1);
        expect(puts.map(([url]) => String(url))).toEqual([
            expect.stringContaining('/admin/api/2026-01/variants/111.json'),
            expect.stringContaining('/admin/api/2026-01/variants/222.json'),
        ]);
        for (const [, init] of puts) {
            expect((init as RequestInit).method).toBe('PUT');
            expect(JSON.parse((init as RequestInit).body as string).variant.price).toBe('125.00');
        }
    });

    it('updates only the public variant when the program has no claimant product', async () => {
        mockTokenResponse(fetchMock);
        fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });

        const result = await syncProgramPrice({ ...program, claimantShopifyVariantId: null }, 5000);

        expect(result).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(String(fetchMock.mock.calls[1][0])).toContain('variants/111.json');
    });

    it('no-ops successfully (no fetch, no alert) when the program has no variants', async () => {
        const result = await syncProgramPrice({ id: 7, name: 'Free', shopifyVariantId: null, claimantShopifyVariantId: null }, 0);

        expect(result).toBe(true);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(logIntegrationError).not.toHaveBeenCalled();
    });

    it.each([0, null])('never pushes a base of %p: alerts admins and returns false', async (base) => {
        (prisma.person.findMany as jest.Mock).mockResolvedValueOnce([{ email: 'admin@test.com' }]);

        const result = await syncProgramPrice(program, base);

        expect(result).toBe(false);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(logIntegrationError).toHaveBeenCalledWith('shopify', expect.any(Error), expect.objectContaining({ operation: 'syncProgramPrice', programId: 7 }));
        expect(sendEmail).toHaveBeenCalledWith('admin@test.com', 'Shopify Integration Error', expect.stringContaining('price for program'));
    });

    it('returns false and alerts admins when a variant update fails', async () => {
        mockTokenResponse(fetchMock);
        fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
        fetchMock.mockResolvedValueOnce({ ok: false, status: 404, text: async () => 'Not Found' });
        (prisma.person.findMany as jest.Mock).mockResolvedValueOnce([{ email: 'admin@test.com' }]);

        const result = await syncProgramPrice(program, 12500);

        expect(result).toBe(false);
        expect(logIntegrationError).toHaveBeenCalledWith('shopify', expect.objectContaining({ message: expect.stringContaining('222') }), expect.objectContaining({ operation: 'syncProgramPrice' }));
        expect(sendEmail).toHaveBeenCalledWith('admin@test.com', 'Shopify Integration Error', expect.stringContaining('out of date'));
    });

    it('returns false and alerts admins without fetching when credentials are missing', async () => {
        delete process.env.SHOPIFY_STORE_DOMAIN;
        delete process.env.SHOPIFY_CLIENT_ID;
        delete process.env.SHOPIFY_CLIENT_SECRET;
        (prisma.person.findMany as jest.Mock).mockResolvedValueOnce([]);

        const result = await syncProgramPrice(program, 12500);

        expect(result).toBe(false);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(logIntegrationError).toHaveBeenCalledWith('shopify', expect.any(Error), expect.objectContaining({ operation: 'syncProgramPrice' }));
    });

    it('logs and succeeds without fetching when the Shopify mock is active', async () => {
        process.env.CHECKIN_ENV = 'local';
        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

        const result = await syncProgramPrice(program, 12500);

        expect(result).toBe(true);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('125.00'));
    });
});
