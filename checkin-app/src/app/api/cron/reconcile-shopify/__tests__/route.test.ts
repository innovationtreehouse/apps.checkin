/**
 * @jest-environment node
 */
/**
 * GET /api/cron/reconcile-shopify: the library catch-up and program-stock heal steps are
 * isolated, so no one step's failure fails checkin's reconcile. Every step is mocked; prisma.cronRunLog is stubbed for withCron's stamp.
 */
import { runExpenseCatchUp, runExpenseQbPosting } from '@inventory/expense';
import { catchUpOrgEvents as catchUpInventoryEvents } from '@inventory/local-inventory';
import { catchUpOrgEvents as catchUpWorkflowEvents } from '@inventory/workflow-mapping';
import { runReconcile as runIncomeReconcile } from '@inventory/income';
import { runReconcile } from '@/lib/finance/reconcile';
import { runSaleSweep } from '@/lib/programs/saleSweep';
import { healProgramStock } from '@/lib/shopify';
import prisma from '@/lib/prisma';
import { GET } from '../route';

jest.mock('@/lib/finance/reconcile', () => ({ runReconcile: jest.fn() }));
jest.mock('@inventory/expense', () => ({ runExpenseCatchUp: jest.fn(), runExpenseQbPosting: jest.fn() }));
jest.mock('@inventory/income', () => ({ runReconcile: jest.fn() }));
jest.mock('@inventory/local-inventory', () => ({ catchUpOrgEvents: jest.fn() }));
jest.mock('@inventory/workflow-mapping', () => ({ catchUpOrgEvents: jest.fn() }));
jest.mock('@/lib/programs/saleSweep', () => ({ runSaleSweep: jest.fn() }));
jest.mock('@/lib/shopify', () => ({ healProgramStock: jest.fn() }));
jest.mock('@/lib/catalog/configure', () => ({ getOrg: jest.fn().mockResolvedValue({ id: 'org-1', name: 'Org' }) }));

const SECRET = 'cron-secret-under-test';
const RECONCILED = { configured: true, ordersScanned: 2, reversalsRaised: 0, failed: 0 };
const SALE_SWEEP = { salesEnded: 0, productsHidden: 0, unpaidNotified: 0 };
const INCOME = { status: 'unbound' as const };
const PROGRAM_STOCK = { checked: 0, settled: 0 };
const CATCH_UP = { intake: { applied: 0, failed: 0 }, catalogEvents: { processed: 0, duplicate: 0, failed: 0 } };
const QB_POSTING = { stranded: { checked: 0, failed: 0 }, qbPost: 'unbound' as const };
const INVENTORY_EVENTS = { processed: 1, duplicate: 0, failed: 0, skipped: 0 };
const WORKFLOW_EVENTS = { applied: 1, failed: 0 };
const req = () =>
    new Request('http://localhost/api/cron/reconcile-shopify', { headers: { authorization: `Bearer ${SECRET}` } });

describe('GET /api/cron/reconcile-shopify — expense catch-up step', () => {
    const prev = process.env.CRON_SECRET;

    beforeEach(() => {
        jest.clearAllMocks();
        process.env.CRON_SECRET = SECRET;
        prisma.cronRunLog.create = jest.fn().mockResolvedValue({});
        prisma.cronRunLog.deleteMany = jest.fn().mockResolvedValue({ count: 0 });
        jest.mocked(runReconcile).mockResolvedValue(RECONCILED);
        jest.mocked(runSaleSweep).mockResolvedValue(SALE_SWEEP);
        jest.mocked(runIncomeReconcile).mockResolvedValue(INCOME);
        jest.mocked(healProgramStock).mockResolvedValue(PROGRAM_STOCK);
        jest.mocked(runExpenseCatchUp).mockResolvedValue(CATCH_UP);
        jest.mocked(runExpenseQbPosting).mockResolvedValue(QB_POSTING);
        jest.mocked(catchUpInventoryEvents).mockResolvedValue(INVENTORY_EVENTS);
        jest.mocked(catchUpWorkflowEvents).mockResolvedValue(WORKFLOW_EVENTS);
    });

    afterAll(() => {
        if (prev === undefined) delete process.env.CRON_SECRET;
        else process.env.CRON_SECRET = prev;
    });

    it('returns the expense catch-up and QuickBooks posting counts under one expense key', async () => {
        const res = await GET(req());

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toEqual({ success: true, ...RECONCILED, saleSweep: SALE_SWEEP, income: INCOME, expense: { ...CATCH_UP, ...QB_POSTING }, programStock: PROGRAM_STOCK, inventoryEvents: INVENTORY_EVENTS, workflowEvents: WORKFLOW_EVENTS });
        expect(Object.keys(body.expense).sort()).toEqual(['catalogEvents', 'intake', 'qbPost', 'stranded']);
    });

    it('a throwing expense step still answers 200 with the reconcile result', async () => {
        jest.mocked(runExpenseCatchUp).mockRejectedValue(new Error('expense db down'));
        const logged = jest.spyOn(console, 'error').mockImplementation(() => {});

        const res = await GET(req());

        expect(res.status).toBe(200);
        expect(runReconcile).toHaveBeenCalledTimes(1);
        expect(await res.json()).toEqual({ success: true, ...RECONCILED, saleSweep: SALE_SWEEP, income: INCOME, expense: { status: 'error' }, programStock: PROGRAM_STOCK, inventoryEvents: INVENTORY_EVENTS, workflowEvents: WORKFLOW_EVENTS });
        expect(logged).toHaveBeenCalledWith('[reconcile] expense catch-up failed:', expect.any(Error));
        logged.mockRestore();
    });

    it('a throwing program-stock heal still answers 200 with the reconcile result', async () => {
        jest.mocked(healProgramStock).mockRejectedValue(new Error('stock db down'));
        const logged = jest.spyOn(console, 'error').mockImplementation(() => {});

        const res = await GET(req());

        expect(res.status).toBe(200);
        expect((await res.json()).programStock).toEqual({ status: 'error' });
        expect(logged).toHaveBeenCalledWith('[reconcile] program stock heal failed:', expect.any(Error));
        logged.mockRestore();
    });

    it('a throwing event catch-up step still answers 200 and runs the other one', async () => {
        jest.mocked(catchUpInventoryEvents).mockRejectedValue(new Error('inventory db down'));
        const logged = jest.spyOn(console, 'error').mockImplementation(() => {});

        const res = await GET(req());

        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ success: true, inventoryEvents: { status: 'error' }, workflowEvents: WORKFLOW_EVENTS });
        expect(logged).toHaveBeenCalledWith('[reconcile] inventory event catch-up failed:', expect.any(Error));
        logged.mockRestore();
    });
});
