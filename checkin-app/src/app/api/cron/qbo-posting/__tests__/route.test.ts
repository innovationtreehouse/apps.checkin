/**
 * @jest-environment node
 */
/**
 * GET /api/cron/qbo-posting: admits only QBO_POSTING_CRON_SECRET, refreshes the copy of QuickBooks' lists, runs the expense, donation and
 * in-kind QuickBooks steps, income's drain and income's orphan sweep (each isolated), the three drains each under the posting slot,
 * then any lane still queued; records the run, and answers `{}`.
 */
import type { NextRequest as NextRequestType } from 'next/server';
import { runExpenseQbPosting } from '@checkin/expense';
import { runDonationDepositHandOver, runInKindQbPosting } from '@checkin/bulk-donation';
import { drainIncomeOutbox, runIncomeOrphanSweep } from '@checkin/income';
import { authenticateRequest } from '@/lib/auth';
import prisma from '@/lib/prisma';
import { reportTo } from '@/lib/finishRun';
import { refreshQuickBooksLists } from '@/lib/finance/quickBooksLists';
import { GET } from '../route';

jest.mock('@/lib/auth', () => ({ authenticateRequest: jest.fn() }));
jest.mock('@checkin/expense', () => ({ runExpenseQbPosting: jest.fn() }));
jest.mock('@checkin/bulk-donation', () => ({ runDonationDepositHandOver: jest.fn(), runInKindQbPosting: jest.fn() }));
jest.mock('@checkin/income', () => ({ drainIncomeOutbox: jest.fn(), runIncomeOrphanSweep: jest.fn() }));
jest.mock('@/lib/finance/quickBooksLists', () => ({ refreshQuickBooksLists: jest.fn() }));
jest.mock('@/lib/components/host', () => ({ getOrg: jest.fn().mockResolvedValue({ id: 'org-1', name: 'Org' }) }));
const { NextRequest } = jest.requireActual<{ NextRequest: typeof NextRequestType }>('next/server');

const SECRET = 'qbo-posting-secret-under-test';
const EXPENSE_DRAIN = { posted: 0, matched: 0, queued: 0, failed: 0, throttled: 0, waiting: 0, not_sent: 0, needs_finance: 0, no_class: 0, unpostable: 0, capped: null, closeDateRead: true, sweep: { entries: 0, flagged: 0, full: false } };
const IN_KIND_DRAIN = { posted: 0, matched: 0, unbooked: 0, needs_finance: 0, held: 0, failed: 0, throttled: 0, waiting: 0, capped: false, closeDateRead: true, sweep: { entries: 0, flagged: 0, full: false }, drift: { checked: 0, drifted: 0 }, capital: { registered: 0, failed: 0 } };
const expensePosting = (qbPost: Awaited<ReturnType<typeof runExpenseQbPosting>>['qbPost']) =>
    ({ stranded: { checked: 0, failed: 0 }, qbPost, qbDrift: 'unbound' as const, outcomeNotices: { sent: 0, failed: 0 }, failedParts: [] });
const req = (secret = SECRET) =>
    new NextRequest('http://localhost/api/cron/qbo-posting', { headers: { authorization: `Bearer ${secret}` } });

