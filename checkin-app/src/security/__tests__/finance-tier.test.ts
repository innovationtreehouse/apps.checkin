/**
 * @jest-environment node
 */
// The `finance` tier is finance's alone: only an isFinance view entry may hold it,
// only as everyones:finance, and no outbound surface carries it. The grants are
// read from the live registry, so these pins track policy edits.
import { stripValue } from '@/security/stripper';
import type { CallerContext } from '@/security/access-resolvers';
import {
    allFileRoutes,
    allRoutes,
    defineFileRoute,
    defineOutbound,
    defineRoute,
    fieldVisible,
    financeTokenError,
    getRoute,
    parseToken,
    type OutboundSpec,
    type Role,
    type Scope,
    type Token,
} from '@/security/core';
import '@/security/registry';

const EVERY_SCOPE = new Set<Scope>(['everyones']);

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

function tokensFor(endpoint: string, role: Role): readonly Token[] {
    const entry = getRoute(endpoint)?.orderedView.find(([r]) => r === role);
    if (!entry) throw new Error(`no ${role} view on ${endpoint}`);
    return entry[1];
}

describe.each(['GET /api/donations/in-kind/receipt/[id]', 'GET /api/donations/in-kind/manual/[id]'])('%s', (endpoint) => {
    const gift = { id: 'g1', state: 'POST_FAILED', qbLastError: 'QuickBooks refused: code 6000 (request tid-1)', qbFaultText: 'A business validation error has occurred' };

    it('gives finance the fault text', () => {
        const out = stripValue('InKindGiftDetailView', gift, tokensFor(endpoint, 'isFinance'), CTX) as Record<string, unknown>;
        expect(out.qbFaultText).toBe(gift.qbFaultText);
    });

    it('strips the fault text from the Board, keeping the codes note', () => {
        const out = stripValue('InKindGiftDetailView', gift, tokensFor(endpoint, 'isBoardMember'), CTX) as Record<string, unknown>;
        expect(out).not.toHaveProperty('qbFaultText');
        expect(out.qbLastError).toBe(gift.qbLastError);
    });
});

describe('the finance tier', () => {
    it('shows a finance field only under everyones:finance', () => {
        expect(fieldVisible('finance', ['everyones:finance'], EVERY_SCOPE)).toBe(true);
        const everyOtherGrant: Token[] = ['public', 'member', 'everyones:pii', 'everyones:personal', 'everyones:internal', 'everyones:hardship'];
        expect(fieldVisible('finance', everyOtherGrant, EVERY_SCOPE)).toBe(false);
    });

    it('is held by no view entry but isFinance, on every registered route', () => {
        const holders: string[] = [];
        for (const [endpoint, spec] of [...allRoutes(), ...allFileRoutes()]) {
            for (const [role, tokens] of spec.orderedView) {
                for (const tok of tokens) {
                    const parsed = parseToken(tok);
                    if (parsed && typeof parsed === 'object' && parsed.tier === 'finance') holders.push(`${endpoint} ${role} ${tok}`);
                }
            }
        }
        expect(holders.sort()).toEqual([
            'GET /api/donations/in-kind/manual/[id] isFinance everyones:finance',
            'GET /api/donations/in-kind/receipt/[id] isFinance everyones:finance',
            'GET /api/expense/expenses/[id] isFinance everyones:finance',
            'GET /api/income/payouts/[gid] isFinance everyones:finance',
            'GET /api/income/reconciliation isFinance everyones:finance',
        ]);
    });

    it.each([
        ['isBoardMember', 'everyones:finance'],
        ['isSysadmin', 'everyones:finance'],
        ['authenticated', 'everyones:finance'],
        ['isFinance', 'their_own:finance'],
    ] as const)('refuses %s holding %s at registration', (role, token) => {
        expect(financeTokenError(role, parseToken(token))).not.toBeNull();
        expect(() =>
            defineRoute({
                endpoint: `GET /api/test/finance-tier/${role}/${token}`,
                authorize: 'authenticated',
                envelope: null,
                orderedView: [[role, [token, 'public']]],
            }),
        ).toThrow(/finance tier/);
    });

    it('accepts everyones:finance on the isFinance entry', () => {
        expect(financeTokenError('isFinance', parseToken('everyones:finance'))).toBeNull();
        expect(financeTokenError('isBoardMember', parseToken('everyones:internal'))).toBeNull();
    });

    it('is refused on a file route, as a token and as the served field\'s tier', () => {
        const base = { authorize: 'finance', file: { model: 'UploadedFile', field: 'fileBlob' } } as const;
        expect(() => defineFileRoute({ ...base, endpoint: 'GET /api/test/finance-tier/file-token', orderedView: [['isFinance', ['everyones:finance', 'everyones:internal']]] })).toThrow(/finance tier/);
        expect(() => defineFileRoute({ ...base, endpoint: 'GET /api/test/finance-tier/file-field', file: { model: 'InKindGiftDetailView', field: 'qbFaultText' }, orderedView: [['isFinance', ['everyones:internal']]] })).toThrow(/finance tier/);
    });

    it('is refused on an outbound surface', () => {
        const spec = { surface: 'test.finance-outbound', tiers: ['public', 'finance'] } as unknown as OutboundSpec;
        expect(() => defineOutbound(spec)).toThrow(/invalid tier 'finance'/);
    });
});
