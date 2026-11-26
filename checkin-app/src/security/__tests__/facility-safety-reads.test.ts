/**
 * @jest-environment node
 */
/**
 * Admission and view for the facility trends and the front-desk emergency
 * contact sheet (registry.ts). Each case sends a request through handler()
 * with the real authenticateRequest; only next-auth's getServerSession is
 * stubbed (jest.setup.js mocks it). A refused caller never reaches the impl.
 */
import type { NextRequest as NextRequestType } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { classifications, getRoute, type Models } from '@/security/core';
import { handler, type ModelBag } from '@/security/handler';
import { resolveAccess, type CallerContext } from '@/security/access-resolvers';

const { NextRequest } = jest.requireActual<{ NextRequest: typeof NextRequestType }>('next/server');
const mockSession = getServerSession as jest.MockedFunction<typeof getServerSession>;

const TRENDS = 'GET /api/facility/trends';
const CONTACTS = 'GET /api/safety/emergency-contacts';

type Flag = 'isFinance' | 'isBoardMember' | 'isInventoryManager' | 'isSysadmin' | 'isOperations' | 'isKeyholder' | 'isBackgroundCheckReviewer';
type Claims = Partial<Record<Flag, boolean>> & { householdId?: number; householdLead?: boolean };

function signIn(claims: Claims | null) {
    if (!claims) {
        mockSession.mockResolvedValue(null);
        return;
    }
    mockSession.mockResolvedValue({
        user: {
            id: 5,
            isSysadmin: false,
            isBoardMember: false,
            isKeyholder: false,
            isBackgroundCheckReviewer: false,
            isOperations: false,
            isInventoryManager: false,
            isFinance: false,
            ...claims,
        },
        expires: '2099-01-01',
    });
}

async function call(endpoint: string, claims: Claims | null, bag: ModelBag) {
    signIn(claims);
    const impl = jest.fn(async () => bag);
    const req = new NextRequest(`http://localhost${endpoint.slice('GET '.length)}`);
    const res = await handler(endpoint, impl)(req, { params: Promise.resolve({}) });
    return { res, impl };
}

const emptyContext = (): CallerContext => ({
    isKeyholder: false,
    isKiosk: true,
    programsLed: new Set(),
    programsCoreVolIn: new Set(),
    participantIdsInScopePrograms: new Set(),
    householdIdsInScopePrograms: new Set(),
    eventIdsInScopePrograms: new Set(),
    activeVisitorIds: new Set(),
    ledHouseholdMemberIds: new Set(),
});

async function admitsKiosk(endpoint: string): Promise<boolean> {
    const route = getRoute(endpoint);
    if (!route) throw new Error(`no registry entry for ${endpoint}`);
    return (await resolveAccess(route.authorize, { auth: { type: 'kiosk' }, params: {}, callerContext: emptyContext() })).allowed;
}

function tierOf(model: Models, field: string): unknown {
    return (classifications[model] as Record<string, unknown>)[field];
}

beforeEach(() => mockSession.mockReset());

describe('GET /api/facility/trends', () => {
    const bucket = {
        label: 'November 2026',
        periodStart: '2026-11-01T05:00:00.000Z',
        uniqueVolunteers: 4,
        uniqueParticipants: 9,
        totalVolunteerHours: 12.5,
        totalParticipantHours: 30,
        structuredHours: 28,
        unstructuredHours: 14.5,
        bySource: { KIOSK: 40, UNSPECIFIED: 2.5 },
    };
    const trends = { buckets: [bucket], totals: { ...bucket, label: 'Total', periodStart: '' }, period: 'month' };

    it.each([
        ['a sysadmin', { isSysadmin: true }],
        ['BOARD', { isBoardMember: true }],
        ['an operations volunteer', { isOperations: true }],
    ] as const)('lets %s read the trends in their current shape', async (_who, claims) => {
        const { res } = await call(TRENDS, claims, { FacilityTrends: trends });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual(trends);
    });

    it.each([
        ['a keyholder', { isKeyholder: true }],
        ['FINANCE', { isFinance: true }],
        ['an inventory manager', { isInventoryManager: true }],
        ['a household lead', { householdId: 7, householdLead: true }],
        ['a person with no role', {}],
    ] as const)('403s %s without running the impl', async (_who, claims) => {
        const { res, impl } = await call(TRENDS, claims, { FacilityTrends: trends });
        expect(res.status).toBe(403);
        expect(impl).not.toHaveBeenCalled();
    });

    it('401s a signed-out caller', async () => {
        const { res, impl } = await call(TRENDS, null, { FacilityTrends: trends });
        expect(res.status).toBe(401);
        expect(impl).not.toHaveBeenCalled();
    });

    it('refuses a kiosk', async () => {
        expect(await admitsKiosk(TRENDS)).toBe(false);
    });

    it('drops a person id a bucket does not declare', async () => {
        const { res } = await call(TRENDS, { isOperations: true }, {
            FacilityTrends: { ...trends, buckets: [{ ...bucket, personIds: [3, 4] }] },
        });
        expect((await res.json()).buckets).toEqual([bucket]);
    });
});

