/**
 * @jest-environment node
 */
/**
 * Visit.led_households — the household lead's act-for-members grant (#1254, AT3).
 *
 * A lead may correct visits for the members of their household, so the response
 * must carry those rows' `personal` fields (arrivedAt/departedAt). `their_own`
 * alone cannot express that: it is `Visit.personId === selfId`, false on every
 * row the capability exists to return. Visit has no householdId column either,
 * so the grant matches personId against ctx.ledHouseholdMemberIds.
 *
 * These guards pin both edges of the token:
 *   - a lead holds it on a member's visit, and the times survive stripping;
 *   - a NON-lead of the same household holds nothing — led_households is
 *     strictly narrower than their_households, which is the reason it is its
 *     own scope rather than a re-reading of that one;
 *   - self-correction still works via their_own (a plain member's roster is
 *     empty, so they are not a household match);
 *   - `internal` tombstone fields stay stripped for everyone here.
 */
import { scopesHeld, type CallerContext } from '../access-resolvers';
import { stripValue } from '../stripper';
import type { Token } from '../core';

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

// Household 2 = people 5 (the lead), 6, 9. Person 7 is outside it. The row
// under test belongs to 9, so every caller below is a NON-owner except `owner`
// — otherwise their_own would mask what led_households does or doesn't grant.
const lead = ctx({ selfId: 5, householdId: 2, ledHouseholdMemberIds: new Set([5, 6, 9]) });
// Same household, NOT a lead — buildCallerContext leaves the roster empty.
const sibling = ctx({ selfId: 6, householdId: 2 });
const owner = ctx({ selfId: 9, householdId: 2 });
const stranger = ctx({ selfId: 77, householdId: 8 });

// The view the registry grants both /api/attendance/manual/[id] verbs.
const VIEW: Token[] = ['their_own:personal', 'led_households:personal', 'member', 'public'];

const memberVisit = { id: 1, personId: 9, arrivedAt: new Date(0), departedAt: new Date(1), deletedAt: null };

describe('Visit.led_households (household lead act-for-members)', () => {
    it('grants led_households to a lead on a household member’s visit', () => {
        expect(scopesHeld('Visit', memberVisit, lead).has('led_households')).toBe(true);
    });

    it('does NOT grant it to a non-lead member of the SAME household', () => {
        expect(scopesHeld('Visit', memberVisit, sibling).has('led_households')).toBe(false);
    });

    it('does NOT grant it on a visit belonging to someone outside the household', () => {
        const outside = { ...memberVisit, personId: 7 };
        expect(scopesHeld('Visit', outside, lead).has('led_households')).toBe(false);
    });

    it('does NOT grant it to a caller who leads no household', () => {
        expect(scopesHeld('Visit', memberVisit, stranger).has('led_households')).toBe(false);
    });

    it('a lead holds led_households but NOT their_own on a member’s visit', () => {
        const held = scopesHeld('Visit', memberVisit, lead);
        expect(held.has('their_own')).toBe(false);
        expect(held.has('led_households')).toBe(true);
    });

    it('self-correction is unaffected — the owner still holds their_own', () => {
        const held = scopesHeld('Visit', memberVisit, owner);
        expect(held.has('their_own')).toBe(true);
        // ...and holds it WITHOUT led_households: a plain member's roster is
        // empty, which is why dropping their_own would break self-edit.
        expect(held.has('led_households')).toBe(false);
    });
});

describe('Visit.led_households — stripping under the registered view', () => {
    it('keeps the times for a lead reading a member’s visit', () => {
        const out = stripValue('Visit', memberVisit, VIEW, lead) as Record<string, unknown>;
        expect(out.arrivedAt).toEqual(memberVisit.arrivedAt);
        expect(out.departedAt).toEqual(memberVisit.departedAt);
    });

    it('strips the times for a non-lead sibling on the same row', () => {
        const out = stripValue('Visit', memberVisit, VIEW, sibling) as Record<string, unknown>;
        expect(out).not.toHaveProperty('arrivedAt');
        expect(out).not.toHaveProperty('departedAt');
        expect(out.personId).toBe(9); // public tier still rides through
    });

    it('keeps the times for the owner editing their own visit', () => {
        const out = stripValue('Visit', memberVisit, VIEW, owner) as Record<string, unknown>;
        expect(out.arrivedAt).toEqual(memberVisit.arrivedAt);
    });

    it('never exposes the internal tombstone fields — the view stops at personal', () => {
        for (const caller of [lead, sibling, owner]) {
            expect(stripValue('Visit', memberVisit, VIEW, caller)).not.toHaveProperty('deletedAt');
        }
    });
});
