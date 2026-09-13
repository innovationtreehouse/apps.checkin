/**
 * The injection seam (#1286 §3). The host application (checkin) implements these
 * and calls configureCatalog() once at boot; the library reads the configured
 * runtime. The dependency arrow points one way — the library NEVER imports the
 * host, so "understand the catalog" stays "read this package."
 */
import type { PrismaClient } from "./generated/prisma/client";

/** The acting host user, projected to what catalog rows stamp. */
export interface CatalogPrincipal {
  /** Host person id — stamped as local_user_id / *ByUserId on catalog rows. */
  id: number;
  /** Display name — stamped as *ByUsername. Null when the host has no name. */
  name: string | null;
}

/** Org identity stamped on proposals / provisional items / OrgEvent (#1286 §6). */
export interface OrgIdentity {
  id: string;
  name: string;
}

export interface CatalogAuth {
  /**
   * The current host user, or null when unauthenticated. Host admission
   * (checkin's registry authorize) runs BEFORE any route body, so a write
   * factory that reaches getPrincipal() can treat null as an invariant breach.
   */
  getPrincipal(): Promise<CatalogPrincipal | null>;
}

export interface CatalogRuntimeConfig {
  auth: CatalogAuth;
  /**
   * Org identity as an ACCESSOR, not a frozen value (#1286 §6): single-org
   * returns the one row every call; multi-org later resolves the current org
   * per request — same seam, no library change.
   */
  org: () => OrgIdentity;
  /**
   * Optional Prisma client override. Defaults to the library's own catalog
   * client (`@/db`, reading CATALOG_DATABASE_URL that the host provides), so
   * single-DB deployments need not inject one; tests pass a throwaway client.
   */
  db?: PrismaClient;
  /**
   * Map a status + message to the host's API error. checkin passes its
   * `ApiResponseError`, so the error a route factory throws is caught and
   * rendered by the host's handler() (status + message) — the library never
   * imports the host's error class.
   */
  httpError: (status: number, message: string) => Error;
}

/**
 * The slice of a Next route context a catalog route factory consumes. Kept
 * structurally minimal (req + params) so a factory is assignable to the host's
 * handler fn without importing host types; user identity and org come from the
 * runtime, not from here.
 */
export interface CatalogRouteCtx {
  req: Request;
  params: Record<string, string>;
}

/** A route factory's body: parse → service → model bag (stripped by the host). */
export type CatalogBag = Record<string, unknown>;
export type CatalogRouteHandler = (ctx: CatalogRouteCtx) => Promise<CatalogBag>;
