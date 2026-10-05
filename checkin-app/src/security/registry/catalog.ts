// Global catalog (#1286 §5/§6) route policy. Aggregated by ../registry.ts.
import { defineRoute, type OrderedViewEntry } from '../core';

// Reads admit any catalog viewer — the single read chokepoint (§6); writes are
// INVENTORY_MANAGER-only. Catalog reference data is `public`; the only non-public
// fields are `internal` (actor attribution, free text, cross-app plumbing — §5),
// granted to the manager view. The catalog schema has no pii/personal/member
// tier, so the viewer view is `public` only and the manager view adds
// `everyones:internal`. Every route returns model bags through handler() (§5.4);
// envelope null ships the single model payload directly (arrays for lists).
//
// NOT registered here, deliberately:
//   • POST/GET /api/internal/[...path] — the S4 receipt RPC (§8). It authenticates
//     with a machine org-bearer token, not a checkin session, so it carries its
//     own gate and lives in the legacy-authz baseline (scripts/legacy-authz-routes.txt),
//     like every other machine route (webhooks/cron). The overlap-window reads
//     that the source served at /api/catalog(/items) are folded onto this surface.
//   • proposals/counts, reference-conflicts/count — badge counts, "not
//     first-landing" (§7); deferred to track 5 with the nav badges.
const CATALOG_VIEW: readonly OrderedViewEntry[] = [
    ['isInventoryManager', ['everyones:internal', 'public']],
    ['authenticated', ['public']],
];
const CATALOG_MANAGER_VIEW: readonly OrderedViewEntry[] = [
    ['isInventoryManager', ['everyones:internal', 'public']],
];

// Reads — catalog-viewer admission, tiered view.
defineRoute({ endpoint: 'GET /api/catalog/categories', authorize: 'catalog-viewer', envelope: null, returns: ['Category'], orderedView: CATALOG_VIEW });
defineRoute({ endpoint: 'GET /api/catalog/subcategories', authorize: 'catalog-viewer', envelope: null, returns: ['Subcategory'], orderedView: CATALOG_VIEW });
defineRoute({ endpoint: 'GET /api/catalog/items', authorize: 'catalog-viewer', envelope: null, returns: ['Item', 'Category', 'Subcategory'], orderedView: CATALOG_VIEW });
// Item count for the paginated list UI (#1286 §7). Returns the synthetic
// CatalogItemCount model ({ total } — public); a scalar total can't ride a Prisma
// model bag, so it is declared in catalogSyntheticClassifications.ts.
defineRoute({ endpoint: 'GET /api/catalog/items/count', authorize: 'catalog-viewer', envelope: null, returns: ['CatalogItemCount'], orderedView: CATALOG_VIEW });
defineRoute({ endpoint: 'GET /api/catalog/items/[gtin13]', authorize: 'catalog-viewer', envelope: null, returns: ['Item', 'Category', 'Subcategory'], orderedView: CATALOG_VIEW });
defineRoute({ endpoint: 'GET /api/catalog/item-references', authorize: 'catalog-viewer', envelope: null, returns: ['ItemReference', 'Item'], orderedView: CATALOG_VIEW });
defineRoute({ endpoint: 'GET /api/catalog/audit', authorize: 'catalog-viewer', envelope: null, returns: ['Item', 'ItemReference'], orderedView: CATALOG_VIEW });
defineRoute({ endpoint: 'GET /api/catalog/proposals/item-references', authorize: 'catalog-viewer', envelope: null, returns: ['ItemReferenceProposal'], orderedView: CATALOG_VIEW });
defineRoute({ endpoint: 'GET /api/catalog/provisional-items', authorize: 'catalog-viewer', envelope: null, returns: ['ProvisionalItem'], orderedView: CATALOG_VIEW });
defineRoute({ endpoint: 'GET /api/catalog/reference-conflicts', authorize: 'catalog-viewer', envelope: null, returns: ['ReferenceConflict'], orderedView: CATALOG_VIEW });
defineRoute({ endpoint: 'GET /api/catalog/conversion-challenges', authorize: 'catalog-viewer', envelope: null, returns: ['ConversionChallenge'], orderedView: CATALOG_VIEW });

