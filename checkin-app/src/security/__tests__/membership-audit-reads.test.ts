/**
 * @jest-environment node
 */
/**
 * Admission and view for the membership audit lists and the caller's own
 * membership fee and renewal reads (registry.ts). Each case sends a request
 * through handler() with the real authenticateRequest; only next-auth's
 * getServerSession is stubbed (jest.setup.js mocks it). A refused caller never
 * reaches the impl.
 */
import type { NextRequest as NextRequestType } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { classifications, getRoute, type Models } from '@/security/core';
import { handler, type ModelBag } from '@/security/handler';
import { resolveAccess, type CallerContext } from '@/security/access-resolvers';

const { NextRequest } = jest.requireActual<{ NextRequest: typeof NextRequestType }>('next/server');
const mockSession = getServerSession as jest.MockedFunction<typeof getServerSession>;

const MISSING_CONTACT = 'GET /api/membership-audit/households-missing-contact';
const UNCLAIMED = 'GET /api/membership-audit/unclaimed-households';
const PAYMENT = 'GET /api/membership/payment';
const RENEWAL = 'GET /api/membership/renewal-status';

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

const kioskContext = (): CallerContext => ({
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
    return (await resolveAccess(route.authorize, { auth: { type: 'kiosk' }, params: {}, callerContext: kioskContext() })).allowed;
}

function tierOf(model: Models, field: string): unknown {
    return (classifications[model] as Record<string, unknown>)[field];
}

beforeEach(() => mockSession.mockReset());

const lead = { id: 20, name: 'Lee Rivera', phone: '555-0199', email: 'lee@x.test' };

describe.each([
    [MISSING_CONTACT, { MissingContactHousehold: [{ id: 7, name: 'Rivera', leads: [lead] }] }],
    [UNCLAIMED, { UnclaimedHousehold: [{ id: 7, name: 'Rivera', members: [{ id: 20, name: 'Lee Rivera', email: 'lee@x.test' }] }] }],
] as const)('%s', (endpoint, bag) => {
    const rows = Object.values(bag)[0];

    it.each([
        ['a sysadmin', { isSysadmin: true }],
        ['BOARD', { isBoardMember: true }],
    ] as const)('lets %s read the list in its current shape', async (_who, claims) => {
        const { res } = await call(endpoint, claims, bag);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ households: rows });
    });

    it.each([
        ['a keyholder', { isKeyholder: true }],
        ['an operations volunteer', { isOperations: true }],
        ['FINANCE', { isFinance: true }],
        ['a background-check reviewer', { isBackgroundCheckReviewer: true }],
        ['a household lead', { householdId: 7, householdLead: true }],
        ['a person with no role', {}],
    ] as const)('403s %s without running the impl', async (_who, claims) => {
        const { res, impl } = await call(endpoint, claims, bag);
        expect(res.status).toBe(403);
        expect(impl).not.toHaveBeenCalled();
    });

    it('401s a signed-out caller', async () => {
        const { res, impl } = await call(endpoint, null, bag);
        expect(res.status).toBe(401);
        expect(impl).not.toHaveBeenCalled();
    });

    it('refuses a kiosk', async () => {
        expect(await admitsKiosk(endpoint)).toBe(false);
    });
});

describe('household contact rows', () => {
    it('drop a date of birth and a background-check date they do not declare', async () => {
        const { res } = await call(MISSING_CONTACT, { isBoardMember: true }, {
            MissingContactHousehold: [{ id: 7, name: 'Rivera', line1: '1 Elm St', leads: [{ ...lead, dateOfBirth: '1980-01-01', lastBackgroundCheck: '2025-01-01' }] }],
        });
        expect(await res.json()).toEqual({ households: [{ id: 7, name: 'Rivera', leads: [lead] }] });
    });

    it('keep each field at its Person tier', () => {
        for (const field of ['id', 'name', 'phone', 'email']) {
            expect([field, tierOf('HouseholdContactPerson', field)]).toEqual([field, tierOf('Person', field)]);
        }
        for (const model of ['MissingContactHousehold', 'UnclaimedHousehold'] as const) {
            for (const field of ['id', 'name']) {
                expect([model, field, tierOf(model, field)]).toEqual([model, field, tierOf('Household', field)]);
            }
        }
    });
});

