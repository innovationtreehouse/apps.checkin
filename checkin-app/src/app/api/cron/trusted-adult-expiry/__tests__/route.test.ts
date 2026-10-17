/**
 * @jest-environment node
 */
/**
 * Route-level auth-gate tests for GET /api/cron/trusted-adult-expiry.
 *
 * The sweep SERVICE (runExpirySweep) is unit-tested elsewhere; nothing exercised
 * the ROUTE's `requireCronSecret` gate or its success envelope. The service is
 * mocked here so this is a pure unit test (no DB): we only assert the gate
 * (missing / wrong secret → 401) and the 200 envelope when authorized.
 *
 * withCron also stamps the run into CronRunLog, so prisma.cronRunLog is stubbed
 * below. It is stubbed rather than allowlisted in jest.setup.js on purpose: the
 * default prisma mock REJECTS an unstubbed call, recordCronRun swallows that, and
 * a global console.error allowlist would let the write fail unnoticed in every
 * cron route test. Stubbing keeps the failure loud and lets us assert the stamp.
 */
import { GET } from '../route';
import prisma from '@/lib/prisma';

jest.mock('@/lib/trusted-adult/service', () => ({
    runExpirySweep: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { runExpirySweep } = require('@/lib/trusted-adult/service');

const SECRET = 'cron-secret-under-test';

function req(authHeader?: string) {
    return new Request('http://localhost/api/cron/trusted-adult-expiry', {
        method: 'GET',
        ...(authHeader ? { headers: { authorization: authHeader } } : {}),
    });
}

describe('GET /api/cron/trusted-adult-expiry — auth gate', () => {
    const prev = process.env.CRON_SECRET;
    let recordRun: jest.Mock;

    beforeEach(() => {
        jest.clearAllMocks();
        process.env.CRON_SECRET = SECRET;
        recordRun = jest.fn().mockResolvedValue({});
        prisma.cronRunLog.create = recordRun;
        prisma.cronRunLog.deleteMany = jest.fn().mockResolvedValue({ count: 0 });
    });

    afterAll(() => {
        if (prev === undefined) delete process.env.CRON_SECRET;
        else process.env.CRON_SECRET = prev;
    });

    it('401 when the Authorization header is missing', async () => {
        const res = await GET(req());
        expect(res.status).toBe(401);
        expect(runExpirySweep).not.toHaveBeenCalled();
        // A rejected call is not a run.
        expect(recordRun).not.toHaveBeenCalled();
    });

    it('401 when the bearer secret is wrong', async () => {
        const res = await GET(req('Bearer not-the-secret'));
        expect(res.status).toBe(401);
        expect(runExpirySweep).not.toHaveBeenCalled();
    });

    it('200 with the success envelope when the secret is correct', async () => {
        (runExpirySweep as jest.Mock).mockResolvedValue({ warned: 2, expired: 1 });

        const res = await GET(req(`Bearer ${SECRET}`));
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toEqual({ success: true, warned: 2, expired: 1 });
        expect(runExpirySweep).toHaveBeenCalledTimes(1);
        // The run is stamped for the System Status panel / stale-job badge.
        expect(recordRun).toHaveBeenCalledTimes(1);
        expect(recordRun.mock.calls[0][0].data).toMatchObject({ job: 'trusted-adult-expiry', success: true });
    });
});
