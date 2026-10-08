export function logError(event: string, context: Record<string, unknown>, err: unknown): void {
  console.error(JSON.stringify({
    level: "error",
    event,
    ...context,
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
    ts: new Date().toISOString(),
  }));
}

export function logWarn(event: string, context: Record<string, unknown>): void {
  console.warn(JSON.stringify({ level: "warn", event, ...context, ts: new Date().toISOString() }));
}
