/**
 * @jest-environment node
 */
/**
 * X4 binding (#1289 §8c): workflow-mapping's InventorySink driven into the real
 * local-inventory apply, each library on its own throwaway database migrated
 * from its committed migrations. The receipt runs through the library services
 * (proceed → apply → retry-apply) exactly as the routes call them.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import {
    configureWorkflowMapping,
    getPrisma as getWorkflowPrisma,
    lineItemService,
    receiptService,
} from '@inventory/workflow-mapping';
import type { CompletedReceipt } from '@inventory/receipt-types';
import { getPrisma as getInventoryPrisma } from '@inventory/local-inventory';
import { createLocalInventorySink } from '../inventorySink';

// The integration global setup's database helpers (CommonJS, untyped).
const { adminClient, withDb } = jest.requireActual<{
    adminClient: (base: string) => import('pg').Client;
    withDb: (base: string, db: string) => string;
}>('../../../../test/integrationDb');

const ORG = { id: 'treehouse', name: 'Treehouse' };
const GTIN = '0011111111116';
const runTag = `${process.env.TEST_RUN_ID ?? process.pid}_${process.env.JEST_WORKER_ID ?? '1'}`;
const DBS = { wm: `wm_x4_${runTag}`, li: `li_x4_${runTag}` };
const base = process.env.TEST_BASE_URL ?? process.env.DATABASE_URL ?? '';

class TestHttpError extends Error {
    constructor(public readonly status: number, message: string) {
        super(message);
    }
}

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

const expense = { fails: true };
let wm: ReturnType<typeof getWorkflowPrisma>;
let li: ReturnType<typeof getInventoryPrisma>;

beforeAll(async () => {
    await admin(async (c) => {
        for (const db of Object.values(DBS)) {
            await c.query(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`);
            await c.query(`CREATE DATABASE "${db}"`);
        }
    });
    process.env.WORKFLOW_MAPPING_DATABASE_URL = withDb(base, DBS.wm);
    process.env.LOCAL_INVENTORY_DATABASE_URL = withDb(base, DBS.li);
    migrate('workflow-mapping', 'WORKFLOW_MAPPING_DATABASE_URL', process.env.WORKFLOW_MAPPING_DATABASE_URL);
    migrate('local-inventory', 'LOCAL_INVENTORY_DATABASE_URL', process.env.LOCAL_INVENTORY_DATABASE_URL);
    wm = getWorkflowPrisma();
    li = getInventoryPrisma();

    configureWorkflowMapping({
        auth: { getPrincipal: async () => ({ id: 1, name: 'Manager' }) },
        org: async () => ORG,
        httpError: (status, message) => new TestHttpError(status, message),
        // The expense leg (X5) is a stand-in, so each test chooses whether the money side lands.
        expenseSink: {
            pushReceipt: async () => {
                if (expense.fails) throw new Error('ExpenseSink.pushReceipt not wired');
            },
        },
        inventorySink: createLocalInventorySink(async () => ORG),
    });
}, 120_000);

afterAll(async () => {
    await wm?.$disconnect();
    await li?.$disconnect();
    await admin(async (c) => {
        for (const db of Object.values(DBS)) await c.query(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`);
    });
});

/** A pending_review receipt whose lines are all resolved: line 1 recognized (×2 factor), line 2 delayed. */
async function seedReceipt(receiptId: string): Promise<{ id: number; lineIds: number[] }> {
    const receipt: CompletedReceipt = {
        receiptId,
        orgId: ORG.id,
        submitterId: 99,
        vendorName: null,
        receiptNumber: null,
        orderNumber: null,
        currency: 'USD',
        taxCents: 0,
        shippingCents: 0,
        discountCents: 0,
        receiptTotalCents: 1000,
        receiptDate: null,
        needsReimbursement: false,
        reimbursementFor: null,
        submittedAt: new Date().toISOString(),
        backfill: false,
        isInKind: false,
        lineItems: [
            { receiptLineItemId: 1, lineNumber: 1, description: 'Bolts', partNumber: null, manufacturer: null, quantity: 3, unitPriceCents: 200, totalPriceCents: 600, isDelayed: false },
            { receiptLineItemId: 2, lineNumber: 2, description: 'Nuts', partNumber: null, manufacturer: null, quantity: 4, unitPriceCents: 100, totalPriceCents: 400, isDelayed: true },
        ],
    };
    const row = await wm.receivedReceipt.create({
        data: {
            orgId: ORG.id,
            receiptId,
            state: 'pending_review',
            receiptJson: JSON.stringify(receipt),
            lineStatuses: {
                create: [
                    { receiptLineItemId: 1, recognitionStatus: 'recognized', assignedGtin13: GTIN, conversionFactor: 2, conversionVersion: 1 },
                    { receiptLineItemId: 2, recognitionStatus: 'recognized', assignedGtin13: GTIN, conversionFactor: 1, conversionVersion: 1 },
                ],
            },
        },
        include: { lineStatuses: { orderBy: { receiptLineItemId: 'asc' } } },
    });
    return { id: row.id, lineIds: row.lineStatuses.map((l) => l.id) };
}

