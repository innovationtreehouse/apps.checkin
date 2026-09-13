/**
 * The catalog runtime singleton (#1286 §3). configureCatalog() is the one
 * justified global — the ceiling is "one runtime per process," fine for a
 * single Next app. The host wires it once at boot (checkin instrumentation.ts);
 * routes and services read it through the accessors below.
 */
import { db as defaultDb } from "./db";
import type { PrismaClient } from "./generated/prisma/client";
import { ServiceError } from "./services/categoryService";
import type { CatalogRuntimeConfig, CatalogPrincipal, OrgIdentity } from "./contract";

// Stored on globalThis, not a module-scoped `let` — the same singleton pattern
// the catalog Prisma client uses (`__gcPrisma`). It survives Turbopack HMR
// re-evaluation in dev and removes any module-identity doubt in prod (the
// instrumentation chunk that calls configureCatalog() and the route chunks that
// read it must see one runtime).
const globalForRuntime = globalThis as typeof globalThis & {
  __gcRuntime?: CatalogRuntimeConfig;
};

export function configureCatalog(config: CatalogRuntimeConfig): void {
  globalForRuntime.__gcRuntime = config;
}

function requireRuntime(): CatalogRuntimeConfig {
  const runtime = globalForRuntime.__gcRuntime;
  if (!runtime) {
    throw new Error(
      "global-catalog runtime not configured — the host must call configureCatalog() at boot",
    );
  }
  return runtime;
}

/**
 * The acting host user. Throws if absent: host admission runs before any route
 * body, so a factory reaching this has already passed the gate.
 */
export async function getPrincipal(): Promise<CatalogPrincipal> {
  const principal = await requireRuntime().auth.getPrincipal();
  if (!principal) {
    throw new Error("no catalog principal — host admission should have rejected this request");
  }
  return principal;
}

/** Org identity for the current request (#1286 §6). */
export function getOrg(): Promise<OrgIdentity> {
  return requireRuntime().org();
}

/**
 * The catalog Prisma client — the library's own (`@/db`, reading
 * CATALOG_DATABASE_URL). The route repos and the ported services both use this
 * one client; there is no host-injected alternative (single catalog DB).
 */
export function getDb(): PrismaClient {
  return defaultDb;
}

/**
 * An HTTP-status error thrown by a route factory. The host translates it into
 * its own API error at the route boundary; the library never imports the
 * host's error class.
 */
export class CatalogHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "CatalogHttpError";
  }
}

export function catalogError(status: number, message: string): CatalogHttpError {
  return new CatalogHttpError(status, message);
}

/** Run a service call, remapping its ServiceError to a host-rendered HTTP error. */
export async function mapServiceErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ServiceError) throw catalogError(err.status, err.message);
    throw err;
  }
}
