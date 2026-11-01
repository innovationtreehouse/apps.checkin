/**
 * @checkin/monitoring-db — the dedicated monitoring Postgres layer.
 *
 * The DB-backed enrichment tier from MONITORING-PRD.md: the append-only `health_event`
 * log, the transactional `monitoring_outbox`, and the helpers that the watchdog (write)
 * and relay (read) use. Kept separate from @checkin/telemetry so that services which
 * only need to *emit* metrics/logs don't pull in Prisma/Postgres.
 */

// Prisma client + enums (the DB contract)
export { Prisma, PrismaClient, IncidentKind, OutboxStatus, Severity } from "./generated/prisma/client.js";

// DB client singleton (+ lazy factory for explicit-URL construction in tests)
export { prisma, getPrisma } from "./db/client.js";

// Transactional incident write (watchdog side)
export * from "./incident.js";

// Outbox read/ack (relay side)
export * from "./outbox.js";

// Push-based freshness heartbeats: services write (createHeartbeatSink/recordHeartbeat),
// the watchdog reads (readServiceHeartbeats).
export * from "./heartbeat.js";

// Concurrency guard: advisory-lock helper that defends the single-flight assumption
export * from "./lock.js";
