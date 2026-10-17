/**
 * @jest-environment node
 */
/**
 * Pins the app pool's constructor options. Every one of these regresses
 * silently — nothing throws, no other test goes red: a non-zero `min` or an
 * unbounded idle keeps the shared Aurora cluster from ever auto-pausing, and
 * the missing timeout/keepAlive only ever shows up as a hang.
 *
 * jest.setup.js mocks `@/lib/prisma` for the unit tier, so the real module is
 * pulled in with requireActual. `pg` and the Prisma client are mocked so
 * loading it builds the options object without opening a connection.
 */
// Keeps the consts below out of the global scope tsc gives an import-free test
// file, where they'd collide with same-named consts in other such files.
export {};

const poolCtor = jest.fn();

jest.mock('pg', () => ({
    Pool: jest.fn().mockImplementation((opts: unknown) => {
        poolCtor(opts);
        return { query: jest.fn(), on: jest.fn(), end: jest.fn() };
    }),
}));

jest.mock('@prisma/adapter-pg', () => ({ PrismaPg: jest.fn() }));

jest.mock('@/generated/prisma/client', () => ({
    PrismaClient: jest.fn().mockImplementation(() => ({
        $extends() {
            return this;
        },
    })),
    Prisma: { defineExtension: (ext: unknown) => ext },
}));

let opts: Record<string, unknown>;

beforeAll(() => {
    jest.isolateModules(() => {
        jest.requireActual('@/lib/prisma');
    });
    opts = poolCtor.mock.calls[0][0];
});

describe('app pool options', () => {
    it('holds no idle connections, so the Aurora cluster can auto-pause', () => {
        expect(opts.min).toBe(0);
        expect(opts.idleTimeoutMillis).toBeGreaterThan(0);
        // 0 disables reaping in pg-pool, which reads as "no idle timeout" —
        // the same failure as min > 0, so keep the ceiling explicit.
        expect(opts.idleTimeoutMillis).toBeLessThanOrEqual(60_000);
    });

    it('fails fast instead of hanging when the pool cannot get a connection', () => {
        // pg has NO default here: without it an exhausted or unresponsive
        // server blocks a connection attempt forever, with no error.
        expect(opts.connectionTimeoutMillis).toBeGreaterThan(0);
    });

    it('probes dead peers, so an abandoned lock holder gets reaped', () => {
        // Off by default in pg. A connection whose peer died abruptly while
        // holding pg_advisory_xact_lock looks alive to Postgres forever, and
        // every later query needing that lock hangs.
        expect(opts.keepAlive).toBe(true);
    });
});
