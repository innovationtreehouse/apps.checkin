/**
 * @jest-environment node
 */
/**
 * The Roles screen's registry entries: GET and PATCH /api/roles admit sysadmin
 * and board alone, and a RoleHolder row keeps exactly its declared fields.
 */
import '@/security/registry';
import { getRoute, type Token } from '@/security/core';
import { stripBag } from '@/security/stripper';
import { resolveAccess, type CallerContext } from '@/security/access-resolvers';
import { classifications as checkinClassifications } from '@/security/generated/classifications';
import { classifications } from '@/security/roleHolderSyntheticClassifications';
import type { AuthenticatedUser } from '@/types/auth';

const GET = 'GET /api/roles';
const PATCH = 'PATCH /api/roles';

const callerContext: CallerContext = {
    selfId: 5,
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
    return (await resolveAccess(spec(endpoint).authorize, { auth, params: {}, callerContext })).allowed;
}

function tokensFor(endpoint: string, role: string): readonly Token[] {
    const entry = spec(endpoint).orderedView.find(([r]) => r === role);
    if (!entry) throw new Error(`${endpoint} has no view for ${role}`);
    return entry[1];
}

const strip = (endpoint: string, value: object, role: string) =>
    (stripBag({ RoleHolder: [value] }, tokensFor(endpoint, role), callerContext).RoleHolder as unknown[])[0];

const flags = {
    isSysadmin: false,
    isBoardMember: true,
    isKeyholder: true,
    isBackgroundCheckReviewer: false,
    isOperations: false,
    isInventoryManager: false,
    isFinance: true,
    isKeyVolunteer: true,
};
const updated = { id: 9, email: 'ana@example.com', name: 'Ana', canAccessStaging: false, ...flags };
const listed = { ...updated, isYouth: false, kvaSignedCurrent: true, kvaSignedAt: '2026-07-01T00:00:00.000Z', kvaOpenProcessId: null };

describe.each([GET, PATCH])('%s admission', (endpoint) => {
    it.each([
        ['a sysadmin', { isSysadmin: true }],
        ['a board member', { isBoardMember: true }],
    ])('admits %s', async (_label, callerFlags) => {
        expect(await admits(endpoint, callerFlags)).toBe(true);
    });

    it.each([
        ['finance', { isFinance: true }],
        ['operations', { isOperations: true }],
        ['a keyholder', { isKeyholder: true }],
        ['a background-check reviewer', { isBackgroundCheckReviewer: true }],
        ['an inventory manager', { isInventoryManager: true }],
        ['a household lead', { householdId: 7, householdLead: true }],
        ['a plain member', {}],
    ])('refuses %s', async (_label, callerFlags) => {
        expect(await admits(endpoint, callerFlags)).toBe(false);
    });

    it('refuses an unauthenticated caller and a kiosk', async () => {
        for (const auth of [{ type: 'unauthenticated' as const }, { type: 'kiosk' as const }]) {
            expect((await resolveAccess(spec(endpoint).authorize, { auth, params: {}, callerContext })).allowed).toBe(false);
        }
    });

    it('returns RoleHolder rows and views them for sysadmin then board', () => {
        expect(spec(endpoint).returns).toEqual(['RoleHolder']);
        expect(spec(endpoint).orderedView.map(([role]) => role)).toEqual(['isSysadmin', 'isBoardMember']);
    });
});

describe('RoleHolder tiers', () => {
    it('mirrors Person for every field taken from a Person column', () => {
        const person: Record<string, string> = checkinClassifications.Person;
        const holder: Record<string, string> = classifications.RoleHolder;
        for (const field of ['id', 'email', 'name', 'canAccessStaging', 'isSysadmin', 'isBoardMember', 'isKeyholder', 'isBackgroundCheckReviewer']) {
            expect([field, holder[field]]).toEqual([field, person[field]]);
        }
    });

    it('tiers the derived fields', () => {
        const { isOperations, isInventoryManager, isFinance, isKeyVolunteer, isYouth, kvaSignedCurrent, kvaSignedAt, kvaOpenProcessId } = classifications.RoleHolder;
        expect({ isOperations, isInventoryManager, isFinance, isKeyVolunteer, isYouth, kvaSignedCurrent, kvaSignedAt, kvaOpenProcessId }).toEqual({
            isOperations: 'internal',
            isInventoryManager: 'internal',
            isFinance: 'internal',
            isKeyVolunteer: 'internal',
            isYouth: 'personal',
            kvaSignedCurrent: 'internal',
            kvaSignedAt: 'internal',
            kvaOpenProcessId: 'internal',
        });
    });
});

describe('RoleHolder strip', () => {
    it.each(['isSysadmin', 'isBoardMember'])('GET keeps the whole listed row for %s', (role) => {
        expect(strip(GET, listed, role)).toEqual(listed);
    });

    it.each(['isSysadmin', 'isBoardMember'])('PATCH keeps the whole updated row for %s', (role) => {
        expect(strip(PATCH, updated, role)).toEqual(updated);
    });

    it.each([GET, PATCH])('%s drops a key the row does not declare', (endpoint) => {
        const leaky = { ...listed, dateOfBirth: '2010-01-01', phone: '555-0100', googleId: 'g-1' };
        expect(strip(endpoint, leaky, 'isBoardMember')).not.toHaveProperty('dateOfBirth');
        expect(strip(endpoint, leaky, 'isBoardMember')).not.toHaveProperty('phone');
        expect(strip(endpoint, leaky, 'isBoardMember')).not.toHaveProperty('googleId');
    });

    it('PATCH grants no personal tier, so isYouth does not leave', () => {
        expect(strip(PATCH, listed, 'isSysadmin')).not.toHaveProperty('isYouth');
    });
});
