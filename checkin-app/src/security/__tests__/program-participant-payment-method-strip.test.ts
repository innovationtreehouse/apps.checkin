/**
 * @jest-environment node
 */
// Program staff and sysadmins see whether a place is paid, never how
// (docs/rules/programs.md, Access to program information). View tokens come from
// the live registry, so these pins track policy edits.
import { stripValue } from '@/security/stripper';
import { type CallerContext } from '@/security/access-resolvers';
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

const PROGRAM_PAGE = 'GET /api/programs/[id]';
const PAYMENT_PLANS = 'GET /api/finance-ops/payment-plans';

// Every column that says a family asked for, holds, or was refused a payment
// plan or scholarship.
const PAYMENT_METHOD_FIELDS = [
    'isPaymentPlanRequested',
    'scholarshipRequestKind',
    'paymentPlanDeniedAt',
    'inventoryHeldAt',
    'seatTakenWithoutSaleAt',
    'wasOrgMemberAtApproval',
] as const;

// A refused request still inside its grace period, plus an approved one.
const deniedRow = {
    programId: 7,
    personId: 501,
    status: 'PENDING',
    pendingSince: '2026-01-06T00:00:00.000Z',
    isPaymentPlanRequested: false,
    scholarshipRequestKind: 'SCHOLARSHIP',
    paymentPlanDeniedAt: '2026-01-08T00:00:00.000Z',
    inventoryHeldAt: '2026-01-06T00:00:00.000Z',
    seatTakenWithoutSaleAt: null,
    wasOrgMemberAtApproval: null,
};
const approvedRow = {
    programId: 7,
    personId: 502,
    status: 'ACTIVE',
    pendingSince: null,
    isPaymentPlanRequested: true,
    scholarshipRequestKind: 'PAYMENT_PLAN',
    paymentPlanDeniedAt: null,
    inventoryHeldAt: null,
    seatTakenWithoutSaleAt: '2026-01-09T00:00:00.000Z',
    wasOrgMemberAtApproval: true,
};

function strip(endpoint: string, role: Role, row: Record<string, unknown>, c: CallerContext) {
    return stripValue('ProgramParticipant', row, tokensFor(endpoint, role), c) as Record<string, unknown>;
}

describe('ProgramParticipant payment method: program staff see paid or not, never how', () => {
    const staff: Array<[Role, CallerContext]> = [
        ['programLeadMentor', ctx({ programsLed: new Set([7]) })],
        ['programCoreVolunteer', ctx({ programsCoreVolIn: new Set([7]) })],
    ];

    describe.each(staff)('%s on the program page', (role, c) => {
        it.each([['refused', deniedRow], ['approved', approvedRow]])(
            'a %s request reaches them as nothing',
            (_label, row) => {
                const out = strip(PROGRAM_PAGE, role, row, c);
                for (const f of PAYMENT_METHOD_FIELDS) expect(out).not.toHaveProperty(f);
            },
        );

        it('still sees whether the place is paid, and since when it has waited', () => {
            const out = strip(PROGRAM_PAGE, role, deniedRow, c);
            expect(out.status).toBe('PENDING');
            expect(out.pendingSince).toBe('2026-01-06T00:00:00.000Z');
        });
    });
});

describe('ProgramParticipant payment method: a sysadmin sees paid or not, never how', () => {
    it.each([['refused', deniedRow], ['approved', approvedRow]])(
        'a %s request reaches a sysadmin on the program page as nothing',
        (_label, row) => {
            const out = strip(PROGRAM_PAGE, 'isSysadmin', row, ctx());
            for (const f of PAYMENT_METHOD_FIELDS) expect(out).not.toHaveProperty(f);
            expect(out.status).toBe(row.status);
        },
    );
});

describe('ProgramParticipant payment method: finance and the Board see it on their queue', () => {
    it.each<[string, Role]>([
        [PAYMENT_PLANS, 'isFinance'],
        [PAYMENT_PLANS, 'isBoardMember'],
    ])('%s as %s', (endpoint, role) => {
        const denied = strip(endpoint, role, deniedRow, ctx());
        expect(denied.isPaymentPlanRequested).toBe(false);
        expect(denied.scholarshipRequestKind).toBe('SCHOLARSHIP');
        expect(denied.paymentPlanDeniedAt).toBe('2026-01-08T00:00:00.000Z');
        expect(denied.inventoryHeldAt).toBe('2026-01-06T00:00:00.000Z');

        const approved = strip(endpoint, role, approvedRow, ctx());
        expect(approved.isPaymentPlanRequested).toBe(true);
        expect(approved.seatTakenWithoutSaleAt).toBe('2026-01-09T00:00:00.000Z');
        expect(approved.wasOrgMemberAtApproval).toBe(true);
    });
});
