/**
 * @jest-environment node
 */
/**
 * GET /api/cron/reconcile-shopify: the library catch-up, program-stock heal and donor re-send steps are
 * isolated, so no one step's failure fails checkin's reconcile. Every step is mocked; prisma.cronRunLog is stubbed for withCron's stamp.
 */
import { runExpenseCatchUp } from '@inventory/expense';
import { catchUpOrgEvents as catchUpInventoryEvents } from '@inventory/local-inventory';
import { catchUpOrgEvents as catchUpWorkflowEvents } from '@inventory/workflow-mapping';
import { runReconcile as runIncomeReconcile } from '@inventory/income';
import { repushUnpushed, resendDonorSync, sweepInterruptedOcr } from '@inventory/receipt';
import { runReconcile } from '@/lib/finance/reconcile';
import { runSaleSweep } from '@/lib/programs/saleSweep';
import { healProgramStock } from '@/lib/shopify';
import prisma from '@/lib/prisma';
import { GET } from '../route';

jest.mock('@/lib/finance/reconcile', () => ({ runReconcile: jest.fn() }));
jest.mock('@inventory/expense', () => ({ runExpenseCatchUp: jest.fn() }));
jest.mock('@inventory/income', () => ({ runReconcile: jest.fn() }));
jest.mock('@inventory/local-inventory', () => ({ catchUpOrgEvents: jest.fn() }));
jest.mock('@inventory/workflow-mapping', () => ({ catchUpOrgEvents: jest.fn() }));
jest.mock('@inventory/receipt', () => ({ sweepInterruptedOcr: jest.fn(), repushUnpushed: jest.fn(), resendDonorSync: jest.fn() }));
jest.mock('@/lib/programs/saleSweep', () => ({ runSaleSweep: jest.fn() }));
jest.mock('@/lib/shopify', () => ({ healProgramStock: jest.fn() }));
jest.mock('@/lib/catalog/configure', () => ({ getOrg: jest.fn().mockResolvedValue({ id: 'org-1', name: 'Org' }) }));

