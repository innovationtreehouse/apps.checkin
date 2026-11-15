/**
 * @jest-environment node
 */
// A scholarship or payment-plan request is the Board's and finance's alone; no
// other staff role sees one by default (docs/rules/revenue.md, Ownership). The
// `hardship` tier carries those fields, and only Board and finance views hold a
// hardship token. View tokens and tiers come from the live registry and
// classifications, so these pins track policy edits.
import { stripValue } from '@/security/stripper';
import { scopesHeld, type CallerContext } from '@/security/access-resolvers';
import {
    allFileRoutes,
    allRoutes,
    classifications,
    getRoute,
    parseToken,
    type Role,
    type Token,
} from '@/security/core';
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

const HARDSHIP_FIELDS = {
    OrgMembershipProcess: ['isPaymentPlanRequested', 'scholarshipRequestKind'],
    ProgramParticipant: [
        'isPaymentPlanRequested',
        'scholarshipRequestKind',
        'wasOrgMemberAtApproval',
        'inventoryHeldAt',
        'paymentPlanDeniedAt',
        'seatTakenWithoutSaleAt',
    ],
    ProgramPaymentPlanDecision: ['outcome', 'decidedAt'],
    MembershipPaymentPlanDecision: ['outcome', 'decidedAt'],
} as const;

// The Board and finance are the only staff audiences.
const HARDSHIP_ROLES: ReadonlySet<Role> = new Set<Role>(['isBoardMember', 'isFinance']);
// A family reading its own rows is not staff.
const OWN_SCOPES: ReadonlySet<string> = new Set(['their_own', 'led_households']);

const PROGRAM_PAGE = 'GET /api/programs/[id]';
const PAYMENT_PLANS = 'GET /api/finance-ops/payment-plans';
const MEMBERSHIP_PAYMENT_PLANS = 'GET /api/finance-ops/membership-payment-plans';

const participantRow = {
    programId: 7,
    personId: 501,
    status: 'PENDING',
    pendingSince: '2026-01-06T00:00:00.000Z',
    isPaymentPlanRequested: true,
    scholarshipRequestKind: 'SCHOLARSHIP',
    wasOrgMemberAtApproval: true,
    inventoryHeldAt: '2026-01-06T00:00:00.000Z',
    paymentPlanDeniedAt: '2026-01-08T00:00:00.000Z',
    seatTakenWithoutSaleAt: '2026-01-09T00:00:00.000Z',
    shopifyOrderId: '1001',
};

const processRow = {
    id: 12,
    kind: 'HOUSEHOLD',
    status: 'PENDING_PAYMENT',
    bgClearedAt: '2026-01-05T00:00:00.000Z',
    paidAt: null,
    isPaymentPlanRequested: true,
    scholarshipRequestKind: 'PAYMENT_PLAN',
};

describe('hardship tier: which fields carry it', () => {
    it('is exactly the request, hold, approval and refusal fields', () => {
        const tiered: Record<string, string[]> = {};
        for (const [model, fields] of Object.entries(classifications as Record<string, Record<string, string>>)) {
            const hits = Object.entries(fields).filter(([, tier]) => tier === 'hardship').map(([f]) => f);
            if (hits.length) tiered[model] = hits.sort();
        }
        expect(tiered).toEqual({
            OrgMembershipProcess: [...HARDSHIP_FIELDS.OrgMembershipProcess].sort(),
            ProgramParticipant: [...HARDSHIP_FIELDS.ProgramParticipant].sort(),
            ProgramPaymentPlanDecision: [...HARDSHIP_FIELDS.ProgramPaymentPlanDecision].sort(),
            MembershipPaymentPlanDecision: [...HARDSHIP_FIELDS.MembershipPaymentPlanDecision].sort(),
        });
    });

    it('is a valid token tier', () => {
        expect(parseToken('everyones:hardship')).toEqual({ scope: 'everyones', tier: 'hardship' });
        expect(parseToken('their_own:hardship')).toEqual({ scope: 'their_own', tier: 'hardship' });
    });
});

describe('hardship tier: no staff view but the Board and finance holds it', () => {
    const views: Array<[string, Role, readonly Token[]]> = [];
    for (const [endpoint, spec] of allRoutes()) {
        for (const [role, tokens] of spec.orderedView) views.push([endpoint, role, tokens]);
    }
    for (const [endpoint, spec] of allFileRoutes()) {
        for (const [role, tokens] of spec.orderedView) views.push([endpoint, role, tokens]);
    }

    it('every hardship grant is a Board or finance view, or a family reading its own rows', () => {
        const offenders = views.flatMap(([endpoint, role, tokens]) =>
            tokens
                .filter((t) => t.endsWith(':hardship'))
                .filter((t) => !HARDSHIP_ROLES.has(role) && !OWN_SCOPES.has(t.split(':')[0]))
                .map((t) => `${endpoint} ${role} ${t}`),
        );
        expect(offenders).toEqual([]);
    });

    it('the finance queues are the routes that grant it', () => {
        const granting = new Set(
            views.filter(([, , tokens]) => tokens.some((t) => t.endsWith(':hardship'))).map(([endpoint]) => endpoint),
        );
        expect([...granting].sort()).toEqual([
            MEMBERSHIP_PAYMENT_PLANS,
            `${MEMBERSHIP_PAYMENT_PLANS}/past`,
            PAYMENT_PLANS,
            `${PAYMENT_PLANS}/past`,
        ]);
    });
});

