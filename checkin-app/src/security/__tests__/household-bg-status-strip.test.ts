/**
 * @jest-environment node
 */
/**
 * GET /api/household: a peer's background-check status reaches the person
 * themself and a lead of their household. A non-lead sibling, another
 * household and a sysadmin outside the household keep the peer without it.
 */
import { stripBag } from '@/security/stripper';
import type { CallerContext } from '@/security/access-resolvers';
import { getRoute } from '@/security/core';
import { classifications, relations } from '@/security/householdSyntheticClassifications';
import { SCOPE_BINDINGS } from '@/security/scopeBindings';
import '@/security/registry';

const GET = 'GET /api/household';
const HH = 10;
const LEAD = 1;
const ADULT = 2;
const SIBLING = 3;

function ctx(opts: Partial<CallerContext> = {}): CallerContext {
    return {
        selfId: LEAD,
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

const lead = ctx({ ledHouseholdMemberIds: new Set([LEAD, ADULT, SIBLING]) });
const adultSelf = ctx({ selfId: ADULT });
const sibling = ctx({ selfId: SIBLING });
const otherHousehold = ctx({ selfId: 50, householdId: 77, ledHouseholdMemberIds: new Set([50]) });
const sysadminElsewhere = ctx({ selfId: 90, householdId: 99 });

const peer = (id: number) => ({
    id,
    householdId: HH,
    name: `Person ${id}`,
    nickname: null,
    isHouseholdLead: id === LEAD,
    bgStatus: { personId: id, status: 'VALID' },
});

/** The bgStatus each peer of the household keeps after stripping, by peer id. */
function statuses(caller: CallerContext): Record<number, unknown> {
    const view = getRoute(GET)?.orderedView.find(([r]) => r === 'authenticated')?.[1];
    if (!view) throw new Error('no authenticated view');
    const bag = {
        HouseholdPage: {
            household: { id: HH, name: 'H', householdMembers: [peer(LEAD), peer(ADULT), peer(SIBLING)], orgMembership: null },
            boardReplyTo: null,
            validUntil: null,
        },
    };
    const out = stripBag(bag, view, caller) as {
        HouseholdPage: { household: { householdMembers: { id: number; bgStatus?: unknown }[] } };
    };
    return Object.fromEntries(out.HouseholdPage.household.householdMembers.map((m) => [m.id, m.bgStatus]));
}

describe('HouseholdPeerBgStatus', () => {
    it('is a status, never a date, bound to the person and their household lead only', () => {
        expect(classifications.HouseholdPeerBgStatus).toEqual({ personId: 'public', status: 'internal' });
        expect(relations.HouseholdPeer.bgStatus).toEqual({ model: 'HouseholdPeerBgStatus', isList: false });
        expect(SCOPE_BINDINGS.HouseholdPeerBgStatus).toEqual({
            their_own: { field: 'personId', eqCtx: 'selfId' },
            led_households: { field: 'personId', inCtx: 'ledHouseholdMemberIds' },
        });
    });

    it('has no role-specific view on GET /api/household, so a sysadmin reads it as any member', () => {
        expect(getRoute(GET)?.orderedView.map(([role]) => role)).toEqual(['authenticated']);
    });

    it('shows every adult status to a household lead', () => {
        const status = { status: 'VALID' };
        expect(statuses(lead)).toEqual({
            [LEAD]: { personId: LEAD, ...status },
            [ADULT]: { personId: ADULT, ...status },
            [SIBLING]: { personId: SIBLING, ...status },
        });
    });

    it('shows a non-lead adult who is not a sysadmin their own status only', () => {
        expect(statuses(adultSelf)).toEqual({
            [LEAD]: { personId: LEAD },
            [ADULT]: { personId: ADULT, status: 'VALID' },
            [SIBLING]: { personId: SIBLING },
        });
    });

    it('shows a non-lead sibling no status but their own', () => {
        expect(statuses(sibling)).toEqual({
            [LEAD]: { personId: LEAD },
            [ADULT]: { personId: ADULT },
            [SIBLING]: { personId: SIBLING, status: 'VALID' },
        });
    });

    it('never ships a clearance date, even to the person themself or their lead', () => {
        const view = getRoute(GET)?.orderedView[0][1] ?? [];
        const dated = {
            ...peer(ADULT),
            bgClearedAt: '2026-01-01',
            bgStatus: { personId: ADULT, status: 'VALID', bgClearedAt: '2026-01-01', expiresAt: '2027-01-01' },
        };
        const bag = () => ({ HouseholdPage: { household: { id: HH, name: 'H', householdMembers: [dated], orgMembership: null }, boardReplyTo: null, validUntil: null } });
        for (const caller of [adultSelf, lead]) {
            const out = stripBag(bag(), view, caller) as { HouseholdPage: { household: { householdMembers: Record<string, unknown>[] } } };
            const member = out.HouseholdPage.household.householdMembers[0];
            expect(member).not.toHaveProperty('bgClearedAt');
            expect(member.bgStatus).toEqual({ personId: ADULT, status: 'VALID' });
        }
    });

    it('shows no status to another household or a sysadmin outside the household', () => {
        for (const caller of [otherHousehold, sysadminElsewhere]) {
            expect(statuses(caller)).toEqual({
                [LEAD]: { personId: LEAD },
                [ADULT]: { personId: ADULT },
                [SIBLING]: { personId: SIBLING },
            });
        }
    });

    it('drops the status from a row that lacks its personId', () => {
        const view = getRoute(GET)?.orderedView[0][1] ?? [];
        const keyless = { ...peer(ADULT), bgStatus: { status: 'VALID' } };
        const bag = { HouseholdPage: { household: { id: HH, name: 'H', householdMembers: [keyless], orgMembership: null }, boardReplyTo: null, validUntil: null } };
        const out = stripBag(bag, view, adultSelf) as { HouseholdPage: { household: { householdMembers: { bgStatus?: unknown }[] } } };
        expect(out.HouseholdPage.household.householdMembers[0].bgStatus).toBeNull();
    });
});
