/**
 * Watchdog configuration — the service registry.
 *
 * Detection is registry-driven (PRD §6 / Option A): the watchdog is handed an explicit
 * list of monitored services, one entry per service. This is the EXPECTED set — "who
 * should be reporting" — so a service that goes silent (never pushes a heartbeat) is still
 * detected as stale.
 *
 * NOTE (F7, pull→push inversion): the registry no longer carries any database URL. The
 * watchdog reads each service's freshness from the dedicated monitoring DB's
 * `service_heartbeat` table (which the services PUSH to), so it holds no credential to any
 * watched service's own financial database. The only DB it connects to is the monitoring DB
 * (`MONITORING_DATABASE_URL`, via @inventory/monitoring-db).
 *
 * Provided via the MONITORING_SERVICES env var as a JSON array, e.g.:
 *   [{"service":"shopify-read","staleAfterSeconds":7200}]
 */
import { z } from "zod";

const entrySchema = z.object({
  /** Pipeline/service name — must match what the service pushes as its heartbeat `service`. */
  service: z.string().min(1),
  /** Alert if `now - lastSuccessAt` exceeds this. Typically a couple of cron intervals. */
  staleAfterSeconds: z.number().int().positive(),
});

export type ServiceEntry = z.infer<typeof entrySchema>;

const configSchema = z.object({
  MONITORING_SERVICES: z.string().min(1, "MONITORING_SERVICES (JSON array) is required"),
  MONITORING_ENV: z.string().min(1, "MONITORING_ENV is required"),
  MONITOR_NAME: z.string().min(1).default("monitoring-watchdog"),
  /** Re-alert window: a persistent incident only re-pages after this many seconds (default 1h). */
  RENOTIFY_AFTER_SECONDS: z.coerce.number().int().positive().default(3600),
});

export interface WatchdogConfig {
  /** Deployment environment, e.g. "prod" — the `env` metric dimension. */
  env: string;
  /** This monitor's own name — the `service` dimension on its heartbeat. */
  monitorName: string;
  /** Suppress a duplicate alert for the same (service, kind) seen within this many seconds. */
  renotifyAfterSeconds: number;
  /** The services to check. */
  services: ServiceEntry[];
}

export function loadWatchdogConfig(env: NodeJS.ProcessEnv = process.env): WatchdogConfig {
  const parsed = configSchema.parse(env);
  let raw: unknown;
  try {
    raw = JSON.parse(parsed.MONITORING_SERVICES);
  } catch (e) {
    throw new Error(`MONITORING_SERVICES is not valid JSON: ${(e as Error).message}`);
  }
  const services = z.array(entrySchema).min(1, "MONITORING_SERVICES must list at least one service").parse(raw);
  return {
    env: parsed.MONITORING_ENV,
    monitorName: parsed.MONITOR_NAME,
    renotifyAfterSeconds: parsed.RENOTIFY_AFTER_SECONDS,
    services,
  };
}
