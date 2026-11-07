/**
 * The local-inventory runtime singleton. The host wires it once at
 * boot; routes read it through the accessors below. Binding touches no
 * database — the services below build lazily on first request.
 */
import { defineRuntime, settleCounts } from "@checkin/component-kit";
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

/** Whether the catalog the host bound has an active item with this GTIN; throws when the host bound none. */
export async function catalogHasActiveItem(gtin13: string): Promise<boolean> {
  const catalog = requireRuntime().catalog;
  if (!catalog) throw new Error("local-inventory: no catalog is bound, so no catalog item can be checked");
  return (await catalog.getActiveItem(gtin13)) != null;
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

/** What the host binds receiving's backorder count to: each receipt's lines still open on the receive queue. */
export const openBackordersByReceipt = (orgId: string, receiptIds: string[]): Promise<Map<string, number>> =>
  getServices().receiveQueueService.openBackordersByReceipt(orgId, receiptIds);

/** An org's items with no location: the Needs a location list and its pill. */
export const unlocatedWhere = (orgId: string) => ({ orgId, locationId: null });

/** The host nav's pill counts for the current org: open receive-queue lines, pending merge conflicts and unlocated items. A failed count is left out. */
export async function getNavCounts(): Promise<Partial<Record<"openBackorders" | "pendingMergeConflicts" | "unlocated", number>>> {
  const orgId = await getOrgId();
  return settleCounts("local-inventory", {
    openBackorders: () => getServices().receiveQueueService.countOpen(orgId),
    pendingMergeConflicts: () => db.inventoryMergeConflict.count({ where: { orgId, status: "pending" } }),
    unlocated: () => db.orgItem.count({ where: unlocatedWhere(orgId) }),
  });
}
