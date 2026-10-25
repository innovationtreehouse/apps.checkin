/**
 * @jest-environment node
 *
 * The part-bucket map ships each mapped part's catalog name as Item, which the
 * FINANCE/BOARD view reads.
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

    it('declares the catalog Item alongside the map and the buckets', () => {
        expect(route?.authorize).toBe('finance-or-board');
        expect(route?.returns).toEqual(['PartOwnerMap', 'Item', 'ExpenseBucketView']);
    });

    it("keeps an item's GTIN and name for every admitted view", () => {
        for (const [, tokens] of route!.orderedView) {
            const item = stripValue('Item', { gtin13: '0012345678905', name: 'Hex bolt M6' }, tokens, ctx);
            expect(item).toEqual({ gtin13: '0012345678905', name: 'Hex bolt M6' });
        }
    });
});
