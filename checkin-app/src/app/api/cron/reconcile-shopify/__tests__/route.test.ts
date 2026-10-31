/**
 * @jest-environment node
 */
/**
 * GET /api/cron/reconcile-shopify: the library catch-up, program-stock heal and donor re-send steps are
 * isolated, so no one step's failure fails checkin's reconcile. Every step is mocked; prisma.cronRunLog is stubbed for withCron's stamp.
 */
import { runExpenseCatchUp } from '@checkin/expense';
import { catchUpOrgEvents as catchUpInventoryEvents } from '@checkin/local-inventory';
import { catchUpOrgEvents as catchUpWorkflowEvents, sweepStuckApplying } from '@checkin/workflow-mapping';
import { runReconcile as runIncomeReconcile } from '@checkin/income';
import { readMailbox, repushUnpushed, resendDonorSync, sweepInterruptedOcr, sweepStuckUploaded } from '@checkin/receipt';
import { runReconcile } from '@/lib/finance/reconcile';
import { runSaleSweep } from '@/lib/programs/saleSweep';
import { healProgramStock } from '@/lib/shopify/stock';
import prisma from '@/lib/prisma';
import { GET } from '../route';

jest.mock('@/lib/finance/reconcile', () => ({ runReconcile: jest.fn() }));
jest.mock('@checkin/expense', () => ({ runExpenseCatchUp: jest.fn() }));
jest.mock('@checkin/income', () => ({ runReconcile: jest.fn() }));
jest.mock('@checkin/local-inventory', () => ({ catchUpOrgEvents: jest.fn() }));
jest.mock('@checkin/workflow-mapping', () => ({ catchUpOrgEvents: jest.fn(), sweepStuckApplying: jest.fn() }));
jest.mock('@checkin/receipt', () => ({ sweepInterruptedOcr: jest.fn(), sweepStuckUploaded: jest.fn(), repushUnpushed: jest.fn(), resendDonorSync: jest.fn(), readMailbox: jest.fn() }));
jest.mock('@/lib/programs/saleSweep', () => ({ runSaleSweep: jest.fn() }));
jest.mock('@/lib/shopify/stock', () => ({ healProgramStock: jest.fn() }));
jest.mock('@/lib/components/host', () => ({ getOrg: jest.fn().mockResolvedValue({ id: 'org-1', name: 'Org' }) }));

