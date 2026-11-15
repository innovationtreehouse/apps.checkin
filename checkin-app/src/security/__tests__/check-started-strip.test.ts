/**
 * @jest-environment node
 */
/**
 * Boundary coverage for the background-check "started" routes. A CheckStartedRow's
 * `state` reaches the caller on their own row and, for a household lead, on the
 * rows of the household they lead; anyone else keeps personId and name alone.
 * The dismissal route admits only reviewers and the Board, as undo does.
 */
import { stripValue } from '@/security/stripper';
import type { CallerContext } from '@/security/access-resolvers';
import { getRoute, type Token } from '@/security/core';
import { classifications } from '@/security/checkStartedSyntheticClassifications';
import { SCOPE_BINDINGS } from '@/security/scopeBindings';
import '@/security/registry';

function ctx(opts: Partial<CallerContext> = {}): CallerContext {
    return {
        selfId: 1,
        householdId: 10,
        isKeyholder: false,
        isKiosk: false,
        programsLed: new Set(),
        programsCoreVolIn: new Set(),
        participantIdsInScopePrograms: new Set(),
        householdIdsInScopePrograms: new Set(),
        eventIdsInScopePrograms: new Set(),
        activeVisitorIds: new Set(),
        ledHouseholdMemberIds: new Set(),
        ...opts,
    };
}

const VIEW: readonly Token[] = ['their_own:internal', 'led_households:internal', 'public'];
const ENDPOINTS = ['GET /api/membership/check-started', 'POST /api/membership/check-started'];

const row = (personId: number) => ({ personId, name: `Person ${personId}`, state: 'NEEDS_MARKING' });
const strip = (value: object, caller: CallerContext) =>
    stripValue('CheckStartedRow', value, VIEW, caller) as Record<string, unknown>;

describe('check-started synthetic view', () => {
    it('tiers personId and name public, state internal', () => {
        expect(classifications).toEqual({
            CheckStartedRow: { personId: 'public', name: 'public', state: 'internal' },
        });
    });

    it('binds their_own and led_households on personId', () => {
        expect(SCOPE_BINDINGS.CheckStartedRow).toEqual({
            their_own: { field: 'personId', eqCtx: 'selfId' },
            led_households: { field: 'personId', inCtx: 'ledHouseholdMemberIds' },
        });
    });

    it("the caller's own row reaches them whole", () => {
        expect(strip(row(1), ctx())).toEqual(row(1));
    });

    it("a lead sees the state of each adult in the household they lead", () => {
        const lead = ctx({ ledHouseholdMemberIds: new Set([1, 2, 3]) });
        expect(strip(row(2), lead)).toEqual(row(2));
    });

    it("a non-lead co-member keeps only personId and name of another adult's row", () => {
        expect(strip(row(2), ctx())).toEqual({ personId: 2, name: 'Person 2' });
    });

    it("a lead keeps only personId and name of a row outside their household", () => {
        const lead = ctx({ ledHouseholdMemberIds: new Set([1, 2, 3]) });
        expect(strip(row(99), lead)).toEqual({ personId: 99, name: 'Person 99' });
    });

    it('a row without personId keeps no state', () => {
        expect(strip({ name: 'X', state: 'NOTHING_TO_DO' }, ctx())).toEqual({ name: 'X' });
    });

    it('any field the row does not declare is stripped, even on the own row', () => {
        expect(strip({ ...row(1), clearedAt: '2026-01-01', reviewStatus: 'BLOCKED' }, ctx())).toEqual(row(1));
    });

    it('registers both verbs for any signed-in caller, own and led rows only', () => {
        for (const endpoint of ENDPOINTS) {
            const route = getRoute(endpoint);
            expect(route?.authorize).toBe('authenticated');
            expect(route?.envelope).toBe('rows');
            expect(route?.returns).toEqual(['CheckStartedRow']);
            expect(route?.orderedView).toEqual([['authenticated', VIEW]]);
        }
    });
});

describe('POST /api/membership/reviews/dismiss', () => {
    it('admits reviewers and the Board, the same band as undo, with no bag', () => {
        const dismiss = getRoute('POST /api/membership/reviews/dismiss');
        const undo = getRoute('POST /api/membership/reviews/undo');
        expect(dismiss?.authorize).toEqual({ anyRole: ['isBackgroundCheckReviewer', 'isBoardMember'] });
        expect(dismiss?.authorize).toEqual(undo?.authorize);
        expect(dismiss?.envelope).toBeNull();
        expect(dismiss?.returns).toBeUndefined();
        expect(dismiss?.orderedView).toEqual([]);
    });
});
