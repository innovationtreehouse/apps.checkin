/**
 * @jest-environment node
 */
/**
 * Boundary coverage for B28, a family telling the Board it won't renew.
 * The Board's application rows carry `notRenewing` at the internal tier and
 * mirror OrgMembershipProcess's tiers for every other field; POST and DELETE
 * /api/membership/not-renewing return the caller's own household's
 * OrgMembership under GET /api/household's view.
 */
import '@/security/registry';
import { getRoute, type Token } from '@/security/core';
import { stripValue } from '@/security/stripper';
import type { CallerContext } from '@/security/access-resolvers';
import { classifications } from '@/security/membershipApplicationSyntheticClassifications';
import { classifications as schema } from '@/security/generated/classifications';

function ctx(opts: Partial<CallerContext> = {}): CallerContext {
    return {
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
        ...opts,
    };
}

function spec(endpoint: string) {
    const route = getRoute(endpoint);
    if (!route) throw new Error(`no registry entry for ${endpoint}`);
    return route;
}

function tokensFor(endpoint: string, role: string): readonly Token[] {
    const entry = spec(endpoint).orderedView.find(([r]) => r === role);
    if (!entry) throw new Error(`${endpoint} has no view for ${role}`);
    return entry[1];
}

const APPLICATIONS = 'GET /api/membership-ops/applications';
const NOT_RENEWING = ['POST /api/membership/not-renewing', 'DELETE /api/membership/not-renewing'];

const applicationRow = {
    id: 3,
    kind: 'RENEWAL',
    status: 'PENDING_RENEWAL',
    createdAt: '2026-08-01T00:00:00.000Z',
    zohoEnvelopeId: 'env-1',
    contractSignedAt: null,
    bgConsentAt: null,
    bgClearedAt: null,
    paidAt: null,
    requestedForHouseholdId: null,
    notRenewing: true,
    isPaymentPlanRequested: true,
    shopifyInvoiceUrl: 'https://shop.example/invoice',
    attestations: [],
    subjectPerson: null,
    orgMembership: { householdId: 10, isVolunteerFamily: false },
};

describe('MembershipApplicationRow', () => {
    it('mirrors each OrgMembershipProcess field at its schema tier', () => {
        const { notRenewing, ...mirrored } = classifications.MembershipApplicationRow;
        for (const [field, tier] of Object.entries(mirrored)) {
            expect([field, tier]).toEqual([field, schema.OrgMembershipProcess[field as keyof typeof schema.OrgMembershipProcess]]);
        }
        expect(notRenewing).toBe('internal');
    });

    it.each(['isSysadmin', 'isBoardMember'])('reaches a %s with notRenewing and no field the row does not declare', (role) => {
        const out = stripValue('MembershipApplicationRow', applicationRow, tokensFor(APPLICATIONS, role), ctx()) as Record<string, unknown>;
        expect(out.notRenewing).toBe(true);
        expect(out.status).toBe('PENDING_RENEWAL');
        expect(out.orgMembership).toEqual({ householdId: 10, isVolunteerFamily: false });
        expect(out).not.toHaveProperty('isPaymentPlanRequested');
        expect(out).not.toHaveProperty('shopifyInvoiceUrl');
    });

    it('a public-only view keeps no notRenewing', () => {
        const out = stripValue('MembershipApplicationRow', applicationRow, ['public'], ctx()) as Record<string, unknown>;
        expect(out).not.toHaveProperty('notRenewing');
        expect(out.kind).toBe('RENEWAL');
    });

    it('is what the applications route declares it returns', () => {
        expect(spec(APPLICATIONS).returns).toContain('MembershipApplicationRow');
        expect(spec(APPLICATIONS).envelope).toBe('processes');
    });
});

describe.each(NOT_RENEWING)('%s', (endpoint) => {
    it("admits any session and shows the household's membership under GET /api/household's view", () => {
        const route = spec(endpoint);
        expect(route.authorize).toBe('authenticated');
        expect(route.envelope).toBeNull();
        expect(route.returns).toEqual(['OrgMembership']);
        expect(route.orderedView).toEqual(spec('GET /api/household').orderedView);
    });
});
