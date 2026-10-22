/**
 * @jest-environment node
 */
/**
 * Boundary coverage for the budget-owner synthetic views. A QuickBooks Class
 * option is finance structure, so the finance-or-board view (internal + public)
 * sees all of it and a public-only view sees none of it.
 */
import { stripValue } from '@/security/stripper';
import type { CallerContext } from '@/security/access-resolvers';
import type { Token } from '@/security/core';
import { classifications } from '@/security/budgetOwnerSyntheticClassifications';

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
    it('tiers every field internal', () => {
        for (const [model, fields] of Object.entries(classifications)) {
            for (const [field, tier] of Object.entries(fields)) {
                expect(`${model}.${field}:${tier}`).toMatch(/:internal$/);
            }
        }
    });

    it('a QuickBooks Class option reaches finance or board whole, and nobody on a public view', () => {
        const option = { id: '5000000000000123', name: 'Programs:Robotics', active: true };
        expect(strip('QuickBooksClassOption', option, FINANCE_OR_BOARD_VIEW)).toEqual(option);
        expect(strip('QuickBooksClassOption', option, PUBLIC_ONLY)).toEqual({});
    });
});
