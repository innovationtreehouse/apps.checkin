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

    it('admits finance only to mark a charge not Everyday', () => {
        const route = getRoute('POST /api/expense/expenses/[id]/not-everyday');
        expect(route?.authorize).toBe('finance');
        expect(route?.envelope).toBeNull();
        expect(route?.returns).toEqual(['ExpenseLineSignoffStatus']);
        expect(route?.orderedView.map(([role]) => role)).toEqual(['isFinance']);
    });
});
