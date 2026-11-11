/**
 * Freshness push wiring.
 *
 * This function writes its own run freshness into the dedicated monitoring DB so the
 * watchdog can read it there instead of holding a credential to THIS service's database.
 * The push is best-effort and opt-in: it only happens when `MONITORING_DATABASE_URL` is
 * configured, so local dev and the offline inject path stay quiet (no monitoring DB → no
 * sink → no failed-push noise). withSyncRun fires the returned sink on each terminal
 * DATA-run transition (never for ADMIN runs).
 */
import { prisma as monitoringPrisma, recordHeartbeat } from "@checkin/monitoring-db";
import { logger, type HeartbeatSink } from "@checkin/s-ingest-core";

/** Build the heartbeat sink, or `undefined` when monitoring isn't configured for this env. */
export function buildHeartbeatSink(env: NodeJS.ProcessEnv = process.env): HeartbeatSink | undefined {
  if (!env.MONITORING_DATABASE_URL) return undefined;
  // `service`/`env` must match the watchdog registry entry and its MONITORING_ENV so the
  // (service, env) heartbeat key lines up on both sides of the contract.
  const service = env.SERVICE_NAME ?? "shopify-read";
  const deployEnv = env.MONITORING_ENV;
  // A missing env must never stop the sync, and must never fall back to another env's rows.
  if (!deployEnv) {
    logger.error("MONITORING_ENV is required when MONITORING_DATABASE_URL is set; heartbeat push disabled", {});
    return undefined;
  }
  return (beat) =>
    recordHeartbeat(monitoringPrisma, {
      service,
      env: deployEnv,
      status: beat.status,
      finishedAt: beat.finishedAt,
      error: beat.error,
      kind: beat.kind,
    });
}
