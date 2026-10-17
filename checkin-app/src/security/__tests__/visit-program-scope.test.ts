/**
 * @jest-environment node
 */
/**
 * Visit.their_program_participants via associatedEventId.
 *
 * The session attendance roster (GET /api/events/[id]) grants a lead mentor /
 * core volunteer 'their_program_participants:personal', which is the tier
 * Visit.arrivedAt and Visit.departedAt sit on. Visit had no binding for that
 * scope, so the grant resolved to nothing and every visit stripped to
 * { id, personId } for staff who are not sysadmin/board. These guards pin the
 * binding and its bounds:
 *   - a lead / core-vol holds it on a visit associated with one of their
 *     program's events; a plain member does not;
 *   - it is the EVENT that grants it, not the person: a participant's visit
 *     with no event, or one at another program's event, grants nothing;
 *   - the visit's own person still holds their_own.
 */
import { scopesHeld, type CallerContext } from '../access-resolvers';

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

// Event 200 belongs to a program the caller leads; event 201 to one they core-vol.
// Person 5 is enrolled in both callers' programs.
const lead = ctx({
    selfId: 10,
    programsLed: new Set([100]),
    participantIdsInScopePrograms: new Set([5]),
    eventIdsInScopePrograms: new Set([200]),
});
const coreVol = ctx({
    selfId: 11,
    programsCoreVolIn: new Set([101]),
    participantIdsInScopePrograms: new Set([5]),
    eventIdsInScopePrograms: new Set([201]),
});
const member = ctx({ selfId: 5 }); // no programs

describe('Visit their_program_participants via associatedEventId', () => {
    it('grants a lead the scope on a visit at their own program session', () => {
        const held = scopesHeld('Visit', { id: 1, personId: 5, associatedEventId: 200 }, lead);
        expect(held.has('their_program_participants')).toBe(true);
    });

    it('grants a core-vol the scope on a visit at an in-program session', () => {
        const held = scopesHeld('Visit', { id: 1, personId: 5, associatedEventId: 201 }, coreVol);
        expect(held.has('their_program_participants')).toBe(true);
    });

    it('does NOT grant it to a plain member', () => {
        const held = scopesHeld('Visit', { id: 1, personId: 99, associatedEventId: 200 }, member);
        expect(held.has('their_program_participants')).toBe(false);
    });

    it('does NOT grant it for another program’s event', () => {
        const held = scopesHeld('Visit', { id: 1, personId: 5, associatedEventId: 999 }, lead);
        expect(held.has('their_program_participants')).toBe(false);
    });

    it('does NOT grant it for a participant’s unassociated walk-in visit', () => {
        const held = scopesHeld('Visit', { id: 1, personId: 5, associatedEventId: null }, lead);
        expect(held.has('their_program_participants')).toBe(false);
    });

    it('fails closed when the route does not select associatedEventId', () => {
        const held = scopesHeld('Visit', { id: 1, personId: 5 }, lead);
        expect(held.has('their_program_participants')).toBe(false);
    });

    it('the visit’s own person still holds their_own', () => {
        const held = scopesHeld('Visit', { id: 1, personId: 5, associatedEventId: 999 }, member);
        expect(held.has('their_own')).toBe(true);
    });
});
