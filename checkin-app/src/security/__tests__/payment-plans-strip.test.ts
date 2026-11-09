/**
 * @jest-environment node
 */
/**
 * Strip-assertion for GET /api/finance-ops/payment-plans. The handler returns
 * ProgramParticipant rows with the participant nested. Pulls the live view
 * tokens from the registry so this tracks any future policy edit.
 *
 *   - board/finance view (everyones:*)   → nested participant.email (pii) survives.
 *   - any non-admin view (member+public) → email stripped, name kept. This is the
 *     migration's whole point: a role later added to this route is auto-stripped.
 *   - admission: Board and Finance only; a sysadmin-only session is refused.
 */
import { stripValue } from '@/security/stripper';
import { resolveAccess, scopesHeld, type CallerContext } from '@/security/access-resolvers';
import type { AuthenticatedUser } from '@/types/auth';
import { getRoute, type Role, type Token } from '@/security/core';
import '@/security/registry';

function ctx(opts: Partial<CallerContext> = {}): CallerContext {
    return {
        selfId: undefined,
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
        ...opts,
    };
}

function tokensFor(endpoint: string, role: Role): readonly Token[] {
    const spec = getRoute(endpoint);
    if (!spec) throw new Error(`no registry entry for ${endpoint}`);
    const entry = spec.orderedView.find(([r]) => r === role);
    if (!entry) throw new Error(`no orderedView entry for ${role} on ${endpoint}`);
    return entry[1];
}

const PROGRAM_ENDPOINT = 'GET /api/finance-ops/payment-plans';
const MEMBERSHIP_ENDPOINT = 'GET /api/finance-ops/membership-payment-plans';

// A pending row with the participant (pii) + program nested, as the handler ships it.
const row = {
    programId: 1,
    participantId: 2,
    status: 'PENDING',
    isPaymentPlanRequested: true,
    person: {
        id: 2, name: 'Member Name', email: 'member@x.test', dateOfBirth: '2000-01-01',
        household: {
            id: 1, name: 'The Members',
            householdMembers: [{ id: 3, name: 'Lead Parent', email: 'lead@x.test' }],
        },
    },
    program: { id: 1, name: 'Woodshop' },
};

describe('payment-plans field-stripping', () => {
    it('board sees the nested participant email (pii) + dateOfBirth (personal)', () => {
        const tokens = tokensFor(PROGRAM_ENDPOINT, 'isBoardMember');
        const out = stripValue('ProgramParticipant', row, tokens, ctx()) as Record<string, unknown>;
        const p = out.person as Record<string, unknown>;
        expect(p.email).toBe('member@x.test');
        expect(p.dateOfBirth).toBe('2000-01-01');
        expect(p.name).toBe('Member Name');
    });

    it('board sees household lead email (pii) nested under person.household', () => {
        const tokens = tokensFor(PROGRAM_ENDPOINT, 'isBoardMember');
        const out = stripValue('ProgramParticipant', row, tokens, ctx()) as Record<string, unknown>;
        const p = out.person as Record<string, unknown>;
        const h = p.household as Record<string, unknown>;
        const leads = h.householdMembers as Array<Record<string, unknown>>;
        expect(leads).toHaveLength(1);
        expect(leads[0].email).toBe('lead@x.test');
        expect(leads[0].name).toBe('Lead Parent');
    });

    it('a non-admin view strips lead email but keeps lead name', () => {
        const tokens: readonly Token[] = ['member', 'public'];
        const out = stripValue('ProgramParticipant', row, tokens, ctx()) as Record<string, unknown>;
        const p = out.person as Record<string, unknown>;
        const h = p.household as Record<string, unknown>;
        const leads = h.householdMembers as Array<Record<string, unknown>>;
        expect(leads).toHaveLength(1);
        expect(leads[0].email).toBeUndefined();
        expect(leads[0].name).toBe('Lead Parent');
    });

    it('a non-admin view (member+public) strips email/dob but keeps name', () => {
        // Not in the registry — proves the declared policy auto-strips any
        // role later granted a member/public-only view of this route.
        const tokens: readonly Token[] = ['member', 'public'];
        const out = stripValue('ProgramParticipant', row, tokens, ctx()) as Record<string, unknown>;
        const p = out.person as Record<string, unknown>;
        expect(p.email).toBeUndefined();
        expect(p.dateOfBirth).toBeUndefined();
        expect(p.name).toBe('Member Name');
    });

    it('Person.email is pii, so everyones:pii is required to see it', () => {
        // Guards the assumption the test rests on.
        const board = tokensFor(PROGRAM_ENDPOINT, 'isBoardMember');
        expect(board).toContain('everyones:pii');
        const scopes = scopesHeld('Person', row.person, ctx());
        expect(scopes.has('everyones')).toBe(true);
    });
});

