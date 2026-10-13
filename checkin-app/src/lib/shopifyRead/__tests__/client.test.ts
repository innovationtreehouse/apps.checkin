/**
 * @jest-environment node
 */
/**
 * Unit tests for the mirror client. The s-ingest-core Prisma client, its pg adapter
 * and `pg` are mocked — this covers the wiring the reconciler's integration tests
 * don't: that an unconfigured env never opens a pool, that the pool keeps the
 * scale-to-zero settings, and that every read keeps its filters (no test orders,
 * no removed lines) and its result shape.
 *
 * The client caches its pool and Prisma client in module-level singletons, so each
 * case re-imports the module under jest.isolateModules to get fresh ones.
 */
const queryMock = jest.fn();
const poolCtor = jest.fn();
const adapterCtor = jest.fn();
const prismaCtor = jest.fn();

const db = {
    shopOrder: { findMany: jest.fn() },
    shopOrderLine: { findMany: jest.fn() },
    shopBalanceTransaction: { findMany: jest.fn() },
    syncRun: { findFirst: jest.fn() },
    $queryRaw: jest.fn(),
};

jest.mock('pg', () => ({
    Pool: jest.fn().mockImplementation((opts: unknown) => {
        poolCtor(opts);
        return { query: queryMock, on: jest.fn() };
    }),
}));
jest.mock('@prisma/adapter-pg', () => ({
    PrismaPg: jest.fn().mockImplementation((pool: unknown) => {
        adapterCtor(pool);
        return { pool };
    }),
}));
jest.mock('@inventory/s-ingest-core/client', () => ({
    PrismaClient: jest.fn().mockImplementation((opts: unknown) => {
        prismaCtor(opts);
        return db;
    }),
}));

type Client = typeof import('../client');

/** Load a fresh copy of the client against the current process.env. */
function freshClient(): Client {
    let mod!: Client;
    jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        mod = require('../client');
    });
    return mod;
}

// The app's OWN credential pointed at the mirror's database — there is no mirror
// credential. Set through the SHOPIFY_READ_DATABASE_URL override; the
// DATABASE_URL + SHOPIFY_READ_DB derivation has its own tests in config.test.ts.
const MIRROR_URL = 'postgresql://checkin_dev_dml:pw@host:5432/shopify_read_dev';

// Both inputs of the resolved url. SHOPIFY_READ_DB must be cleared too, or an ambient
// value derives a url and the "unwired" cases below can never actually be unwired.
const MIRROR_KEYS = ['SHOPIFY_READ_DATABASE_URL', 'SHOPIFY_READ_DB'] as const;
const prev: Record<string, string | undefined> = {};
for (const k of MIRROR_KEYS) prev[k] = process.env[k];

beforeEach(() => {
    jest.clearAllMocks();
    for (const k of MIRROR_KEYS) delete process.env[k];
    process.env.SHOPIFY_READ_DATABASE_URL = MIRROR_URL;
    db.shopOrder.findMany.mockResolvedValue([]);
    db.shopOrderLine.findMany.mockResolvedValue([]);
    db.shopBalanceTransaction.findMany.mockResolvedValue([]);
    db.syncRun.findFirst.mockResolvedValue(null);
});

afterAll(() => {
    for (const k of MIRROR_KEYS) {
        if (prev[k] === undefined) delete process.env[k];
        else process.env[k] = prev[k];
    }
});

const whereOf = (mock: jest.Mock, call = 0) => mock.mock.calls[call][0].where;

describe('wiring', () => {
    it('opens nothing when the mirror is unwired', async () => {
        delete process.env.SHOPIFY_READ_DATABASE_URL;
        const client = freshClient();

        expect(client.isConfigured()).toBe(false);
        expect(await client.latestSyncRun()).toBeNull();
        expect(await client.ordersChangedSince(null)).toEqual([]);
        expect(await client.ordersByLegacyIds(['123'])).toEqual([]);
        expect(await client.minRealOrderLegacyId()).toBeNull();
        await expect(client.countSyncRuns()).rejects.toThrow(/not configured/);
        await expect(client.lineVariantStats()).rejects.toThrow(/not configured/);
        // The load-bearing half: an env with no mirror must not connect to anything.
        expect(poolCtor).not.toHaveBeenCalled();
        expect(prismaCtor).not.toHaveBeenCalled();
    });

    it('honours the scale-to-zero pool invariant and names the session', async () => {
        await freshClient().latestSyncRun();

        // min 0 + a fast idle reap is what lets the shared Aurora cluster auto-pause;
        // a pool that holds a connection open would keep it awake forever (PR #1030).
        expect(poolCtor).toHaveBeenCalledTimes(1);
        expect(poolCtor.mock.calls[0][0]).toMatchObject({
            connectionString: MIRROR_URL,
            min: 0,
            max: 3,
            idleTimeoutMillis: 10_000,
            application_name: 'checkin-shopify-read',
        });
    });

    it('builds the Prisma client on that pool, once', async () => {
        const client = freshClient();
        await client.latestSyncRun();
        await client.ordersByLegacyIds(['1']);

        expect(prismaCtor).toHaveBeenCalledTimes(1);
        expect(adapterCtor.mock.calls[0][0]).toEqual(expect.objectContaining({ query: queryMock }));
        expect(prismaCtor.mock.calls[0][0]).toEqual({ adapter: { pool: adapterCtor.mock.calls[0][0] } });
    });
});

