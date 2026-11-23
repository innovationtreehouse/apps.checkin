/**
 * @jest-environment node
 */
/**
 * The cron run ledger against a real Postgres. The unit tests stub the two reads;
 * what only a real database proves is that the migration's columns match the Prisma
 * model, and that the latest-failure-per-job read (`distinct` over an ordered scan)
 * actually returns one row per job rather than the whole table.
 *
 * Also covers the write path end to end through withCron — the same wrapper every
 * /api/cron route goes through.
 */
import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { withCron } from '@/lib/cronAuth';
import { getCronJobStatuses, recordCronRun } from '@/lib/cronRuns';

const TAG = 'cron-runs-int';
const JOB_A = `${TAG}-alpha`;
const JOB_B = `${TAG}-beta`;
const SECRET = 'integration-cron-secret';

const HOUR = 60 * 60 * 1000;
const ago = (ms: number) => new Date(Date.now() - ms);

// JOB_A was last due on 2020-01-01; JOB_B has no schedule.
const DUE_A = new Date('2020-01-01T00:00:00.000Z');
const SCHEDULES = JSON.stringify([{ job: JOB_A, schedule: 'cron(0 0 1 1 ? 2020)', timezone: 'UTC' }]);

/** Statuses for this suite's jobs only — the DB may hold rows from other suites. */
const mine = async () => (await getCronJobStatuses()).filter((s) => s.job.startsWith(TAG));

describe('cron run ledger (real DB)', () => {
    const prevSecret = process.env.CRON_SECRET;
    const prevSchedules = process.env.CRON_SCHEDULES;

    beforeAll(() => {
        process.env.CRON_SECRET = SECRET;
        process.env.CRON_SCHEDULES = SCHEDULES;
    });

    afterAll(async () => {
        if (prevSecret === undefined) delete process.env.CRON_SECRET;
        else process.env.CRON_SECRET = prevSecret;
        if (prevSchedules === undefined) delete process.env.CRON_SCHEDULES;
        else process.env.CRON_SCHEDULES = prevSchedules;
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
        expect(status.late).toBe(false);
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
            // Never completed a run, so it is listed as failing rather than left off.
            expect(await mine()).toEqual([{ job: JOB_A, lastSuccessAt: null, lastDueAt: DUE_A, late: true, lastError: 'sweep exploded', lastErrorAt: expect.any(Date) }]);
        } finally {
            logged.mockRestore();
        }
    });

    it('reports only the newest failure per job, and only while it is unresolved', async () => {
        await prisma.cronRunLog.createMany({
            data: [
                // JOB_A: late, and broken since — two failures, only the newest is reported.
                { job: JOB_A, startedAt: new Date('2019-12-31T00:00:00.000Z'), finishedAt: new Date('2019-12-31T00:00:00.000Z'), success: true },
                { job: JOB_A, startedAt: ago(3 * HOUR), finishedAt: ago(3 * HOUR), success: false, error: 'older failure' },
                { job: JOB_A, startedAt: ago(HOUR), finishedAt: ago(HOUR), success: false, error: 'newest failure' },
                // JOB_B: failed, then recovered — healthy, no error surfaced.
                { job: JOB_B, startedAt: ago(4 * HOUR), finishedAt: ago(4 * HOUR), success: false, error: 'recovered since' },
                { job: JOB_B, startedAt: ago(HOUR), finishedAt: ago(HOUR), success: true },
            ],
        });

        // Oldest completed run first.
        const statuses = await mine();
        expect(statuses).toEqual([
            { job: JOB_A, lastSuccessAt: expect.any(Date), lastDueAt: DUE_A, late: true, lastError: 'newest failure', lastErrorAt: expect.any(Date) },
            { job: JOB_B, lastSuccessAt: expect.any(Date), lastDueAt: null, late: false },
        ]);
        expect(Math.abs((statuses[0].lastErrorAt?.getTime() ?? 0) - ago(HOUR).getTime())).toBeLessThan(60_000);
    });

    it('purges rows past the 90-day TTL on write', async () => {
        const ancient = ago(91 * 24 * HOUR);
        await prisma.cronRunLog.create({ data: { job: JOB_B, startedAt: ancient, finishedAt: ancient, success: true } });

        await recordCronRun(JOB_A, new Date(), true);

        expect(await prisma.cronRunLog.count({ where: { job: JOB_B } })).toBe(0);
        expect(await prisma.cronRunLog.count({ where: { job: JOB_A } })).toBe(1);
    });
});
