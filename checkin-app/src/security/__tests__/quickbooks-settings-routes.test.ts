/**
 * @jest-environment node
 *
 * Registry shape for the QuickBooks connection settings and the dev-only
 * expense test-data toggle: who is admitted and how far each view reaches.
 */
import { getRoute } from '@/security/core';
import '@/security/registry';

describe('QuickBooks settings registry', () => {
    it.each(['GET /api/settings/quickbooks', 'PUT /api/settings/quickbooks'])('%s admits board only, through internal', endpoint => {
        const route = getRoute(endpoint);
        expect(route?.authorize).toEqual({ anyRole: ['isBoardMember'] });
        expect(route?.envelope).toBe('settings');
        expect(route?.returns).toEqual(['BoardSettings']);
        expect(route?.orderedView).toEqual([['isBoardMember', ['everyones:internal', 'member', 'public']]]);
    });
});

describe('expense test-data registry', () => {
    it('admits finance only, on the finance view', () => {
        const route = getRoute('PUT /api/expense/expenses/[id]/test-data');
        expect(route?.authorize).toBe('finance');
        expect(route?.envelope).toBeNull();
        expect(route?.returns).toEqual(['Expense']);
        expect(route?.orderedView.map(([role]) => role)).toEqual(['isFinance']);
    });
});
