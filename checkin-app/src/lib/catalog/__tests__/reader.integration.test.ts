/**
 * @jest-environment node
 */
/**
 * X3 binding: the host's catalog reader, bound by each consumer's configureRuntime(),
 * reading a real global-catalog database migrated from its committed migrations. The
 * last tests point the catalog at a missing database to show the display reads fall
 * back and the reference check fails closed.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { getPrisma as getCatalogPrisma } from '@inventory/global-catalog';
import { getExpenseRuntime } from '@inventory/expense';
import { ports } from '@inventory/workflow-mapping';
import { configureRuntime as configureExpenseRuntime } from '@/lib/expense/configure';
import { configureRuntime as configureWorkflowRuntime } from '@/lib/workflowMapping/configure';

const { adminClient, withDb } = jest.requireActual<{
    adminClient: (base: string) => import('pg').Client;
    withDb: (base: string, db: string) => string;
}>('../../../../test/integrationDb');

const GTIN = '0022222222223';
const runTag = `${process.env.TEST_RUN_ID ?? process.pid}_${process.env.JEST_WORKER_ID ?? '1'}`;
const DB = `gc_x3_${runTag}`;
const base = process.env.TEST_BASE_URL ?? process.env.DATABASE_URL ?? '';

function prismaBin(): string {
    const req = createRequire(resolve(__dirname, '../../../../package.json'));
    const pkg = req('prisma/package.json') as { bin: string | Record<string, string> };
    const rel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin.prisma;
    return resolve(dirname(req.resolve('prisma/package.json')), rel);
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

let catalog: ReturnType<typeof getCatalogPrisma>;
let categoryId: number;
let subcategoryId: number;

beforeAll(async () => {
    await admin(async (c) => {
        await c.query(`DROP DATABASE IF EXISTS "${DB}" WITH (FORCE)`);
        await c.query(`CREATE DATABASE "${DB}"`);
    });
    process.env.CATALOG_DATABASE_URL = withDb(base, DB);
    execFileSync(process.execPath, [prismaBin(), 'migrate', 'deploy'], {
        cwd: resolve(__dirname, '../../../../../packages/global-catalog'),
        env: process.env,
        stdio: 'pipe',
    });
    catalog = getCatalogPrisma();

    const category = await catalog.category.create({ data: { name: 'Fasteners', letter: 'F' } });
    const subcategory = await catalog.subcategory.create({ data: { name: 'Bolts', number: 1, categoryId: category.id } });
    categoryId = category.id;
    subcategoryId = subcategory.id;
    await catalog.item.create({
        data: { gtin13: GTIN, name: 'Hex bolt', categoryId, subcategoryId, sequence: 1, usageBehavior: 'consumable' },
    });
    await catalog.itemReference.create({
        data: { gtin13: GTIN, partNumber: 'HB-1', manufacturer: 'Acme', retailer: 'Hardware Co', conversionFactor: 4 },
    });

    configureExpenseRuntime();
    configureWorkflowRuntime();
}, 120_000);

// DROP DATABASE waits on a forced checkpoint, which can outlast the default hook timeout.
afterAll(async () => {
    await catalog?.$disconnect();
    await admin((c) => c.query(`DROP DATABASE IF EXISTS "${DB}" WITH (FORCE)`));
}, 60_000);

describe('expense CatalogReader bound to the catalog', () => {
    it('reads categories, subcategories, an item and a lookup', async () => {
        const reader = getExpenseRuntime().catalog;
        expect(await reader.listCategories()).toEqual([{ id: categoryId, name: 'Fasteners', letter: 'F' }]);
        expect(await reader.listSubcategories()).toEqual([{ id: subcategoryId, name: 'Bolts', number: 1, categoryId }]);
        expect(await reader.getItem(GTIN)).toEqual({ gtin13: GTIN, categoryId, subcategoryId });
        expect(await reader.getItem('0000000000000')).toBeNull();
        expect(await reader.lookupItems('Hardware Co', [{ index: 0, partNumber: 'HB-1', manufacturer: 'Acme' }])).toEqual([
            expect.objectContaining({ index: 0, gtin13: GTIN, conversionFactor: 4 }),
        ]);
    });
});

describe('workflow-mapping CatalogReader bound to the catalog', () => {
    it('looks up items and checks references', async () => {
        const reader = ports().catalogReader;
        expect(await reader.lookupItems('Hardware Co', [{ index: 3, partNumber: 'HB-1', manufacturer: null }])).toEqual([
            expect.objectContaining({ index: 3, gtin13: GTIN }),
        ]);
        const refs = await reader.checkReferences({ retailer: 'Hardware Co', partNumber: 'HB-1', manufacturer: 'Acme' });
        expect(refs.mfr_part).toEqual(expect.objectContaining({ exists: true, gtin13: GTIN }));
        expect(refs.retailer_part.exists).toBe(true);
        expect(refs.wouldCreateNewReference).toBe(false);
    });
});

describe('catalog database down', () => {
    // The catalog client is a lazy global singleton: clear it so the next read builds one
    // against a database that does not exist.
    beforeAll(() => {
        globalThis.__gcPrisma = undefined;
        process.env.CATALOG_DATABASE_URL = withDb(base, `${DB}_missing`);
    });

    it('display reads return the inert result', async () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        const reader = getExpenseRuntime().catalog;
        expect(await reader.listCategories()).toEqual([]);
        expect(await reader.listSubcategories()).toEqual([]);
        expect(await reader.getItem(GTIN)).toBeNull();
        expect(await ports().catalogReader.lookupItems('Hardware Co', [{ index: 0, partNumber: 'HB-1' }])).toEqual([]);
        expect(warn).toHaveBeenCalledTimes(4);
        warn.mockRestore();
    });

    it('the reference check fails closed', async () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        await expect(
            ports().catalogReader.checkReferences({ retailer: 'Hardware Co', partNumber: 'HB-1', manufacturer: 'Acme' }),
        ).rejects.toThrow();
        warn.mockRestore();
    });
});
