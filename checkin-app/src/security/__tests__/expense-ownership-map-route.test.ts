/**
 * @jest-environment node
 *
 * The part-bucket map ships each mapped part's catalog name as Item, and whether
 * the catalog could be read as ExpenseCatalogNames; the FINANCE/BOARD view reads both.
 */
import { getRoute } from '@/security/core';
import { stripValue } from '@/security/stripper';
import type { CallerContext } from '@/security/access-resolvers';
import '@/security/registry';

const ctx: CallerContext = {
    selfId: 1,
    householdId: undefined,
    isKeyholder: false,
    isKiosk: false,
    programsLed: new Set(),
    programsCoreVolIn: new Set(),
    participantIdsInScopePrograms: new Set(),
    householdIdsInScopePrograms: new Set(),
    eventIdsInScopePrograms: new Set(),
    activeVisitorIds: new Set(),
    ledHouseholdMemberIds: new Set(),
};

describe('GET /api/expense/ownership-map registry', () => {
    const route = getRoute('GET /api/expense/ownership-map');

    it('declares the catalog Item and the names flag alongside the map and the buckets', () => {
        expect(route?.authorize).toBe('finance-or-board');
        expect(route?.returns).toEqual(['PartOwnerMap', 'Item', 'ExpenseBucketView', 'ExpenseCatalogNames']);
    });

    it("keeps an item's GTIN and name for every admitted view", () => {
        for (const [, tokens] of route!.orderedView) {
            const item = stripValue('Item', { gtin13: '0012345678905', name: 'Hex bolt M6' }, tokens, ctx);
            expect(item).toEqual({ gtin13: '0012345678905', name: 'Hex bolt M6' });
        }
    });

    it('keeps the names-unavailable flag for every admitted view', () => {
        for (const [, tokens] of route!.orderedView) {
            expect(stripValue('ExpenseCatalogNames', { unavailable: true }, tokens, ctx)).toEqual({ unavailable: true });
        }
    });
});
