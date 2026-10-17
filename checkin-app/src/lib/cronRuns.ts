import prisma from "./prisma";

/**
 * How long a job may go without a successful run before it counts as stale.
 *
 * ONE coarse constant for every job, deliberately — there is no per-job schedule
 * here and there must not be one. The schedule and the caller live in a separate
 * infra repository (an EventBridge rule invoking a Lambda that calls the route),
 * so any expected-interval table copied into this repo would rot the moment
 * someone retimes a job there, and would then either cry wolf or go quiet. 48h is
 * picked to be unfalsifiable in both directions: generous enough that a daily job
 * can miss a run, a deploy window, or a clock skew without alarming, and strict
 * enough that a job which genuinely stopped surfaces within two days.
 */
export const CRON_STALE_AFTER_MS = 48 * 60 * 60 * 1000;

/**
 * Two independent signals per job, because "did it run" and "did it work" are
 * different questions and one boolean cannot answer both:
 *   - `lastSuccessAt`/`stale` — did the sweep RUN. Only a run that never completed
 *     (a throw, or the route's own error envelope) holds this back.
 *   - `lastError` — was the latest run CLEAN. Set from that run's error, so a sweep
 *     that ran last night and failed 4 rows reads as fresh-but-unhealthy rather
 *     than as stopped. A failure the job has since recovered from is history, not
 *     a status: the next clean run clears it.
 */
export type CronJobStatus = { job: string; lastSuccessAt: Date; stale: boolean; lastError?: string };

/** Route slug for the run ledger: the last path segment of /api/cron/<job>. */
export function cronJobName(url: string): string {
    const path = new URL(url).pathname.replace(/\/+$/, "");
    return path.slice(path.lastIndexOf("/") + 1) || "unknown";
}

/**
 * Records one completed cron run, then purges rows older than 90 days.
 *
 * `success` means the run COMPLETED, not that it was clean — pass an `error`
 * alongside `success: true` for a sweep that finished but could not process every
 * row. See {@link CronJobStatus}.
 *
 * Never throws and never rethrows: recording that a job ran must not change
 * whether the job ran or what it returned. A failed write degrades the System
 * Status panel, not the sweep.
 *
 * ponytail: the TTL purge runs inline on each write rather than from its own
 * sweep — writes are ~9/day, and a cron to prune the cron log would be the exact
 * circularity this table exists to detect. Same pattern as logIntegrationError.
 */
export async function recordCronRun(job: string, startedAt: Date, success: boolean, error?: unknown) {
    try {
        await prisma.cronRunLog.create({
            data: {
                job,
                startedAt,
                success,
                error: error === undefined ? null : error instanceof Error ? error.message : String(error),
            },
        });

        const ninetyDaysAgo = new Date();
        ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
        await prisma.cronRunLog.deleteMany({ where: { finishedAt: { lt: ninetyDaysAgo } } });
    } catch (writeError) {
        console.error("Failed to record cron run:", writeError);
    }
}

/**
 * Most recent COMPLETED run per job — the "did it run" half. A partial sweep counts:
 * it ran, so it must not read as stopped. Whether it was clean is {@link lastRunByJob}.
 *
 * Only jobs with a recorded success appear. A route that has never run is not
 * reported as stale, because the app has no way to know whether infra schedules
 * it at all — absence of evidence isn't a missed run, and it also keeps the badge
 * from firing on all nine routes the moment this table ships. The corollary: a job
 * that stops and stays stopped drops off the list once the 90-day purge takes its
 * last success, long after the badge has been red about it.
 */
async function lastSuccessByJob(): Promise<Map<string, Date>> {
    const rows = await prisma.cronRunLog.groupBy({
        by: ["job"],
        where: { success: true },
        _max: { finishedAt: true },
    });

    const out = new Map<string, Date>();
    for (const r of rows) if (r._max.finishedAt) out.set(r.job, r._max.finishedAt);
    return out;
}

/**
 * Latest run per job whatever its outcome — the "did it work" half. Read for its
 * `error`, which a partial sweep sets while still recording a completed run.
 *
 * `distinct` after an ordered scan rather than a correlated subquery: the table is
 * ~one row per job per day under a 90-day TTL, so there is nothing worth optimising.
 */
async function lastRunByJob() {
    const rows = await prisma.cronRunLog.findMany({
        orderBy: [{ job: "asc" }, { finishedAt: "desc" }],
        distinct: ["job"],
        select: { job: true, success: true, error: true },
    });
    return new Map(rows.map((r) => [r.job, r]));
}

/**
 * Every job that has ever completed a run, most-stale first so the problems are at
 * the top of the panel. Carries the latest run's error — a red row that names what
 * broke is actionable; one that only says "stopped" sends the reader to CloudWatch.
 *
 * The two halves are read independently on purpose: a sweep that ran last night and
 * failed 4 of 200 rows gets a fresh `lastSuccessAt` AND a `lastError`. Judging both
 * off one flag is what let "9 of 10 rows processed" render as "job not running".
 */
export async function getCronJobStatuses(now: Date = new Date()): Promise<CronJobStatus[]> {
    const [successes, latestRuns] = await Promise.all([lastSuccessByJob(), lastRunByJob()]);

    return [...successes.entries()]
        .map(([job, lastSuccessAt]) => {
            // Only the LATEST run's error is a status; the next clean run clears it.
            const latest = latestRuns.get(job);
            const unclean = latest && (latest.error !== null || !latest.success);
            return {
                job,
                lastSuccessAt,
                stale: now.getTime() - lastSuccessAt.getTime() > CRON_STALE_AFTER_MS,
                ...(unclean ? { lastError: latest.error ?? "unknown error" } : {}),
            };
        })
        .sort((a, b) => a.lastSuccessAt.getTime() - b.lastSuccessAt.getTime());
}

/**
 * Count of jobs needing attention — the nav-badge number. BOTH halves: a job that
 * stopped running, and a job that runs nightly but cannot finish its work. Counting
 * only staleness is what let a sweep fail every row forever behind a green pill.
 *
 * ponytail: shares getCronJobStatuses' two reads rather than keeping a leaner
 * aggregate for the nav-poll path — the panel's "failure detail" IS half the badge
 * now, so a second query shape would only be the same reads spelled twice.
 */
export async function countUnhealthyCronJobs(now: Date = new Date()): Promise<number> {
    return (await getCronJobStatuses(now)).filter((j) => j.stale || j.lastError).length;
}