const SECRET = 'cron-secret-under-test';
const RECONCILED = { configured: true, ordersScanned: 2, reversalsRaised: 0, failed: 0 };
const SALE_SWEEP = { salesEnded: 0, productsHidden: 0, unpaidNotified: 0 };
const INCOME = { status: 'unbound' as const };
const PROGRAM_STOCK = { checked: 0, settled: 0 };
const INVENTORY_EVENTS = { processed: 1, duplicate: 0, failed: 0, skipped: 0, reconciled: 0, reconcileFailed: 0, unprocessed: 0, unreadable: false };
const WORKFLOW_EVENTS = { applied: 1, failed: 0, unprocessed: 0, unreadable: false };
const RECEIVING_APPLY = { resolved: 1, failed: 0, applying: 0, skipped: 0, errored: 0, gaveUp: 0 };
const RECEIPT = { swept: 2, failed: 0 };
const RECEIPT_STUCK = { swept: 1, failed: 0 };
const RECEIPT_PUSH = { pushed: 2, failed: 0, skipped: 1 };
const DONOR_SYNC = { resent: 1, failed: 0 };
const RECEIPT_MAIL = { status: 'unbound' as const };
// The one expense result every case uses; a new catch-up step adds its key here.
const EXPENSE: Awaited<ReturnType<typeof runExpenseCatchUp>> = {
    intake: { applied: 0, failed: 0 },
    catalogEvents: { processed: 0, duplicate: 0, failed: 0, unprocessed: 0, unreadable: false },
};
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
        jest.mocked(runExpenseCatchUp).mockResolvedValue(EXPENSE);
        jest.mocked(catchUpInventoryEvents).mockResolvedValue(INVENTORY_EVENTS);
        jest.mocked(catchUpWorkflowEvents).mockResolvedValue(WORKFLOW_EVENTS);
        jest.mocked(sweepStuckApplying).mockResolvedValue(RECEIVING_APPLY);
        jest.mocked(sweepInterruptedOcr).mockResolvedValue(RECEIPT);
        jest.mocked(sweepStuckUploaded).mockResolvedValue(RECEIPT_STUCK);
        jest.mocked(repushUnpushed).mockResolvedValue(RECEIPT_PUSH);
        jest.mocked(resendDonorSync).mockResolvedValue(DONOR_SYNC);
        jest.mocked(readMailbox).mockResolvedValue(RECEIPT_MAIL);
    });

    afterAll(() => {
        if (prev === undefined) delete process.env.CRON_SECRET;
        else process.env.CRON_SECRET = prev;
    });

    it('returns the expense catch-up counts under the expense key, with no QuickBooks posting', async () => {
        const res = await GET(req());

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toEqual({ success: true, ...RECONCILED, saleSweep: SALE_SWEEP, income: INCOME, expense: EXPENSE, programStock: PROGRAM_STOCK, inventoryEvents: INVENTORY_EVENTS, workflowEvents: WORKFLOW_EVENTS, receivingApply: RECEIVING_APPLY, receipt: RECEIPT, receiptStuck: RECEIPT_STUCK, receiptPush: RECEIPT_PUSH, donorSync: DONOR_SYNC, receiptMail: RECEIPT_MAIL });
        expect(Object.keys(body.expense).sort()).toEqual(['catalogEvents', 'intake']);
    });

    it('a throwing expense step still answers 200 with the reconcile result', async () => {
        jest.mocked(runExpenseCatchUp).mockRejectedValue(new Error('expense db down'));
        const logged = jest.spyOn(console, 'error').mockImplementation(() => {});

        const res = await GET(req());

        expect(res.status).toBe(200);
        expect(runReconcile).toHaveBeenCalledTimes(1);
        expect(await res.json()).toEqual({ success: true, ...RECONCILED, saleSweep: SALE_SWEEP, income: INCOME, expense: { status: 'error' }, programStock: PROGRAM_STOCK, inventoryEvents: INVENTORY_EVENTS, workflowEvents: WORKFLOW_EVENTS, receivingApply: RECEIVING_APPLY, receipt: RECEIPT, receiptStuck: RECEIPT_STUCK, receiptPush: RECEIPT_PUSH, donorSync: DONOR_SYNC, receiptMail: RECEIPT_MAIL });
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

    it('a throwing stuck-apply sweep still answers 200 with every other step', async () => {
        jest.mocked(sweepStuckApplying).mockRejectedValue(new Error('workflow db down'));
        const logged = jest.spyOn(console, 'error').mockImplementation(() => {});

        const res = await GET(req());

        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ success: true, workflowEvents: WORKFLOW_EVENTS, receivingApply: { status: 'error' }, receipt: RECEIPT });
        expect(logged).toHaveBeenCalledWith('[reconcile] workflow-mapping stuck-apply sweep failed:', expect.any(Error));
        logged.mockRestore();
    });

    it('a throwing receipt step still answers 200 with every other step', async () => {
        jest.mocked(sweepInterruptedOcr).mockRejectedValue(new Error('receipt db down'));
        const logged = jest.spyOn(console, 'error').mockImplementation(() => {});

        const res = await GET(req());

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ success: true, ...RECONCILED, saleSweep: SALE_SWEEP, income: INCOME, expense: EXPENSE, programStock: PROGRAM_STOCK, inventoryEvents: INVENTORY_EVENTS, workflowEvents: WORKFLOW_EVENTS, receivingApply: RECEIVING_APPLY, receipt: { status: 'error' }, receiptStuck: RECEIPT_STUCK, receiptPush: RECEIPT_PUSH, donorSync: DONOR_SYNC, receiptMail: RECEIPT_MAIL });
        expect(logged).toHaveBeenCalledWith('[reconcile] receipt catch-up failed:', expect.any(Error));
        logged.mockRestore();
    });

    it('a throwing stuck-upload sweep still answers 200 with every other step', async () => {
        jest.mocked(sweepStuckUploaded).mockRejectedValue(new Error('receipt db down'));
        const logged = jest.spyOn(console, 'error').mockImplementation(() => {});

        const res = await GET(req());

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ success: true, ...RECONCILED, saleSweep: SALE_SWEEP, income: INCOME, expense: EXPENSE, programStock: PROGRAM_STOCK, inventoryEvents: INVENTORY_EVENTS, workflowEvents: WORKFLOW_EVENTS, receivingApply: RECEIVING_APPLY, receipt: RECEIPT, receiptStuck: { status: 'error' }, receiptPush: RECEIPT_PUSH, donorSync: DONOR_SYNC, receiptMail: RECEIPT_MAIL });
        expect(logged).toHaveBeenCalledWith('[reconcile] receipt stuck-upload sweep failed:', expect.any(Error));
        logged.mockRestore();
    });

    it('a throwing receipt re-push still answers 200 with every other step', async () => {
        jest.mocked(repushUnpushed).mockRejectedValue(new Error('receipt db down'));
        const logged = jest.spyOn(console, 'error').mockImplementation(() => {});

        const res = await GET(req());

        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ success: true, inventoryEvents: INVENTORY_EVENTS, workflowEvents: WORKFLOW_EVENTS, receivingApply: RECEIVING_APPLY, receipt: RECEIPT, receiptPush: { status: 'error' } });
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

    it('a throwing mail intake still answers 200 with every other step', async () => {
        jest.mocked(readMailbox).mockRejectedValue(new Error('gmail down'));
        const logged = jest.spyOn(console, 'error').mockImplementation(() => {});

        const res = await GET(req());

        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ success: true, donorSync: DONOR_SYNC, receiptMail: { status: 'error' } });
        expect(logged).toHaveBeenCalledWith('[reconcile] receipt mail intake failed:', expect.any(Error));
        logged.mockRestore();
    });

    it('records the cron run as failed when mail intake throws', async () => {
        jest.mocked(readMailbox).mockRejectedValue(new Error('gmail down'));
        const logged = jest.spyOn(console, 'error').mockImplementation(() => {});

        const body = await (await GET(req())).json();

        expect(body).toMatchObject({ success: true, failed: 1 });
        expect(prisma.cronRunLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ success: true, error: '1 item(s) failed' }) });
        logged.mockRestore();
    });

    it('records the cron run as failed when the mailbox could not be listed, on top of reconcile failures', async () => {
        jest.mocked(runReconcile).mockResolvedValue({ ...RECONCILED, failed: 2 });
        jest.mocked(readMailbox).mockResolvedValue({ status: 'listing_failed', messages: 0, receipts: 0, held: 0, skipped: 0, rejected: 0, failed: 0, deferred: 0, overLimit: 0, overCeiling: 0, unread: 0, ignored: 0, replied: 1, replyFailed: 0 });

        const body = await (await GET(req())).json();

        expect(body).toMatchObject({ success: true, failed: 3, receiptMail: { status: 'listing_failed', replied: 1 } });
        expect(prisma.cronRunLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ success: true, error: '3 item(s) failed' }) });
    });

    it('records the cron run as failed for provisionals the inventory catch-up could not reconcile', async () => {
        jest.mocked(catchUpInventoryEvents).mockResolvedValue({ ...INVENTORY_EVENTS, reconcileFailed: 2 });

        const body = await (await GET(req())).json();

        expect(body).toMatchObject({ success: true, failed: 2 });
        expect(prisma.cronRunLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ success: true, error: '2 item(s) failed' }) });
    });

    it('records the cron run as failed for receipt rows the sweeps could not move', async () => {
        jest.mocked(sweepInterruptedOcr).mockResolvedValue({ swept: 0, failed: 1 });
        jest.mocked(sweepStuckUploaded).mockResolvedValue({ swept: 0, failed: 2 });

        const body = await (await GET(req())).json();

        expect(body).toMatchObject({ success: true, failed: 3 });
        expect(prisma.cronRunLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ success: true, error: '3 item(s) failed' }) });
    });

    it('records a clean run when the mailbox was read', async () => {
        await GET(req());

        expect(prisma.cronRunLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ success: true, error: null }) });
    });
});