describe('GET /api/safety/emergency-contacts', () => {
    const household = {
        id: 7,
        name: 'Rivera',
        emergencyContactName: 'Ana Rivera',
        emergencyContactPhone: '555-0101',
        emergencyContacts: [
            { id: 1, name: 'Ana Rivera', phone: '555-0101', email: 'ana@x.test', relationship: 'Aunt', invalid: false },
        ],
        isPresent: true,
        householdMembers: [{ id: 21, name: 'Sam Rivera', isPresent: true }],
        leads: [{ id: 20, name: 'Lee Rivera', phone: '555-0199', email: 'lee@x.test' }],
    };
    const building = { reachable: true, lastSeenAt: '2026-11-25T09:00:00.000Z', queued: 0 };
    const sheet = { households: [household], building };

    it.each([
        ['a sysadmin', { isSysadmin: true }],
        ['BOARD', { isBoardMember: true }],
        ['a keyholder', { isKeyholder: true }],
    ] as const)('lets %s read the sheet in its current shape', async (_who, claims) => {
        const { res } = await call(CONTACTS, claims, { SafetyContactSheet: sheet });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual(sheet);
    });

    it.each([
        ['an operations volunteer', { isOperations: true }],
        ['FINANCE', { isFinance: true }],
        ['a background-check reviewer', { isBackgroundCheckReviewer: true }],
        ['a household lead', { householdId: 7, householdLead: true }],
        ['a person with no role', {}],
    ] as const)('403s %s without running the impl', async (_who, claims) => {
        const { res, impl } = await call(CONTACTS, claims, { SafetyContactSheet: sheet });
        expect(res.status).toBe(403);
        expect(impl).not.toHaveBeenCalled();
    });

    it('401s a signed-out caller', async () => {
        const { res, impl } = await call(CONTACTS, null, { SafetyContactSheet: sheet });
        expect(res.status).toBe(401);
        expect(impl).not.toHaveBeenCalled();
    });

    it('refuses a kiosk', async () => {
        expect(await admitsKiosk(CONTACTS)).toBe(false);
    });

    it('drops a date of birth, a conflict id and an address the sheet does not declare', async () => {
        const { res } = await call(CONTACTS, { isKeyholder: true }, {
            SafetyContactSheet: {
                building,
                households: [{
                    ...household,
                    line1: '1 Elm St',
                    emergencyContacts: [{ ...household.emergencyContacts[0], conflictParticipantId: 21 }],
                    householdMembers: [{ ...household.householdMembers[0], dateOfBirth: '2014-03-02' }],
                    leads: [{ ...household.leads[0], googleId: 'g-20' }],
                }],
            },
        });
        expect(await res.json()).toEqual(sheet);
    });

    it('keeps each mirrored field at its schema tier', () => {
        for (const field of ['id', 'name', 'phone', 'email', 'relationship']) {
            expect([field, tierOf('SafetyEmergencyContact', field)]).toEqual([field, tierOf('EmergencyContact', field)]);
        }
        for (const field of ['id', 'name']) {
            expect([field, tierOf('SafetyContactHousehold', field)]).toEqual([field, tierOf('Household', field)]);
            expect([field, tierOf('SafetyHouseholdMember', field)]).toEqual([field, tierOf('Person', field)]);
        }
        expect(tierOf('SafetyContactHousehold', 'emergencyContactName')).toBe(tierOf('EmergencyContact', 'name'));
        expect(tierOf('SafetyContactHousehold', 'emergencyContactPhone')).toBe(tierOf('EmergencyContact', 'phone'));
        expect(tierOf('SafetyHouseholdMember', 'isPresent')).toBe(tierOf('Visit', 'arrivedAt'));
    });
});
