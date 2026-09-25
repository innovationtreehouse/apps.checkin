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

let runtime: CatalogRuntimeConfig | undefined;

export function configureCatalog(config: CatalogRuntimeConfig): void {
  runtime = config;
}

function requireRuntime(): CatalogRuntimeConfig {
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
export function getOrg(): OrgIdentity {
  return requireRuntime().org();
}

/**
 * The catalog Prisma client. Falls back to the library's own client (`@/db`)
 * when the host injects none — so it resolves even before configureCatalog()
 * runs (the library's services read `@/db` directly for the same reason).
 */
export function getDb(): PrismaClient {
  return runtime?.db ?? defaultDb;
}

/**
 * Build a host-rendered HTTP error. Uses the injected factory (checkin's
 * ApiResponseError, which handler() maps to status + message); falls back to a
 * plain Error carrying `status` when unconfigured (tests).
 */
export function catalogError(status: number, message: string): Error {
  const make = runtime?.httpError;
  if (make) return make(status, message);
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
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