// Membership payment-plan queue: OrgMembershipProcess → orgMembership →
// household → householdMembers (Person leads).
const membershipRow = {
    id: 1,
    isPaymentPlanRequested: true,
    stageEnteredAt: '2026-01-15T00:00:00.000Z',
    orgMembership: {
        id: 1, isVolunteerFamily: false,
        household: {
            id: 1, name: 'The Members',
            householdMembers: [{ id: 3, name: 'Lead Parent', email: 'lead@x.test' }],
        },
    },
};

describe('membership-payment-plans field-stripping', () => {
    it('board sees household lead email (pii) nested under household', () => {
        const tokens = tokensFor(MEMBERSHIP_ENDPOINT, 'isBoardMember');
        const out = stripValue('OrgMembershipProcess', membershipRow, tokens, ctx()) as Record<string, unknown>;
        const om = out.orgMembership as Record<string, unknown>;
        const h = om.household as Record<string, unknown>;
        const leads = h.householdMembers as Array<Record<string, unknown>>;
        expect(leads).toHaveLength(1);
        expect(leads[0].email).toBe('lead@x.test');
        expect(leads[0].name).toBe('Lead Parent');
    });

    it('a non-admin view strips lead email but keeps lead name', () => {
        const tokens: readonly Token[] = ['member', 'public'];
        const out = stripValue('OrgMembershipProcess', membershipRow, tokens, ctx()) as Record<string, unknown>;
        const om = out.orgMembership as Record<string, unknown>;
        const h = om.household as Record<string, unknown>;
        const leads = h.householdMembers as Array<Record<string, unknown>>;
        expect(leads).toHaveLength(1);
        expect(leads[0].email).toBeUndefined();
        expect(leads[0].name).toBe('Lead Parent');
    });
});

describe('payment-plan queue admission', () => {
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

    async function admits(endpoint: string, flags: Partial<AuthenticatedUser>) {
        const spec = getRoute(endpoint);
        if (!spec) throw new Error(`no registry entry for ${endpoint}`);
        const auth = { type: 'session' as const, user: { ...noFlags, ...flags } };
        return (await resolveAccess(spec.authorize, { auth, params: {}, callerContext: ctx() })).allowed;
    }

    it.each([PROGRAM_ENDPOINT, MEMBERSHIP_ENDPOINT])('%s admits board and finance, refuses a sysadmin-only session', async (endpoint) => {
        expect(await admits(endpoint, { isBoardMember: true })).toBe(true);
        expect(await admits(endpoint, { isFinance: true })).toBe(true);
        expect(await admits(endpoint, { isSysadmin: true })).toBe(false);
        expect(await admits(endpoint, {})).toBe(false);
    });

    it.each([PROGRAM_ENDPOINT, MEMBERSHIP_ENDPOINT])('%s gives finance the same view as board', (endpoint) => {
        expect(tokensFor(endpoint, 'isFinance')).toEqual(tokensFor(endpoint, 'isBoardMember'));
    });
});
