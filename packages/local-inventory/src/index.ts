// Public surface of the @inventory/local-inventory library (Track 1: domain only —
// routes, components, pages, nav, and the runtime/contract seams land in later tracks).
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
export * from "./lib/services/orgSettingsService";
export * from "./lib/services/provisionalItemService";
export * from "./lib/services/receiptService";
export * from "./lib/services/receiveQueueService";
export * from "./lib/services/userService";
export * from "./lib/services/serviceError";

export * from "./workflows/index";
