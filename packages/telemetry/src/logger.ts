/**
 * Minimal structured JSON logger + correlation id — the fleet-wide canonical version.
 *
 * One JSON object per line, friendly to CloudWatch / log aggregators. This is the
 * single source of truth for log *shape* across the ~50 Lambdas; services should import
 * it from here rather than hand-rolling their own. `msg`, every top-level string
 * field and every Error's message and stack pass through `redactSecrets`. Skipped:
 * the logger's own `level`/`time`, and `*Id` fields holding a UUID or digits, which
 * the opaque-key pattern would otherwise eat. Strings nested in plain objects are
 * not redacted.
 */
import crypto from "node:crypto";
import { redactSecrets } from "@checkin/utils";

export function newCorrelationId(): string {
  return crypto.randomUUID();
}

export type Fields = Record<string, unknown>;

const ID_KEY = /^id$|Id$|_id$/;
const ID_VALUE = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d+)$/i;

function redactField(key: string, value: string): string {
  if (key === "level" || key === "time") return value;
  if (ID_KEY.test(key) && ID_VALUE.test(value)) return value;
  return redactSecrets(value);
}

function emit(level: "info" | "warn" | "error", msg: string, fields?: Fields) {
  const line = { level, msg, time: new Date().toISOString(), ...fields };
  const out = JSON.stringify(line, function (this: unknown, k, v) {
    if (v instanceof Error) {
      return { name: v.name, message: redactSecrets(v.message), stack: v.stack && redactSecrets(v.stack) };
    }
    if (typeof v === "string" && this === line) return redactField(k, v);
    return v;
  });
  const sink = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  sink(out);
}

export const logger = {
  info: (msg: string, fields?: Fields) => emit("info", msg, fields),
  warn: (msg: string, fields?: Fields) => emit("warn", msg, fields),
  error: (msg: string, fields?: Fields) => emit("error", msg, fields),
};
