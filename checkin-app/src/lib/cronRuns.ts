import prisma from "./prisma";
import { CRON_LATE_GRACE_MS, lastDueAt, readCronSchedules } from "./cronSchedules";

/**
 * Two independent signals per job, because "did it run" and "did it work" are
 * different questions and one boolean cannot answer both:
 *   - `late` — did the sweep RUN when infra last called it. True when it has no completed run
 *     since its last due time (`lastDueAt`) plus {@link CRON_LATE_GRACE_MS}, including a job
 *     that has never run. `lastDueAt` is null, and `late` false, when the schedule is unknown:
 *     `CRON_SCHEDULES` unset or unreadable, or the job not listed in it.
 *   - `lastError` — was the latest run CLEAN. Set from that run's error, or from its
 *     failures by kind other than `data`, so a sweep that ran last night and failed
 *     4 rows reads as on-time-but-unhealthy rather than as late. The next clean run clears it.
 */
export type CronJobStatus = {
    job: string;
    lastSuccessAt: Date | null;
    lastDueAt: Date | null;
    late: boolean;
    lastError?: string;
    lastErrorAt?: Date;
};

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
 * row. See {@link CronJobStatus}. `failuresByKind` counts the run's failed items per failure kind.
 *
 * Never throws and never rethrows: recording that a job ran must not change
 * whether the job ran or what it returned. A failed write degrades the System
 * Status panel, not the sweep.
 *
 * ponytail: the TTL purge runs inline on each write rather than from its own
 * sweep — writes are ~9/day, and a cron to prune the cron log would be the exact
 * circularity this table exists to detect. Same pattern as logIntegrationError.
 */
export async function recordCronRun(job: string, startedAt: Date, success: boolean, error?: unknown, failuresByKind?: Record<string, number>) {
    try {
        await prisma.cronRunLog.create({
            data: {
                job,
                startedAt,
                success,
                error: error === undefined ? null : error instanceof Error ? error.message : String(error),
                ...(failuresByKind ? { failuresByKind } : {}),
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
 * it ran, so it must not read as late. Whether it was clean is {@link lastRunByJob}.
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
        select: { job: true, success: true, error: true, failuresByKind: true, finishedAt: true },
    });
    return new Map(rows.map((r) => [r.job, r]));
}

/**
 * The latest run's failures by kind as an error, e.g. "3 item(s) failed: connection 2, system 1",
 * or null when it has none. `data` failures wait in finance's queue, so they do not count.
 */
export function failuresError(failuresByKind: unknown): string | null {
    if (!failuresByKind || typeof failuresByKind !== "object" || Array.isArray(failuresByKind)) return null;
    const counts = Object.entries(failuresByKind).filter(
        (entry): entry is [string, number] => entry[0] !== "data" && typeof entry[1] === "number" && entry[1] > 0,
    );
    if (counts.length === 0) return null;
    const total = counts.reduce((sum, [, n]) => sum + n, 0);
    return `${total} item(s) failed: ${counts.map(([kind, n]) => `${kind} ${n}`).join(", ")}`;
}

/**
 * Every job that is scheduled or has recorded a run: those with no completed run first, then
 * by last completed run, oldest first. Carries the latest run's error — a red row that names what
 * broke is actionable; one that only says "late" sends the reader to CloudWatch.
 *
 * The two halves are read independently on purpose: a sweep that ran last night and
 * failed 4 of 200 rows gets a fresh `lastSuccessAt` AND a `lastError`.
 */
export async function getCronJobStatuses(now: Date = new Date()): Promise<CronJobStatus[]> {
    const [successes, latestRuns] = await Promise.all([lastSuccessByJob(), lastRunByJob()]);
    const source = readCronSchedules();
    const schedules = new Map(source.kind === "ok" ? source.schedules.map((s) => [s.job, s]) : []);
    const jobs = new Set([...schedules.keys(), ...latestRuns.keys(), ...successes.keys()]);

    return [...jobs]
        .map((job): CronJobStatus => {
            const lastSuccessAt = successes.get(job) ?? null;
            const schedule = schedules.get(job);
            const dueAt = schedule ? lastDueAt(schedule, now) : null;
            const late = dueAt !== null && now.getTime() > dueAt.getTime() + CRON_LATE_GRACE_MS && (lastSuccessAt === null || lastSuccessAt < dueAt);
            // Only the LATEST run's error is a status; the next clean run clears it.
            const latest = latestRuns.get(job);
            const failures = latest ? failuresError(latest.failuresByKind) : null;
            const unclean = latest && (latest.error !== null || !latest.success || failures !== null);
            return {
                job,
                lastSuccessAt,
                lastDueAt: dueAt,
                late,
                ...(unclean ? { lastError: latest.error ?? failures ?? "unknown error", lastErrorAt: latest.finishedAt } : {}),
            };
        })
        .sort((a, b) => (a.lastSuccessAt?.getTime() ?? -Infinity) - (b.lastSuccessAt?.getTime() ?? -Infinity) || a.job.localeCompare(b.job));
}

/**
 * Count of jobs needing attention — the nav-badge number. BOTH halves: a late job,
 * and a job that runs nightly but cannot finish its work. Counting only lateness
 * would let a sweep fail every row forever behind a green pill.
 *
 * ponytail: shares getCronJobStatuses' two reads rather than keeping a leaner
 * aggregate for the nav-poll path — the panel's "failure detail" IS half the badge,
 * so a second query shape would only be the same reads spelled twice.
 */
export async function countUnhealthyCronJobs(now: Date = new Date()): Promise<number> {
    return (await getCronJobStatuses(now)).filter((j) => j.late || j.lastError).length;
}
