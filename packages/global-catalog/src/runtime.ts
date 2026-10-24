/**
 * The catalog runtime singleton (#1286 §3). configureCatalog() is the one
 * justified global — the ceiling is "one runtime per process," fine for a
 * single Next app. The host wires it once at boot (checkin instrumentation.ts);
 * routes and services read it through the accessors below.
 */
import { defineRuntime } from "@checkin/component-kit";
import { db as defaultDb } from "./db";
import type { PrismaClient } from "./generated/prisma/client";
import type { CatalogRuntimeConfig, CatalogPrincipal, OrgEventConsumer, OrgIdentity } from "./contract";

export const catalogRuntime = defineRuntime<CatalogRuntimeConfig, CatalogPrincipal>("global-catalog");

export const configureCatalog = catalogRuntime.configure;

/**
 * The acting host user. A 401 if absent: host admission runs before any route
 * body, so a factory reaching this has already passed the gate.
 */
export const getPrincipal = catalogRuntime.getPrincipal;

/** Registered S5 consumers; none when unconfigured, since it runs after a commit and consumers replay from their cursors. */
export function getOrgEventConsumers(): Record<string, OrgEventConsumer> {
  return catalogRuntime.configured()?.orgEventConsumers ?? {};
}

/** Org identity for the current request (#1286 §6). */
export function getOrg(): Promise<OrgIdentity> {
  return catalogRuntime.require().org();
}

/**
 * The catalog Prisma client — the library's own (`@/db`, reading
 * CATALOG_DATABASE_URL). The route repos and the ported services both use this
 * one client; there is no host-injected alternative (single catalog DB).
 */
export function getDb(): PrismaClient {
  return defaultDb;
}
