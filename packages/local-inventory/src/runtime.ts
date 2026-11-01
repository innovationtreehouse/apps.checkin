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
import { createReceiptService, type ReceiptService } from "./lib/services/receiptService";
import { createReceiveQueueService } from "./lib/services/receiveQueueService";
import { inertCatalogEventSource, type CatalogEventSource, type InventoryAlerts, type InventoryPrincipal, type InventoryRuntimeConfig } from "./contract";

export const localInventoryRuntime = defineRuntime<InventoryRuntimeConfig, InventoryPrincipal>("local-inventory");
const requireRuntime = localInventoryRuntime.require;

export const configureLocalInventory = localInventoryRuntime.configure;

/** The acting host user. A 401 if absent: host admission has already run. */
export const getPrincipal = localInventoryRuntime.getPrincipal;

/** Org identity for the current request. */
/** The current request's org id, the scope of every inventory row. */
export const getOrgId = localInventoryRuntime.getOrgId;

/** The S5 replay read the host bound, or the inert one. */
export function getCatalogEventSource(): CatalogEventSource {
  return requireRuntime().catalogEventSource ?? inertCatalogEventSource;
}

/** The alerts the host bound, if any. */
export function getInventoryAlerts(): InventoryAlerts | undefined {
  return requireRuntime().alerts;
}

function buildServices() {
  const inventoryRepo = createInventoryRepository(db);
  const inventoryService = createInventoryService({ inventoryRepo, db });
  const provisionalRepo = createProvisionalItemRepository(db);
  const receiveQueueRepo = createReceiveQueueRepository(db);
  const provisionalItemService = createProvisionalItemService({
    provisionalRepo,
    resolutionRepo: createProvisionalResolutionRepository(db),
    inventoryRepo,
    db,
  });
  return {
    inventoryService,
    locationService: createLocationService({ locationRepo: createLocationRepository(db), db }),
    provisionalItemService,
    receiptService: createReceiptService({ provisionalItemService, inventoryRepo, receiveQueueRepo, db }),
    receiveQueueService: createReceiveQueueService({ receiveQueueRepo, db }),
  };
}

let services: ReturnType<typeof buildServices> | undefined;

/** The domain services over the library's own client, built on first use. */
export function getServices(): ReturnType<typeof buildServices> {
  services ??= buildServices();
  return services;
}

/** What the host binds its inventory crossings to: stock applied once per receipt or donation, and why a donation's apply failed. */
export const inventoryApply: Pick<ReceiptService, "applyReceipt" | "applyDonation" | "donationFailureReason"> = {
  applyReceipt: (...args) => getServices().receiptService.applyReceipt(...args),
  applyDonation: (...args) => getServices().receiptService.applyDonation(...args),
  donationFailureReason: (...args) => getServices().receiptService.donationFailureReason(...args),
};

/** The host nav's pill counts for the current org: open receive-queue lines. */
export async function getNavCounts(): Promise<{ openBackorders: number }> {
  return { openBackorders: await getServices().receiveQueueService.countOpen(await getOrgId()) };
}
