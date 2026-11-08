/**
 * @jest-environment node
 */
/**
 * Household archive and unarchive: the Board only is admitted, and the
 * returned household keeps id, name and archivedAt while dropping the
 * address and the intake note.
 */
import '@/security/registry';
import { getRoute } from '@/security/core';
import { stripValue } from '@/security/stripper';
import { resolveAccess, type CallerContext } from '@/security/access-resolvers';
import type { AuthenticatedUser } from '@/types/auth';

const ENDPOINTS = [
    'POST /api/membership-ops/households/[id]/archive',
    'POST /api/membership-ops/households/[id]/unarchive',
];

function ctx(): CallerContext {
    return {
        selfId: 1,
        householdId: 7,
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

function spec(endpoint: string) {
    const route = getRoute(endpoint);
    if (!route) throw new Error(`no registry entry for ${endpoint}`);
    return route;
}

async function admits(endpoint: string, flags: Partial<AuthenticatedUser>): Promise<boolean> {
    const auth = { type: 'session' as const, user: { ...noFlags, ...flags } };
    return (await resolveAccess(spec(endpoint).authorize, { auth, params: { id: '7' }, callerContext: ctx() })).allowed;
}

describe.each(ENDPOINTS)('%s', (endpoint) => {
    it('admits the Board', async () => {
        expect(await admits(endpoint, { isBoardMember: true })).toBe(true);
    });

    it.each([
        ['a sysadmin not on the Board', { isSysadmin: true }],
        ['a household lead', { householdId: 7, householdLead: true }],
        ['operations', { isOperations: true }],
        ['a plain member', {}],
    ])('refuses %s', async (_label, flags) => {
        expect(await admits(endpoint, flags)).toBe(false);
    });

    it('declares a public-only view for the Board alone', () => {
        expect(spec(endpoint).orderedView).toEqual([['isBoardMember', ['public']]]);
    });

    it('returns the household under the household key', () => {
        expect(spec(endpoint).envelope).toBe('household');
        expect(spec(endpoint).returns).toEqual(['Household']);
    });
});

describe('archived household strip', () => {
    const row = {
        id: 7,
        name: 'Rivera',
        line1: '1 Elm St',
        line2: null,
        city: 'Springfield',
        state: 'IL',
        postalCode: '62701',
        intakeNotes: 'moving away',
        archivedAt: '2026-11-08T12:00:00.000Z',
    };

    it('keeps id, name and archivedAt and drops the address and intake note', () => {
        const tokens = spec(ENDPOINTS[0]).orderedView[0][1];
        expect(stripValue('Household', row, tokens, ctx())).toEqual({
            id: 7,
            name: 'Rivera',
            archivedAt: '2026-11-08T12:00:00.000Z',
        });
    });
});
