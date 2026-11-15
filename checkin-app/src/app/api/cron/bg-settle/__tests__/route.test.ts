/**
 * @jest-environment node
 */
/**
 * GET /api/cron/bg-settle: admits only BG_SETTLE_CRON_SECRET, runs the household
 * background-check catch-up, records the run, and answers `{}`.
 */
import type { NextRequest as NextRequestType } from 'next/server';
import { authenticateRequest } from '@/lib/auth';
import prisma from '@/lib/prisma';
import { settleApplicationsAwaitingCheck } from '@/lib/membership/settleHouseholdBg';
import { GET } from '../route';

jest.mock('@/lib/auth', () => ({ authenticateRequest: jest.fn() }));
// The incident engine has its own tests; here a run only reaches it.
jest.mock('@/lib/runIncidents', () => ({ evaluateRun: jest.fn() }));
jest.mock('@/lib/membership/settleHouseholdBg', () => ({ settleApplicationsAwaitingCheck: jest.fn() }));
const { NextRequest } = jest.requireActual<{ NextRequest: typeof NextRequestType }>('next/server');

const SECRET = 'bg-settle-secret-under-test';
const req = (secret = SECRET) =>
    new NextRequest('http://localhost/api/cron/bg-settle', { headers: { authorization: `Bearer ${secret}` } });

describe('GET /api/cron/bg-settle', () => {
    const prev = process.env.BG_SETTLE_CRON_SECRET;
    let create: jest.Mock;

    beforeEach(() => {
        jest.clearAllMocks();
        process.env.BG_SETTLE_CRON_SECRET = SECRET;
        jest.mocked(authenticateRequest).mockResolvedValue({ type: 'unauthenticated' });
        create = jest.fn().mockResolvedValue({});
        prisma.cronRunLog.create = create;
        prisma.cronRunLog.deleteMany = jest.fn().mockResolvedValue({ count: 0 });
        jest.mocked(settleApplicationsAwaitingCheck).mockResolvedValue({ households: 7, opened: 2, failed: 0 });
    });

    afterAll(() => {
        if (prev === undefined) delete process.env.BG_SETTLE_CRON_SECRET;
        else process.env.BG_SETTLE_CRON_SECRET = prev;
    });

    it('refuses a wrong secret with 401 and runs nothing', async () => {
        const res = await GET(req('not-the-secret'));

        expect(res.status).toBe(401);
        expect(settleApplicationsAwaitingCheck).not.toHaveBeenCalled();
        expect(create).not.toHaveBeenCalled();
    });

    it('runs the catch-up, records a clean run, and answers {}', async () => {
        const res = await GET(req());

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({});
        expect(settleApplicationsAwaitingCheck).toHaveBeenCalledTimes(1);
        expect(create.mock.calls[0][0].data).toMatchObject({ job: 'bg-settle', success: true, error: null });
    });

    it('records households that failed to settle as an error on a completed run', async () => {
        jest.mocked(settleApplicationsAwaitingCheck).mockResolvedValue({ households: 3, opened: 1, failed: 2 });

        expect((await GET(req())).status).toBe(200);
        expect(create.mock.calls[0][0].data).toMatchObject({ job: 'bg-settle', success: true, error: '2 item(s) failed' });
    });

    it('records a crashed run as not completed and answers 500', async () => {
        jest.mocked(settleApplicationsAwaitingCheck).mockRejectedValue(new Error('db down'));
        const logged = jest.spyOn(console, 'error').mockImplementation(() => {});

        expect((await GET(req())).status).toBe(500);
        expect(create.mock.calls[0][0].data).toMatchObject({ job: 'bg-settle', success: false });
        logged.mockRestore();
    });
});
