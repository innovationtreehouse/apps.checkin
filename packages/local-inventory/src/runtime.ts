/**
 * The local-inventory runtime singleton. The host wires it once at
 * boot; routes read it through the accessors below. Binding touches no
 * database — the services below build lazily on first request.
 */
import { defineRuntime } from "@checkin/component-kit";
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
import { inertCatalogEventSource, type CatalogEventSource, type InventoryPrincipal, type InventoryRuntimeConfig, type OrgIdentity } from "./contract";

export const localInventoryRuntime = defineRuntime<InventoryRuntimeConfig, InventoryPrincipal>("local-inventory");
const requireRuntime = localInventoryRuntime.require;

export const configureLocalInventory = localInventoryRuntime.configure;

/** The acting host user. A 401 if absent: host admission has already run. */
export const getPrincipal = localInventoryRuntime.getPrincipal;

/** Org identity for the current request. */
export function getOrg(): Promise<OrgIdentity> {
  return requireRuntime().org();
}

/** The current request's org id, the scope of every inventory row. */
export const getOrgId = localInventoryRuntime.getOrgId;

/** The S5 replay read the host bound, or the inert one. */
export function getCatalogEventSource(): CatalogEventSource {
  return requireRuntime().catalogEventSource ?? inertCatalogEventSource;
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
      db,
    }),
  };
}

let services: ReturnType<typeof buildServices> | undefined;

/** The domain services over the library's own client, built on first use. */
export function getServices(): ReturnType<typeof buildServices> {
  services ??= buildServices();
  return services;
}

/** The host nav's pill counts for the current org: open receive-queue lines. */
export async function getNavCounts(): Promise<{ openBackorders: number }> {
  return { openBackorders: await getServices().receiveQueueService.countOpen(await getOrgId()) };
}