describe('hardship tier: staff audiences outside the Board and finance lose the request', () => {
    // Every registered route that returns ProgramParticipant or
    // OrgMembershipProcess to a staff role, except the event page.
    const staffViews: Array<[string, Role, 'ProgramParticipant' | 'OrgMembershipProcess', CallerContext]> = [
        [PROGRAM_PAGE, 'isSysadmin', 'ProgramParticipant', ctx()],
        [PROGRAM_PAGE, 'programLeadMentor', 'ProgramParticipant', ctx({ programsLed: new Set([7]) })],
        [PROGRAM_PAGE, 'programCoreVolunteer', 'ProgramParticipant', ctx({ programsCoreVolIn: new Set([7]) })],
        ['GET /api/membership-audit/turning-18', 'isSysadmin', 'ProgramParticipant', ctx()],
        ['GET /api/membership-ops/applications', 'isSysadmin', 'OrgMembershipProcess', ctx()],
        ['GET /api/membership-ops/volunteer-memberships', 'isSysadmin', 'OrgMembershipProcess', ctx()],
        ['GET /api/membership-audit/bg-attestations', 'isSysadmin', 'OrgMembershipProcess', ctx()],
        ['POST /api/membership-audit/person-agreement', 'isSysadmin', 'OrgMembershipProcess', ctx()],
        ['GET /api/membership/reviews', 'isBackgroundCheckReviewer', 'OrgMembershipProcess', ctx()],
    ];

    it.each(staffViews)('%s as %s receives no hardship field', (endpoint, role, model, c) => {
        const row = model === 'ProgramParticipant' ? participantRow : processRow;
        const out = stripValue(model, row, tokensFor(endpoint, role), c) as Record<string, unknown>;
        for (const f of HARDSHIP_FIELDS[model]) expect(out).not.toHaveProperty(f);
    });

    it.each([
        'GET /api/membership-ops/applications',
        'GET /api/membership-audit/bg-attestations',
        'GET /api/membership-ops/volunteer-memberships',
    ])('%s still gives a sysadmin the application state it works from', (endpoint) => {
        const out = stripValue('OrgMembershipProcess', processRow, tokensFor(endpoint, 'isSysadmin'), ctx()) as Record<string, unknown>;
        expect(out.status).toBe('PENDING_PAYMENT');
        expect(out.bgClearedAt).toBe('2026-01-05T00:00:00.000Z');
    });

    it('the program page still gives a sysadmin the internal order id beside the stripped request', () => {
        const out = stripValue('ProgramParticipant', participantRow, tokensFor(PROGRAM_PAGE, 'isSysadmin'), ctx()) as Record<string, unknown>;
        expect(out.shopifyOrderId).toBe('1001');
        expect(out.status).toBe('PENDING');
    });
});

describe('hardship tier: the Board and finance keep it', () => {
    it.each<[string, Role]>([
        [PAYMENT_PLANS, 'isFinance'],
        [PAYMENT_PLANS, 'isBoardMember'],
    ])('%s as %s receives every ProgramParticipant hardship field', (endpoint, role) => {
        const out = stripValue('ProgramParticipant', participantRow, tokensFor(endpoint, role), ctx()) as Record<string, unknown>;
        for (const f of HARDSHIP_FIELDS.ProgramParticipant) {
            expect(out[f]).toBe(participantRow[f]);
        }
    });

    it.each<[string, Role]>([
        [MEMBERSHIP_PAYMENT_PLANS, 'isFinance'],
        [MEMBERSHIP_PAYMENT_PLANS, 'isBoardMember'],
    ])('%s as %s receives every OrgMembershipProcess hardship field', (endpoint, role) => {
        const out = stripValue('OrgMembershipProcess', processRow, tokensFor(endpoint, role), ctx()) as Record<string, unknown>;
        for (const f of HARDSHIP_FIELDS.OrgMembershipProcess) {
            expect(out[f]).toBe(processRow[f]);
        }
    });
});

describe('hardship tier: the family keeps its own view', () => {
    it('their household reads their requests on routes outside the stripper', () => {
        // My activities and the household to-do list read the request directly,
        // limited to the caller's own household; no tier strips them.
        expect(getRoute('GET /api/programs/mine')).toBeUndefined();
    });

    it('a their_own:hardship grant reaches the person themself and no one else', () => {
        const tokens: readonly Token[] = ['their_own:hardship', 'public'];
        const self = stripValue('ProgramParticipant', participantRow, tokens, ctx({ selfId: 501 })) as Record<string, unknown>;
        expect(self.isPaymentPlanRequested).toBe(true);
        expect(scopesHeld('ProgramParticipant', participantRow, ctx({ selfId: 502 })).has('their_own')).toBe(false);
        const other = stripValue('ProgramParticipant', participantRow, tokens, ctx({ selfId: 502 })) as Record<string, unknown>;
        expect(other).not.toHaveProperty('isPaymentPlanRequested');
    });
});
