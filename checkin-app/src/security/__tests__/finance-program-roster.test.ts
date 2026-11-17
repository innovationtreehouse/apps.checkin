/**
 * @jest-environment node
 */
/**
 * Finance reaches a program's roster to enroll places paid outside the store: it
 * reads what the roster shows on GET /api/programs/[id], nothing internal, and may
 * search the people to enroll. The search stays closed to anyone else outside the program's staff.
 */
import '@/security/registry';
import { getRoute } from '@/security/core';
import { resolveAccess, type CallerContext } from '@/security/access-resolvers';
import type { AuthenticatedUser } from '@/types/auth';

const PROGRAM = 'GET /api/programs/[id]';
const SEARCH = 'GET /api/programs/[id]/eligible-participants';

function ctx(programsLed: number[] = []): CallerContext {
    return {
        selfId: 5,
        householdId: undefined,
        isKeyholder: false,
        isKiosk: false,
        programsLed: new Set(programsLed),
        programsCoreVolIn: new Set(),
        participantIdsInScopePrograms: new Set(),
        householdIdsInScopePrograms: new Set(),
        eventIdsInScopePrograms: new Set(),
        activeVisitorIds: new Set(),
        ledHouseholdMemberIds: new Set(),
    };
}

const noFlags: AuthenticatedUser = {
    id: 5,
    email: 'caller@x.test',
    isSysadmin: false,
    isBoardMember: false,
    isKeyholder: false,
    isBackgroundCheckReviewer: false,
    isOperations: false,
    isInventoryManager: false,
    isFinance: false,
};

function view(endpoint: string, role: string) {
    return getRoute(endpoint)?.orderedView.find(([r]) => r === role)?.[1];
}

async function searchAdmits(flags: Partial<AuthenticatedUser>, programsLed: number[] = []): Promise<boolean> {
    const auth = { type: 'session' as const, user: { ...noFlags, ...flags } };
    return (await resolveAccess(getRoute(SEARCH)!.authorize, { auth, params: { id: '3' }, callerContext: ctx(programsLed) })).allowed;
}

describe('Finance on a program roster', () => {
    it('reads the roster, not the internal tier the Board also reads', () => {
        expect(view(PROGRAM, 'isFinance')).toEqual(['everyones:pii', 'everyones:personal', 'member', 'public']);
        expect(view(PROGRAM, 'isBoardMember')).toContain('everyones:internal');
    });

    it('may search the people to enroll, by name only', async () => {
        expect(await searchAdmits({ isFinance: true })).toBe(true);
        expect(view(SEARCH, 'isFinance')).toEqual(['public']);
    });

    it.each([
        ['the program lead', {}, [3], true],
        ['a sysadmin', { isSysadmin: true }, [], true],
        ['a board member', { isBoardMember: true }, [], true],
        ['a lead of another program', {}, [4], false],
        ['a plain member', {}, [], false],
        ['an operations volunteer', { isOperations: true }, [], false],
    ] as const)('search admission for %s', async (_who, flags, led, allowed) => {
        expect(await searchAdmits(flags, [...led])).toBe(allowed);
    });

    it('refuses the search without a program id', async () => {
        const auth = { type: 'session' as const, user: { ...noFlags, isFinance: true } };
        expect((await resolveAccess(getRoute(SEARCH)!.authorize, { auth, params: {}, callerContext: ctx() })).allowed).toBe(false);
    });
});
