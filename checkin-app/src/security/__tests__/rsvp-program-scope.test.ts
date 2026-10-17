/**
 * @jest-environment node
 */
/**
 * RSVP.their_program_participants via eventId (deliberate behavior change).
 *
 * RSVP has no programId column (PK [eventId, participantId]); the old switch read
 * row.programId, which was always undefined on a real RSVP — the program-lead
 * grant was DEAD. The resolver now reaches a program via eventId →
 * ctx.eventIdsInScopePrograms. These guards pin the new capability:
 *   - a lead / core-vol holds their_program_participants on an RSVP whose event
 *     is in their program; a non-lead does not;
 *   - the RSVP owner still holds their_own (participantId === selfId);
 *   - the stale programId read no longer grants anything.
 * See docs/security/auth-consistency-analysis.md §7.5 + §9 Step 3 Blocker 1.
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
const lead = ctx({ selfId: 10, programsLed: new Set([100]), eventIdsInScopePrograms: new Set([200]) });
const coreVol = ctx({ selfId: 11, programsCoreVolIn: new Set([101]), eventIdsInScopePrograms: new Set([201]) });
const member = ctx({ selfId: 5 }); // no programs

describe('RSVP their_program_participants via eventId', () => {
    it('grants their_program_participants to a lead for an RSVP whose event is in their program', () => {
        const held = scopesHeld('RSVP', { eventId: 200, personId:5 }, lead);
        expect(held.has('their_program_participants')).toBe(true);
    });

    it('grants their_program_participants to a core-vol for an in-program event', () => {
        const held = scopesHeld('RSVP', { eventId: 201, personId:5 }, coreVol);
        expect(held.has('their_program_participants')).toBe(true);
    });

    it('does NOT grant their_program_participants to a plain member', () => {
        const held = scopesHeld('RSVP', { eventId: 200, personId:99 }, member);
        expect(held.has('their_program_participants')).toBe(false);
    });

    it('does NOT grant a lead access to an RSVP whose event is in a DIFFERENT program', () => {
        const held = scopesHeld('RSVP', { eventId: 999, personId:5 }, lead);
        expect(held.has('their_program_participants')).toBe(false);
    });

    it('the RSVP owner still holds their_own (participantId === selfId)', () => {
        const held = scopesHeld('RSVP', { eventId: 999, personId:5 }, member);
        expect(held.has('their_own')).toBe(true);
    });

    it('a non-owner does NOT hold their_own', () => {
        const held = scopesHeld('RSVP', { eventId: 999, personId:5 }, ctx({ selfId: 6 }));
        expect(held.has('their_own')).toBe(false);
    });

    it('the stale programId read no longer grants — a row carrying only programId is inert', () => {
        // Old dead binding: a lead of program 100 with a row {programId: 100} used
        // to (try to) match. With the eventId binding it grants nothing.
        const held = scopesHeld('RSVP', { programId: 100, personId:99 }, lead);
        expect(held.has('their_program_participants')).toBe(false);
    });
});
