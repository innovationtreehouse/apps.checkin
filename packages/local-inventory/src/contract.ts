/**
 * The injection seam. The host (checkin) implements these and calls
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

/** Org identity stamped on every inventory row. */
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
  /**
   * Org identity as an async accessor, called once per request: the host may
   * resolve it from its own store, so it is never read at boot.
   */
  org: () => Promise<OrgIdentity>;
  /** S5 replay read; inert (no events) until the host binds it to the catalog. */
  catalogEventSource?: CatalogEventSource;
  alerts?: InventoryAlerts;
}

/** Alerts the host binds to reach a person. */
export interface InventoryAlerts {
  /** Catalog events a catch-up run left undone: newly failed, stalled over its cap, or the catalog unreadable. */
  orgEventsStuck(event: { failed: number; unprocessed: number; unreadable: boolean }): Promise<void>;
}

/** One catalog OrgEvent row; `payload` is its stored JSON body without `eventType`. */
export interface OrgEventRecord {
  id: number;
  orgId: string;
  eventType: string;
  payload: string;
  createdAt: Date;
}

/** Replay read: the org's events with id greater than `afterId`, ascending. */
export interface CatalogEventSource {
  eventsSince(orgId: string, afterId: number): Promise<OrgEventRecord[]>;
}

export const inertCatalogEventSource: CatalogEventSource = { eventsSince: async () => [] };

/** The slice of a route context a factory consumes: request + path params. */
export interface InventoryRouteCtx {
  req: Request;
  params: Record<string, string>;
}

/** A route factory's body: parse → service → model bag (stripped by the host). */
export type InventoryBag = Record<string, unknown>;
export type InventoryRouteHandler = (ctx: InventoryRouteCtx) => Promise<InventoryBag>;