// Writes — INVENTORY_MANAGER only.
defineRoute({ endpoint: 'POST /api/catalog/categories', authorize: 'inventory-manager', envelope: null, returns: ['Category'], orderedView: CATALOG_MANAGER_VIEW });
defineRoute({ endpoint: 'PUT /api/catalog/categories/[id]', authorize: 'inventory-manager', envelope: null, returns: ['Category'], orderedView: CATALOG_MANAGER_VIEW });
defineRoute({ endpoint: 'POST /api/catalog/categories/[id]/archive', authorize: 'inventory-manager', envelope: null, returns: ['Category'], orderedView: CATALOG_MANAGER_VIEW });
defineRoute({ endpoint: 'POST /api/catalog/categories/[id]/unarchive', authorize: 'inventory-manager', envelope: null, returns: ['Category'], orderedView: CATALOG_MANAGER_VIEW });
defineRoute({ endpoint: 'POST /api/catalog/subcategories', authorize: 'inventory-manager', envelope: null, returns: ['Subcategory'], orderedView: CATALOG_MANAGER_VIEW });
defineRoute({ endpoint: 'PUT /api/catalog/subcategories/[id]', authorize: 'inventory-manager', envelope: null, returns: ['Subcategory'], orderedView: CATALOG_MANAGER_VIEW });
defineRoute({ endpoint: 'POST /api/catalog/subcategories/[id]/archive', authorize: 'inventory-manager', envelope: null, returns: ['Subcategory'], orderedView: CATALOG_MANAGER_VIEW });
defineRoute({ endpoint: 'POST /api/catalog/subcategories/[id]/unarchive', authorize: 'inventory-manager', envelope: null, returns: ['Subcategory'], orderedView: CATALOG_MANAGER_VIEW });
defineRoute({ endpoint: 'POST /api/catalog/items', authorize: 'inventory-manager', envelope: null, returns: ['Item', 'Category', 'Subcategory'], orderedView: CATALOG_MANAGER_VIEW });
defineRoute({ endpoint: 'PUT /api/catalog/items/[gtin13]', authorize: 'inventory-manager', envelope: null, returns: ['Item', 'Category', 'Subcategory'], orderedView: CATALOG_MANAGER_VIEW });
defineRoute({ endpoint: 'POST /api/catalog/items/[gtin13]/archive', authorize: 'inventory-manager', envelope: null, returns: ['Item'], orderedView: CATALOG_MANAGER_VIEW });
defineRoute({ endpoint: 'POST /api/catalog/items/[gtin13]/unarchive', authorize: 'inventory-manager', envelope: null, returns: ['Item'], orderedView: CATALOG_MANAGER_VIEW });
defineRoute({ endpoint: 'POST /api/catalog/item-references', authorize: 'inventory-manager', envelope: null, returns: ['ItemReference'], orderedView: CATALOG_MANAGER_VIEW });
defineRoute({ endpoint: 'PUT /api/catalog/item-references/[id]', authorize: 'inventory-manager', envelope: null, returns: ['ItemReference'], orderedView: CATALOG_MANAGER_VIEW });
defineRoute({ endpoint: 'POST /api/catalog/item-references/[id]/archive', authorize: 'inventory-manager', envelope: null, returns: ['ItemReference'], orderedView: CATALOG_MANAGER_VIEW });
defineRoute({ endpoint: 'POST /api/catalog/item-references/[id]/unarchive', authorize: 'inventory-manager', envelope: null, returns: ['ItemReference'], orderedView: CATALOG_MANAGER_VIEW });
defineRoute({ endpoint: 'POST /api/catalog/proposals/item-references/[id]/approve', authorize: 'inventory-manager', envelope: null, returns: ['ItemReferenceProposal', 'ItemReference'], orderedView: CATALOG_MANAGER_VIEW });
defineRoute({ endpoint: 'POST /api/catalog/proposals/item-references/[id]/reject', authorize: 'inventory-manager', envelope: null, returns: ['ItemReferenceProposal'], orderedView: CATALOG_MANAGER_VIEW });
defineRoute({ endpoint: 'POST /api/catalog/provisional-items/[id]/approve', authorize: 'inventory-manager', envelope: null, returns: ['ProvisionalItem', 'Item'], orderedView: CATALOG_MANAGER_VIEW });
defineRoute({ endpoint: 'POST /api/catalog/provisional-items/[id]/reject', authorize: 'inventory-manager', envelope: null, returns: ['ProvisionalItem'], orderedView: CATALOG_MANAGER_VIEW });
defineRoute({ endpoint: 'POST /api/catalog/provisional-items/[id]/map-to-existing', authorize: 'inventory-manager', envelope: null, returns: ['ProvisionalItem'], orderedView: CATALOG_MANAGER_VIEW });
defineRoute({ endpoint: 'PUT /api/catalog/reference-conflicts/[id]/resolve', authorize: 'inventory-manager', envelope: null, returns: ['ReferenceConflict'], orderedView: CATALOG_MANAGER_VIEW });
defineRoute({ endpoint: 'POST /api/catalog/conversion-challenges/[id]/accept', authorize: 'inventory-manager', envelope: null, returns: ['ConversionChallenge'], orderedView: CATALOG_MANAGER_VIEW });
defineRoute({ endpoint: 'POST /api/catalog/conversion-challenges/[id]/reject', authorize: 'inventory-manager', envelope: null, returns: ['ConversionChallenge'], orderedView: CATALOG_MANAGER_VIEW });
