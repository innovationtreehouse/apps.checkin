// Public surface of the @inventory/local-inventory library: the domain, plus the
// route factories and runtime seams below. Pages and nav are subpath exports.
export * from "./lib/db";
export * from "./lib/gtin";
export * from "./lib/db/schema";

export * from "./lib/repositories/inventoryRepository";
export * from "./lib/repositories/locationRepository";
export * from "./lib/repositories/orgEventsRepository";
export * from "./lib/repositories/provisionalItemRepository";
export * from "./lib/repositories/provisionalResolutionRepository";
export * from "./lib/repositories/receiveQueueRepository";

export * from "./lib/services/inventoryService";
export * from "./lib/services/locationService";
export * from "./lib/services/provisionalItemService";
export * from "./lib/services/receiptService";
export * from "./lib/services/receiveQueueService";
export * from "./lib/services/serviceError";

export * from "./workflows/index";

// Route + runtime surface the host wires in. Exposed off the main entry, not a
// subpath: Turbopack's Docker build resolves a package's `.` export only.
export * as routes from "./routes";
export {
  configureLocalInventory,
  getPrincipal,
  getOrg,
  inventoryError,
  mapServiceErrors,
  InventoryHttpError,
} from "./runtime";
export type {
  InventoryPrincipal,
  OrgIdentity,
  InventoryAuth,
  InventoryRuntimeConfig,
  InventoryRouteCtx,
  InventoryBag,
  InventoryRouteHandler,
} from "./contract";
