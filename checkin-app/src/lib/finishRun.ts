import { AsyncLocalStorage } from "node:async_hooks";
import { kindOf, type FailureReport, type OnFailure } from "@checkin/component-kit";
import { recordCronRun } from "@/lib/cronRuns";
import type { RunFailure } from "@/lib/opsIncidents";
import { evaluateRun } from "@/lib/runIncidents";

/** What one job run's lanes reported, and which lanes it stopped early. */
export interface Run {
    reports: FailureReport[];
    stopped: Set<string>;
}

// On globalThis: the ports bind in the instrumentation chunk and the runs start in route chunks, which load this module apart.
const STORE = Symbol.for("@checkin/finishRun/current");
const shared = globalThis as typeof globalThis & { [STORE]?: AsyncLocalStorage<Run> };
const current = (shared[STORE] ??= new AsyncLocalStorage<Run>());

/**
 * The library lanes each job runs every time, as "<library> <lane>", with the cause their
 * failures are grouped under. A run covers these lanes, so their incidents can close on it.
 */
const JOB_LANES: Record<string, Record<string, string>> = {
    "reconcile-shopify": {
        "receipt push": "mapping",
        "receipt mail-listing": "gmail",
        "receipt ocr": "ocr",
        "expense intake": "intake",
        "expense intake-replay": "intake",
    },
    "qbo-posting": {
        "expense posting": "quickbooks",
        "bulk-donation in-kind-posting": "quickbooks",
        "income deposit-build": "quickbooks",
    },
};
const CAUSES: Record<string, string> = Object.assign({}, ...Object.values(JOB_LANES));

export const newRun = (): Run => ({ reports: [], stopped: new Set() });

/** Runs a job's work inside `run`, so every report its lanes make lands on it. */
export const inRun = <T>(run: Run, work: () => Promise<T>): Promise<T> => current.run(run, work);

/** The host's "on failure" port for one library. A report outside a job run is only the library's own log line. */
export const reportTo = (library: string): OnFailure => (report) => {
    current.getStore()?.reports.push({ ...report, lane: `${library} ${report.lane}` });
};

/** A crashed step, as a failure of the job's own lane: a bug unless its error carries a kind. */
const crashReport = (job: string, step: string, err: unknown): FailureReport => ({ lane: job, kind: kindOf(err), faultCodes: [`${step} crashed`] });

export function stepCrashed(job: string, step: string, err: unknown): void {
    current.getStore()?.reports.push(crashReport(job, step, err));
}

/** Marks a lane the run stopped early, so a system failure on it alerts on this run. */
export function laneStopped(lane: string): void {
    current.getStore()?.stopped.add(lane);
}

/** One failure per lane, kind and code. Each item counts once, however many times its lane reported it this run. */
function runFailures(run: Run): RunFailure[] {
    const byKey = new Map<string, RunFailure & { items: Set<string> }>();
    for (const r of run.reports) {
        const code = r.faultCodes?.join("+") ?? (r.status === undefined ? r.kind : `HTTP ${r.status}`);
        const key = `${r.lane}\n${r.kind}\n${code}`;
        const f = byKey.get(key) ?? { lane: r.lane, cause: CAUSES[r.lane] ?? r.lane, kind: r.kind, code, count: 0, stopped: run.stopped.has(r.lane), items: new Set<string>() };
        f.items.add(r.detail ?? "");
        byKey.set(key, f);
    }
    return [...byKey.values()].map(({ items, ...f }) => ({ ...f, count: items.size }));
}

function byKind(failures: RunFailure[]): Record<string, number> {
    const out: Record<string, number> = {};
    for (const f of failures) out[f.kind] = (out[f.kind] ?? 0) + f.count;
    return out;
}

/**
 * The shared end of every job run: records it with its failures by kind, then applies it to the
 * incident engine, which also checks for stopped jobs. Never throws.
 */
export async function finishRun(job: string, startedAt: Date, completed: boolean, error: unknown, run: Run): Promise<void> {
    const failures = runFailures(run);
    await recordCronRun(job, startedAt, completed, error, byKind(failures));
    await evaluateRun({ lanes: [job, ...Object.keys(JOB_LANES[job] ?? {})], failures });
}

/** A run that crashed outside any step: a failure of the job's own lane. */
export function runCrashed(run: Run, job: string, err: unknown): void {
    run.reports.push(crashReport(job, "run", err));
}
