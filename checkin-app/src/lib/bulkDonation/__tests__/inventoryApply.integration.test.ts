/**
 * @jest-environment node
 */
/**
 * X11 binding: bulk-donation's no-receipt in-kind entry driven into the real
 * local-inventory apply, each library on its own throwaway database migrated
 * from its committed migrations.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import {
    configureBulkDonation,
    getPrisma as getDonationPrisma,
    loadInKindInventory,
    recordInKindWithoutReceipt,
} from '@inventory/bulk-donation';
import { getPrisma as getInventoryPrisma } from '@inventory/local-inventory';
import { createLocalInventoryApply } from '../inventoryApply';

// The integration global setup's database helpers (CommonJS, untyped).
const { adminClient, withDb } = jest.requireActual<{
    adminClient: (base: string) => import('pg').Client;
    withDb: (base: string, db: string) => string;
}>('../../../../test/integrationDb');

const ORG = { id: 'treehouse', name: 'Treehouse' };
const GTIN = '0011111111116';
const runTag = `${process.env.TEST_RUN_ID ?? process.pid}_${process.env.JEST_WORKER_ID ?? '1'}`;
const DBS = { bd: `bd_x11_${runTag}`, li: `li_x11_${runTag}` };
const base = process.env.TEST_BASE_URL ?? process.env.DATABASE_URL ?? '';

function prismaBin(): string {
    const req = createRequire(resolve(__dirname, '../../../../package.json'));
    const pkg = req('prisma/package.json') as { bin: string | Record<string, string> };
    const rel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin.prisma;
    return resolve(dirname(req.resolve('prisma/package.json')), rel);
}

function migrate(pkgDir: string, envVar: string, url: string): void {
    execFileSync(process.execPath, [prismaBin(), 'migrate', 'deploy'], {
        cwd: resolve(__dirname, '../../../../../packages', pkgDir),
        env: { ...process.env, [envVar]: url },
        stdio: 'pipe',
    });
}

async function admin<T>(fn: (c: import('pg').Client) => Promise<T>): Promise<T> {
    const c = adminClient(base);
    await c.connect();
    try {
        return await fn(c);
    } finally {
        await c.end();
    }
}

let bd: ReturnType<typeof getDonationPrisma>;
let li: ReturnType<typeof getInventoryPrisma>;

beforeAll(async () => {
    await admin(async (c) => {
        for (const db of Object.values(DBS)) {
            await c.query(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`);
            await c.query(`CREATE DATABASE "${db}"`);
        }
    });
    process.env.BULK_DONATION_DATABASE_URL = withDb(base, DBS.bd);
    process.env.LOCAL_INVENTORY_DATABASE_URL = withDb(base, DBS.li);
    migrate('bulk-donation', 'BULK_DONATION_DATABASE_URL', process.env.BULK_DONATION_DATABASE_URL);
    migrate('local-inventory', 'LOCAL_INVENTORY_DATABASE_URL', process.env.LOCAL_INVENTORY_DATABASE_URL);
    bd = getDonationPrisma();
    li = getInventoryPrisma();

    configureBulkDonation({
        auth: { getPrincipal: async () => ({ id: 1, name: 'Ops' }) },
        org: async () => ORG,
        catalog: { search: async () => [], getItem: async (gtin13) => ({ gtin13, name: 'Cordless Drill' }) },
        inventory: createLocalInventoryApply(async () => ORG),
    });
}, 120_000);

afterAll(async () => {
    await bd?.$disconnect();
    await li?.$disconnect();
    await admin(async (c) => {
        for (const db of Object.values(DBS)) await c.query(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`);
    });
}, 60_000);

const stock = async () =>
    (await li.orgItem.findUnique({ where: { orgGtin: { orgId: ORG.id, gtin13: GTIN } } }))?.existingQuantity ?? 0;

const donation = {
    donor: { firstName: 'Jane', lastName: 'Donor', companyName: null },
    donationDate: '2026-10-01',
    lines: [{ gtin13: GTIN, quantity: 3, valueCents: 4500 }],
};

describe('X11 InventoryApply → local-inventory apply', () => {
    it('loads a no-receipt donation once, keyed donation:<id>, and a repeat load is a replay', async () => {
        const before = await stock();

        const { id, inventoryLoaded } = await recordInKindWithoutReceipt(donation);

        expect(inventoryLoaded).toBe(true);
        expect(await stock()).toBe(before + 3);
        expect(await li.receivedInventoryDelta.findMany({ where: { orgId: ORG.id, sourceKey: `donation:${id}` } }))
            .toEqual([expect.objectContaining({ status: 'applied', receiptId: null })]);
        expect((await bd.manualInKindDonation.findUniqueOrThrow({ where: { id } })).inventoryLoadedAt).not.toBeNull();

        await loadInKindInventory(id);
        expect(await stock()).toBe(before + 3);
    });
});
