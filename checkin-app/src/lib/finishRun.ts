import { AsyncLocalStorage } from "node:async_hooks";
import { kindOf, type FailureReport, type OnFailure } from "@checkin/component-kit";
import { recordCronRun } from "@/lib/cronRuns";
import type { RunFailure } from "@/lib/opsIncidents";
import { recordFaultCodes } from "@/lib/qboFaultCodes";
import { evaluateRun } from "@/lib/runIncidents";

/** What one job run's lanes reported, which lanes it reached, and which it stopped early. */
export interface Run {
    reports: FailureReport[];
    reached: Set<string>;
    stopped: Set<string>;
}

// On globalThis: the ports bind in the instrumentation chunk and the runs start in route chunks, which load this module apart.
const STORE = Symbol.for("@checkin/finishRun/current");
const shared = globalThis as typeof globalThis & { [STORE]?: AsyncLocalStorage<Run> };
const current = (shared[STORE] ??= new AsyncLocalStorage<Run>());

/** Each library lane, as "<library> <lane>", and the cause its failures are grouped under. */
const CAUSES: Record<string, string> = {
    "receipt push": "mapping",
    "receipt mail-listing": "gmail",
    "receipt ocr": "ocr",
    "expense intake": "intake",
    "expense intake-replay": "intake",
    "expense posting": "quickbooks",
    "bulk-donation in-kind-posting": "quickbooks",
    "income deposit-build": "quickbooks",
    "workflow-mapping matching": "mapping",
};

export const newRun = (): Run => ({ reports: [], reached: new Set(), stopped: new Set() });

/** Runs a job's work inside `run`, so every report its lanes make lands on it. */
export const inRun = <T>(run: Run, work: () => Promise<T>): Promise<T> => current.run(run, work);

/**
 * The host's "on failure" port for one library. A QuickBooks lane's fault codes are always counted;
 * otherwise a report outside a job run is only the library's own log line.
 */
export const reportTo = (library: string): OnFailure => (report) => {
    const named = { ...report, lane: `${library} ${report.lane}` };
    current.getStore()?.reports.push(named);
    if (CAUSES[named.lane] === "quickbooks") void recordFaultCodes(named);
};

/** A crashed step's failure on one lane: a bug unless its error carries a kind. */
const crashReport = (lane: string, step: string, err: unknown): FailureReport => ({ lane, kind: kindOf(err), faultCodes: [`${step} crashed`] });

/** A crashed step, filed under the library lanes it runs, or under the job's own lane when it runs none. */
export function stepCrashed(job: string, step: string, err: unknown, lanes: string[] = []): void {
    const run = current.getStore();
    for (const lane of lanes.length ? lanes : [job]) run?.reports.push(crashReport(lane, step, err));
}

/**
 * Marks lanes the run reached: their work ran to a result. Only reached lanes count as covered,
 * so an incident closes only on a run that really did that lane's work.
 */
export function laneReached(...lanes: string[]): void {
    const run = current.getStore();
    for (const lane of lanes) run?.reached.add(lane);
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
    await evaluateRun({ lanes: [job, ...run.reached], failures });
}

/** A run that crashed outside any step: a failure of the job's own lane. */
export function runCrashed(run: Run, job: string, err: unknown): void {
    run.reports.push(crashReport(job, "run", err));
    run.reached.clear();
}
