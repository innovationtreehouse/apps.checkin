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
    appendFileSync(sink, JSON.stringify(line) + "\n");
}
