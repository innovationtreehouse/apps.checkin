/**
 * @jest-environment node
 */
/**
 * GET and PATCH /api/household: a signed-in caller sees their own household's
 * address, members and contact details in today's response shape. Every
 * sensitive field is gated to the caller's household, a row without its scope
 * key keeps nothing sensitive, and no Person field outside the peer projection
 * can leave.
 */
import { stripBag } from '@/security/stripper';
import type { CallerContext } from '@/security/access-resolvers';
import { classifications, getRoute, type Token } from '@/security/core';
import { classifications as generated } from '@/security/generated/classifications';
import { classifications as household } from '@/security/householdSyntheticClassifications';
import '@/security/registry';

const HH = 10;
const SELF = 1;

function ctx(opts: Partial<CallerContext> = {}): CallerContext {
    return {
        selfId: SELF,
        householdId: HH,
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

const VIEW: readonly Token[] = ['their_households:pii', 'their_households:personal', 'their_households:internal', 'member', 'public'];

function view(endpoint: string): readonly Token[] {
    const entry = getRoute(endpoint)?.orderedView.find(([r]) => r === 'authenticated');
    if (!entry) throw new Error(`no authenticated view on ${endpoint}`);
    return entry[1];
}

/** The handler's unwrap: one bag key, envelope null, so the payload is that key's value. */
function payload(endpoint: string, bag: Record<string, unknown>, caller: CallerContext): unknown {
    const stripped = stripBag(bag, view(endpoint), caller);
    const keys = Object.keys(stripped);
    expect(keys).toHaveLength(1);
    return stripped[keys[0]];
}

function peer(id: number, householdId: number | null = HH) {
    return {
        id,
        ...(householdId === null ? {} : { householdId }),
        name: `Person ${id}`,
        nickname: null,
        email: `p${id}@example.com`,
        phone: '555-0100',
        dateOfBirth: '2012-04-01',
        isDeclaredAdult: false,
        allergies: 'peanuts',
        isHouseholdLead: id === SELF,
        emailLocked: id === SELF,
    };
}

const HOUSEHOLD_ROW = { id: HH, name: 'The Example Household', line1: '1 Main St', line2: null, city: 'Town', state: 'WA', postalCode: '98000' };
const ORG_MEMBERSHIP = { status: 'ACTIVE', memberSince: '2025-01-01', isVolunteerFamily: false };

function page(members: unknown[], hh: Record<string, unknown> = HOUSEHOLD_ROW) {
    return {
        household: { ...hh, householdMembers: members, orgMembership: ORG_MEMBERSHIP },
        boardReplyTo: 'board@example.org',
        validUntil: '2026-12-31',
    };
}

const GET = 'GET /api/household';
const PATCH = 'PATCH /api/household';

describe('/api/household registry entries', () => {
    it('admits any session on both verbs with one household-scoped view', () => {
        for (const endpoint of [GET, PATCH]) {
            const route = getRoute(endpoint);
            expect(route?.authorize).toBe('authenticated');
            expect(route?.envelope).toBeNull();
            expect(route?.orderedView).toEqual([['authenticated', VIEW]]);
        }
        expect(getRoute(GET)?.returns).toEqual(['HouseholdPage', 'HouseholdPageHousehold', 'HouseholdPeer', 'OrgMembership']);
        expect(getRoute(PATCH)?.returns).toEqual(['HouseholdMemberAdded', 'HouseholdPeer', 'EmergencyContactWarning']);
    });

    it('mirrors each schema field at its schema tier', () => {
        const peerTiers: Record<string, string> = household.HouseholdPeer;
        const personTiers: Record<string, string> = generated.Person;
        for (const field of Object.keys(peerTiers)) {
            if (field === 'emailLocked') continue;
            expect([field, peerTiers[field]]).toEqual([field, personTiers[field]]);
        }
        const householdTiers: Record<string, string> = household.HouseholdPageHousehold;
        const schemaHousehold: Record<string, string> = generated.Household;
        for (const field of Object.keys(householdTiers)) {
            expect([field, householdTiers[field]]).toEqual([field, schemaHousehold[field]]);
        }
        expect(household.HouseholdPeer.emailLocked).toBe('internal');
        expect(classifications.HouseholdPage.boardReplyTo).toBe('member');
    });
});

describe('GET /api/household', () => {
    it("ships the caller's household in today's shape, peers carrying householdId", () => {
        const members = [peer(SELF), peer(2)];
        expect(payload(GET, { HouseholdPage: page(members) }, ctx())).toEqual(page(members));
    });

    it('drops every Person field outside the peer projection, lock inputs and role flags included', () => {
        const raw = {
            ...peer(2),
            lastBackgroundCheck: '2026-01-01',
            canAccessStaging: true,
            isSysadmin: true,
            isKeyholder: true,
            googleId: 'g-2',
            householdJoinPending: false,
            _count: { roles: 1, accounts: 1 },
            budgetOwnersOwned: [{ id: 3 }],
            household: { orgMembership: { isVolunteerFamily: true } },
        };
        expect(payload(GET, { HouseholdPage: page([raw]) }, ctx())).toEqual(page([peer(2)]));
    });

    it("keeps nothing sensitive on another household's rows", () => {
        const stranger = ctx({ selfId: 50, householdId: 77 });
        expect(payload(GET, { HouseholdPage: page([peer(2)]) }, stranger)).toEqual({
            household: {
                id: HH,
                name: 'The Example Household',
                householdMembers: [{ id: 2, householdId: HH, name: 'Person 2', nickname: null, isHouseholdLead: false }],
                orgMembership: ORG_MEMBERSHIP,
            },
            boardReplyTo: 'board@example.org',
            validUntil: '2026-12-31',
        });
    });

    it('keeps only public fields on a peer or household row that lacks its scope key', () => {
        const { id: _id, ...keyless } = HOUSEHOLD_ROW;
        const out = payload(GET, { HouseholdPage: page([peer(2, null)], keyless) }, ctx()) as {
            household: Record<string, unknown>;
        };
        expect(out.household).toEqual({
            name: 'The Example Household',
            householdMembers: [{ id: 2, name: 'Person 2', nickname: null, isHouseholdLead: false }],
            orgMembership: ORG_MEMBERSHIP,
        });
    });

    it('ships a caller with no household as household null', () => {
        const empty = { household: null, boardReplyTo: null, validUntil: null };
        expect(payload(GET, { HouseholdPage: empty }, ctx({ householdId: undefined }))).toEqual(empty);
    });
});

describe('PATCH /api/household', () => {
    const warning = {
        code: 'EMERGENCY_CONTACT_CONFLICT',
        householdId: HH,
        conflictedContactIds: [4],
        hasValidContact: false,
        message: 'Your emergency contact is now a household member.',
    };
    const added = (member: unknown, w: unknown) => ({ member, warning: w });

    it("ships the new member and the warning to the caller's household", () => {
        expect(payload(PATCH, { HouseholdMemberAdded: added(peer(3), warning) }, ctx())).toEqual(added(peer(3), warning));
    });

    it('ships a null warning as null', () => {
        expect(payload(PATCH, { HouseholdMemberAdded: added(peer(3), null) }, ctx())).toEqual(added(peer(3), null));
    });

    it("keeps only the public fields of another household's member and warning", () => {
        const stranger = ctx({ selfId: 50, householdId: 77 });
        expect(payload(PATCH, { HouseholdMemberAdded: added(peer(3), warning) }, stranger)).toEqual(
            added(
                { id: 3, householdId: HH, name: 'Person 3', nickname: null, isHouseholdLead: false },
                { code: 'EMERGENCY_CONTACT_CONFLICT', householdId: HH },
            ),
        );
    });

    it('keeps only the code of a warning that lacks its householdId', () => {
        const { householdId: _h, ...keyless } = warning;
        expect(payload(PATCH, { HouseholdMemberAdded: added(peer(3), keyless) }, ctx())).toEqual(
            added(peer(3), { code: 'EMERGENCY_CONTACT_CONFLICT' }),
        );
    });
});
