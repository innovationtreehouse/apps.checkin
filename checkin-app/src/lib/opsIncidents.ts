import type { FailureKind } from "@checkin/component-kit";
import type { OpsIncident, Prisma } from "@/generated/prisma/client";
import { config } from "@/lib/config";
import type { TemplateCtx } from "@/lib/email-templates/registry";
import prisma from "@/lib/prisma";
import { isPrismaError } from "@/lib/prismaUniqueViolation";
import { formatDateTime } from "@/lib/time";

/**
 * The incident engine: turns each job run's failures into at most one alert per
 * outage, with reminders, one escalation and a recovery notice. Thresholds and
 * keys follow the ops alerting design; see docs/ops/production-runbook.md § Alerts.
 */

/** One kind of failure a lane met in a run. `count` is the items it affected; `stopped` means the lane gave up on the run. */
export interface RunFailure {
    lane: string;
    cause: string;
    kind: FailureKind;
    code: string;
    count: number;
    stopped?: boolean;
}

/**
 * What a run saw. `lanes` are the lanes that ran, clean or not: an open incident
 * closes only when a run covers every one of its lanes without failing it. A settings
 * failure counts only while work is waiting (`count` above 0). `staleJobs` lists jobs with no
 * successful run in 48 hours; leave it out when the run did not check.
 */
export interface RunReport {
    lanes: string[];
    failures: RunFailure[];
    staleJobs?: string[];
}

export type OpsTemplate = "ops.incidentOpened" | "ops.incidentReminder" | "ops.incidentEscalated" | "ops.incidentRecovered";

/** Sends one alert to one address; resolves true when it was handed to the mail service. */
export type SendAlert = (to: string, template: OpsTemplate, ctx: TemplateCtx<OpsTemplate>) => Promise<boolean>;

export interface Delivery {
    send: SendAlert;
    alertTo: string[];
    boardTo: string[];
    timeZone: string;
    now?: Date;
}

