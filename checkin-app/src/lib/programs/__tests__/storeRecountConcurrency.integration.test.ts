/**
 * @jest-environment node
 */
/**
 * The turn-off re-count reads Shopify only once it holds the Program row lock, so
 * a stock write that lands while it waits (the switch's zero, a store sale) is
 * in what it counts from. Real Postgres, CHECKIN_ENV=local Shopify stock mock.
 */
import { backendPid, waitersBehind } from '@checkin/pg-test-harness/lockGate';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@/generated/prisma/client';
import prisma from '@/lib/prisma';
import { localMockStock, setProgramInventory } from '@/lib/shopify/stock';

const TAG = 'Store Recount Concurrency Test';

// The lock holder and the re-count take both of the app pool's connections, so the gate polls on its own.
const observer = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

let prevEnv: string | undefined;
let logSpy: jest.SpyInstance;

beforeAll(() => {
    prevEnv = process.env.CHECKIN_ENV;
    process.env.CHECKIN_ENV = 'local';
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterAll(async () => {
    await prisma.program.deleteMany({ where: { name: TAG } });
    await observer.$disconnect();
    logSpy.mockRestore();
    process.env.CHECKIN_ENV = prevEnv;
});

describe('store re-count under the Program row lock', () => {
    it('the re-count reads stock only once it holds the Program row lock, so a write landing before it is counted', async () => {
        const program = await prisma.program.create({
            data: { appliesToYear: 2099, name: TAG, startAt: new Date('2099-01-01'), endAt: new Date('2099-12-31'), offSaleAt: new Date('2098-01-01'), maxParticipants: 5, nonOrgMemberPriceCents: 1500, shopifyVariantId: `var-${TAG}-${Date.now()}` },
        });
        await setProgramInventory(program, async () => 3, 'initial-stock');

        let release!: () => void;
        const released = new Promise<void>((r) => (release = r));
        let locked!: (pid: number) => void;
        const held = new Promise<number>((r) => (locked = r));
        const holder = prisma.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT id FROM "Program" WHERE id = ${program.id} FOR UPDATE`;
            locked(await backendPid(tx));
            await released;
        }, { timeout: 15_000 });
        const holderPid = await held;

        const recount = setProgramInventory(program, async () => 3, 'store-reopened');
        try {
            await waitersBehind(observer, holderPid);
            localMockStock.set(program.shopifyVariantId!, 1); // the switch's zero, or store sales, land first
        } finally {
            release();
            await holder;
        }

        expect(await recount).toBe(true);
        expect(localMockStock.get(program.shopifyVariantId!)).toBe(3);
    });
});