describe('latestSyncRun', () => {
    it('reads one run, newest first', async () => {
        const run = {
            status: 'COMPLETED',
            kind: 'INCREMENTAL',
            startedAt: new Date('2026-07-16T09:00:00Z'),
            finishedAt: new Date('2026-07-16T09:02:00Z'),
            counts: { orders: 12 },
            error: null,
        };
        db.syncRun.findFirst.mockResolvedValue(run);

        expect(await freshClient().latestSyncRun()).toEqual(run);
        expect(db.syncRun.findFirst.mock.calls[0][0].orderBy).toEqual({ startedAt: 'desc' });
    });
});

describe('countSyncRuns (the diagnose route\'s probe)', () => {
    it('returns the run count from the pool', async () => {
        queryMock.mockResolvedValue({ rows: [{ runs: 3 }] });
        expect(await freshClient().countSyncRuns()).toBe(3);
        expect(queryMock.mock.calls[0][0]).toContain('FROM sync_run');
    });

    it('lets pg errors escape untouched — the caller owns the code→verdict mapping', async () => {
        const err = Object.assign(new Error('permission denied for table sync_run'), { code: '42501' });
        queryMock.mockRejectedValue(err);
        await expect(freshClient().countSyncRuns()).rejects.toBe(err);
    });
});

describe('order reads', () => {
    const row = {
        shopifyGid: 'gid://shopify/Order/1',
        legacyId: '1',
        customerEmail: 'a@example.com',
        financialStatus: 'PAID',
        totalCents: 100,
        subtotalCents: 100,
        totalRefundedCents: 0,
        discountCents: 0,
        discountCodes: [],
        cancelledAt: null,
        updatedAt: new Date('2026-07-01T00:00:00Z'),
        noteAttributes: [{ key: 'Program_ID', value: '7' }, { key: 'Odd', value: 5 }, 'junk'],
    };

    it('maps a row to MirrorOrder and keeps well-formed cart attributes', async () => {
        db.shopOrder.findMany.mockResolvedValue([row]);
        const [o] = await freshClient().ordersByLegacyIds(['1']);

        expect(o.orderGid).toBe('gid://shopify/Order/1');
        expect(o).not.toHaveProperty('shopifyGid');
        expect(o.noteAttributes).toEqual([{ key: 'Program_ID', value: '7' }, { key: 'Odd', value: null }]);
        expect(freshClient().orderAttr(o, 'Program_ID')).toBe('7');
    });

    it('a null note_attributes stays null', async () => {
        db.shopOrder.findMany.mockResolvedValue([{ ...row, noteAttributes: null }]);
        expect((await freshClient().ordersByLegacyIds(['1']))[0].noteAttributes).toBeNull();
    });

    it('ordersChangedSince skips test orders and reads oldest-first past the cursor', async () => {
        const since = new Date('2026-07-01T00:00:00Z');
        await freshClient().ordersChangedSince(since, 50);
        const args = db.shopOrder.findMany.mock.calls[0][0];

        expect(args.where).toEqual({ test: false, updatedAt: { gt: since } });
        expect(args.orderBy).toEqual({ updatedAt: { sort: 'asc', nulls: 'first' } });
        expect(args.take).toBe(50);
    });

    it('ordersChangedSince(null) reads from the beginning', async () => {
        await freshClient().ordersChangedSince(null);
        expect(whereOf(db.shopOrder.findMany)).toEqual({ test: false });
    });

    it('ordersByLegacyIds ignores test orders and short-circuits an empty list', async () => {
        const client = freshClient();
        expect(await client.ordersByLegacyIds([])).toEqual([]);
        expect(db.shopOrder.findMany).not.toHaveBeenCalled();

        await client.ordersByLegacyIds(['123']);
        expect(whereOf(db.shopOrder.findMany)).toEqual({ test: false, legacyId: { in: ['123'] } });
    });

    it('orderLines drops removed and variant-less lines', async () => {
        db.shopOrderLine.findMany.mockResolvedValue([{ variantLegacyId: '9', quantity: 2 }]);
        expect(await freshClient().orderLines('gid://shopify/Order/1')).toEqual([{ variantId: '9', quantity: 2 }]);
        expect(whereOf(db.shopOrderLine.findMany)).toEqual({ orderGid: 'gid://shopify/Order/1', variantLegacyId: { not: null }, removed: false });
    });

    it('orderLineVariantIds reads distinct non-null variants', async () => {
        db.shopOrderLine.findMany.mockResolvedValue([{ variantLegacyId: '9' }, { variantLegacyId: '8' }]);
        expect(await freshClient().orderLineVariantIds('g')).toEqual(['9', '8']);
        expect(db.shopOrderLine.findMany.mock.calls[0][0].distinct).toEqual(['variantLegacyId']);
    });

    it('disputedOrderGids counts disputes on real orders only', async () => {
        db.shopBalanceTransaction.findMany.mockResolvedValue([{ orderGid: 'g1' }, { orderGid: 'g2' }]);
        db.shopOrder.findMany.mockResolvedValue([{ shopifyGid: 'g1' }]);

        expect(await freshClient().disputedOrderGids(['g1', 'g2', 'g3'])).toEqual(new Set(['g1']));
        expect(whereOf(db.shopBalanceTransaction.findMany).OR).toEqual([
            { type: { contains: 'dispute', mode: 'insensitive' } },
            { type: { contains: 'chargeback', mode: 'insensitive' } },
        ]);
        expect(whereOf(db.shopOrder.findMany)).toEqual({ test: false, shopifyGid: { in: ['g1', 'g2'] } });
    });
});

