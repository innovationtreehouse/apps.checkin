/**
 * @jest-environment node
 */
/**
 * ToolStatus.userId was renamed userId->participantId->personId (Person =
 * Person). The `their_own` stripper branch was SPLIT so ToolStatus reads
 * `personId` while Account/Session (NextAuth-mandated) keep reading `userId`.
 * Guards that split: a member must still self-scope their own ToolStatus rows,
 * and the Account/Session read must NOT regress.
 */
import { scopesHeld, type CallerContext } from '../access-resolvers';

const ctx: CallerContext = {
    selfId: 7,
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

describe('ToolStatus self-scoping after participantId -> personId rename', () => {
    it("grants their_own on a ToolStatus row whose personId is the caller", () => {
        expect(scopesHeld('ToolStatus', { personId: 7, toolId: 1 }, ctx).has('their_own')).toBe(true);
    });

    it('does NOT grant their_own on someone else\'s ToolStatus row', () => {
        expect(scopesHeld('ToolStatus', { personId: 99, toolId: 1 }, ctx).has('their_own')).toBe(false);
    });

    it('reads personId, not the stale participantId, for ToolStatus', () => {
        // A row carrying only the OLD key must no longer self-scope.
        expect(scopesHeld('ToolStatus', { participantId: 7, toolId: 1 }, ctx).has('their_own')).toBe(false);
    });

    it('Account/Session still self-scope on userId (NextAuth, unchanged)', () => {
        expect(scopesHeld('Account', { userId: 7 }, ctx).has('their_own')).toBe(true);
        expect(scopesHeld('Session', { userId: 7 }, ctx).has('their_own')).toBe(true);
        expect(scopesHeld('Account', { userId: 99 }, ctx).has('their_own')).toBe(false);
    });
});