const SECRET = 'cron-secret-under-test';
const RECONCILED = { configured: true, ordersScanned: 2, reversalsRaised: 0, failed: 0 };
const SALE_SWEEP = { salesEnded: 0, productsHidden: 0, unpaidNotified: 0 };
const INCOME = { status: 'unbound' as const };
const PROGRAM_STOCK = { checked: 0, settled: 0 };
const INVENTORY_EVENTS = { processed: 1, duplicate: 0, failed: 0, skipped: 0 };
const WORKFLOW_EVENTS = { applied: 1, failed: 0 };
const RECEIPT = { swept: 2 };
const RECEIPT_PUSH = { pushed: 2, failed: 0 };
const DONOR_SYNC = { resent: 1, failed: 0 };
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
        jest.mocked(catchUpInventoryEvents).mockResolvedValue(INVENTORY_EVENTS);
        jest.mocked(catchUpWorkflowEvents).mockResolvedValue(WORKFLOW_EVENTS);
        jest.mocked(sweepInterruptedOcr).mockResolvedValue(RECEIPT);
        jest.mocked(repushUnpushed).mockResolvedValue(RECEIPT_PUSH);
        jest.mocked(resendDonorSync).mockResolvedValue(DONOR_SYNC);
    });

    afterAll(() => {
        if (prev === undefined) delete process.env.CRON_SECRET;
        else process.env.CRON_SECRET = prev;
    });

    it('returns the expense counts beside the reconcile result', async () => {
        const counts = {
            intake: { applied: 0, failed: 0 },
            stranded: { checked: 0, failed: 0 },
            catalogEvents: { processed: 0, duplicate: 0, failed: 0 },
            qbPost: 'unbound' as const,
        };
        jest.mocked(runExpenseCatchUp).mockResolvedValue(counts);

        const res = await GET(req());

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ success: true, ...RECONCILED, saleSweep: SALE_SWEEP, income: INCOME, expense: counts, programStock: PROGRAM_STOCK, inventoryEvents: INVENTORY_EVENTS, workflowEvents: WORKFLOW_EVENTS, receipt: RECEIPT, receiptPush: RECEIPT_PUSH, donorSync: DONOR_SYNC });
    });

    it('a throwing expense step still answers 200 with the reconcile result', async () => {
        jest.mocked(runExpenseCatchUp).mockRejectedValue(new Error('expense db down'));
        const logged = jest.spyOn(console, 'error').mockImplementation(() => {});

        const res = await GET(req());

        expect(res.status).toBe(200);
        expect(runReconcile).toHaveBeenCalledTimes(1);
        expect(await res.json()).toEqual({ success: true, ...RECONCILED, saleSweep: SALE_SWEEP, income: INCOME, expense: { status: 'error' }, programStock: PROGRAM_STOCK, inventoryEvents: INVENTORY_EVENTS, workflowEvents: WORKFLOW_EVENTS, receipt: RECEIPT, receiptPush: RECEIPT_PUSH, donorSync: DONOR_SYNC });
        expect(logged).toHaveBeenCalledWith('[reconcile] expense catch-up failed:', expect.any(Error));
        logged.mockRestore();
    });

    it('a throwing program-stock heal still answers 200 with the reconcile result', async () => {
        jest.mocked(runExpenseCatchUp).mockResolvedValue({
            intake: { applied: 0, failed: 0 },
            stranded: { checked: 0, failed: 0 },
            catalogEvents: { processed: 0, duplicate: 0, failed: 0 },
            qbPost: 'unbound' as const,
        });
        jest.mocked(healProgramStock).mockRejectedValue(new Error('stock db down'));
        const logged = jest.spyOn(console, 'error').mockImplementation(() => {});

        const res = await GET(req());

        expect(res.status).toBe(200);
        expect((await res.json()).programStock).toEqual({ status: 'error' });
        expect(logged).toHaveBeenCalledWith('[reconcile] program stock heal failed:', expect.any(Error));
        logged.mockRestore();
    });

    it('a throwing event catch-up step still answers 200 and runs the other one', async () => {
        jest.mocked(runExpenseCatchUp).mockResolvedValue({ intake: { applied: 0, failed: 0 }, stranded: { checked: 0, failed: 0 }, catalogEvents: { processed: 0, duplicate: 0, failed: 0 }, qbPost: 'unbound' });
        jest.mocked(catchUpInventoryEvents).mockRejectedValue(new Error('inventory db down'));
        const logged = jest.spyOn(console, 'error').mockImplementation(() => {});

        const res = await GET(req());

        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ success: true, inventoryEvents: { status: 'error' }, workflowEvents: WORKFLOW_EVENTS });
        expect(logged).toHaveBeenCalledWith('[reconcile] inventory event catch-up failed:', expect.any(Error));
        logged.mockRestore();
    });

    it('a throwing receipt step still answers 200 with every other step', async () => {
        const counts = {
            intake: { applied: 0, failed: 0 },
            stranded: { checked: 0, failed: 0 },
            catalogEvents: { processed: 0, duplicate: 0, failed: 0 },
            qbPost: 'unbound' as const,
        };
        jest.mocked(runExpenseCatchUp).mockResolvedValue(counts);
        jest.mocked(sweepInterruptedOcr).mockRejectedValue(new Error('receipt db down'));
        const logged = jest.spyOn(console, 'error').mockImplementation(() => {});

        const res = await GET(req());

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ success: true, ...RECONCILED, saleSweep: SALE_SWEEP, income: INCOME, expense: counts, programStock: PROGRAM_STOCK, inventoryEvents: INVENTORY_EVENTS, workflowEvents: WORKFLOW_EVENTS, receipt: { status: 'error' }, receiptPush: RECEIPT_PUSH, donorSync: DONOR_SYNC });
        expect(logged).toHaveBeenCalledWith('[reconcile] receipt catch-up failed:', expect.any(Error));
        logged.mockRestore();
    });

    it('a throwing receipt re-push still answers 200 with every other step', async () => {
        jest.mocked(runExpenseCatchUp).mockResolvedValue({ intake: { applied: 0, failed: 0 }, stranded: { checked: 0, failed: 0 }, catalogEvents: { processed: 0, duplicate: 0, failed: 0 }, qbPost: 'unbound' });
        jest.mocked(repushUnpushed).mockRejectedValue(new Error('receipt db down'));
        const logged = jest.spyOn(console, 'error').mockImplementation(() => {});

        const res = await GET(req());

        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ success: true, inventoryEvents: INVENTORY_EVENTS, workflowEvents: WORKFLOW_EVENTS, receipt: RECEIPT, receiptPush: { status: 'error' } });
        expect(logged).toHaveBeenCalledWith('[reconcile] receipt re-push failed:', expect.any(Error));
        logged.mockRestore();
    });

    it('a throwing donor re-send still answers 200 with the reconcile result', async () => {
        jest.mocked(resendDonorSync).mockRejectedValue(new Error('receipt db down'));
        const logged = jest.spyOn(console, 'error').mockImplementation(() => {});

        const res = await GET(req());

        expect(res.status).toBe(200);
        expect((await res.json()).donorSync).toEqual({ status: 'error' });
        expect(logged).toHaveBeenCalledWith('[reconcile] receipt donor re-send failed:', expect.any(Error));
        logged.mockRestore();
    });
});
