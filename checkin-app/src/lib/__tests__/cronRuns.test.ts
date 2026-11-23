/**
 * @jest-environment node
 */
/**
 * Health derivation for the cron run ledger. The DB half is two stubbed reads; what
 * is worth testing is the rule applied to their rows — a job is late against the
 * schedule in CRON_SCHEDULES, not against a fixed window, a job with no known schedule
 * is never late, and "did it run" and "did it work" stay independent of each other.
 */
import prisma from '@/lib/prisma';
import { cronJobName, countUnhealthyCronJobs, getCronJobStatuses } from '@/lib/cronRuns';

// 12:00 UTC: today's 09:00 UTC run is three hours old, one hour past its grace.
const NOW = new Date('2026-08-06T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const HOUR = 60 * 60 * 1000;
const DUE = new Date('2026-08-06T09:00:00.000Z');

const schedule = (job: string, expression = 'cron(0 9 * * ? *)', timezone = 'UTC') => ({ job, schedule: expression, timezone });
const setSchedules = (list: ReturnType<typeof schedule>[] | undefined) => {
    if (list === undefined) delete process.env.CRON_SCHEDULES;
    else process.env.CRON_SCHEDULES = JSON.stringify(list);
};

/**
 * Stub the two reads: the last-completed-run aggregate, and the latest-run-per-job
 * scan the error is taken from. `latest` defaults to a clean run for every job.
 */
function stubGroupBy(
    rows: { job: string; finishedAt: Date | null }[],
    latest?: { job: string; success: boolean; error: string | null; finishedAt?: Date | null; failuresByKind?: Record<string, number> | null }[],
) {
    prisma.cronRunLog.groupBy = jest.fn().mockResolvedValue(
        rows.map((r) => ({ job: r.job, _max: { finishedAt: r.finishedAt } })),
    );
    prisma.cronRunLog.findMany = jest.fn().mockResolvedValue(
        latest ?? rows.map((r) => ({ job: r.job, success: true, error: null, finishedAt: r.finishedAt })),
    );
}

const previousSchedules = process.env.CRON_SCHEDULES;
afterAll(() => {
    if (previousSchedules === undefined) delete process.env.CRON_SCHEDULES;
    else process.env.CRON_SCHEDULES = previousSchedules;
});
beforeEach(() => setSchedules([schedule('nightly')]));

describe('cronJobName', () => {
    it('takes the last path segment and ignores the query string', () => {
        expect(cronJobName('http://localhost/api/cron/nightly')).toBe('nightly');
        expect(cronJobName('https://app.example.org/api/cron/post-event?force=1')).toBe('post-event');
    });

    it('tolerates a trailing slash', () => {
        expect(cronJobName('http://localhost/api/cron/nightly/')).toBe('nightly');
    });
});

describe('getCronJobStatuses', () => {
    it('is late when it was due and has not run since, past the grace', async () => {
        stubGroupBy([{ job: 'nightly', finishedAt: ago(27 * HOUR) }]);

        expect(await getCronJobStatuses(NOW)).toEqual([{ job: 'nightly', lastSuccessAt: ago(27 * HOUR), lastDueAt: DUE, late: true }]);
        expect(await countUnhealthyCronJobs(NOW)).toBe(1);
    });

    it('is not late inside the grace after the due time', async () => {
        stubGroupBy([{ job: 'nightly', finishedAt: ago(27 * HOUR) }]);

        expect((await getCronJobStatuses(new Date('2026-08-06T10:59:00.000Z')))[0].late).toBe(false);
    });

    it('is not late when it ran after it was due', async () => {
        stubGroupBy([{ job: 'nightly', finishedAt: ago(2.5 * HOUR) }]);

        expect(await getCronJobStatuses(NOW)).toEqual([{ job: 'nightly', lastSuccessAt: ago(2.5 * HOUR), lastDueAt: DUE, late: false }]);
        expect(await countUnhealthyCronJobs(NOW)).toBe(0);
    });

    it('is late when a scheduled job has never run', async () => {
        stubGroupBy([]);

        expect(await getCronJobStatuses(NOW)).toEqual([{ job: 'nightly', lastSuccessAt: null, lastDueAt: DUE, late: true }]);
        expect(await countUnhealthyCronJobs(NOW)).toBe(1);
    });

    it('judges a Chicago schedule in Chicago time across the change from daylight saving', async () => {
        // 22:50 Chicago is 03:50 UTC under CDT and 04:50 UTC under CST; DST ends 2026-11-01.
        setSchedules([schedule('nightly', 'cron(50 22 * * ? *)', 'America/Chicago')]);
        const ranAt = new Date('2026-11-01T03:55:00.000Z');
        stubGroupBy([{ job: 'nightly', finishedAt: ranAt }]);

        const before = await getCronJobStatuses(new Date('2026-11-02T06:00:00.000Z'));
        expect(before[0]).toMatchObject({ lastDueAt: new Date('2026-11-02T04:50:00.000Z'), late: false });

        const after = await getCronJobStatuses(new Date('2026-11-02T07:00:00.000Z'));
        expect(after[0]).toMatchObject({ lastDueAt: new Date('2026-11-02T04:50:00.000Z'), late: true });
    });

    it('judges nothing late while CRON_SCHEDULES is unset, however long ago the job ran', async () => {
        setSchedules(undefined);
        stubGroupBy([{ job: 'nightly', finishedAt: ago(30 * 24 * HOUR) }]);

        expect(await getCronJobStatuses(NOW)).toEqual([{ job: 'nightly', lastSuccessAt: ago(30 * 24 * HOUR), lastDueAt: null, late: false }]);
        expect(await countUnhealthyCronJobs(NOW)).toBe(0);
    });

    it('judges nothing late while CRON_SCHEDULES is malformed', async () => {
        process.env.CRON_SCHEDULES = '[{"job":"nightly"}]';
        stubGroupBy([{ job: 'nightly', finishedAt: ago(30 * 24 * HOUR) }]);

        expect((await getCronJobStatuses(NOW))[0]).toMatchObject({ lastDueAt: null, late: false });
    });

    it('judges a job with runs but no schedule as never late', async () => {
        stubGroupBy([
            { job: 'nightly', finishedAt: ago(HOUR) },
            { job: 'bg-settle', finishedAt: ago(30 * 24 * HOUR) },
        ]);

        expect((await getCronJobStatuses(NOW)).find((s) => s.job === 'bg-settle')).toMatchObject({ lastDueAt: null, late: false });
    });

    it('puts jobs with no completed run first, then the oldest run', async () => {
        setSchedules([schedule('nightly'), schedule('post-event'), schedule('reconcile-shopify'), schedule('qbo-posting')]);
        stubGroupBy([
            { job: 'nightly', finishedAt: ago(27 * HOUR) },
            { job: 'post-event', finishedAt: ago(2 * HOUR) },
            { job: 'reconcile-shopify', finishedAt: ago(10 * 24 * HOUR) },
        ]);

        const statuses = await getCronJobStatuses(NOW);

        expect(statuses.map((s) => s.job)).toEqual(['qbo-posting', 'reconcile-shopify', 'nightly', 'post-event']);
        expect(statuses.filter((s) => s.late).map((s) => s.job)).toEqual(['qbo-posting', 'reconcile-shopify', 'nightly']);
        expect(await countUnhealthyCronJobs(NOW)).toBe(3);
    });

    it('reports the error of a job whose latest run failed outright', async () => {
        stubGroupBy(
            [{ job: 'nightly', finishedAt: ago(3 * 24 * HOUR) }],
            [{ job: 'nightly', success: false, error: 'connection refused', finishedAt: ago(HOUR) }],
        );

        expect(await getCronJobStatuses(NOW)).toEqual([
            { job: 'nightly', lastSuccessAt: ago(3 * 24 * HOUR), lastDueAt: DUE, late: true, lastError: 'connection refused', lastErrorAt: ago(HOUR) },
        ]);
    });

    it('drops a failure the job has since recovered from', async () => {
        stubGroupBy([{ job: 'nightly', finishedAt: ago(2 * HOUR) }]);

        const [status] = await getCronJobStatuses(NOW);
        expect(status.lastError).toBeUndefined();
        expect(status.late).toBe(false);
    });

    it('names a failure even when the ledger row recorded no message', async () => {
        // `error` is nullable; a row that failed with nothing written still renders a red line.
        stubGroupBy(
            [{ job: 'nightly', finishedAt: ago(3 * 24 * HOUR) }],
            [{ job: 'nightly', success: false, error: null }],
        );

        expect((await getCronJobStatuses(NOW))[0].lastError).toBe('unknown error');
    });

    it('lists a job that has runs but never completed one as failing, first', async () => {
        stubGroupBy(
            [{ job: 'nightly', finishedAt: ago(2 * HOUR) }],
            [
                { job: 'new-job', success: false, error: 'boom', finishedAt: ago(HOUR) },
                { job: 'nightly', success: true, error: null, finishedAt: ago(2 * HOUR) },
            ],
        );

        expect(await getCronJobStatuses(NOW)).toEqual([
            { job: 'new-job', lastSuccessAt: null, lastDueAt: null, late: false, lastError: 'boom', lastErrorAt: ago(HOUR) },
            { job: 'nightly', lastSuccessAt: ago(2 * HOUR), lastDueAt: DUE, late: false },
        ]);
        expect(await countUnhealthyCronJobs(NOW)).toBe(1);
    });
});

/**
 * The two signals are independent. A sweep that runs every night but cannot process
 * one poison row is NOT the same as a late sweep, and the ledger has
 * to say so: a job that ran last night must not read as late for as long as one row
 * stays broken.
 */
describe('a run that completed but could not do all of its work', () => {
    const partial = () =>
        stubGroupBy(
            [{ job: 'nightly', finishedAt: ago(2 * HOUR) }],
            [{ job: 'nightly', success: true, error: '1 item(s) failed', finishedAt: ago(2 * HOUR) }],
        );

    it('is not late — it ran, so lastSuccessAt keeps moving', async () => {
        partial();

        const [status] = await getCronJobStatuses(NOW);
        expect(status.late).toBe(false);
        expect(status.lastSuccessAt).toEqual(ago(2 * HOUR));
    });

    it('still surfaces the error, so the panel does not read as healthy', async () => {
        partial();

        expect((await getCronJobStatuses(NOW))[0].lastError).toBe('1 item(s) failed');
    });

    it('carries when that run finished', async () => {
        partial();

        expect((await getCronJobStatuses(NOW))[0].lastErrorAt).toEqual(ago(2 * HOUR));
    });

    it('counts toward the nav badge even though nothing is late', async () => {
        // Without this the pill goes green on a nightly sweep that fails every row.
        partial();

        expect(await countUnhealthyCronJobs(NOW)).toBe(1);
    });

    it('is counted once when the job is BOTH late and failing', async () => {
        stubGroupBy(
            [{ job: 'nightly', finishedAt: ago(30 * HOUR) }],
            [{ job: 'nightly', success: false, error: 'connection refused' }],
        );

        expect(await countUnhealthyCronJobs(NOW)).toBe(1);
    });

    it('is failing when its lanes reported failures other than data, even with no error', async () => {
        const run = (failuresByKind: Record<string, number>) => stubGroupBy(
            [{ job: 'nightly', finishedAt: ago(2 * HOUR) }],
            [{ job: 'nightly', success: true, error: null, finishedAt: ago(2 * HOUR), failuresByKind }],
        );

        run({ connection: 2, system: 1, data: 5 });
        expect((await getCronJobStatuses(NOW))[0].lastError).toBe('3 item(s) failed: connection 2, system 1');
        expect(await countUnhealthyCronJobs(NOW)).toBe(1);

        run({ data: 5 });
        expect((await getCronJobStatuses(NOW))[0].lastError).toBeUndefined();
        expect(await countUnhealthyCronJobs(NOW)).toBe(0);
    });
});
