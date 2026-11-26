/**
 * @jest-environment node
 */
// A failed post's QuickBooks fault text reaches finance alone: every other view of
// the routes that carry it strips it, and the codes page never gains it.
import { stripValue } from '@/security/stripper';
import type { CallerContext } from '@/security/access-resolvers';
import { allFileRoutes, allRoutes, classifications, fieldVisible, getRoute, type Role, type Scope, type Token } from '@/security/core';
import '@/security/registry';

const CTX: CallerContext = {
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
};

const WORDS = 'Duplicate Name Exists Error: The name supplied already exists. : Jane Donor';

function tokensFor(endpoint: string, role: Role): readonly Token[] {
    const entry = getRoute(endpoint)?.orderedView.find(([r]) => r === role);
    if (!entry) throw new Error(`no ${role} view on ${endpoint}`);
    return entry[1];
}

const tierOf = (model: string, field: string) => (classifications as Record<string, Record<string, string>>)[model]?.[field];

describe.each([
    ['GET /api/expense/expenses/[id]', 'Expense', ['isBoardMember', 'authenticated']],
    ['GET /api/income/payouts/[gid]', 'PayoutReconciliation', ['isBoardMember']],
    ['GET /api/income/reconciliation', 'PayoutReconciliation', ['isBoardMember']],
] as const)('%s', (endpoint, model, others) => {
    const row = { id: 7, qbLastError: 'QuickBooks refused: code 6240 (request tid-1)', reason: 'QuickBooks refused: code 6240 (request tid-1)', qbFaultText: WORDS };

    it('is classified finance', () => {
        expect(tierOf(model, 'qbFaultText')).toBe('finance');
    });

    it('gives finance the fault text', () => {
        const out = stripValue(model, row, tokensFor(endpoint, 'isFinance'), CTX) as Record<string, unknown>;
        expect(out.qbFaultText).toBe(WORDS);
    });

    it.each(others)('strips it from %s', (role) => {
        const out = stripValue(model, row, tokensFor(endpoint, role), CTX) as Record<string, unknown>;
        expect(out).not.toHaveProperty('qbFaultText');
    });
});

it('no view but finance can see a fault text field on any route', () => {
    const everyScope = new Set<Scope>(['everyones']);
    for (const [endpoint, spec] of [...allRoutes(), ...allFileRoutes()]) {
        for (const [role, tokens] of spec.orderedView) {
            if (role === 'isFinance') continue;
            expect([endpoint, role, fieldVisible('finance', tokens, everyScope)]).toEqual([endpoint, role, false]);
        }
    }
});

it('leaves the codes page rows as code, kind, counts, dates and lane only', () => {
    const fields = (classifications as Record<string, Record<string, string>>).QboFaultCodeSeen;
    expect(Object.keys(fields).sort()).toEqual(['code', 'count', 'firstSeenAt', 'kind', 'lastLane', 'lastSeenAt']);
});