const stock = async () =>
    (await li.orgItem.findUnique({ where: { orgGtin: { orgId: ORG.id, gtin13: GTIN } } }))?.existingQuantity ?? 0;
const legs = (id: number) => wm.receivedReceipt.findUniqueOrThrow({ where: { id } });

describe('X4 InventorySink → local-inventory apply', () => {
    it('applies a proceeded receipt once, keyed receipt:<id>, then locks its lines', async () => {
        const { id, lineIds } = await seedReceipt('x4-once');
        const before = await stock();

        expect(await receiptService.proceed(id)).toEqual({ state: 'applying' });
        expense.fails = true;
        const result = await receiptService.apply(id);

        // The money leg is down, so the receipt waits in apply_failed — but stock already landed.
        expect(result).toMatchObject({ state: 'apply_failed' });
        expect((await legs(id)).inventoryAppliedAt).not.toBeNull();
        expect(await stock()).toBe(before + 3 * 2);
        const queued = await li.receiveQueue.findMany({ where: { orgId: ORG.id, receiptId: 'x4-once' } });
        // retailer: null crossed as undefined; the queue stores the empty string for "no retailer".
        expect(queued).toEqual([expect.objectContaining({ gtin13: GTIN, quantity: 4, retailer: '' })]);
        expect(await li.receivedInventoryDelta.findMany({ where: { orgId: ORG.id, sourceKey: 'receipt:x4-once' } }))
            .toEqual([expect.objectContaining({ status: 'applied' })]);

        await expect(lineItemService.markNonInventory(id, lineIds[0])).rejects.toMatchObject({ status: 409 });
    });

    it('replays idempotently when the inventory leg is pushed again', async () => {
        const { id } = await seedReceipt('x4-replay');
        await receiptService.proceed(id);
        expense.fails = true;
        await receiptService.apply(id);
        const applied = await stock();

        // The callee committed but the stamp was lost: the retry pushes the same delta again.
        await wm.receivedReceipt.update({ where: { id }, data: { inventoryAppliedAt: null } });
        expense.fails = false;
        await receiptService.retryApply(id);
        expect(await receiptService.apply(id)).toEqual({ state: 'resolved' });

        expect(await stock()).toBe(applied);
        expect((await legs(id)).inventoryAppliedAt).not.toBeNull();
        expect(await li.receiveQueue.count({ where: { orgId: ORG.id, receiptId: 'x4-replay' } })).toBe(1);
    });

    it('lands a replay with a different delta in apply_failed with the 409, never swallowed', async () => {
        const { id, lineIds } = await seedReceipt('x4-mismatch');
        await receiptService.proceed(id);
        expense.fails = true;
        await receiptService.apply(id);
        const applied = await stock();

        await wm.receivedReceipt.update({ where: { id }, data: { inventoryAppliedAt: null } });
        await wm.receivedReceiptLineStatus.update({ where: { id: lineIds[0] }, data: { conversionFactor: 5 } });
        expense.fails = false;
        await receiptService.retryApply(id);
        const result = await receiptService.apply(id);

        expect(result).toEqual({
            state: 'apply_failed',
            error: 'This source was already applied with a different inventory delta.',
        });
        const row = await legs(id);
        expect(row.state).toBe('apply_failed');
        expect(row.inventoryAppliedAt).toBeNull();
        expect(await stock()).toBe(applied);
    });

    it('refuses a delta for another org', async () => {
        const sink = createLocalInventorySink(async () => ORG);
        await expect(
            sink.applyDelta({
                receiptId: 'x4-foreign',
                orgId: 'elsewhere',
                retailer: null,
                lineItems: [{ lineItemId: 1, gtin13: GTIN, quantityDelta: 1, isDelayed: false, conversionFactor: 1, conversionVersion: 1 }],
            }),
        ).rejects.toThrow(/org/);
        expect(await li.receivedInventoryDelta.count({ where: { sourceKey: 'receipt:x4-foreign' } })).toBe(0);
    });
});
