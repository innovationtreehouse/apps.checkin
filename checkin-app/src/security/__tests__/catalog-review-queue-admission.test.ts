/**
 * @jest-environment node
 *
 * The catalog review queues are INVENTORY_MANAGER-only reads; finished catalog
 * data stays open to every catalog viewer (docs/rules/inventory.md, Access).
 */
import { getRoute } from '@/security/core';
import '@/security/registry';

const REVIEW_QUEUE_READS = [
    'GET /api/catalog/proposals/item-references',
    'GET /api/catalog/provisional-items',
    'GET /api/catalog/reference-conflicts',
    'GET /api/catalog/conversion-challenges',
];

const FINISHED_CATALOG_READS = [
    'GET /api/catalog/categories',
    'GET /api/catalog/subcategories',
    'GET /api/catalog/items',
    'GET /api/catalog/items/count',
    'GET /api/catalog/items/[gtin13]',
    'GET /api/catalog/item-references',
    'GET /api/catalog/audit',
];

describe('catalog read admission', () => {
    it.each(REVIEW_QUEUE_READS)('%s admits INVENTORY_MANAGER only', (endpoint) => {
        const spec = getRoute(endpoint);
        expect(spec?.authorize).toBe('inventory-manager');
        expect(spec?.orderedView.map(([role]) => role)).toEqual(['isInventoryManager']);
    });

    it.each(FINISHED_CATALOG_READS)('%s admits any catalog viewer', (endpoint) => {
        expect(getRoute(endpoint)?.authorize).toBe('catalog-viewer');
    });
});
