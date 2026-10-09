// Local inventory (#1287 §5/§6) route policy. Aggregated by ../registry.ts.
import { defineRoute, type OrderedViewEntry } from '../core';

// Reads admit any inventory viewer through the reused `catalog-viewer` resolver —
// inventory read-eligibility is identical to catalog's (§6); writes and the
// manager work-queue reads are INVENTORY_MANAGER-only. Inventory reference data is `public`; the non-public
// fields are `internal` (orgId, actor attribution, free text, cross-app
// plumbing — §5), granted to the manager view. The schema has no pii/personal
// tier, so the viewer view is `public` only. Verbs follow the source app's
// route tree; DELETEs answer 204 with no bag.
//
// NOT registered here, deliberately:
//   • the machine surface — org-bearer POST /api/inventory/apply and the
//     X-Service-Key /api/internal/* RPC. checkin cannot gate a machine-bearer
//     route; the apply crossing is in-process only (§8c).
//   • the source's /api/global-catalog/items* proxies — replaced by an
//     in-process catalog read (§8b).
//   • GET/PUT /api/inventory/system-data — the source's settings routes; local
//     inventory has no settings model (§7).
const INVENTORY_VIEW: readonly OrderedViewEntry[] = [
    ['isInventoryManager', ['everyones:internal', 'public']],
    ['authenticated', ['public']],
];
const INVENTORY_MANAGER_VIEW: readonly OrderedViewEntry[] = [
    ['isInventoryManager', ['everyones:internal', 'public']],
];

// Reads — inventory-viewer admission, tiered view.
defineRoute({ endpoint: 'GET /api/inventory/locations', authorize: 'catalog-viewer', envelope: null, returns: ['Location'], orderedView: INVENTORY_VIEW });
defineRoute({ endpoint: 'GET /api/inventory/org-items', authorize: 'catalog-viewer', envelope: null, returns: ['OrgItem', 'Location'], orderedView: INVENTORY_VIEW });
defineRoute({ endpoint: 'GET /api/inventory/org-items/[gtin13]', authorize: 'catalog-viewer', envelope: null, returns: ['OrgItem', 'Location'], orderedView: INVENTORY_VIEW });
defineRoute({ endpoint: 'GET /api/inventory/receive-queue', authorize: 'catalog-viewer', envelope: null, returns: ['ReceiveQueue'], orderedView: INVENTORY_VIEW });
defineRoute({ endpoint: 'GET /api/inventory/inventory-log', authorize: 'catalog-viewer', envelope: null, returns: ['InventoryLog'], orderedView: INVENTORY_VIEW });
defineRoute({ endpoint: 'GET /api/inventory/received-inventory-deltas', authorize: 'catalog-viewer', envelope: null, returns: ['ReceivedInventoryDelta'], orderedView: INVENTORY_VIEW });

// Totals for the numbered-pagination lists (§11 track 5): the unbounded log and
// delta ledger, plus org-items (catalog-sized, like GET /api/catalog/items/count).
// Each returns the synthetic InventoryCount model (inventorySyntheticClassifications.ts).
defineRoute({ endpoint: 'GET /api/inventory/inventory-log/count', authorize: 'catalog-viewer', envelope: null, returns: ['InventoryCount'], orderedView: INVENTORY_VIEW });
defineRoute({ endpoint: 'GET /api/inventory/org-items/count', authorize: 'catalog-viewer', envelope: null, returns: ['InventoryCount'], orderedView: INVENTORY_VIEW });
defineRoute({ endpoint: 'GET /api/inventory/received-inventory-deltas/count', authorize: 'catalog-viewer', envelope: null, returns: ['InventoryCount'], orderedView: INVENTORY_VIEW });

// Manager-only — the work-queue reads (the source gates these to managers too),
// then the writes.
defineRoute({ endpoint: 'GET /api/inventory/inventory-merge-conflicts', authorize: 'inventory-manager', envelope: null, returns: ['InventoryMergeConflict'], orderedView: INVENTORY_MANAGER_VIEW });
defineRoute({ endpoint: 'GET /api/inventory/provisional-items', authorize: 'inventory-manager', envelope: null, returns: ['InventoryProvisionalItem'], orderedView: INVENTORY_MANAGER_VIEW });
defineRoute({ endpoint: 'GET /api/inventory/received-org-events', authorize: 'inventory-manager', envelope: null, returns: ['InventoryReceivedOrgEvent'], orderedView: INVENTORY_MANAGER_VIEW });
defineRoute({ endpoint: 'POST /api/inventory/locations', authorize: 'inventory-manager', envelope: null, returns: ['Location'], orderedView: INVENTORY_MANAGER_VIEW });
defineRoute({ endpoint: 'PUT /api/inventory/locations/[id]', authorize: 'inventory-manager', envelope: null, returns: ['Location'], orderedView: INVENTORY_MANAGER_VIEW });
defineRoute({ endpoint: 'DELETE /api/inventory/locations/[id]', authorize: 'inventory-manager', envelope: null, orderedView: INVENTORY_MANAGER_VIEW });
defineRoute({ endpoint: 'POST /api/inventory/locations/[id]/reassign', authorize: 'inventory-manager', envelope: null, returns: ['OrgItem', 'Location'], orderedView: INVENTORY_MANAGER_VIEW });
defineRoute({ endpoint: 'POST /api/inventory/org-items', authorize: 'inventory-manager', envelope: null, returns: ['OrgItem', 'Location'], orderedView: INVENTORY_MANAGER_VIEW });
defineRoute({ endpoint: 'PUT /api/inventory/org-items/[gtin13]', authorize: 'inventory-manager', envelope: null, returns: ['OrgItem', 'Location'], orderedView: INVENTORY_MANAGER_VIEW });
defineRoute({ endpoint: 'DELETE /api/inventory/org-items/[gtin13]', authorize: 'inventory-manager', envelope: null, orderedView: INVENTORY_MANAGER_VIEW });
defineRoute({ endpoint: 'DELETE /api/inventory/receive-queue/[id]', authorize: 'inventory-manager', envelope: null, orderedView: INVENTORY_MANAGER_VIEW });
defineRoute({ endpoint: 'POST /api/inventory/receive-queue/[id]/fulfill', authorize: 'inventory-manager', envelope: null, returns: ['ReceiveQueue', 'OrgItem'], orderedView: INVENTORY_MANAGER_VIEW });
defineRoute({ endpoint: 'PUT /api/inventory/inventory-merge-conflicts/[id]/resolve', authorize: 'inventory-manager', envelope: null, returns: ['InventoryMergeConflict'], orderedView: INVENTORY_MANAGER_VIEW });
