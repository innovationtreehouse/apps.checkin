/**
 * @jest-environment node
 */
/**
 * The `their_own` stripper branch reads `personId` for ToolStatus and `userId`
 * for Account/Session (NextAuth-mandated). Guards that split: a member self-scopes
 * their own ToolStatus rows, and Account/Session self-scope on `userId`.
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
        // A row carrying only participantId does not self-scope.
        expect(scopesHeld('ToolStatus', { participantId: 7, toolId: 1 }, ctx).has('their_own')).toBe(false);
    });

    it('Account/Session still self-scope on userId (NextAuth, unchanged)', () => {
        expect(scopesHeld('Account', { userId: 7 }, ctx).has('their_own')).toBe(true);
        expect(scopesHeld('Session', { userId: 7 }, ctx).has('their_own')).toBe(true);
        expect(scopesHeld('Account', { userId: 99 }, ctx).has('their_own')).toBe(false);
    });
});
