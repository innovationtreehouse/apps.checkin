/**
 * @jest-environment node
 */
/**
 * Health derivation for the cron run ledger. The DB half is two stubbed reads; what
 * is worth testing is the rule applied to their rows — one coarse staleness window
 * for every job, a job that has NEVER run is not reported as stale (the app can't
 * know whether infra schedules it at all), and above all that "did it run" and "did
 * it work" stay independent of each other.
 */
import prisma from '@/lib/prisma';
import { CRON_STALE_AFTER_MS, cronJobName, countUnhealthyCronJobs, getCronJobStatuses } from '@/lib/cronRuns';

const NOW = new Date('2026-08-06T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const HOUR = 60 * 60 * 1000;

/**
 * Stub the two reads: the last-completed-run aggregate, and the latest-run-per-job
 * scan the error is taken from. `latest` defaults to a clean run for every job.
 */
function stubGroupBy(
    rows: { job: string; finishedAt: Date | null }[],
    latest?: { job: string; success: boolean; error: string | null }[],
) {
    prisma.cronRunLog.groupBy = jest.fn().mockResolvedValue(
        rows.map((r) => ({ job: r.job, _max: { finishedAt: r.finishedAt } })),
    );
    prisma.cronRunLog.findMany = jest.fn().mockResolvedValue(
        latest ?? rows.map((r) => ({ job: r.job, success: true, error: null })),
    );
}

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
    it('marks a job stale once its last success is older than the window', async () => {
        stubGroupBy([{ job: 'nightly', finishedAt: ago(CRON_STALE_AFTER_MS + HOUR) }]);

        const statuses = await getCronJobStatuses(NOW);

        expect(statuses).toEqual([{ job: 'nightly', lastSuccessAt: ago(CRON_STALE_AFTER_MS + HOUR), stale: true }]);
    });

    it('leaves a healthy daily job alone — one missed run is inside the window', async () => {
        // 30h since the last success: a daily job that skipped one run. The window is
        // deliberately coarse enough that this must NOT alarm.
        stubGroupBy([{ job: 'nightly', finishedAt: ago(30 * HOUR) }]);

        expect((await getCronJobStatuses(NOW))[0].stale).toBe(false);
    });

    it('omits a job that has never recorded a successful run', async () => {
        // A route nothing schedules has no rows at all — absence of evidence is not a
        // missed run, and this is what stops the badge firing on all nine routes the
        // day the table ships.
        stubGroupBy([]);

        expect(await getCronJobStatuses(NOW)).toEqual([]);
        expect(await countUnhealthyCronJobs(NOW)).toBe(0);
    });

    it('puts the stalest job first and counts only the stale ones', async () => {
        stubGroupBy([
            { job: 'nightly', finishedAt: ago(CRON_STALE_AFTER_MS + HOUR) },
            { job: 'post-event', finishedAt: ago(2 * HOUR) },
            { job: 'reconcile-shopify', finishedAt: ago(10 * 24 * HOUR) },
        ]);

        const statuses = await getCronJobStatuses(NOW);

        expect(statuses.map((s) => s.job)).toEqual(['reconcile-shopify', 'nightly', 'post-event']);
        expect(statuses.filter((s) => s.stale).map((s) => s.job)).toEqual(['reconcile-shopify', 'nightly']);
        expect(await countUnhealthyCronJobs(NOW)).toBe(2);
    });

    it('reports the error of a job whose latest run failed outright', async () => {
        stubGroupBy(
            [{ job: 'nightly', finishedAt: ago(3 * 24 * HOUR) }],
            [{ job: 'nightly', success: false, error: 'connection refused' }],
        );

        expect(await getCronJobStatuses(NOW)).toEqual([
            { job: 'nightly', lastSuccessAt: ago(3 * 24 * HOUR), stale: true, lastError: 'connection refused' },
        ]);
    });

    it('drops a failure the job has since recovered from', async () => {
        // Latest run is clean, so the older failure is history rather than status.
        stubGroupBy([{ job: 'nightly', finishedAt: ago(2 * HOUR) }]);

        const [status] = await getCronJobStatuses(NOW);
        expect(status.lastError).toBeUndefined();
        expect(status.stale).toBe(false);
    });

    it('names a failure even when the ledger row recorded no message', async () => {
        // Guard: `error` is nullable, and a row that failed with nothing written must
        // still render a red line rather than silently reading as clean.
        stubGroupBy(
            [{ job: 'nightly', finishedAt: ago(3 * 24 * HOUR) }],
            [{ job: 'nightly', success: false, error: null }],
        );

        expect((await getCronJobStatuses(NOW))[0].lastError).toBe('unknown error');
    });
});

/**
 * The two signals are independent. A sweep that runs every night but cannot process
 * one poison row is NOT the same as a sweep that stopped running, and the ledger has
 * to say so: judging both off `success` alone freezes `lastSuccessAt` on the first
 * permanently-failing row, and the badge then calls a job that ran last night "not
 * running" for as long as the row stays broken.
 */
describe('a run that completed but could not do all of its work', () => {
    const partial = () =>
        stubGroupBy(
            [{ job: 'nightly', finishedAt: ago(2 * HOUR) }],
            [{ job: 'nightly', success: true, error: '1 item(s) failed' }],
        );

    it('is not stale — it ran, so lastSuccessAt keeps moving', async () => {
        partial();

        const [status] = await getCronJobStatuses(NOW);
        expect(status.stale).toBe(false);
        expect(status.lastSuccessAt).toEqual(ago(2 * HOUR));
    });

    it('still surfaces the error, so the panel does not read as healthy', async () => {
        partial();

        expect((await getCronJobStatuses(NOW))[0].lastError).toBe('1 item(s) failed');
    });

    it('counts toward the nav badge even though nothing is stale', async () => {
        // Without this the pill goes green on a nightly sweep that fails every row.
        partial();

        expect(await countUnhealthyCronJobs(NOW)).toBe(1);
    });

    it('is counted once when the job is BOTH stale and failing', async () => {
        stubGroupBy(
            [{ job: 'nightly', finishedAt: ago(CRON_STALE_AFTER_MS + HOUR) }],
            [{ job: 'nightly', success: false, error: 'connection refused' }],
        );

        expect(await countUnhealthyCronJobs(NOW)).toBe(1);
    });
});
