/**
 * @jest-environment node
 */
/**
 * The cron run ledger against a real Postgres. The unit tests stub the two reads;
 * what only a real database proves is that the migration's columns match the Prisma
 * model, and that the latest-failure-per-job read (`distinct` over an ordered scan)
 * actually returns one row per job rather than the whole table.
 *
 * Also covers the write path end to end through withCron — the same wrapper all nine
 * /api/cron routes go through.
 */
import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { withCron } from '@/lib/cronAuth';
import { CRON_STALE_AFTER_MS, getCronJobStatuses, recordCronRun } from '@/lib/cronRuns';

const TAG = 'cron-runs-int';
const JOB_A = `${TAG}-alpha`;
const JOB_B = `${TAG}-beta`;
const SECRET = 'integration-cron-secret';

const HOUR = 60 * 60 * 1000;
const ago = (ms: number) => new Date(Date.now() - ms);

/** Statuses for this suite's jobs only — the DB may hold rows from other suites. */
const mine = async () => (await getCronJobStatuses()).filter((s) => s.job.startsWith(TAG));

describe('cron run ledger (real DB)', () => {
    const prevSecret = process.env.CRON_SECRET;

    beforeAll(() => {
        process.env.CRON_SECRET = SECRET;
    });

    afterAll(async () => {
        if (prevSecret === undefined) delete process.env.CRON_SECRET;
        else process.env.CRON_SECRET = prevSecret;
        await prisma.cronRunLog.deleteMany({ where: { job: { startsWith: TAG } } });
    });

    afterEach(async () => {
        await prisma.cronRunLog.deleteMany({ where: { job: { startsWith: TAG } } });
    });

    it('withCron writes a success row the status read can see', async () => {
        const handler = async () => NextResponse.json({ success: true, checkedOutCount: 0 });
        const req = new Request(`http://localhost/api/cron/${JOB_A}`, { headers: { authorization: `Bearer ${SECRET}` } });

        const res = await withCron(handler)(req);
        expect(res.status).toBe(200);

        const [status] = await mine();
        expect(status.job).toBe(JOB_A);
        expect(status.stale).toBe(false);
        expect(status.lastError).toBeUndefined();
    });

    it('withCron records a failure and still returns the 500', async () => {
        // Local suppression of the wrapper's own catch log — deliberately not a global
        // jest.setup.js allowlist entry, which would silence it in every cron test.
        const logged = jest.spyOn(console, 'error').mockImplementation(() => {});
        try {
            const handler = async (): Promise<NextResponse> => { throw new Error('sweep exploded'); };
            const req = new Request(`http://localhost/api/cron/${JOB_A}`, { headers: { authorization: `Bearer ${SECRET}` } });

            const res = await withCron(handler)(req);
            expect(res.status).toBe(500);

            const row = await prisma.cronRunLog.findFirstOrThrow({ where: { job: JOB_A } });
            expect(row).toMatchObject({ success: false, error: 'sweep exploded' });
        } finally {
            logged.mockRestore();
        }
    });

    it('reports only the newest failure per job, and only while it is unresolved', async () => {
        await prisma.cronRunLog.createMany({
            data: [
                // JOB_A: stale, and broken since — two failures, only the newest is reported.
                { job: JOB_A, startedAt: ago(CRON_STALE_AFTER_MS + 5 * HOUR), finishedAt: ago(CRON_STALE_AFTER_MS + 5 * HOUR), success: true },
                { job: JOB_A, startedAt: ago(3 * HOUR), finishedAt: ago(3 * HOUR), success: false, error: 'older failure' },
                { job: JOB_A, startedAt: ago(HOUR), finishedAt: ago(HOUR), success: false, error: 'newest failure' },
                // JOB_B: failed, then recovered — healthy, no error surfaced.
                { job: JOB_B, startedAt: ago(4 * HOUR), finishedAt: ago(4 * HOUR), success: false, error: 'recovered since' },
                { job: JOB_B, startedAt: ago(HOUR), finishedAt: ago(HOUR), success: true },
            ],
        });

        // Stalest first.
        expect(await mine()).toEqual([
            { job: JOB_A, lastSuccessAt: expect.any(Date), stale: true, lastError: 'newest failure' },
            { job: JOB_B, lastSuccessAt: expect.any(Date), stale: false },
        ]);
    });

    it('purges rows past the 90-day TTL on write', async () => {
        const ancient = ago(91 * 24 * HOUR);
        await prisma.cronRunLog.create({ data: { job: JOB_B, startedAt: ancient, finishedAt: ancient, success: true } });

        await recordCronRun(JOB_A, new Date(), true);

        expect(await prisma.cronRunLog.count({ where: { job: JOB_B } })).toBe(0);
        expect(await prisma.cronRunLog.count({ where: { job: JOB_A } })).toBe(1);
    });
});
