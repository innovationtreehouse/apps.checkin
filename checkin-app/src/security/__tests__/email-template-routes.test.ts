/**
 * @jest-environment node
 */
/**
 * Email Templates tab: sysadmins and the Board are admitted to the list, save
 * and send-to-self routes; everyone else is refused. The list and save return
 * whole EmailTemplate rows; send-to-self returns no rows.
 */
import '@/security/registry';
import { getRoute } from '@/security/core';
import { stripValue } from '@/security/stripper';
import { resolveAccess, type CallerContext } from '@/security/access-resolvers';
import type { AuthenticatedUser } from '@/types/auth';

const ROW_ENDPOINTS = ['GET /api/settings/templates', 'PUT /api/settings/templates/[key]'];
const SEND_ENDPOINT = 'POST /api/settings/templates/[key]/test-send';

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
    return (await resolveAccess(spec(endpoint).authorize, {
        auth,
        params: { key: 'membership.welcome' },
        callerContext: ctx(),
    })).allowed;
}

describe.each([...ROW_ENDPOINTS, SEND_ENDPOINT])('%s', (endpoint) => {
    it.each([
        ['a sysadmin', { isSysadmin: true }],
        ['the Board', { isBoardMember: true }],
    ])('admits %s', async (_label, flags) => {
        expect(await admits(endpoint, flags)).toBe(true);
    });

    it.each([
        ['operations', { isOperations: true }],
        ['finance', { isFinance: true }],
        ['a keyholder', { isKeyholder: true }],
        ['a household lead', { householdId: 7, householdLead: true }],
        ['a plain member', {}],
    ])('refuses %s', async (_label, flags) => {
        expect(await admits(endpoint, flags)).toBe(false);
    });
});

describe.each(ROW_ENDPOINTS)('%s view', (endpoint) => {
    it('grants internal and public fields to sysadmins and the Board', () => {
        expect(spec(endpoint).orderedView).toEqual([
            ['isSysadmin', ['everyones:internal', 'public']],
            ['isBoardMember', ['everyones:internal', 'public']],
        ]);
        expect(spec(endpoint).returns).toEqual(['EmailTemplate']);
    });

    it('keeps the whole row', () => {
        const row = {
            key: 'membership.welcome',
            subject: 'Welcome',
            body: 'Hi {{name}}',
            updatedBy: 12,
            updatedAt: '2026-11-14T12:00:00.000Z',
        };
        expect(stripValue('EmailTemplate', row, spec(endpoint).orderedView[0][1], ctx())).toEqual(row);
    });
});

it('wraps the list and the saved row in their envelopes', () => {
    expect(spec('GET /api/settings/templates').envelope).toBe('templates');
    expect(spec('PUT /api/settings/templates/[key]').envelope).toBe('template');
});

it('makes send-to-self an admission gate with no rows', () => {
    expect(spec(SEND_ENDPOINT).envelope).toBeNull();
    expect(spec(SEND_ENDPOINT).orderedView).toEqual([]);
});
