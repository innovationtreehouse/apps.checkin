import { AsyncLocalStorage } from "node:async_hooks";
import { kindOf, type FailureReport, type OnFailure } from "@checkin/component-kit";
import { recordCronRun } from "@/lib/cronRuns";
import { recordFaultCodes } from "@/lib/qboFaultCodes";

/** What one job run's lanes reported. */
export interface Run {
    reports: FailureReport[];
}

// On globalThis: the ports bind in the instrumentation chunk and the runs start in route chunks, which load this module apart.
const STORE = Symbol.for("@checkin/finishRun/current");
const shared = globalThis as typeof globalThis & { [STORE]?: AsyncLocalStorage<Run> };
const current = (shared[STORE] ??= new AsyncLocalStorage<Run>());

/** The QuickBooks lanes, as "<library> <lane>", whose fault codes are counted. */
const QUICKBOOKS_LANES = new Set(["expense posting", "bulk-donation in-kind-posting", "income deposit-build", "quickbooks lists-refresh"]);

export const newRun = (): Run => ({ reports: [] });

/** Runs a job's work inside `run`, so every report its lanes make lands on it. */
export const inRun = <T>(run: Run, work: () => Promise<T>): Promise<T> => current.run(run, work);

/**
 * The host's "on failure" port for one library. A QuickBooks lane's fault codes are always counted;
 * otherwise a report outside a job run is only the library's own log line.
 */
export const reportTo = (library: string): OnFailure => (report) => {
    const named = { ...report, lane: `${library} ${report.lane}` };
    current.getStore()?.reports.push(named);
    if (QUICKBOOKS_LANES.has(named.lane)) void recordFaultCodes(named);
};

/** A crashed step's failure on one lane: a bug unless its error carries a kind. */
const crashReport = (lane: string, step: string, err: unknown): FailureReport => ({ lane, kind: kindOf(err), faultCodes: [`${step} crashed`] });

/** A crashed step, filed under the library lanes it runs, or under the job's own lane when it runs none. */
export function stepCrashed(job: string, step: string, err: unknown, lanes: string[] = []): void {
    const run = current.getStore();
    for (const lane of lanes.length ? lanes : [job]) run?.reports.push(crashReport(lane, step, err));
}

/** Failed items per failure kind. Each item counts once per lane, kind and code, however many times its lane reported it this run. */
function byKind(run: Run): Record<string, number> {
    const items = new Map<string, { kind: string; details: Set<string> }>();
    for (const r of run.reports) {
        const code = r.faultCodes?.join("+") ?? (r.status === undefined ? r.kind : `HTTP ${r.status}`);
        const key = `${r.lane}\n${r.kind}\n${code}`;
        const entry = items.get(key) ?? { kind: r.kind, details: new Set<string>() };
        entry.details.add(r.detail ?? "");
        items.set(key, entry);
    }
    const out: Record<string, number> = {};
    for (const { kind, details } of items.values()) out[kind] = (out[kind] ?? 0) + details.size;
    return out;
}

/** The shared end of every job run: records it with its failures by kind. Never throws. */
export async function finishRun(job: string, startedAt: Date, completed: boolean, error: unknown, run: Run): Promise<void> {
    await recordCronRun(job, startedAt, completed, error, byKind(run));
}

/** A run that crashed outside any step: a failure of the job's own lane. */
export function runCrashed(run: Run, job: string, err: unknown): void {
    run.reports.push(crashReport(job, "run", err));
}
