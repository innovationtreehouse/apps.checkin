/**
 * @jest-environment node
 */
/**
 * GET /api/cron/qbo-posting: admits only QBO_POSTING_CRON_SECRET, runs the expense, donation and
 * in-kind QuickBooks steps, income's drain and income's orphan sweep (each isolated), records the run, and answers `{}`.
 */
import type { NextRequest as NextRequestType } from 'next/server';
import { runExpenseQbPosting } from '@checkin/expense';
import { runDonationDepositHandOver, runInKindQbPosting } from '@checkin/bulk-donation';
import { drainIncomeOutbox, runIncomeOrphanSweep } from '@checkin/income';
import { authenticateRequest } from '@/lib/auth';
import prisma from '@/lib/prisma';
import { GET } from '../route';

jest.mock('@/lib/auth', () => ({ authenticateRequest: jest.fn() }));
jest.mock('@checkin/expense', () => ({ runExpenseQbPosting: jest.fn() }));
jest.mock('@checkin/bulk-donation', () => ({ runDonationDepositHandOver: jest.fn(), runInKindQbPosting: jest.fn() }));
jest.mock('@checkin/income', () => ({ drainIncomeOutbox: jest.fn(), runIncomeOrphanSweep: jest.fn() }));
jest.mock('@/lib/components/host', () => ({ getOrg: jest.fn().mockResolvedValue({ id: 'org-1', name: 'Org' }) }));
const { NextRequest } = jest.requireActual<{ NextRequest: typeof NextRequestType }>('next/server');

const SECRET = 'qbo-posting-secret-under-test';
const EXPENSE_DRAIN = { posted: 0, matched: 0, queued: 0, failed: 0, waiting: 0, not_sent: 0, needs_finance: 0, no_class: 0, unpostable: 0, outage: 0, disconnected: 0, waiting_on_settings: 0, refused: 0, capped: null, stoppedAfterFailures: false, stoppedOnConnection: false, refusalStop: null, closeDateRead: true, sweep: { entries: 0, flagged: 0, full: false } };
const IN_KIND_DRAIN = { posted: 0, matched: 0, unbooked: 0, needs_finance: 0, held: 0, exhausted: 0, failed: 0, connection: 0, settings: 0, waiting: 0, capped: false, stoppedAfterFailures: false, stopKind: null, refusalStop: null, closeDateRead: true, sweep: { entries: 0, flagged: 0, full: false }, drift: { checked: 0, drifted: 0 } };
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
        jest.mocked(runExpenseQbPosting).mockResolvedValue({ stranded: { checked: 0, failed: 0 }, qbPost: 'unbound', qbDrift: 'unbound', outcomeNotices: { sent: 0, failed: 0 }, failedParts: [] });
        jest.mocked(runDonationDepositHandOver).mockResolvedValue('unbound');
        jest.mocked(runInKindQbPosting).mockResolvedValue('unbound');
        jest.mocked(drainIncomeOutbox).mockResolvedValue({ reconcile: { status: 'unbound' }, post: 'unbound' });
        jest.mocked(runIncomeOrphanSweep).mockResolvedValue({ status: 'unbound' });
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
        expect(runInKindQbPosting).toHaveBeenCalledWith('org-1');
        expect(drainIncomeOutbox).toHaveBeenCalledWith('org-1');
        expect(runIncomeOrphanSweep).toHaveBeenCalledWith('org-1');
        expect(create).toHaveBeenCalledTimes(1);
        expect(create.mock.calls[0][0].data).toMatchObject({ job: 'qbo-posting', success: true, error: null });
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
        expect(drainIncomeOutbox).toHaveBeenCalledWith('org-1');
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

    it('records an expense drain stopped by its failure streak', async () => {
        jest.mocked(runExpenseQbPosting).mockResolvedValue(expensePosting({ ...EXPENSE_DRAIN, stoppedAfterFailures: true }));

        await GET(req());

        expect(create.mock.calls[0][0].data).toMatchObject({ success: true, error: 'failed: expense streak stop' });
    });

    it('records an expense duplicate check that could not read QuickBooks', async () => {
        jest.mocked(runExpenseQbPosting).mockResolvedValue(expensePosting({ ...EXPENSE_DRAIN, sweep: { failed: true } }));

        await GET(req());

        expect(create.mock.calls[0][0].data).toMatchObject({ success: true, error: 'failed: expense duplicate check' });
    });

    it('records an in-kind drain stopped by its streak whose duplicate check also failed', async () => {
        jest.mocked(runInKindQbPosting).mockResolvedValue({ ...IN_KIND_DRAIN, stoppedAfterFailures: true, sweep: { failed: true } });

        await GET(req());

        expect(create.mock.calls[0][0].data).toMatchObject({ success: true, error: 'failed: in-kind streak stop, in-kind duplicate check' });
    });

    it('records an unconfigured in-kind lane only while gifts wait', async () => {
        jest.mocked(runInKindQbPosting).mockResolvedValueOnce({ unconfigured: true, waiting: 0 }).mockResolvedValueOnce({ unconfigured: true, waiting: 2 });

        await GET(req());
        await GET(req());

        expect(create.mock.calls[0][0].data).toMatchObject({ success: true, error: null });
        expect(create.mock.calls[1][0].data).toMatchObject({ success: true, error: 'failed: in-kind unconfigured' });
    });
});
