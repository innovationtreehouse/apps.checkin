/**
 * @jest-environment node
 */
/**
 * GET /api/cron/person-bg-annual: admits only CRON_SECRET and runs the annual
 * PERSON_BG sweep alone; the household catch-up belongs to /api/cron/bg-settle.
 */
import prisma from '@/lib/prisma';
import { runPersonBgAnnualSweep } from '@/lib/membership/personBgTriggers';
import { settleApplicationsAwaitingCheck } from '@/lib/membership/settleHouseholdBg';
import { GET } from '../route';

jest.mock('@/lib/membership/personBgTriggers', () => ({ runPersonBgAnnualSweep: jest.fn() }));
jest.mock('@/lib/membership/settleHouseholdBg', () => ({ settleApplicationsAwaitingCheck: jest.fn() }));

const SECRET = 'cron-secret-under-test';
const req = (secret = SECRET) =>
    new Request('http://localhost/api/cron/person-bg-annual', { headers: { authorization: `Bearer ${secret}` } });

describe('GET /api/cron/person-bg-annual', () => {
    const prev = process.env.CRON_SECRET;

    beforeEach(() => {
        jest.clearAllMocks();
        process.env.CRON_SECRET = SECRET;
        prisma.cronRunLog.create = jest.fn().mockResolvedValue({});
        prisma.cronRunLog.deleteMany = jest.fn().mockResolvedValue({ count: 0 });
        jest.mocked(runPersonBgAnnualSweep).mockResolvedValue({ opened: 3, boundary: '2026-09-01T00:00:00.000Z' });
    });

    afterAll(() => {
        if (prev === undefined) delete process.env.CRON_SECRET;
        else process.env.CRON_SECRET = prev;
    });

    it('refuses a wrong secret with 401 and runs nothing', async () => {
        expect((await GET(req('not-the-secret'))).status).toBe(401);
        expect(runPersonBgAnnualSweep).not.toHaveBeenCalled();
    });

    it('runs the sweep only, never the household catch-up', async () => {
        const res = await GET(req());

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ success: true, opened: 3, boundary: '2026-09-01T00:00:00.000Z' });
        expect(runPersonBgAnnualSweep).toHaveBeenCalledTimes(1);
        expect(settleApplicationsAwaitingCheck).not.toHaveBeenCalled();
    });
});
