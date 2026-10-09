/**
 * The local-inventory runtime singleton (#1287 §3). The host wires it once at
 * boot; routes read it through the accessors below. Binding touches no
 * database — the services below build lazily on first request.
 */
import { db } from "./lib/db";
import { createInventoryRepository } from "./lib/repositories/inventoryRepository";
import { createLocationRepository } from "./lib/repositories/locationRepository";
import { createProvisionalItemRepository } from "./lib/repositories/provisionalItemRepository";
import { createProvisionalResolutionRepository } from "./lib/repositories/provisionalResolutionRepository";
import { createReceiveQueueRepository } from "./lib/repositories/receiveQueueRepository";
import { createInventoryService } from "./lib/services/inventoryService";
import { createLocationService } from "./lib/services/locationService";
import { createProvisionalItemService } from "./lib/services/provisionalItemService";
import { createReceiveQueueService } from "./lib/services/receiveQueueService";
import { ServiceError } from "./lib/services/serviceError";
import type { InventoryPrincipal, InventoryRuntimeConfig, OrgIdentity } from "./contract";

// On globalThis so the instrumentation chunk that configures it and the route
// chunks that read it share one runtime (and it survives dev HMR).
const globalForRuntime = globalThis as typeof globalThis & {
  __localInventoryRuntime?: InventoryRuntimeConfig;
};

export function configureLocalInventory(config: InventoryRuntimeConfig): void {
  globalForRuntime.__localInventoryRuntime = config;
}

function requireRuntime(): InventoryRuntimeConfig {
  const runtime = globalForRuntime.__localInventoryRuntime;
  if (!runtime) {
    throw new Error(
      "local-inventory runtime not configured — the host must call configureLocalInventory() at boot",
    );
  }
  return runtime;
}

/** The acting host user. Throws if absent: host admission has already run. */
export async function getPrincipal(): Promise<InventoryPrincipal> {
  const principal = await requireRuntime().auth.getPrincipal();
  if (!principal || !Number.isInteger(principal.id)) {
    throw new Error("no inventory principal — host admission should have rejected this request");
  }
  return principal;
}

/** Org identity for the current request (#1287 §6). */
export function getOrg(): Promise<OrgIdentity> {
  return requireRuntime().org();
}

/** The current request's org id, the scope of every inventory row. */
export async function getOrgId(): Promise<string> {
  return (await getOrg()).id;
}

function buildServices() {
  const inventoryRepo = createInventoryRepository(db);
  const inventoryService = createInventoryService({ inventoryRepo, db });
  const provisionalRepo = createProvisionalItemRepository(db);
  return {
    inventoryService,
    locationService: createLocationService({ locationRepo: createLocationRepository(db), db }),
    provisionalItemService: createProvisionalItemService({
      provisionalRepo,
      resolutionRepo: createProvisionalResolutionRepository(db),
      inventoryRepo,
      db,
    }),
    receiveQueueService: createReceiveQueueService({
      receiveQueueRepo: createReceiveQueueRepository(db),
      provisionalRepo,
      inventoryService,
    }),
  };
}

let services: ReturnType<typeof buildServices> | undefined;

/** The domain services over the library's own client, built on first use. */
export function getServices(): ReturnType<typeof buildServices> {
  services ??= buildServices();
  return services;
}

/**
 * An HTTP-status error thrown by a route factory. The host translates it into
 * its own API error at the route boundary.
 */
export class InventoryHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "InventoryHttpError";
  }
}

export function inventoryError(status: number, message: string): InventoryHttpError {
  return new InventoryHttpError(status, message);
}

/** Run a service call, remapping its ServiceError to a host-rendered HTTP error. */
export async function mapServiceErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ServiceError) throw inventoryError(err.statusCode, err.message);
    throw err;
  }
}
