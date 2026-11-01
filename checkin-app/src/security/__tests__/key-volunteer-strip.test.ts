/**
 * @jest-environment node
 */
/**
 * Boundary coverage for the Key Volunteer Agreement synthetic views. The
 * caller's own status and sign URL reach them through their_own; anyone else's
 * row keeps only its public personId. The Board's version bump is internal.
 */
import { stripValue } from '@/security/stripper';
import type { CallerContext } from '@/security/access-resolvers';
import { getRoute, type Token } from '@/security/core';
import { classifications } from '@/security/keyVolunteerSyntheticClassifications';
import { SCOPE_BINDINGS } from '@/security/scopeBindings';
import '@/security/registry';

const ctx: CallerContext = {
    selfId: 1,
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
};

const SELF_VIEW: readonly Token[] = ['their_own:internal', 'public'];
const BOARD_VIEW: readonly Token[] = ['everyones:internal', 'public'];

const strip = (model: string, row: object, tokens: readonly Token[]) =>
    stripValue(model, row, tokens, ctx) as Record<string, unknown>;

const SELF_ENDPOINTS = [
    'GET /api/membership/key-volunteer',
    'POST /api/membership/key-volunteer/sign',
    'POST /api/membership/key-volunteer/sync',
];

describe('key volunteer synthetic views', () => {
    it('tiers every field internal except the public personId binding key', () => {
        for (const [model, fields] of Object.entries(classifications)) {
            for (const [field, tier] of Object.entries(fields)) {
                expect(`${model}.${field}:${tier}`).toBe(
                    `${model}.${field}:${field === 'personId' ? 'public' : 'internal'}`,
                );
            }
        }
    });

    it('binds their_own on personId for the two self models', () => {
        for (const model of ['KeyVolunteerSelfStatus', 'KeyVolunteerSigning'] as const) {
            expect(SCOPE_BINDINGS[model]).toEqual({ their_own: { field: 'personId', eqCtx: 'selfId' } });
        }
    });

    it("the caller's own status and sign URL reach them whole", () => {
        const status = { personId: 1, owesSignature: true, agreementVersion: 2, requestStarted: false, documentConfigured: true };
        expect(strip('KeyVolunteerSelfStatus', status, SELF_VIEW)).toEqual(status);
        const signing = { personId: 1, signUrl: 'https://sign.example/abc' };
        expect(strip('KeyVolunteerSigning', signing, SELF_VIEW)).toEqual(signing);
    });

    it("another person's status or sign URL keeps only its personId", () => {
        const status = { personId: 2, owesSignature: true, agreementVersion: 2, requestStarted: true, documentConfigured: true };
        expect(strip('KeyVolunteerSelfStatus', status, SELF_VIEW)).toEqual({ personId: 2 });
        expect(strip('KeyVolunteerSigning', { personId: 2, signUrl: 'https://sign.example/abc' }, SELF_VIEW)).toEqual({ personId: 2 });
    });

    it('a row without personId fails closed to nothing', () => {
        expect(strip('KeyVolunteerSigning', { signUrl: 'https://sign.example/abc' }, SELF_VIEW)).toEqual({});
    });

    it('the version bump reaches the Board whole, and nobody on a public view', () => {
        const bump = { agreementVersion: 3, agreementsOpened: 12 };
        expect(strip('KeyVolunteerVersionBump', bump, BOARD_VIEW)).toEqual(bump);
        expect(strip('KeyVolunteerVersionBump', bump, ['public'])).toEqual({});
    });

    it('registers the self routes for any signed-in caller with their_own grants only', () => {
        for (const endpoint of SELF_ENDPOINTS) {
            const route = getRoute(endpoint);
            expect(route?.authorize).toBe('authenticated');
            expect(route?.orderedView).toEqual([['authenticated', SELF_VIEW]]);
        }
        expect(getRoute('GET /api/membership/key-volunteer')?.returns).toEqual(['KeyVolunteerSelfStatus']);
        expect(getRoute('POST /api/membership/key-volunteer/sign')?.returns).toEqual(['KeyVolunteerSigning']);
        expect(getRoute('POST /api/membership/key-volunteer/sync')?.returns).toEqual(['KeyVolunteerSelfStatus']);
    });

    it('registers the version bump for the Board alone', () => {
        const route = getRoute('POST /api/settings/membership/key-volunteer-version');
        expect(route?.authorize).toEqual({ anyRole: ['isBoardMember'] });
        expect(route?.returns).toEqual(['KeyVolunteerVersionBump']);
        expect(route?.orderedView).toEqual([['isBoardMember', BOARD_VIEW]]);
    });
});
