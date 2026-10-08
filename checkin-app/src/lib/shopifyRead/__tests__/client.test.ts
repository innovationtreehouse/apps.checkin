/**
 * @jest-environment node
 */
/**
 * Unit tests for the mirror client's sync-status read. `pg` is mocked — this covers
 * the wiring the reconciler's integration tests don't: that an unconfigured env never
 * opens a pool at all, and that the read is a single newest-first row.
 *
 * The order reads below are guarded the same way, and for the same reason: both pin
 * the shape of the SQL rather than a round-tripped Date, because the round trip
 * passes either way under TZ=UTC (which is what CI and the deployed tasks both run).
 *
 * The client caches its Pool in a module-level singleton, so each case re-imports the
 * module under jest.isolateModules to get a fresh one.
 */
const queryMock = jest.fn();
const poolCtor = jest.fn();

jest.mock('pg', () => ({
    Pool: jest.fn().mockImplementation((...args: unknown[]) => {
        poolCtor(...args);
        return { query: queryMock, on: jest.fn() };
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
// credential (its SELECT grant reaches checkin's DML role via NOLOGIN-grant-holder
// membership). Set through the SHOPIFY_READ_DATABASE_URL override rather than the
// DATABASE_URL + SHOPIFY_READ_DB derivation: this file tests the client, and
// config.shopifyReadDatabaseUrl()'s derivation has its own tests in config.test.ts.
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
});

afterAll(() => {
    for (const k of MIRROR_KEYS) {
        if (prev[k] === undefined) delete process.env[k];
        else process.env[k] = prev[k];
    }
});

describe('latestSyncRun', () => {
    it('returns null without opening a pool when the mirror is unwired', async () => {
        delete process.env.SHOPIFY_READ_DATABASE_URL;
        const client = freshClient();

        expect(client.isConfigured()).toBe(false);
        expect(await client.latestSyncRun()).toBeNull();
        // The load-bearing half: an env with no mirror must not connect to anything.
        expect(poolCtor).not.toHaveBeenCalled();
        expect(queryMock).not.toHaveBeenCalled();
    });

    it('returns the most recent run', async () => {
        const row = {
            status: 'COMPLETED',
            kind: 'INCREMENTAL',
            startedAt: new Date('2026-07-16T09:00:00Z'),
            finishedAt: new Date('2026-07-16T09:02:00Z'),
            counts: { orders: 12 },
            error: null,
        };
        queryMock.mockResolvedValue({ rows: [row] });

        expect(await freshClient().latestSyncRun()).toEqual(row);
    });

    it('returns null when the mirror has never run a sync', async () => {
        queryMock.mockResolvedValue({ rows: [] });
        expect(await freshClient().latestSyncRun()).toBeNull();
    });

    it('reads exactly one row, newest first', async () => {
        queryMock.mockResolvedValue({ rows: [] });
        await freshClient().latestSyncRun();

        const sql = queryMock.mock.calls[0][0].replace(/\s+/g, ' ');
        expect(sql).toContain('FROM sync_run');
        expect(sql).toContain('ORDER BY started_at DESC');
        expect(sql).toContain('LIMIT 1');
    });

    it("pins both timestamps to UTC", async () => {
        queryMock.mockResolvedValue({ rows: [] });
        await freshClient().latestSyncRun();

        // s-read's columns are `timestamp WITHOUT time zone` holding UTC, and node-pg
        // resolves those against the Node process's zone — drop these casts and a
        // non-UTC container reports a 12-minute-old sync as "just now" (a future
        // instant makes the age negative). Caught by driving the real page on a
        // Chicago-zoned laptop; nothing else fails if this regresses.
        const sql = queryMock.mock.calls[0][0].replace(/\s+/g, ' ');
        expect(sql).toContain(`started_at AT TIME ZONE 'UTC'`);
        expect(sql).toContain(`finished_at AT TIME ZONE 'UTC'`);
    });

    it('honours the scale-to-zero pool invariant', async () => {
        queryMock.mockResolvedValue({ rows: [] });
        await freshClient().latestSyncRun();

        // min 0 + a finite idle reap is what lets the shared Aurora cluster auto-pause;
        // a pool that holds a connection open would keep it awake forever (PR #1030).
        const opts = poolCtor.mock.calls[0][0];
        expect(opts.min).toBe(0);
        expect(opts.idleTimeoutMillis).toBeGreaterThan(0);
    });
});

/** The SQL of the Nth query, whitespace-collapsed so indentation doesn't matter. */
const sqlOf = (call: number) => (queryMock.mock.calls[call][0] as string).replace(/\s+/g, ' ');

describe('match-audit reads', () => {
    it('ordersForVariants filters to non-test orders with a live line in the requested variant set', async () => {
        queryMock.mockResolvedValue({ rows: [] });
        await freshClient().ordersForVariants(['111', '222']);

        const sql = sqlOf(0);
        expect(sql).toContain('test = false');
        expect(sql).toContain('removed = false');
        expect(sql).toContain(`variant_legacy_id = ANY($1::text[])`);
        expect(queryMock.mock.calls[0][1]).toEqual([['111', '222']]);
    });

    it('ordersForVariants projects discount_codes', async () => {
        queryMock.mockResolvedValue({ rows: [] });
        await freshClient().ordersForVariants(['111']);
        expect(sqlOf(0)).toContain('discount_codes AS "discountCodes"');
    });

    it('ordersForVariants short-circuits on an empty variant set without querying', async () => {
        expect(await freshClient().ordersForVariants([])).toEqual([]);
        expect(queryMock).not.toHaveBeenCalled();
    });

    it('lineVariantStats counts only live lines of real (non-test) orders', async () => {
        queryMock.mockResolvedValue({ rows: [{ lines: 5, withVariant: 2 }] });
        expect(await freshClient().lineVariantStats()).toEqual({ lines: 5, withVariant: 2 });
        expect(sqlOf(0)).toContain('removed = false');
        // Same test-order rule as ordersForVariants: test lines must not count as
        // variant coverage, or they'd mask an unbackfilled real mirror.
        expect(sqlOf(0)).toContain('test = false');
        expect(sqlOf(0)).toContain('JOIN shop_order');
    });

    it('orderLegacyIdsPresent returns the found ids as a set, ignoring test orders', async () => {
        queryMock.mockResolvedValue({ rows: [{ legacyId: '900' }] });
        expect(await freshClient().orderLegacyIdsPresent(['900', '901'])).toEqual(new Set(['900']));
        // A test-mode order must not serve as an activation's payment basis.
        expect(sqlOf(0)).toContain('test = false');
    });

    it('minRealOrderLegacyId returns the mirror low-water mark', async () => {
        queryMock.mockResolvedValue({ rows: [{ minLegacyId: '4200' }] });
        expect(await freshClient().minRealOrderLegacyId()).toBe(BigInt(4200));
        expect(sqlOf(0)).toContain('min(legacy_id::bigint)');
        expect(sqlOf(0)).toContain('test = false');
        // Guards the ::bigint cast against a non-numeric legacy_id, which would
        // otherwise throw for the whole aggregate and 500 the audit.
        expect(sqlOf(0)).toContain(`legacy_id ~ '^\\d+$'`);
    });

    it('minRealOrderLegacyId returns null for an empty mirror', async () => {
        queryMock.mockResolvedValue({ rows: [{ minLegacyId: null }] });
        expect(await freshClient().minRealOrderLegacyId()).toBeNull();
    });

    it('minRealOrderLegacyId returns null without opening a pool when unwired', async () => {
        delete process.env.SHOPIFY_READ_DATABASE_URL;
        expect(await freshClient().minRealOrderLegacyId()).toBeNull();
        expect(poolCtor).not.toHaveBeenCalled();
    });
});

describe('countSyncRuns (the diagnose route\'s probe)', () => {
    it('returns the run count', async () => {
        queryMock.mockResolvedValue({ rows: [{ runs: 3 }] });
        expect(await freshClient().countSyncRuns()).toBe(3);
        expect(sqlOf(0)).toContain('FROM sync_run');
    });

    it('throws when unconfigured rather than opening a pool', async () => {
        delete process.env.SHOPIFY_READ_DATABASE_URL;
        await expect(freshClient().countSyncRuns()).rejects.toThrow(/not configured/);
        expect(poolCtor).not.toHaveBeenCalled();
    });

    it('lets pg errors escape untouched — the caller owns the code→verdict mapping', async () => {
        const err = Object.assign(new Error('permission denied for table sync_run'), { code: '42501' });
        queryMock.mockRejectedValue(err);
        await expect(freshClient().countSyncRuns()).rejects.toBe(err);
    });
});

describe('order reads', () => {
    // s-read's columns are `timestamp WITHOUT time zone` holding UTC, and node-pg
    // resolves those against the Node process's zone — drop these casts and a non-UTC
    // container reads every mirror timestamp at an offset. Deployed tasks set no TZ
    // (so the container is UTC and the naive read is accidentally right), which is
    // exactly why nothing else fails if this regresses.
    it('ordersChangedSince pins both timestamps to UTC', async () => {
        queryMock.mockResolvedValue({ rows: [] });
        await freshClient().ordersChangedSince(new Date('2026-07-01T00:00:00Z'));
        const sql = sqlOf(0);

        expect(sql).toContain(`cancelled_at AT TIME ZONE 'UTC' AS "cancelledAt"`);
        expect(sql).toContain(`updated_at AT TIME ZONE 'UTC' AS "updatedAt"`);
    });

    it('ordersChangedSince casts the cursor param, not the column', async () => {
        queryMock.mockResolvedValue({ rows: [] });
        await freshClient().ordersChangedSince(new Date('2026-07-01T00:00:00Z'));
        const sql = sqlOf(0);

        // The WHERE must move with the projection: this is the reconciler's high-water
        // cursor (reconcile.ts reads updatedAt, stores it, feeds it back as `since`),
        // so casting one side only would shift it by the offset. Naive column vs a
        // timestamptz param would ALSO resolve against the session TimeZone — a second
        // offset, unrelated to node's.
        expect(sql).toContain(`updated_at > ($1::timestamptz AT TIME ZONE 'UTC')`);
        // Param-side cast keeps the comparison sargable for any future index.
        expect(sql).not.toMatch(/updated_at AT TIME ZONE 'UTC'\s*>/);
    });

    it('ordersByLegacyIds pins both timestamps to UTC', async () => {
        queryMock.mockResolvedValue({ rows: [] });
        await freshClient().ordersByLegacyIds(['123']);
        const sql = sqlOf(0);

        expect(sql).toContain(`cancelled_at AT TIME ZONE 'UTC' AS "cancelledAt"`);
        expect(sql).toContain(`updated_at AT TIME ZONE 'UTC' AS "updatedAt"`);
    });

    it('ordersByLegacyIds ignores test orders', async () => {
        queryMock.mockResolvedValue({ rows: [] });
        await freshClient().ordersByLegacyIds(['123']);
        expect(sqlOf(0)).toContain('test = false');
    });

    it('disputedOrderGids counts disputes on real orders only', async () => {
        queryMock.mockResolvedValue({ rows: [{ orderGid: 'gid://shopify/Order/1' }] });
        expect(await freshClient().disputedOrderGids(['gid://shopify/Order/1'])).toEqual(
            new Set(['gid://shopify/Order/1']),
        );
        expect(sqlOf(0)).toContain('JOIN shop_order o');
        expect(sqlOf(0)).toContain('o.test = false');
    });

    it('neither read opens a pool when the mirror is unwired', async () => {
        delete process.env.SHOPIFY_READ_DATABASE_URL;
        const client = freshClient();

        expect(await client.ordersChangedSince(null)).toEqual([]);
        expect(await client.ordersByLegacyIds(['123'])).toEqual([]);
        expect(poolCtor).not.toHaveBeenCalled();
        expect(queryMock).not.toHaveBeenCalled();
    });
});