describe(PAYMENT, () => {
    const link = { amountCents: 12000, checkoutUrl: 'https://store.test/cart/1:1?discount=VOL', financeContactEmail: 'finance@x.test' };

    it.each([
        ['a household lead', { householdId: 7, householdLead: true }],
        ['a sysadmin', { householdId: 7, isSysadmin: true }],
        ['BOARD', { isBoardMember: true }],
    ] as const)('lets %s read the fee and checkout link', async (_who, claims) => {
        const { res } = await call(PAYMENT, claims, { MembershipPaymentLink: link });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual(link);
    });

    it.each([
        ['a household member who is not a lead', { householdId: 7, householdLead: false }],
        ['a keyholder', { householdId: 7, isKeyholder: true }],
        ['FINANCE', { householdId: 7, isFinance: true }],
        ['an operations volunteer', { householdId: 7, isOperations: true }],
        ['a person with no household', {}],
    ] as const)('403s %s without running the impl', async (_who, claims) => {
        const { res, impl } = await call(PAYMENT, claims, { MembershipPaymentLink: link });
        expect(res.status).toBe(403);
        expect(impl).not.toHaveBeenCalled();
    });

    it('401s a signed-out caller', async () => {
        const { res, impl } = await call(PAYMENT, null, { MembershipPaymentLink: link });
        expect(res.status).toBe(401);
        expect(impl).not.toHaveBeenCalled();
    });

    it('refuses a kiosk', async () => {
        expect(await admitsKiosk(PAYMENT)).toBe(false);
    });

    it('keeps the checkout link at the discount code tier and the amounts at the fee tier', () => {
        expect(tierOf('MembershipPaymentLink', 'checkoutUrl')).toBe(tierOf('BoardSettings', 'volunteerFamilyDiscountCode'));
        expect(tierOf('MembershipPaymentLink', 'amountCents')).toBe(tierOf('BoardSettings', 'standardMembershipFeeCents'));
        expect(tierOf('MembershipPaymentLink', 'financeContactEmail')).toBe(tierOf('BoardSettings', 'financeContactEmail'));
    });
});

describe(RENEWAL, () => {
    const due = { renewalDue: true, dueDate: '2027-01-01', notRenewing: false };

    it('lets a household lead read the banner state', async () => {
        const { res } = await call(RENEWAL, { householdId: 7, householdLead: true }, { RenewalStatus: due });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual(due);
    });

    it.each([
        ['a household member who is not a lead', { householdId: 7, householdLead: false }],
        ['a person with no household', {}],
    ] as const)('keeps the renewal flags from %s', async (_who, claims) => {
        const { res } = await call(RENEWAL, claims, { RenewalStatus: due });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ dueDate: due.dueDate });
    });

    it('401s a signed-out caller', async () => {
        const { res, impl } = await call(RENEWAL, null, { RenewalStatus: due });
        expect(res.status).toBe(401);
        expect(impl).not.toHaveBeenCalled();
    });

    it('refuses a kiosk', async () => {
        expect(await admitsKiosk(RENEWAL)).toBe(false);
    });

    it('drops the household id and year a row does not declare', async () => {
        const { res } = await call(RENEWAL, { householdId: 7, householdLead: true }, {
            RenewalStatus: { ...due, householdId: 7, notRenewingYear: 2027 },
        });
        expect(await res.json()).toEqual(due);
    });

    it('keeps the renewal flags at their source tiers', () => {
        expect(tierOf('RenewalStatus', 'renewalDue')).toBe(tierOf('OrgMembershipProcess', 'status'));
        expect(tierOf('RenewalStatus', 'notRenewing')).toBe(tierOf('OrgMembership', 'notRenewingYear'));
    });
});
