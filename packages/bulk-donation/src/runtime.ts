import { ServiceError } from "./services/serviceError";
import type {
  BulkDonationConfig,
  BulkDonationPrincipal,
  CatalogLookup,
  DonationQbWriter,
  InventoryApply,
  OrgIdentity,
  OwnerDirectory,
} from "./contract";

/** Thrown by an inert port: the crossing is declared but not bound yet. Callers retry later. */
export class NotWiredError extends Error {
  constructor(port: string) {
    super(`${port} is not wired`);
    this.name = "NotWiredError";
  }
}

const INERT_OWNERS: OwnerDirectory = { list: async () => [] };
const INERT_CATALOG: CatalogLookup = { search: async () => [], getItem: async () => null };
const INERT_INVENTORY: InventoryApply = {
  apply: async () => {
    throw new NotWiredError("InventoryApply (X11)");
  },
};
const INERT_QB: DonationQbWriter = {
  post: async () => {
    throw new NotWiredError("DonationQbWriter");
  },
};

// Stored on globalThis so the boot chunk that configures and the route chunks that read see
// one runtime (survives Turbopack HMR re-evaluation).
const globalForRuntime = globalThis as typeof globalThis & { __bulkDonationRuntime?: BulkDonationConfig };

export function configureBulkDonation(config: BulkDonationConfig): void {
  globalForRuntime.__bulkDonationRuntime = config;
}

function requireRuntime(): BulkDonationConfig {
  const runtime = globalForRuntime.__bulkDonationRuntime;
  if (!runtime) {
    throw new Error("bulk-donation runtime not configured — the host must call configureBulkDonation() at boot");
  }
  return runtime;
}

/** The acting host user. Throws if absent: host admission runs before any route body. */
export async function getPrincipal(): Promise<BulkDonationPrincipal> {
  const principal = await requireRuntime().auth.getPrincipal();
  if (!principal || !Number.isInteger(principal.id)) throw new Error("no bulk-donation principal — host admission should have rejected this request");
  return principal;
}

export function getOrg(): Promise<OrgIdentity> {
  return requireRuntime().org();
}

/** The current request's org id, the scope of every donation row. */
export async function getOrgId(): Promise<string> {
  return (await getOrg()).id;
}

export function getOwnerDirectory(): OwnerDirectory {
  return requireRuntime().owners ?? INERT_OWNERS;
}

export function getCatalogLookup(): CatalogLookup {
  return requireRuntime().catalog ?? INERT_CATALOG;
}

export function getInventoryApply(): InventoryApply {
  return requireRuntime().inventory ?? INERT_INVENTORY;
}

export function getQbWriter(): DonationQbWriter {
  return requireRuntime().qb ?? INERT_QB;
}

/** An HTTP-status error thrown by a route factory; the host translates it at the route boundary. */
export class DonationHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "DonationHttpError";
  }
}

export function donationError(status: number, message: string): DonationHttpError {
  return new DonationHttpError(status, message);
}

/** Run a service call, remapping its ServiceError to a host-rendered HTTP error. */
export async function mapServiceErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ServiceError) throw donationError(err.statusCode, err.message);
    throw err;
  }
}
