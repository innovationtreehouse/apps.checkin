/**
 * @jest-environment node
 */
/**
 * X5 binding: workflow-mapping's ExpenseSink driven into the real
 * expense intake, each library on its own throwaway database migrated from its
 * committed migrations. The inventory leg is a stand-in that always lands.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import {
    configureWorkflowMapping,
    getPrisma as getWorkflowPrisma,
    receiptService,
} from '@checkin/workflow-mapping';
import { configureExpense, expenseIntake, getPrisma as getExpensePrisma } from '@checkin/expense';
import type { CompletedReceipt } from '@checkin/receipt-types';
import { expenseSink } from '../configure';

// The integration global setup's database helpers (CommonJS, untyped).
const { adminClient, withDb } = jest.requireActual<{
    adminClient: (base: string) => import('pg').Client;
    withDb: (base: string, db: string) => string;
}>('../../../../test/integrationDb');

const ORG = { id: 'treehouse', name: 'Treehouse' };
const GTIN = '0011111111116';
const runTag = `${process.env.TEST_RUN_ID ?? process.pid}_${process.env.JEST_WORKER_ID ?? '1'}`;
const DBS = { wm: `wm_x5_${runTag}`, ex: `ex_x5_${runTag}` };
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

let wm: ReturnType<typeof getWorkflowPrisma>;
let ex: ReturnType<typeof getExpensePrisma>;

beforeAll(async () => {
    await admin(async (c) => {
        for (const db of Object.values(DBS)) {
            await c.query(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`);
            await c.query(`CREATE DATABASE "${db}"`);
        }
    });
    process.env.WORKFLOW_MAPPING_DATABASE_URL = withDb(base, DBS.wm);
    process.env.EXPENSE_DATABASE_URL = withDb(base, DBS.ex);
    migrate('workflow-mapping', 'WORKFLOW_MAPPING_DATABASE_URL', process.env.WORKFLOW_MAPPING_DATABASE_URL);
    migrate('expense', 'EXPENSE_DATABASE_URL', process.env.EXPENSE_DATABASE_URL);
    wm = getWorkflowPrisma();
    ex = getExpensePrisma();

    configureExpense({ org: async () => ORG });
    configureWorkflowMapping({
        auth: { getPrincipal: async () => ({ id: 1, name: 'Manager' }) },
        org: async () => ORG,
        expenseSink,
        inventorySink: { applyDelta: async () => {} },
    });
}, 120_000);

afterEach(() => jest.restoreAllMocks());

afterAll(async () => {
    await wm?.$disconnect();
    await ex?.$disconnect();
    await admin(async (c) => {
        for (const db of Object.values(DBS)) await c.query(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`);
    });
});

function receiptFor(receiptId: string): CompletedReceipt {
    return {
        receiptId,
        orgId: ORG.id,
        submitterId: 99,
        vendorName: 'Hardware Co',
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
            { receiptLineItemId: 2, lineNumber: 2, description: 'Nuts', partNumber: null, manufacturer: null, quantity: 4, unitPriceCents: 100, totalPriceCents: 400, isDelayed: false },
        ],
    };
}

/** A pending_review receipt whose two lines are recognized. */
async function seedReceipt(receiptId: string): Promise<{ id: number; lineIds: number[] }> {
    const row = await wm.receivedReceipt.create({
        data: {
            orgId: ORG.id,
            receiptId,
            state: 'pending_review',
            receiptJson: JSON.stringify(receiptFor(receiptId)),
            lineStatuses: {
                create: [
                    { receiptLineItemId: 1, recognitionStatus: 'recognized', assignedGtin13: GTIN, conversionFactor: 1, conversionVersion: 1 },
                    { receiptLineItemId: 2, recognitionStatus: 'recognized', assignedGtin13: GTIN, conversionFactor: 1, conversionVersion: 1 },
                ],
            },
        },
        include: { lineStatuses: { orderBy: { receiptLineItemId: 'asc' } } },
    });
    return { id: row.id, lineIds: row.lineStatuses.map((l) => l.id) };
}

