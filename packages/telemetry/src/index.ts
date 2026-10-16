/**
 * @inventory/telemetry — fleet-wide emission core (the "standardize emission" layer
 * from MONITORING-PRD.md §6.1).
 *
 * Stateless and dependency-light: structured logging + CloudWatch metric emission, with
 * NO database or AWS-SDK dependency. Every Lambda — monitor or worker — can import this
 * to emit health the same *shape* (common metric namespace, dimension keys, log fields).
 * The DB-backed enrichment (health_event / outbox) lives separately in
 * @inventory/monitoring-db so non-DB consumers don't pull in Prisma.
 */
export * from "./logger.js";
export * from "./metrics.js";
