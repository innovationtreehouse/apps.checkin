/**
 * @jest-environment node
 *
 * Registry shape for the dev-only expense test-data toggle: who is admitted
 * and how far the view reaches.
 */
import { getRoute } from '@/security/core';
import '@/security/registry';

describe('expense test-data registry', () => {
    it('admits finance only, on the finance view', () => {
        const route = getRoute('PUT /api/expense/expenses/[id]/test-data');
        expect(route?.authorize).toBe('finance');
        expect(route?.envelope).toBeNull();
        expect(route?.returns).toEqual(['Expense']);
        expect(route?.orderedView.map(([role]) => role)).toEqual(['isFinance']);
    });
});
