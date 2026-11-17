import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync } from "node:fs";
import { config } from "@/lib/config";

/**
 * Trace recorder for validating the check-in TLA+ model against real runs: one
 * NDJSON line per model action point (scan request and commit, visit open and
 * departure, close sweep, web check-in). A test turns it on with a file; nothing
 * else does. Off production it writes; in production it is a no-op whatever was
 * started, checked on every call (docs/rules/principles.md, a non-production
 * capability is absent in production).
 */
let sink: string | null = null;

/** Test-only: record to `file`, or stop with null. */
export function startSpecTrace(file: string | null): void {
    sink = file;
}

export function specTrace(name: string, fields: Record<string, unknown>): void {
    if (sink === null || config.isProd()) return;
    const line = { tag: "trace", ts: Date.now(), ns: process.hrtime.bigint().toString(), event: { name, ...fields } };
    write([JSON.stringify(line) + "\n"]);
}

/** Lines emitted inside an open {@link traceOnCommit}, held until it commits. */
const held = new AsyncLocalStorage<string[]>();

function write(lines: string[]): void {
    const outer = held.getStore();
    if (outer) outer.push(...lines);
    else if (sink !== null) for (const line of lines) appendFileSync(sink, line);
}

/**
 * Run a transaction so the trace lines emitted inside it are written only once
 * it commits; a rollback drops them, so a trace never shows an action the
 * database undid.
 */
export async function traceOnCommit<T>(transaction: () => Promise<T>): Promise<T> {
    if (sink === null) return transaction();
    const lines: string[] = [];
    const result = await held.run(lines, transaction);
    write(lines);
    return result;
}
