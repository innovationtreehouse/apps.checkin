/**
 * @jest-environment node
 *
 * Registry shape for the batch line actions, Approve All and Sign all as
 * Treasurer: who is admitted and how far the view reaches. The library checks
 * each line.
 */
import { getRoute } from '@/security/core';
import '@/security/registry';

describe('expense line-actions registry', () => {
    it('admits a bucket approver to approve every line on an expense at once', () => {
        const route = getRoute('POST /api/expense/expenses/[id]/approve-lines');
        expect(route?.authorize).toBe('expense-approver');
        expect(route?.envelope).toBeNull();
        expect(route?.returns).toEqual(['LineItemOwnerApproval']);
        expect(route?.orderedView.map(([role]) => role)).toEqual(['isFinance', 'isBoardMember', 'authenticated']);
    });

    it("gives an approver who is neither FINANCE nor Board the internal tier only", () => {
        const route = getRoute('POST /api/expense/expenses/[id]/approve-lines');
        expect(route?.orderedView.find(([role]) => role === 'authenticated')?.[1]).toEqual(['everyones:internal']);
    });

    it('admits finance or board to sign every listed line on an expense at once', () => {
        const route = getRoute('POST /api/expense/expenses/[id]/sign-lines');
        expect(route?.authorize).toBe('finance-or-board');
        expect(route?.envelope).toBeNull();
        expect(route?.returns).toEqual(['ExpenseLineSignoffStatus']);
        expect(route?.orderedView.map(([role]) => role)).toEqual(['isFinance', 'isBoardMember']);
    });
});
