/**
 * @jest-environment node
 *
 * Registry shape for the reimbursee's QuickBooks Vendor link: who is admitted
 * and how far the view reaches.
 */
import { getRoute } from '@/security/core';
import '@/security/registry';

describe('expense reimbursee-vendor registry', () => {
    it.each([
        ['GET /api/expense/expenses/[id]/reimbursee-vendor', ['ExpenseReimburseeVendor', 'ExpenseReimburseeView']],
        ['PUT /api/expense/expenses/[id]/reimbursee-vendor', ['ExpenseReimburseeVendor']],
        ['GET /api/expense/expenses/[id]/reimbursee-vendor/options', ['ExpenseQbVendorOption']],
    ])('admits finance only to %s, on the finance view', (endpoint, returns) => {
        const route = getRoute(endpoint);
        expect(route?.authorize).toBe('finance');
        expect(route?.envelope).toBeNull();
        expect(route?.returns).toEqual(returns);
        expect(route?.orderedView.map(([role]) => role)).toEqual(['isFinance']);
    });
});