describe('GET /api/cron/qbo-posting', () => {
    const prev = process.env.QBO_POSTING_CRON_SECRET;
    let create: jest.Mock;

    beforeEach(() => {
        jest.clearAllMocks();
        process.env.QBO_POSTING_CRON_SECRET = SECRET;
        jest.mocked(authenticateRequest).mockResolvedValue({ type: 'unauthenticated' });
        create = jest.fn().mockResolvedValue({});
        prisma.cronRunLog.create = create;
        prisma.cronRunLog.deleteMany = jest.fn().mockResolvedValue({ count: 0 });
        prisma.quickBooksPostingSlot.createMany = jest.fn().mockResolvedValue({ count: 1 });
        prisma.quickBooksPostingSlot.updateMany = jest.fn().mockResolvedValue({ count: 1 });
        prisma.quickBooksPostingSlot.findUnique = jest.fn().mockResolvedValue(null);
        prisma.quickBooksPostingQueue.findMany = jest.fn().mockResolvedValue([]);
        prisma.quickBooksPostingQueue.deleteMany = jest.fn().mockResolvedValue({ count: 0 });
        jest.mocked(runExpenseQbPosting).mockResolvedValue({ stranded: { checked: 0, failed: 0 }, qbPost: 'unbound', qbDrift: 'unbound', outcomeNotices: { sent: 0, failed: 0 }, failedParts: [] });
        jest.mocked(runDonationDepositHandOver).mockResolvedValue('unbound');
        jest.mocked(runInKindQbPosting).mockResolvedValue('unbound');
        jest.mocked(drainIncomeOutbox).mockResolvedValue({ reconcile: { status: 'unbound' }, post: 'unbound' });
        jest.mocked(runIncomeOrphanSweep).mockResolvedValue({ status: 'unbound' });
        jest.mocked(refreshQuickBooksLists).mockResolvedValue(null);
    });

    afterAll(() => {
        if (prev === undefined) delete process.env.QBO_POSTING_CRON_SECRET;
        else process.env.QBO_POSTING_CRON_SECRET = prev;
    });

    it('refuses a wrong secret with 401 and runs nothing', async () => {
        const res = await GET(req('not-the-secret'));

        expect(res.status).toBe(401);
        expect(runExpenseQbPosting).not.toHaveBeenCalled();
        expect(runDonationDepositHandOver).not.toHaveBeenCalled();
        expect(runInKindQbPosting).not.toHaveBeenCalled();
        expect(drainIncomeOutbox).not.toHaveBeenCalled();
        expect(create).not.toHaveBeenCalled();
    });

    it('runs every step, records the run, and answers {}', async () => {
        const res = await GET(req());

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({});
        expect(runExpenseQbPosting).toHaveBeenCalledTimes(1);
        expect(runDonationDepositHandOver).toHaveBeenCalledWith('org-1');
        expect(runInKindQbPosting).toHaveBeenCalledWith('org-1', expect.any(Date), expect.objectContaining({ yielded: false }));
        expect(drainIncomeOutbox).toHaveBeenCalledWith('org-1', expect.any(Date), expect.objectContaining({ yielded: false }));
        expect(prisma.quickBooksPostingQueue.findMany).toHaveBeenCalled();
        expect(runIncomeOrphanSweep).toHaveBeenCalledWith('org-1');
        expect(create).toHaveBeenCalledTimes(1);
        expect(create.mock.calls[0][0].data).toMatchObject({ job: 'qbo-posting', success: true, error: null });
    });

    it("records the lanes' reports counted by kind; expense's drain never stops its lane", async () => {
        jest.mocked(runExpenseQbPosting).mockImplementation(async () => {
            reportTo('expense')({ lane: 'posting', kind: 'system', status: 503, detail: 'expense 1' });
            return expensePosting(EXPENSE_DRAIN);
        });

        await GET(req());

        expect(create.mock.calls[0][0].data).toMatchObject({ success: true, error: null, failuresByKind: { system: 1 } });
    });

    it('records a failed lists refresh as a bug, and still runs every posting step', async () => {
        jest.mocked(refreshQuickBooksLists).mockRejectedValue(new Error('QuickBooks down'));
        const logged = jest.spyOn(console, 'error').mockImplementation(() => {});

        await GET(req());

        expect(runExpenseQbPosting).toHaveBeenCalledTimes(1);
        expect(runIncomeOrphanSweep).toHaveBeenCalledTimes(1);
        expect(create.mock.calls[0][0].data).toMatchObject({ success: true, error: 'failed: lists', failuresByKind: { bug: 1 } });
        logged.mockRestore();
    });

    it('a throwing step still runs the other and records the failure', async () => {
        jest.mocked(runExpenseQbPosting).mockRejectedValue(new Error('expense db down'));
        const logged = jest.spyOn(console, 'error').mockImplementation(() => {});

        const res = await GET(req());

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({});
        expect(runDonationDepositHandOver).toHaveBeenCalledTimes(1);
        expect(create.mock.calls[0][0].data).toMatchObject({ job: 'qbo-posting', success: true, error: 'failed: expense' });
        expect(logged).toHaveBeenCalledWith('[qbo-posting] expense QuickBooks posting failed:', expect.any(Error));
        logged.mockRestore();
    });

    it('records the expense parts that failed and still runs the other steps', async () => {
        jest.mocked(runExpenseQbPosting).mockResolvedValue({ stranded: { checked: 0, failed: 0 }, qbPost: { error: true }, qbDrift: { error: true }, outcomeNotices: { sent: 0, failed: 0 }, failedParts: ['qbPost', 'qbDrift'] });

        const res = await GET(req());

        expect(res.status).toBe(200);
        expect(runDonationDepositHandOver).toHaveBeenCalledTimes(1);
        expect(create.mock.calls[0][0].data).toMatchObject({ job: 'qbo-posting', success: true, error: 'failed: expense qbPost, expense qbDrift' });
    });

    it('a throwing in-kind drain still runs income and records the failure', async () => {
        jest.mocked(runInKindQbPosting).mockRejectedValue(new Error('donation db down'));
        const logged = jest.spyOn(console, 'error').mockImplementation(() => {});

        const res = await GET(req());

        expect(res.status).toBe(200);
        expect(drainIncomeOutbox).toHaveBeenCalledTimes(1);
        expect(create.mock.calls[0][0].data).toMatchObject({ job: 'qbo-posting', success: true, error: 'failed: in-kind' });
        expect(logged).toHaveBeenCalledWith('[qbo-posting] in-kind QuickBooks posting failed:', expect.any(Error));
        logged.mockRestore();
    });

    it('a throwing income drain still runs the sweep and records the failure', async () => {
        jest.mocked(drainIncomeOutbox).mockRejectedValue(new Error('income db down'));
        const logged = jest.spyOn(console, 'error').mockImplementation(() => {});

        const res = await GET(req());

        expect(res.status).toBe(200);
        expect(runIncomeOrphanSweep).toHaveBeenCalledWith('org-1');
        expect(create.mock.calls[0][0].data).toMatchObject({ job: 'qbo-posting', success: true, error: 'failed: income' });
        expect(logged).toHaveBeenCalledWith('[qbo-posting] income QuickBooks posting failed:', expect.any(Error));
        logged.mockRestore();
    });

    it('records an expense duplicate check that could not read QuickBooks', async () => {
        jest.mocked(runExpenseQbPosting).mockResolvedValue(expensePosting({ ...EXPENSE_DRAIN, sweep: { failed: true } }));

        await GET(req());

        expect(create.mock.calls[0][0].data).toMatchObject({ success: true, error: 'failed: expense duplicate check' });
    });

    it('records an in-kind duplicate check that could not read QuickBooks', async () => {
        jest.mocked(runInKindQbPosting).mockResolvedValue({ ...IN_KIND_DRAIN, sweep: { failed: true } });

        await GET(req());

        expect(create.mock.calls[0][0].data).toMatchObject({ success: true, error: 'failed: in-kind duplicate check' });
    });

    it('skips a lane another run holds the slot for, leaving it to that run', async () => {
        jest.mocked(prisma.quickBooksPostingSlot.updateMany).mockResolvedValueOnce({ count: 0 });
        prisma.quickBooksPostingSlot.findUnique = jest.fn().mockResolvedValue({ orgId: 'org-1', holder: 'expense', runId: 'catch-up', until: new Date(Date.now() + 60_000), lastRuns: null });
        jest.spyOn(console, 'info').mockImplementation(() => {});

        await GET(req());

        expect(runExpenseQbPosting).not.toHaveBeenCalled();
        expect(runInKindQbPosting).toHaveBeenCalledTimes(1);
        expect(create.mock.calls[0][0].data).toMatchObject({ success: true, error: null });
    });

    it('records an unconfigured in-kind lane only while gifts wait', async () => {
        jest.mocked(runInKindQbPosting).mockResolvedValueOnce({ unconfigured: true, waiting: 0 }).mockResolvedValueOnce({ unconfigured: true, waiting: 2 });

        await GET(req());
        await GET(req());

        expect(create.mock.calls[0][0].data).toMatchObject({ success: true, error: null });
        expect(create.mock.calls[1][0].data).toMatchObject({ success: true, error: 'failed: in-kind unconfigured' });
    });

    it('records a lane throttled three runs in a row and a run that lapsed holding the slot as failures of the run', async () => {
        const lastRuns = {
            income: { endedAt: '2026-11-18T13:58:00.000Z', ended: 'yielded', created: 0, matched: 0, capped: null, yieldsInRow: 3 },
            expense: { endedAt: '2026-11-18T13:00:00.000Z', ended: 'expired', created: 0, matched: 0, capped: null, yieldsInRow: 0 },
            'in-kind': { endedAt: '2026-11-18T13:00:00.000Z', ended: 'yielded', created: 0, matched: 0, capped: null, yieldsInRow: 2 },
        };
        prisma.quickBooksPostingSlot.findUnique = jest.fn().mockResolvedValue({ orgId: 'org-1', holder: null, runId: null, until: new Date(0), lastRuns });

        await GET(req());

        expect(create.mock.calls[0][0].data).toMatchObject({
            success: true,
            error: 'failed: expense posting warning, income posting warning',
            failuresByKind: { system: 1, connection: 1 },
        });
    });
});