describe('match-audit reads', () => {
    it('ordersForVariants joins live lines to real orders and lists the matched variants', async () => {
        db.shopOrderLine.findMany.mockResolvedValue([
            { orderGid: 'g1', variantLegacyId: '222' },
            { orderGid: 'g1', variantLegacyId: '111' },
            { orderGid: 'g2', variantLegacyId: '111' },
        ]);
        db.shopOrder.findMany.mockResolvedValue([{ shopifyGid: 'g1', legacyId: '1', name: '#1', discountCodes: [] }]);

        expect(await freshClient().ordersForVariants(['111', '222'])).toEqual([
            { legacyId: '1', name: '#1', discountCodes: [], matchedVariantIds: ['111', '222'] },
        ]);
        expect(whereOf(db.shopOrderLine.findMany)).toEqual({ removed: false, variantLegacyId: { in: ['111', '222'] } });
        const orderArgs = db.shopOrder.findMany.mock.calls[0][0];
        expect(orderArgs.where).toEqual({ test: false, shopifyGid: { in: ['g1', 'g2'] } });
        expect(orderArgs.orderBy).toEqual({ legacyId: { sort: 'asc', nulls: 'last' } });
        expect(orderArgs.select.discountCodes).toBe(true);
    });

    it('ordersForVariants short-circuits on an empty variant set without querying', async () => {
        expect(await freshClient().ordersForVariants([])).toEqual([]);
        expect(db.shopOrderLine.findMany).not.toHaveBeenCalled();
    });

    it('lineVariantStats counts only live lines of real (non-test) orders', async () => {
        db.$queryRaw.mockResolvedValue([{ lines: 5, withVariant: 2 }]);
        expect(await freshClient().lineVariantStats()).toEqual({ lines: 5, withVariant: 2 });
        const sql = (db.$queryRaw.mock.calls[0][0] as string[]).join('?').replace(/\s+/g, ' ');
        // Same test-order rule as ordersForVariants: test lines must not count as
        // variant coverage, or they'd mask an unbackfilled real mirror.
        expect(sql).toContain('JOIN shop_order');
        expect(sql).toContain('l.removed = false AND o.test = false');
    });

    it('orderLegacyIdsPresent returns the found ids as a set, ignoring test orders', async () => {
        db.shopOrder.findMany.mockResolvedValue([{ legacyId: '900' }]);
        expect(await freshClient().orderLegacyIdsPresent(['900', '901'])).toEqual(new Set(['900']));
        expect(whereOf(db.shopOrder.findMany)).toEqual({ test: false, legacyId: { in: ['900', '901'] } });
    });

    it('minRealOrderLegacyId returns the mirror low-water mark', async () => {
        db.$queryRaw.mockResolvedValue([{ minLegacyId: '4200' }]);
        expect(await freshClient().minRealOrderLegacyId()).toBe(BigInt(4200));
        const sql = (db.$queryRaw.mock.calls[0][0] as string[]).join('?');
        expect(sql).toContain('min(legacy_id::bigint)');
        expect(sql).toContain('test = false');
        // Guards the ::bigint cast against a non-numeric legacy_id, which would
        // otherwise throw for the whole aggregate and 500 the audit.
        expect(sql).toContain(`legacy_id ~ '^[0-9]+$'`);
    });

    it('minRealOrderLegacyId returns null for an empty mirror', async () => {
        db.$queryRaw.mockResolvedValue([{ minLegacyId: null }]);
        expect(await freshClient().minRealOrderLegacyId()).toBeNull();
    });
});
