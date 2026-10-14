/**
 * Minimal structured JSON logger + correlation id — the fleet-wide canonical version.
 *
 * One JSON object per line, friendly to CloudWatch / log aggregators. This is the
 * single source of truth for log *shape* across the ~50 Lambdas; services should import
 * it from here rather than hand-rolling their own. `s-ingest-core` re-exports this so
 * existing callers keep working unchanged.
 */
import crypto from "node:crypto";

export function newCorrelationId(): string {
  return crypto.randomUUID();
}

export type Fields = Record<string, unknown>;

function emit(level: "info" | "warn" | "error", msg: string, fields?: Fields) {
  const line = { level, msg, time: new Date().toISOString(), ...fields };
  const out = JSON.stringify(line, (_k, v) =>
    v instanceof Error ? { name: v.name, message: v.message, stack: v.stack } : v,
  );
  const sink = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  sink(out);
}

export const logger = {
  info: (msg: string, fields?: Fields) => emit("info", msg, fields),
  warn: (msg: string, fields?: Fields) => emit("warn", msg, fields),
  error: (msg: string, fields?: Fields) => emit("error", msg, fields),
};
