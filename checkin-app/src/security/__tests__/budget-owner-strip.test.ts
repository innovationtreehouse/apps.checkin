/**
 * @jest-environment node
 */
/**
 * Boundary coverage for the budget-owner synthetic views. Finance structure
 * (a Class, which bucket a person approves, their role) is `internal`; a
 * person's id and name are `public`, as on Person. No field is pii or personal.
 */
import { stripValue } from '@/security/stripper';
import type { CallerContext } from '@/security/access-resolvers';
import type { Token } from '@/security/core';
import { classifications } from '@/security/budgetOwnerSyntheticClassifications';
import { getRoute } from '@/security/core';
import '@/security/registry';
import { readLastRuns } from '@/lib/finance/postingRuns';

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

const FINANCE_OR_BOARD_VIEW: readonly Token[] = ['everyones:internal', 'public'];
const PUBLIC_ONLY: readonly Token[] = ['public'];

const strip = (model: string, row: object, tokens: readonly Token[]) =>
    stripValue(model, row, tokens, ctx) as Record<string, unknown>;

describe('budget-owner synthetic views', () => {
    it('tiers every field internal or public', () => {
        for (const [model, fields] of Object.entries(classifications)) {
            for (const [field, tier] of Object.entries(fields)) {
                expect(`${model}.${field}:${tier}`).toMatch(/:(internal|public)$/);
            }
        }
    });

    it('a QuickBooks Class option reaches finance or board whole, and nobody on a public view', () => {
        const option = { id: '5000000000000123', name: 'Programs:Robotics', active: true };
        expect(strip('QuickBooksClassOption', option, FINANCE_OR_BOARD_VIEW)).toEqual(option);
        expect(strip('QuickBooksClassOption', option, PUBLIC_ONLY)).toEqual({});
    });

    it('a public view keeps who an approver is but not which bucket or role', () => {
        const approver = { budgetOwnerId: 2, personId: 9, name: 'Pat Doe', role: 'TREASURER' };
        expect(strip('BudgetOwnerApprover', approver, FINANCE_OR_BOARD_VIEW)).toEqual(approver);
        expect(strip('BudgetOwnerApprover', approver, PUBLIC_ONLY)).toEqual({ personId: 9, name: 'Pat Doe' });
        const option = { id: 9, name: 'Pat Doe' };
        expect(strip('BudgetOwnerApproverOption', option, PUBLIC_ONLY)).toEqual(option);
    });

    it('books-map rows and account options reach finance or board whole, and nobody on a public view', () => {
        const rows: Array<[string, object]> = [
            ['BooksMapClass', { budgetOwnerId: 2, budgetOwnerName: 'Robotics', quickBooksClassId: '5000000000000123' }],
            ['BooksMapAccount', { role: 'BANK_DEPOSITS', quickBooksAccountId: '35' }],
            ['QuickBooksAccountOption', { id: '35', name: 'Checking', accountType: 'Bank', active: true }],
            ['QuickBooksListsStatus', { list: 'accounts', refreshedAt: '2026-11-14T06:00:00.000Z', entries: 42 }],
        ];
        for (const [model, row] of rows) {
            expect(strip(model, row, FINANCE_OR_BOARD_VIEW)).toEqual(row);
            expect(strip(model, row, PUBLIC_ONLY)).toEqual({});
        }
    });

    it('finance or board reads the books map; finance alone edits it', () => {
        expect(getRoute('GET /api/books-map')?.authorize).toBe('finance-or-board');
        expect(getRoute('GET /api/books-map/quickbooks-accounts')?.authorize).toBe('finance-or-board');
        for (const endpoint of ['PUT /api/books-map/classes/[budgetOwnerId]', 'PUT /api/books-map/accounts/[role]']) {
            const route = getRoute(endpoint);
            expect(route?.authorize).toBe('finance');
            expect(route?.orderedView.map(([role]) => role)).toEqual(['isFinance']);
        }
    });

    it('finance or board reads and refreshes the saved QuickBooks lists', () => {
        for (const endpoint of ['GET /api/books-map/quickbooks-lists', 'POST /api/books-map/quickbooks-lists/refresh']) {
            const route = getRoute(endpoint);
            expect(route?.authorize).toBe('finance-or-board');
            expect(route?.returns).toEqual(['QuickBooksListsStatus']);
            expect(route?.orderedView).toEqual([
                ['isFinance', FINANCE_OR_BOARD_VIEW],
                ['isBoardMember', FINANCE_OR_BOARD_VIEW],
            ]);
        }
    });

    it('finance or board asks for and reads a QuickBooks posting catch-up; a public view sees nothing', () => {
        const state = {
            lane: 'expense',
            status: 'queued',
            heldBy: 'in-kind',
            until: '2026-11-18T14:05:00.000Z',
            queued: ['expense'],
            pausedUntil: '2026-11-18T14:04:00.000Z',
            lastRuns: { income: { endedAt: '2026-11-18T13:58:00.000Z', ended: 'done', created: 100, matched: 2, capped: 'count', yieldsInRow: 0 } },
        };
        expect(strip('QuickBooksPostingCatchUp', state, FINANCE_OR_BOARD_VIEW)).toEqual(state);
        expect(strip('QuickBooksPostingCatchUp', state, PUBLIC_ONLY)).toEqual({});
        for (const endpoint of ['GET /api/finance/quickbooks/catch-up', 'POST /api/finance/quickbooks/catch-up']) {
            const route = getRoute(endpoint);
            expect(route?.authorize).toBe('finance-or-board');
            expect(route?.returns).toEqual(['QuickBooksPostingCatchUp']);
            expect(route?.orderedView).toEqual([
                ['isFinance', FINANCE_OR_BOARD_VIEW],
                ['isBoardMember', FINANCE_OR_BOARD_VIEW],
            ]);
        }
    });

    it("pins the inner keys of a lane's last run, classified with lastRuns: a new key needs a classification review", () => {
        // lastRuns is classified whole; this set was reviewed as lane names, times and counts only.
        const REVIEWED = ['capped', 'created', 'ended', 'endedAt', 'matched', 'yieldsInRow'];
        const stored = { income: { endedAt: '2026-11-18T13:58:00.000Z', ended: 'yielded', created: 3, matched: 1, capped: null, yieldsInRow: 2, unreviewed: 'x' } };
        expect(Object.keys(readLastRuns(stored).income ?? {}).sort()).toEqual(REVIEWED);
    });
});
