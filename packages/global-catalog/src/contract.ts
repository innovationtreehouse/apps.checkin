/**
 * The injection seam. The host application (checkin) implements these
 * and calls configureCatalog() once at boot; the library reads the configured
 * runtime. The dependency arrow points one way — the library NEVER imports the
 * host, so "understand the catalog" stays "read this package."
 */

/** The acting host user, projected to what catalog rows stamp. */
export interface CatalogPrincipal {
  /** Host person id — stamped as local_user_id / *ByUserId on catalog rows. */
  id: number;
  /** Display name — stamped as *ByUsername. Null when the host has no name. */
  name: string | null;
}

/** Org identity stamped on proposals / provisional items / OrgEvent. */
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
   * Org identity for the current request, as an async ACCESSOR: the
   * host resolves it lazily (never at boot); single-org returns the one row,
   * multi-org later resolves the current org per request — same seam.
   */
  org: () => Promise<OrgIdentity>;
  /**
   * Org-event consumers, by name. The catalog calls each in-process after a transaction that wrote
   * OrgEvent rows commits; a consumer that throws replays from its own cursor.
   */
  orgEventConsumers?: Record<string, OrgEventConsumer>;
}

/** One OrgEvent row as consumers receive it; `payload` is the stored JSON body without `eventType`. */
export interface OrgEventRecord {
  id: number;
  orgId: string;
  eventType: string;
  payload: string;
  createdAt: Date;
}

export interface OrgEventConsumer {
  onOrgEvents(events: OrgEventRecord[]): Promise<void>;
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
