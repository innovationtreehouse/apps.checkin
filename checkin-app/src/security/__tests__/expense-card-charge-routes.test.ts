/**
 * @jest-environment node
 *
 * Registry shape for the card-charge sign-off writes: who is admitted and how
 * far the view reaches.
 */
import { getRoute } from '@/security/core';
import '@/security/registry';

describe('expense card-charge registry', () => {
    it('admits finance or board to record the Board authorization', () => {
        const route = getRoute('POST /api/expense/expenses/[id]/board-authorization');
        expect(route?.authorize).toBe('finance-or-board');
        expect(route?.envelope).toBeNull();
        expect(route?.returns).toEqual(['ExpenseLineSignoffStatus']);
        expect(route?.orderedView.map(([role]) => role)).toEqual(['isFinance', 'isBoardMember']);
    });

    it('has no route to mark a charge not Everyday: the amounts alone decide it', () => {
        expect(getRoute('POST /api/expense/expenses/[id]/not-everyday')).toBeUndefined();
    });
});
