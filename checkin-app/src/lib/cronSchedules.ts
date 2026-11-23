import { Cron } from "croner";

/** How long after a job's due time it may still finish before it counts as late. */
export const CRON_LATE_GRACE_MS = 2 * 60 * 60 * 1000;

/** The route names under src/app/api/cron/; `cronSchedules.test.ts` fails when this drifts from the directories. */
export const CRON_ROUTES = [
    "bg-settle",
    "lifecycle-reconcile",
    "nightly",
    "pending-participants",
    "post-event",
    "qbo-posting",
    "reconcile-shopify",
    "trusted-adult-expiry",
] as const;

/** One job's schedule as infra runs it: `schedule` is an AWS `cron(...)` expression. */
export interface CronSchedule {
    job: string;
    schedule: string;
    timezone: string;
}

/** `CRON_SCHEDULES` as read: unset (schedules unknown), unreadable as a whole, or the list. */
export type CronScheduleSource =
    | { kind: "unset" }
    | { kind: "malformed"; reason: string }
    | { kind: "ok"; schedules: CronSchedule[] };

/**
 * An AWS six-field cron expression (minute hour day-of-month month day-of-week year) as a croner
 * seven-field pattern, with a zero seconds field in front. Throws on any other form.
 */
export function awsCronToCroner(expression: string): string {
    const body = /^cron\((.*)\)$/.exec(expression.trim())?.[1];
    if (body === undefined) throw new Error(`"${expression}" is not a cron(...) expression`);
    const fields = body.trim().split(/\s+/);
    if (fields.length !== 6) throw new Error(`"${expression}" has ${fields.length} fields, not 6`);
    return `0 ${fields.join(" ")}`;
}

/** The croner job for one schedule; it only computes times and never runs anything. */
function cronFor(s: Pick<CronSchedule, "schedule" | "timezone">): Cron {
    return new Cron(awsCronToCroner(s.schedule), { timezone: s.timezone, alternativeWeekdays: true, mode: "7-part", paused: true });
}

/** The latest time at or before `now` that the schedule was due, or null when it has never been due. */
export function lastDueAt(s: Pick<CronSchedule, "schedule" | "timezone">, now: Date): Date | null {
    return cronFor(s).previousRuns(1, now)[0] ?? null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Why one entry cannot be used, or null when it can. */
function entryProblem(entry: unknown, index: number): string | null {
    if (!isRecord(entry)) return `entry ${index + 1} is not an object`;
    const { job, schedule, timezone } = entry;
    if (typeof job !== "string" || !job) return `entry ${index + 1} has no job`;
    if (typeof schedule !== "string" || typeof timezone !== "string") return `${job} needs a schedule and a timezone`;
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: timezone });
        cronFor({ schedule, timezone });
    } catch (err) {
        return `${job}: ${err instanceof Error ? err.message : String(err)}`;
    }
    return null;
}

/** Reads `CRON_SCHEDULES`; one bad entry makes the whole value malformed, so no schedule is guessed at. */
export function readCronSchedules(raw: string | undefined = process.env.CRON_SCHEDULES): CronScheduleSource {
    if (raw === undefined || raw.trim() === "") return { kind: "unset" };
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return { kind: "malformed", reason: "it is not JSON" };
    }
    if (!Array.isArray(parsed)) return { kind: "malformed", reason: "it is not a list" };
    const problem = parsed.map(entryProblem).find((p) => p !== null);
    if (problem) return { kind: "malformed", reason: problem };
    const schedules = parsed as CronSchedule[];
    const repeated = schedules.find((s, i) => schedules.findIndex((t) => t.job === s.job) !== i);
    if (repeated) return { kind: "malformed", reason: `${repeated.job} is listed twice` };
    return { kind: "ok", schedules: schedules.map(({ job, schedule, timezone }) => ({ job, schedule, timezone })) };
}

/** The Problems lines for the schedule list: unreadable, a route with no schedule, a schedule with no route. */
export function cronScheduleNotices(source: CronScheduleSource = readCronSchedules()): string[] {
    if (source.kind === "unset") return [];
    if (source.kind === "malformed") return [`The scheduled-job list (CRON_SCHEDULES) can't be read: ${source.reason}. No job is judged late.`];
    const scheduled = new Set(source.schedules.map((s) => s.job));
    const routes = new Set<string>(CRON_ROUTES);
    return [
        ...CRON_ROUTES.filter((job) => !scheduled.has(job)).map((job) => `Scheduled job ${job}: has a route but no schedule`),
        ...source.schedules.filter((s) => !routes.has(s.job)).map((s) => `Scheduled job ${s.job}: has a schedule but no route`),
    ];
}