async function proceedAndApply(id: number) {
    await receiptService.proceed(id);
    return receiptService.apply(id);
}

const expenses = (receiptId: string) => ex.expense.findMany({ where: { id: receiptId }, include: { lineItems: true } });
const legs = (id: number) => wm.receivedReceipt.findUniqueOrThrow({ where: { id } });

describe('X5 ExpenseSink → expense intake', () => {
    it('creates the expense with each line carrying its resolved GTIN', async () => {
        const { id } = await seedReceipt('x5-push');

        expect(await proceedAndApply(id)).toEqual({ state: 'resolved' });

        const [expense] = await expenses('x5-push');
        expect(expense).toMatchObject({ orgId: ORG.id, vendorName: 'Hardware Co', receiptTotalCents: 1000 });
        expect(expense.lineItems.map((l) => l.gtin13)).toEqual([GTIN, GTIN]);
        expect((await legs(id)).expenseAppliedAt).not.toBeNull();
        expect(await ex.receivedExpensePayload.findMany({ where: { receiptId: 'x5-push' } }))
            .toEqual([expect.objectContaining({ status: 'applied' })]);
    });

    it('replays without a duplicate when the money leg is pushed again', async () => {
        const { id } = await seedReceipt('x5-replay');
        await proceedAndApply(id);

        // The callee committed but the stamp was lost: the retry pushes the same receipt again.
        await wm.receivedReceipt.update({ where: { id }, data: { state: 'apply_failed', expenseAppliedAt: null } });
        await receiptService.retryApply(id);
        expect(await receiptService.apply(id)).toEqual({ state: 'resolved' });

        expect(await expenses('x5-replay')).toHaveLength(1);
        expect(await ex.expenseLineItem.count({ where: { expenseId: 'x5-replay' } })).toBe(2);
    });

    it('lands a replay with a changed payload in apply_failed with the refusal, never swallowed', async () => {
        const { id, lineIds } = await seedReceipt('x5-mismatch');
        await proceedAndApply(id);
        const before = await expenses('x5-mismatch');

        // Expense built the row but never marked the payload applied; a line was then re-resolved.
        await ex.receivedExpensePayload.updateMany({ where: { receiptId: 'x5-mismatch' }, data: { status: 'received' } });
        await wm.receivedReceipt.update({ where: { id }, data: { state: 'apply_failed', expenseAppliedAt: null } });
        await wm.receivedReceiptLineStatus.update({ where: { id: lineIds[1] }, data: { recognitionStatus: 'unrecognized', assignedGtin13: null } });
        await receiptService.retryApply(id);
        const result = await receiptService.apply(id);

        expect(result).toEqual({ state: 'apply_failed', error: 'Receipt x5-mismatch was already received with a different payload' });
        expect((await legs(id)).expenseAppliedAt).toBeNull();
        expect(await expenses('x5-mismatch')).toEqual(before);
    });

    it('records the failure when expense is down, then lands it on retry', async () => {
        const { id } = await seedReceipt('x5-down');
        jest.spyOn(expenseIntake, 'receive').mockRejectedValueOnce(new Error('expense database unreachable'));

        expect(await proceedAndApply(id)).toEqual({ state: 'apply_failed', error: 'expense database unreachable' });
        const failed = await legs(id);
        expect(failed).toMatchObject({ state: 'apply_failed', validationNotes: 'expense database unreachable', expenseAppliedAt: null });
        expect(failed.inventoryAppliedAt).not.toBeNull();
        expect(await expenses('x5-down')).toHaveLength(0);

        await receiptService.retryApply(id);
        expect(await receiptService.apply(id)).toEqual({ state: 'resolved' });
        expect(await expenses('x5-down')).toHaveLength(1);
    });

    it('refuses a receipt for another org', async () => {
        await expect(expenseSink.pushReceipt({ ...receiptFor('x5-foreign'), orgId: 'elsewhere' })).rejects.toThrow(/not this org/);
        expect(await expenses('x5-foreign')).toHaveLength(0);
    });
});
