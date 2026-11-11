/**
 * @checkin/s-ingest-core — the shared core for the Shopify ingestion functions.
 *
 * Single source of truth for the database (Prisma schema + client + migrations), the
 * raw-event log, the projection/loader, normalization, watermark/cursor logic, run
 * bookkeeping, config, and logging. Consumed by `s-read-function` (API → raw log →
 * live tables) and `s-replay-function` (re-project from the raw log; reset watermarks).
 */

// Prisma client + enums (the DB contract)
export { Prisma, PrismaClient, ObjectType, EventSource, SyncKind, SyncStatus } from "./generated/prisma/client.js";

// DB client singleton (+ lazy factory for explicit-URL construction in tests)
export { prisma, getPrisma } from "./db/client.js";

// Plumbing
export * from "./config.js";
export { logger, newCorrelationId, type Fields } from "@checkin/telemetry";
export * from "./dates.js";
export * from "./money.js";

// Normalization (Shopify node → flat cents-based shape)
export * from "./shopify/schemas.js";

// Append-only raw log + ingest pipeline + inject
export * from "./ingest/rawLog.js";
export * from "./ingest/ingestNode.js";
export * from "./ingest/inject.js";

// Bulk-export reassembly + ingest + recovery (orders backfill)
export * from "./ingest/bulkOrders.js";

// Projection / loader
export * from "./loader/index.js";
export * from "./loader/projectOrders.js";
export * from "./loader/projectPayouts.js";

// Watermark / cursor + run bookkeeping
export * from "./sync/cursor.js";
export * from "./sync/run.js";

// Concurrency guard: advisory-lock helper that defends the single-flight assumption
export * from "./sync/locks.js";
