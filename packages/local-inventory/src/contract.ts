/**
 * The injection seam (#1287 §3). The host (checkin) implements these and calls
 * configureLocalInventory() once at boot; the library reads the configured
 * runtime and never imports the host.
 */

/** The acting host user, projected to what inventory rows stamp. */
export interface InventoryPrincipal {
  /** Host person id — stamped as userId / resolvedByUserId on inventory rows. */
  id: number;
  /** Display name — stamped as username. Null when the host has no name. */
  name: string | null;
}

/** Org identity stamped on every inventory row (#1287 §6). */
export interface OrgIdentity {
  id: string;
  name: string;
}

export interface InventoryAuth {
  /**
   * The current host user, or null when unauthenticated. Host admission runs
   * before any route body, so a factory that reaches getPrincipal() treats null
   * as an invariant breach.
   */
  getPrincipal(): Promise<InventoryPrincipal | null>;
}

export interface InventoryRuntimeConfig {
  auth: InventoryAuth;
  /** Org identity as an accessor: single-org returns one row; multi-org resolves per request. */
  org: () => OrgIdentity;
}

/** The slice of a route context a factory consumes: request + path params. */
export interface InventoryRouteCtx {
  req: Request;
  params: Record<string, string>;
}

/** A route factory's body: parse → service → model bag (stripped by the host). */
export type InventoryBag = Record<string, unknown>;
export type InventoryRouteHandler = (ctx: InventoryRouteCtx) => Promise<InventoryBag>;