export interface IncidentEvent {
    key: string;
    event: "opened" | "reminded" | "escalated" | "recovered";
    sent: boolean;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const FIRST_REMINDER_DAYS = 3;
const REMINDER_EVERY_DAYS = 7;
const ESCALATE_AFTER_DAYS = 14;
const BACK_AGAIN_WITHIN = DAY;
const PURGE_AFTER = 90 * DAY;
const DETAIL_MAX = 500;

interface Observation {
    key: string;
    cause: string;
    kind: FailureKind;
    lanes: string[];
    codes: string[];
    count: number;
    stopped: boolean;
}

/** The key of a stopped job's incident. */
export const staleKey = (job: string) => `cron:${job}:stale`;
const STALE_KEY = /^cron:(.+):stale$/;
/** The job a stopped-job incident's key names, or null for any other key. */
export const staleJobOf = (key: string): string | null => key.match(STALE_KEY)?.[1] ?? null;
const isStaleKey = (key: string) => staleJobOf(key) !== null;
const union = (a: string[], b: string[]) => [...new Set([...a, ...b])];
// Whole days, with a two-hour margin so a daily run that starts early, or after a 23-hour daylight-saving day, still counts its day.
const DAY_MARGIN = 2 * HOUR;
const daysBetween = (from: Date, to: Date) => Math.floor((to.getTime() - from.getTime() + DAY_MARGIN) / DAY);

function observe(report: RunReport): Observation[] {
    const byKey = new Map<string, Observation>();
    for (const f of report.failures) {
        if (f.kind === "data" || (f.kind === "settings" && f.count <= 0)) continue;
        const key = f.kind === "bug" ? `${f.lane}:${f.code}` : `${f.cause}:${f.kind}`;
        const o = byKey.get(key) ?? { key, cause: f.cause, kind: f.kind, lanes: [], codes: [], count: 0, stopped: false };
        o.lanes = union(o.lanes, [f.lane]);
        o.codes = union(o.codes, [f.code]);
        o.count += f.count;
        o.stopped ||= !!f.stopped;
        byKey.set(key, o);
    }
    for (const job of report.staleJobs ?? []) {
        const key = staleKey(job);
        byKey.set(key, { key, cause: "cron", kind: "system", lanes: [job], codes: ["stale"], count: 0, stopped: true });
    }
    return [...byKey.values()];
}

/** System failures alert on the second run in a row or when a lane stopped; connection, settings and bug alert on the first. */
function meetsThreshold(row: OpsIncident, stopped: boolean): boolean {
    return row.kind !== "system" || stopped || row.runsSeen >= 2;
}

function covers(report: RunReport, row: OpsIncident): boolean {
    if (isStaleKey(row.key)) return report.staleJobs !== undefined;
    return row.lanes.every((lane) => report.lanes.includes(lane));
}

const CAUSE_NAMES: Record<string, string> = {
    quickbooks: "QuickBooks",
    gmail: "Gmail",
    ocr: "OCR",
    database: "the database",
    catalog: "catalog events",
    cron: "Scheduled job",
    mapping: "receipt mapping",
    intake: "expense intake",
};

const TODO: Record<string, string> = {
    "quickbooks:connection": "Finance repeats step 3 of the QuickBooks go-live runbook with the infra operator and reseeds the secret (docs/ops/quickbooks-go-live.md).",
    "gmail:connection": "Have the receipt mailbox's Gmail access reconnected, then upload or forward anything that was missed.",
    system: "Usually nothing: the work retries on the next run. If it lasts, check the service's own status page and the job logs.",
    connection: "Reconnect the service named here; the work waiting resumes on the next run.",
    settings: "Fix the setting named on System Status; the work waiting resumes on the next run.",
    bug: "An engineer should check the job logs for the codes named here.",
    stale: "Check the job's schedule and its last run under Scheduled Jobs on System Status.",
};

function summary(row: OpsIncident, cause: string, lanes: string): string {
    if (isStaleKey(row.key)) return `The scheduled job ${lanes} has not finished a successful run in 48 hours.`;
    switch (row.kind) {
        case "system": return `${cause} is failing or not answering, so ${lanes} cannot finish their work.`;
        case "connection": return `The app's connection to ${cause} is broken, for example an expired or revoked login, so ${lanes} are paused.`;
        case "settings": return `A setting that ${lanes} needs for ${cause} is missing or wrong, and work is waiting.`;
        default: return `The app hit an unexpected error (${row.detail ?? "no code"}) in ${lanes}.`;
    }
}

function status(template: OpsTemplate, row: OpsIncident, now: Date): string {
    switch (template) {
        case "ops.incidentRecovered": return "recovered";
        case "ops.incidentEscalated": return "open for 2 weeks";
        case "ops.incidentReminder": return `still open after ${daysBetween(row.notifiedAt ?? now, now)} days`;
        default:
            if (row.recoveryNotifiedAt) return "back again";
            return row.kind === "connection" ? "needs reconnecting" : "needs attention";
    }
}

function context(template: OpsTemplate, row: OpsIncident, delivery: Delivery, now: Date): TemplateCtx<OpsTemplate> {
    const cause = CAUSE_NAMES[row.cause] ?? row.cause;
    const lanes = row.lanes.join(", ");
    const recovered = template === "ops.incidentRecovered";
    return {
        kind: row.kind,
        cause,
        lanes,
        status: status(template, row, now),
        summary: recovered ? `${lanes} ran again without this failure, so the incident is closed.` : summary(row, cause, lanes),
        firstSeen: formatDateTime(row.firstSeenAt, { timeZone: delivery.timeZone, dateStyle: "medium", timeStyle: "short" }),
        runsSeen: String(row.runsSeen),
        items: String(row.itemsAffected),
        todo: recovered
            ? "Nothing, unless items are still waiting on System Status."
            : TODO[isStaleKey(row.key) ? "stale" : `${row.cause}:${row.kind}`] ?? TODO[row.kind],
        actionLink: `${config.baseUrl()}/system-status/health`,
    };
}

/** Counts as sent when at least one address took it. */
async function sendAll(to: string[], template: OpsTemplate, row: OpsIncident, delivery: Delivery, now: Date): Promise<boolean> {
    if (to.length === 0) {
        console.warn(`[ops incident] ${row.key}: ${template} not sent, no address`);
        return false;
    }
    const ctx = context(template, row, delivery, now);
    let sent = false;
    for (const address of to) {
        try {
            sent = (await delivery.send(address, template, ctx)) || sent;
        } catch (err) {
            console.warn(`[ops incident] ${row.key}: ${template} send rejected: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    if (!sent) console.warn(`[ops incident] ${row.key}: ${template} not sent, every send failed`);
    return sent;
}

const update = (row: OpsIncident, data: Prisma.OpsIncidentUpdateInput) => prisma.opsIncident.update({ where: { id: row.id }, data });

type SentAt = "notifiedAt" | "lastRemindedAt" | "escalatedAt" | "recoveryNotifiedAt";

/** Moves `field` from `from` to `to` only if it still holds `from`; true when this call moved it. */
async function swap(row: OpsIncident, field: SentAt, from: Date | null, to: Date | null): Promise<boolean> {
    const { count } = await prisma.opsIncident.updateMany({ where: { id: row.id, [field]: from }, data: { [field]: to } });
    return count === 1;
}

/**
 * Sends one notice at most once across overlapping runs: only the run that claims
 * `field` (moves it from the value it read to `now`) sends. A failed send releases
 * the claim, so the next run tries again.
 */
async function claimAndSend(
    row: OpsIncident, field: SentAt, event: IncidentEvent["event"], to: string[], template: OpsTemplate,
    delivery: Delivery, now: Date, events: IncidentEvent[],
): Promise<void> {
    if (!(await swap(row, field, row[field], now))) return;
    const sent = await sendAll(to, template, row, delivery, now);
    events.push({ key: row.key, event, sent });
    if (!sent) await swap(row, field, now, row[field]);
}

/** Opens or closes the row only while its `openKey` is still what this run read; null when an overlapping run got there first. */
async function transition(row: OpsIncident, data: Prisma.OpsIncidentUpdateInput): Promise<OpsIncident | null> {
    try {
        return await prisma.opsIncident.update({ where: { id: row.id, AND: { openKey: row.openKey } }, data });
    } catch (err) {
        if (!isPrismaError(err, "P2025")) throw err;
        return null;
    }
}

/** The row this observation lands on: the open one, one closed within 24 hours (back again), or a new one. Null when an overlapping run created or reopened it first. */
async function record(o: Observation, open: OpsIncident | undefined, recent: OpsIncident | undefined, now: Date): Promise<OpsIncident | null> {
    const seen = { lastSeenAt: now, itemsAffected: o.count, detail: o.codes.join(", ").slice(0, DETAIL_MAX) };
    if (open) return update(open, { ...seen, lanes: union(open.lanes, o.lanes), runsSeen: { increment: 1 } });
    if (recent?.notifiedAt) {
        return transition(recent, {
            ...seen, openKey: o.key, closedAt: null, notifiedAt: null, lastRemindedAt: null,
            lanes: union(recent.lanes, o.lanes), runsSeen: recent.runsSeen + 1,
        });
    }
    // A watching incident that closed unannounced restarts, so blip, clean run, blip is not "two runs in a row".
    if (recent) return transition(recent, { ...seen, openKey: o.key, closedAt: null, firstSeenAt: now, lanes: o.lanes, runsSeen: 1 });
    try {
        return await prisma.opsIncident.create({
            data: { ...seen, key: o.key, openKey: o.key, cause: o.cause, kind: o.kind, lanes: o.lanes, firstSeenAt: now, runsSeen: 1 },
        });
    } catch (err) {
        if (!isPrismaError(err, "P2002")) throw err;
        // ponytail: a concurrent run opened it first; this run's sighting is dropped, the next run counts.
        return null;
    }
}

async function notify(row: OpsIncident, stopped: boolean, delivery: Delivery, now: Date, events: IncidentEvent[]): Promise<void> {
    if (!row.notifiedAt) {
        if (!meetsThreshold(row, stopped)) return;
        await claimAndSend(row, "notifiedAt", "opened", delivery.alertTo, "ops.incidentOpened", delivery, now, events);
        return;
    }
    if (!row.escalatedAt && daysBetween(row.firstSeenAt, now) >= ESCALATE_AFTER_DAYS) {
        await claimAndSend(row, "escalatedAt", "escalated", delivery.boardTo, "ops.incidentEscalated", delivery, now, events);
    }
    const due = row.lastRemindedAt
        ? daysBetween(row.lastRemindedAt, now) >= REMINDER_EVERY_DAYS
        : daysBetween(row.notifiedAt, now) >= FIRST_REMINDER_DAYS;
    if (due) await claimAndSend(row, "lastRemindedAt", "reminded", delivery.alertTo, "ops.incidentReminder", delivery, now, events);
}

const recover = (row: OpsIncident, delivery: Delivery, now: Date, events: IncidentEvent[]) =>
    claimAndSend(row, "recoveryNotifiedAt", "recovered", delivery.alertTo, "ops.incidentRecovered", delivery, now, events);

/** A recovery email is owed when an opening notice went out and this closing's recovery email has not. */
const recoveryOwed = (row: OpsIncident) =>
    !!row.notifiedAt && !!row.closedAt && (!row.recoveryNotifiedAt || row.recoveryNotifiedAt < row.closedAt);

/**
 * Applies one run to the incident table and sends what it owes: opening notices,
 * reminders, the Board escalation and recovery emails. A failed or unaddressed send
 * is not recorded as sent, so the next run tries it again. Returns every send attempted.
 */
export async function evaluateIncidents(report: RunReport, delivery: Delivery): Promise<IncidentEvent[]> {
    const now = delivery.now ?? new Date();
    const rows = await prisma.opsIncident.findMany({
        where: { OR: [{ closedAt: null }, { closedAt: { gte: new Date(now.getTime() - BACK_AGAIN_WITHIN) } }] },
        orderBy: { closedAt: "asc" },
    });
    const open = new Map(rows.filter((r) => !r.closedAt).map((r) => [r.key, r]));
    const recent = new Map(rows.filter((r) => r.closedAt).map((r) => [r.key, r]));
    const events: IncidentEvent[] = [];
    const observations = observe(report);

    for (const o of observations) {
        const row = await record(o, open.get(o.key), recent.get(o.key), now);
        recent.delete(o.key);
        if (row) await notify(row, o.stopped, delivery, now, events);
    }

    const seen = new Set(observations.map((o) => o.key));
    for (const row of open.values()) {
        if (seen.has(row.key) || !covers(report, row)) continue;
        const closed = await transition(row, { openKey: null, closedAt: now });
        if (closed?.notifiedAt) await recover(closed, delivery, now, events);
    }
    for (const row of recent.values()) {
        if (recoveryOwed(row)) await recover(row, delivery, now, events);
    }
    return events;
}

/** Deletes incidents closed more than 90 days ago; returns how many. */
export async function purgeClosedIncidents(now: Date = new Date()): Promise<number> {
    const { count } = await prisma.opsIncident.deleteMany({ where: { closedAt: { lt: new Date(now.getTime() - PURGE_AFTER) } } });
    return count;
}
