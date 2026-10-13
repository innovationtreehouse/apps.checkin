import { createShopifySingleVariantProgram, adjustProgramInventory, mintMemberDiscountCode, resetTokenCache } from '../shopify';
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

describe('adjustProgramInventory', () => {
    let originalEnv: NodeJS.ProcessEnv;
    let fetchMock: jest.Mock;

    const program = { shopifyVariantId: '67890' };

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

    it('resolves the variant inventory_item_id and adjusts it by delta at the store location', async () => {
        mockTokenResponse(fetchMock);
        fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ locations: [{ id: 555 }] }) });
        fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ variant: { inventory_item_id: 111 } }) });
        fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({}) }); // adjust

        const result = await adjustProgramInventory(program, 5);

        expect(result).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(4); // token + locations + variant get + adjust
        expect(String(fetchMock.mock.calls[2][0])).toContain('67890');

        const adjustCall = fetchMock.mock.calls[3];
        expect(String(adjustCall[0])).toContain('inventory_levels/adjust.json');
        expect(JSON.parse((adjustCall[1] as RequestInit).body as string)).toEqual({
            location_id: 555,
            inventory_item_id: 111,
            available_adjustment: 5,
        });
    });

    it('no-ops successfully (no fetch) when the program has no variant to adjust', async () => {
        const result = await adjustProgramInventory({ shopifyVariantId: null }, -3);

        expect(result).toBe(true);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('returns false and emails admins (non-fatal) when the adjust call fails', async () => {
        mockTokenResponse(fetchMock);
        fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ locations: [{ id: 555 }] }) });
        fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ variant: { inventory_item_id: 111 } }) });
        fetchMock.mockResolvedValueOnce({ ok: false, status: 422, text: async () => '{"errors":"bad adjustment"}' });

        (prisma.person.findMany as jest.Mock).mockResolvedValueOnce([{ email: 'admin@test.com' }]);

        const result = await adjustProgramInventory(program, 5);

        expect(result).toBe(false);
        expect(sendEmail).toHaveBeenCalledWith(
            'admin@test.com',
            'Shopify Integration Error',
            expect.stringContaining('Failed to adjust Shopify inventory'),
        );
    });

    it('adjusts at an ACTIVE location, not locations[0]', async () => {
        mockTokenResponse(fetchMock);
        fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ locations: [{ id: 111, active: false }, { id: 222, active: true }] }) });
        fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ variant: { inventory_item_id: 333 } }) });
        fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({}) }); // adjust

        const result = await adjustProgramInventory(program, -1);

        expect(result).toBe(true);
        expect(JSON.parse((fetchMock.mock.calls[3][1] as RequestInit).body as string).location_id).toBe(222);
    });

    it('returns false and emails admins without calling fetch when credentials are missing', async () => {
        delete process.env.SHOPIFY_STORE_DOMAIN;
        delete process.env.SHOPIFY_CLIENT_ID;
        delete process.env.SHOPIFY_CLIENT_SECRET;
        (prisma.person.findMany as jest.Mock).mockResolvedValueOnce([{ email: 'admin@test.com' }]);

        const result = await adjustProgramInventory(program, 5);

        expect(result).toBe(false);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(logIntegrationError).toHaveBeenCalledWith('shopify', expect.any(Error), expect.objectContaining({ operation: 'adjustProgramInventory' }));
        expect(sendEmail).toHaveBeenCalledWith(
            'admin@test.com',
            'Shopify Integration Error',
            expect.stringContaining('Failed to adjust Shopify inventory'),
        );
    });

    it('no-ops successfully when the Shopify mock is active', async () => {
        process.env.CHECKIN_ENV = 'local';
        delete process.env.SHOPIFY_STORE_DOMAIN;
        delete process.env.SHOPIFY_CLIENT_ID;
        delete process.env.SHOPIFY_CLIENT_SECRET;
        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

        const result = await adjustProgramInventory(program, 5);

        expect(result).toBe(true);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('67890'));
        logSpy.mockRestore();
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

    it('returns null if credentials are missing in prod', async () => {
        // In prod, unconfigured Shopify fails closed to null (no mock stand-in).
        process.env.CHECKIN_ENV = 'prod';
        delete process.env.SHOPIFY_STORE_DOMAIN;

        const result = await createShopifySingleVariantProgram('Test Program', 3500);

        expect(result).toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('returns null when the token request fails', async () => {
        fetchMock.mockResolvedValueOnce({ ok: false, status: 401, text: async () => '{"error":"invalid_client"}' });

        const result = await createShopifySingleVariantProgram('Test Program', 3500);

        expect(result).toBeNull();
        expect(fetchMock).toHaveBeenCalledTimes(1); // only the token request
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

    it('creates the product with its ONE variant inline (non-physical, base price) and sets inventory', async () => {
        mockTokenResponse(fetchMock);
        fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ product: { id: 700, variants: [{ id: 800, inventory_item_id: 900 }] } }) });
        fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ locations: [{ id: 950 }] }) });
        fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({}) }); // inventory_levels/connect
        fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({}) }); // inventory_levels/set

        const result = await createShopifySingleVariantProgram('Single Pool Program', 3500, 10);

        expect(result).toEqual({ shopifyProductId: '700', shopifyVariantId: '800' });
        expect(fetchMock).toHaveBeenCalledTimes(5); // token + product (variant inline) + locations + connect + set
        expect(String(fetchMock.mock.calls[3][0])).toContain('/inventory_levels/connect.json');
        expect(String(fetchMock.mock.calls[4][0])).toContain('/inventory_levels/set.json');

        // The variant MUST ride inside the product create: a bare create mints a
        // physical $0 "Default Title" variant that 422s the follow-up variant
        // POST (no variant stored) and makes checkout ask for shipping.
        const productCall = fetchMock.mock.calls[1];
        expect(String(productCall[0])).toContain('/products.json');
        expect(JSON.parse((productCall[1] as RequestInit).body as string)).toMatchObject({
            product: { variants: [{ price: '35.00', requires_shipping: false, inventory_management: 'shopify', inventory_policy: 'deny' }] },
        });
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

    // setInitialShopifyInventory's failure modes. Non-fatal to the create by
    // design (the variant is returned), but each must reach IntegrationErrorLog
    // so a resulting sold-out product is visible on the Link Status tab rather
    // than shipping silently.
    describe('inventory branch (maxParticipants configured)', () => {
        it('picks an ACTIVE location, not locations[0], to connect+set against', async () => {
            mockTokenResponse(fetchMock);
            fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ product: { id: 710, variants: [{ id: 810, inventory_item_id: 910 }] } }) });
            // A deactivated location sorts first; the active one is second.
            fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ locations: [{ id: 111, active: false }, { id: 222, active: true }] }) });
            fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({}) }); // connect
            fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({}) }); // set

            const result = await createShopifySingleVariantProgram('Active Location Program', 3500, 4);

            expect(result?.shopifyVariantId).toBe('810');
            // the ACTIVE location (222), not the first (deactivated, 111) one — for both calls
            expect(JSON.parse((fetchMock.mock.calls[3][1] as RequestInit).body as string)).toEqual({
                location_id: 222,
                inventory_item_id: 910,
            });
            expect(JSON.parse((fetchMock.mock.calls[4][1] as RequestInit).body as string)).toEqual({
                location_id: 222,
                inventory_item_id: 910,
                available: 4,
            });
            expect(logIntegrationError).not.toHaveBeenCalled();
        });

        it('treats a 422 from connect as "level already exists" and still sets (e.g. a re-sync)', async () => {
            mockTokenResponse(fetchMock);
            fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ product: { id: 720, variants: [{ id: 820, inventory_item_id: 920 }] } }) });
            fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ locations: [{ id: 990, active: true }] }) });
            fetchMock.mockResolvedValueOnce({ ok: false, status: 422, text: async () => 'inventory level already exists' }); // connect → 422
            fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({}) }); // set still runs

            const result = await createShopifySingleVariantProgram('Already Connected Program', 3500, 6);

            expect(result?.shopifyVariantId).toBe('820');
            expect(fetchMock).toHaveBeenCalledTimes(5); // token, product, locations, connect(422), set
            expect(String(fetchMock.mock.calls[4][0])).toContain('/inventory_levels/set.json');
            expect(JSON.parse((fetchMock.mock.calls[4][1] as RequestInit).body as string)).toEqual({ location_id: 990, inventory_item_id: 920, available: 6 });
            expect(logIntegrationError).not.toHaveBeenCalled(); // a 422 here is benign
        });

        it('surfaces and skips set when connect hard-fails (not a 422)', async () => {
            mockTokenResponse(fetchMock);
            fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ product: { id: 730, variants: [{ id: 830, inventory_item_id: 930 }] } }) });
            fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ locations: [{ id: 991, active: true }] }) });
            fetchMock.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'connect boom' }); // connect → 500

            jest.spyOn(console, 'error').mockImplementation(() => {});
            const result = await createShopifySingleVariantProgram('Connect Fail Program', 3500, 2);

            expect(result?.shopifyVariantId).toBe('830');
            expect(fetchMock).toHaveBeenCalledTimes(4); // no set — connect failed hard
            expect(logIntegrationError).toHaveBeenCalledWith(
                'shopify',
                expect.objectContaining({ message: expect.stringContaining('inventory_levels/connect returned 500') }),
                expect.objectContaining({ operation: 'setInitialShopifyInventory' }),
            );
        });

        it('surfaces to IntegrationErrorLog when inventory set ultimately fails — a sold-out product is visible, not silent', async () => {
            mockTokenResponse(fetchMock);
            fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ product: { id: 740, variants: [{ id: 840, inventory_item_id: 940 }] } }) });
            fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ locations: [{ id: 901, active: true }] }) });
            fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({}) }); // connect ok
            fetchMock.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'inventory boom' }); // set fails

            jest.spyOn(console, 'error').mockImplementation(() => {});
            const result = await createShopifySingleVariantProgram('Inventory Fail Program', 3500, 3);

            // The variant itself was made fine (returned); only the stock level failed.
            expect(result).toEqual({ shopifyProductId: '740', shopifyVariantId: '840' });
            expect(logIntegrationError).toHaveBeenCalledWith(
                'shopify',
                expect.objectContaining({ message: expect.stringContaining('inventory_levels/set returned 500') }),
                expect.objectContaining({ operation: 'setInitialShopifyInventory' }),
            );
            expect(sendEmail).not.toHaveBeenCalled();
        });

        it('surfaces (not silently skips) when the store has no locations configured', async () => {
            mockTokenResponse(fetchMock);
            fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ product: { id: 750, variants: [{ id: 850, inventory_item_id: 950 }] } }) });
            fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ locations: [] }) });

            const result = await createShopifySingleVariantProgram('No Location Program', 3500, 2);

            expect(result?.shopifyVariantId).toBe('850');
            // No inventory_levels/set call (no location), but the failure is surfaced.
            expect(fetchMock).toHaveBeenCalledTimes(3);
            expect(logIntegrationError).toHaveBeenCalledWith(
                'shopify',
                expect.objectContaining({ message: expect.stringContaining('no Shopify location') }),
                expect.objectContaining({ operation: 'setInitialShopifyInventory' }),
            );
        });

        it('surfaces when the created variant has no inventory_item_id (would be sold out)', async () => {
            mockTokenResponse(fetchMock);
            // Product create response omits inventory_item_id on the tracked variant.
            fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ product: { id: 760, variants: [{ id: 860 }] } }) });

            const result = await createShopifySingleVariantProgram('No Inventory Item Program', 3500, 2);

            expect(result?.shopifyVariantId).toBe('860');
            // Bails before locations/set (nothing to set stock on), but surfaces it.
            expect(fetchMock).toHaveBeenCalledTimes(2); // token, product only
            expect(logIntegrationError).toHaveBeenCalledWith(
                'shopify',
                expect.objectContaining({ message: expect.stringContaining('no inventory_item_id') }),
                expect.objectContaining({ operation: 'setInitialShopifyInventory' }),
            );
        });
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
        const result = await mintMemberDiscountCode(1, 'variant-1', 0);
        expect(result).toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('returns a synthesized code on local (mock active), no network', async () => {
        process.env.CHECKIN_ENV = 'local';
        delete process.env.SHOPIFY_STORE_DOMAIN;
        delete process.env.SHOPIFY_CLIENT_ID;
        delete process.env.SHOPIFY_CLIENT_SECRET;

        const result = await mintMemberDiscountCode(42, '999888', 1000);
        expect(result).toMatch(/^PRG42-/);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('creates the discount via GraphQL discountCodeBasicCreate and returns the code', async () => {
        mockTokenResponse(fetchMock);
        fetchMock.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ data: { discountCodeBasicCreate: { codeDiscountNode: { id: 'gid://shopify/DiscountCodeNode/1' }, userErrors: [] } } }),
        });

        const result = await mintMemberDiscountCode(42, '999888', 1000);

        expect(result).toMatch(/^PRG42-/);
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

        const result = await mintMemberDiscountCode(42, '999888', 1000);

        expect(result).toBeNull();
        expect(sendEmail).not.toHaveBeenCalled();
    });

    it('returns null (quiet fallback) when the mutation reports userErrors', async () => {
        mockTokenResponse(fetchMock);
        fetchMock.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ data: { discountCodeBasicCreate: { codeDiscountNode: null, userErrors: [{ field: ['basicCodeDiscount'], message: 'nope' }] } } }),
        });

        const result = await mintMemberDiscountCode(42, '999888', 1000);

        expect(result).toBeNull();
        expect(sendEmail).not.toHaveBeenCalled();
        expect(logIntegrationError).toHaveBeenCalled();
    });

    it('returns null without calling fetch when credentials are missing', async () => {
        delete process.env.SHOPIFY_STORE_DOMAIN;
        delete process.env.SHOPIFY_CLIENT_ID;
        delete process.env.SHOPIFY_CLIENT_SECRET;

        const result = await mintMemberDiscountCode(42, '999888', 1000);
        expect(result).toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
