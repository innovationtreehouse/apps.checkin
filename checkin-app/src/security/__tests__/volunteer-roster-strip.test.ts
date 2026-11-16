/**
 * @jest-environment node
 */
/**
 * Boundary coverage for the Board's volunteer roster. A VolunteerRosterRow and
 * its designations reach sysadmin and board whole, and nothing the row does not
 * declare survives the stripper.
 */
import { stripBag } from '@/security/stripper';
import type { CallerContext } from '@/security/access-resolvers';
import { getRoute, type Token } from '@/security/core';
import { classifications, relations } from '@/security/volunteerRosterSyntheticClassifications';
import { SCOPE_BINDINGS } from '@/security/scopeBindings';
import '@/security/registry';

const ENDPOINT = 'GET /api/membership-ops/volunteer-memberships';

const ctx: CallerContext = {
    selfId: 1,
    householdId: 10,
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

const designation = { id: 7, email: 'ana@example.com', createdAt: '2026-07-01T00:00:00.000Z' };
const row = {
    key: 'hh:1',
    status: 'BLOCKED',
    householdId: 1,
    householdName: 'Alvarez',
    leads: ['Ana Alvarez'],
    email: 'ana@example.com',
    memberSince: null,
    designations: [designation],
};

function tokensFor(role: string): readonly Token[] {
    const entry = getRoute(ENDPOINT)?.orderedView.find(([r]) => r === role);
    if (!entry) throw new Error(`${ENDPOINT} has no view for ${role}`);
    return entry[1];
}

const strip = (value: object, role: string) =>
    (stripBag({ VolunteerRosterRow: [value] }, tokensFor(role), ctx).VolunteerRosterRow as unknown[])[0];

describe('volunteer roster synthetic view', () => {
    it('tiers each field as the column it is built from', () => {
        expect(classifications).toEqual({
            VolunteerRosterRow: {
                key: 'public',
                householdId: 'public',
                householdName: 'public',
                leads: 'public',
                memberSince: 'public',
                status: 'internal',
                email: 'pii',
            },
            VolunteerRosterDesignation: { id: 'public', email: 'pii', createdAt: 'public' },
        });
        expect(relations).toEqual({
            VolunteerRosterRow: { designations: { model: 'VolunteerRosterDesignation', isList: true } },
        });
    });

    it('binds their_households on householdId for coverage only', () => {
        expect(SCOPE_BINDINGS.VolunteerRosterRow).toEqual({
            their_households: { field: 'householdId', eqCtx: 'householdId' },
        });
        const grants = getRoute(ENDPOINT)?.orderedView.flatMap(([, tokens]) => tokens) ?? [];
        expect(grants.filter((t) => t.startsWith('their_households'))).toEqual([]);
    });

    it.each(['isSysadmin', 'isBoardMember'])('keeps exactly the declared fields for %s', (role) => {
        expect(strip(row, role)).toEqual(row);
    });

    it.each(['isSysadmin', 'isBoardMember'])('drops a key the row does not declare for %s', (role) => {
        const leaky = {
            ...row,
            dateOfBirth: '2010-01-01',
            allergies: 'peanuts',
            processStatus: 'BLOCKED',
            designations: [{ ...designation, createdById: 3 }],
        };
        expect(strip(leaky, role)).toEqual(row);
    });

    it('registers the roster for sysadmin and board as rows of VolunteerRosterRow', () => {
        const route = getRoute(ENDPOINT);
        const view: Token[] = ['everyones:pii', 'everyones:internal', 'member', 'public'];
        expect(route?.authorize).toEqual({ anyRole: ['isSysadmin', 'isBoardMember'] });
        expect(route?.envelope).toBe('rows');
        expect(route?.returns).toEqual(['VolunteerRosterRow']);
        expect(route?.orderedView).toEqual([
            ['isSysadmin', view],
            ['isBoardMember', view],
        ]);
    });
});
