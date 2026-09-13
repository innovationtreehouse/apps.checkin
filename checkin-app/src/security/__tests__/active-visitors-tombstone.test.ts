/**
 * @jest-environment node
 */
/**
 * all_current_visitors must not count a tombstoned visit (#1503).
 *
 * A Visit is tombstoned, never removed (deletedAt + deletedById). Deleting an
 * OPEN visit therefore leaves departedAt null forever, so `departedAt: null`
 * alone reads the row as "this person is currently in the building" for the
 * rest of time. The keyholder grant fails OPEN on that row, which is why both
 * halves of the scope are pinned here:
 *
 *   - the context prefetch that builds ctx.activeVisitorIds
 *     (buildCallerContext, access-resolvers.ts), and
 *   - the per-row Visit predicate (SCOPE_BINDINGS, scopeBindings.ts).
 *
 * Person.all_current_visitors keys on ctx.activeVisitorIds, so it is fixed by
 * the prefetch rather than by its own binding — the last describe pins that so
 * the transitive path cannot silently regress.
 */
import prisma from '@/lib/prisma';
import { buildCallerContext, scopesHeld, type CallerContext } from '../access-resolvers';
import { LIVE_PERSON } from '@/lib/person/filters';
import { LIVE_VISIT } from '@/lib/visit/filters';
import type { CtxNeeds } from '../core';
import type { AuthResult } from '@/types/auth';

const keyholderAuth: AuthResult = {
    type: 'session',
    user: {
        id: 12,
        householdId: 6,
        isSysadmin: false,
        isBoardMember: false,
        isKeyholder: true,
        isBackgroundCheckReviewer: false,
        isOperations: false,
        isInventoryManager: false,
    },
};

// What deriveCtxNeeds yields for a route whose only row-scoped grant is
// all_current_visitors: the visitor prefetch and nothing else.
const VISITORS_ONLY: CtxNeeds = {
    programs: false,
    programHouseholds: false,
    programEvents: false,
    activeVisitors: true,
    ledHouseholdMembers: false,
};

function ctx(opts: Partial<CallerContext> = {}): CallerContext {
    return {
        selfId: undefined,
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
        ...opts,
    };
}

describe('activeVisitorIds prefetch excludes tombstoned visits and merged-away people', () => {
    it('filters the query by LIVE_VISIT and LIVE_PERSON, not departedAt alone', async () => {
        // The prefetch is a single findMany, so the `where` IS the filter: a
        // tombstoned open visit reaches activeVisitorIds iff the database is
        // asked for it. Asserting the query is what makes this a unit test.
        const findMany = jest.fn().mockResolvedValue([{ personId: 9 }]);
        prisma.visit.findMany = findMany;

        const built = await buildCallerContext(keyholderAuth, VISITORS_ONLY);

        expect(findMany).toHaveBeenCalledWith({
            where: { departedAt: null, ...LIVE_VISIT, person: LIVE_PERSON },
            select: { personId: true },
        });
        expect([...built.activeVisitorIds]).toEqual([9]);
    });
});

describe('Visit.all_current_visitors — the per-row predicate', () => {
    const keyholder = ctx({ selfId: 12, householdId: 6, isKeyholder: true });
    const openVisit = { id: 1, personId: 9, departedAt: null, deletedAt: null };

    it('grants it on a live open visit', () => {
        expect(scopesHeld('Visit', openVisit, keyholder).has('all_current_visitors')).toBe(true);
    });

    it('does NOT grant it on a tombstoned open visit', () => {
        const tombstoned = { ...openVisit, deletedAt: new Date() };
        expect(scopesHeld('Visit', tombstoned, keyholder).has('all_current_visitors')).toBe(false);
    });

    it('still does not grant it on a departed visit, or to a non-keyholder', () => {
        const departed = { ...openVisit, departedAt: new Date() };
        expect(scopesHeld('Visit', departed, keyholder).has('all_current_visitors')).toBe(false);
        expect(scopesHeld('Visit', openVisit, ctx({ selfId: 12 })).has('all_current_visitors')).toBe(
            false,
        );
    });
});

describe('Person.all_current_visitors — fixed transitively by the prefetch', () => {
    it('holds only for people the prefetch put in activeVisitorIds', () => {
        // The Person binding reads ctx.activeVisitorIds and nothing else, so a
        // person whose only open visit was tombstoned is absent from the set
        // and holds nothing — no second binding change needed.
        const keyholder = ctx({ selfId: 12, isKeyholder: true, activeVisitorIds: new Set([9]) });
        expect(scopesHeld('Person', { id: 9 }, keyholder).has('all_current_visitors')).toBe(true);
        expect(scopesHeld('Person', { id: 7 }, keyholder).has('all_current_visitors')).toBe(false);
    });
});
