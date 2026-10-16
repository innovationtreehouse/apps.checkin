/**
 * @jest-environment node
 */
/**
 * The board's unconfirmed Shopify stock screen: both routes admit the board
 * only, and their computed rows keep exactly their declared fields.
 */
import '@/security/registry';
import { getRoute } from '@/security/core';
import { stripValue } from '@/security/stripper';
import type { CallerContext } from '@/security/access-resolvers';

function ctx(): CallerContext {
    return {
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
}

const BOARD = ['everyones:internal', 'public'] as const;

it.each(['GET /api/finance-ops/shopify-stock', 'POST /api/finance-ops/shopify-stock/[id]'])('%s admits the board only', (endpoint) => {
    const spec = getRoute(endpoint);
    expect(spec?.authorize).toEqual({ anyRole: ['isBoardMember'] });
    expect(spec?.orderedView.map(([role]) => role)).toEqual(['isBoardMember']);
});

it('keeps an UnconfirmedStockRow for the board; drops an over-selected field', () => {
    const kept = { programId: 3, programName: 'Robotics', unconfirmed: -2, carry: 1, unconfirmedSince: '2026-10-13T00:00:00.000Z', shopifyAvailable: 4 };
    expect(stripValue('UnconfirmedStockRow', { ...kept, shopifyStockLeaseToken: 'x' }, BOARD, ctx())).toEqual(kept);
});

it('shows nothing internal to a public-only view', () => {
    expect(stripValue('UnconfirmedStockSettlement', { programId: 3, choice: 'landed', amount: -2, carry: 0 }, ['public'], ctx())).toEqual({});
});
