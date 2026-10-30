/**
 * @jest-environment node
 *
 * Boundary coverage for the Shopify mirror (packages/s-ingest-core schema,
 * registry/shopifyRead.ts):
 *
 *   1. Tiering: the raw payload and bulk JSONL are `secret`; buyer and refund-note
 *      columns are `personal`; every other mirror field is `internal`.
 *   2. Admission: every route admits BOARD only — sysadmin, finance, other roles,
 *      a kiosk-less plain session and no session are refused.
 *   3. Stripping: the secret columns never leave under any view, for any role;
 *      the buyer columns leave only through the board's match-audit view.
 *
 * Callers sign in through the real authenticateRequest: only getServerSession is
 * mocked.
 */
import type { NextRequest as NextRequestType } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { allRoutes, getRoute, VALID_ROLES, type Token } from '@/security/core';
import { handler } from '@/security/handler';
import { stripValue } from '@/security/stripper';
import type { CallerContext } from '@/security/access-resolvers';
import * as generated from '@/security/generated/shopify-read-classifications';
import * as synthetic from '@/security/shopifyReadSyntheticClassifications';
import '@/security/registry';

const { NextRequest } = jest.requireActual<{ NextRequest: typeof NextRequestType }>('next/server');
jest.mock('@/lib/finance/financeViewLog', () => ({ recordFinanceView: jest.fn().mockResolvedValue(undefined) }));
const mockSession = getServerSession as jest.MockedFunction<typeof getServerSession>;

const ENDPOINTS = [
    'GET /api/finance-ops/payments',
    'GET /api/finance-ops/s-read/sync',
    'POST /api/finance-ops/s-read/sync',
    'GET /api/finance-ops/s-read/diagnose',
    'GET /api/finance-ops/s-read/match-audit',
    'POST /api/finance-ops/s-read/match-audit/track',
];
const MATCH_AUDIT = 'GET /api/finance-ops/s-read/match-audit';

const SECRET = { ShopifyRawEvent: ['payload'], ShopifyBulkExport: ['jsonl'] };
const PERSONAL = { ShopOrder: ['customerEmail', 'customerName'], ShopRefund: ['note'] };

const FLAGS = ['isSysadmin', 'isBoardMember', 'isKeyholder', 'isBackgroundCheckReviewer', 'isOperations', 'isInventoryManager', 'isFinance'] as const;
type Flag = (typeof FLAGS)[number];
function signIn(flags: Flag[]) {
    const user: Record<string, unknown> = { id: 7 };
    for (const f of FLAGS) user[f] = flags.includes(f);
    mockSession.mockResolvedValue({ user } as never);
}

function ctx(): CallerContext {
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
    };
}

// A bag carrying every restricted column, as a careless handler might return it.
function leakyBag() {
    return {
        ShopifyRawEvent: { id: 1, storeId: 's', shopifyGid: 'gid://shopify/Order/1', payload: { email: 'buyer@example.com' } },
        ShopifyBulkExport: { id: 2, storeId: 's', jsonl: '{"email":"buyer@example.com"}' },
        ShopOrder: { shopifyGid: 'gid://shopify/Order/1', legacyId: '1', customerEmail: 'buyer@example.com', customerName: 'A Buyer', totalCents: 100 },
        ShopRefund: { refundGid: 'gid://shopify/Refund/1', note: 'refund for A Buyer' },
        MatchAuditOrderRow: { bucket: 'UNCLAIMED_PAID', orderLegacyId: '1', customerEmail: 'buyer@example.com' },
        PaymentQueueRow: { id: 3, kind: 'UNMATCHED_ORDER', familyEmail: 'family@example.com' },
    };
}

async function call(endpoint: string) {
    const res = await handler(endpoint, async () => leakyBag())(new NextRequest('http://localhost/api/finance-ops/x'));
    if (res.status !== 200) return { status: res.status, body: undefined };
    const json = await res.json();
    const envelope = getRoute(endpoint)!.envelope;
    return { status: res.status, body: envelope === null ? json : json[envelope] };
}

beforeEach(() => mockSession.mockReset());

describe('mirror tiering', () => {
    it('classifies every mirror model', () => {
        expect(Object.keys(generated.classifications).sort()).toEqual([
            'ShopBalanceTransaction', 'ShopOrder', 'ShopOrderLine', 'ShopPayout', 'ShopRefund',
            'ShopifyBulkExport', 'ShopifyRawEvent', 'Store', 'SyncRun', 'SyncState',
        ]);
    });

    it('raw payloads are secret, buyer and note columns personal, everything else internal', () => {
        for (const [model, fields] of Object.entries(generated.classifications)) {
            for (const [field, tier] of Object.entries(fields as Record<string, string>)) {
                const expected = (SECRET as Record<string, string[]>)[model]?.includes(field)
                    ? 'secret'
                    : (PERSONAL as Record<string, string[]>)[model]?.includes(field) ? 'personal' : 'internal';
                expect(`${model}.${field}:${tier}`).toBe(`${model}.${field}:${expected}`);
            }
        }
    });

    it('synthetic contact fields carry the tier of their source column', () => {
        expect(synthetic.classifications.MatchAuditOrderRow.customerEmail).toBe('personal');
        expect(synthetic.classifications.PaymentQueueRow.familyEmail).toBe('pii');
    });
});

describe('mirror registry — admission', () => {
    it('registers exactly the mirror routes', () => {
        const registered = [...allRoutes()].map(([e]) => e).filter(e => / \/api\/finance-ops\/(payments$|s-read\/)/.test(e));
        expect(registered.sort()).toEqual([...ENDPOINTS].sort());
    });

    it.each(ENDPOINTS)('%s refuses no session with 401', async (endpoint) => {
        mockSession.mockResolvedValue(null);
        expect((await call(endpoint)).status).toBe(401);
    });

    it.each(ENDPOINTS)('%s refuses every non-board role with 403', async (endpoint) => {
        for (const flag of FLAGS.filter(f => f !== 'isBoardMember')) {
            signIn([flag]);
            expect([flag, (await call(endpoint)).status]).toEqual([flag, 403]);
        }
        signIn([]);
        expect((await call(endpoint)).status).toBe(403);
    });

    it.each(ENDPOINTS)('%s admits the board', async (endpoint) => {
        signIn(['isBoardMember']);
        expect((await call(endpoint)).status).toBe(200);
    });
});

describe('mirror registry — stripping', () => {
    it.each(ENDPOINTS)('%s never ships a raw payload or bulk export, even to board+sysadmin', async (endpoint) => {
        signIn(['isBoardMember', 'isSysadmin', 'isFinance']);
        const { body } = await call(endpoint);
        expect(body.ShopifyRawEvent).toEqual({ id: 1, storeId: 's', shopifyGid: 'gid://shopify/Order/1' });
        expect(body.ShopifyBulkExport).toEqual({ id: 2, storeId: 's' });
    });

    it.each(ENDPOINTS)('%s ships buyer columns only on the match audit', async (endpoint) => {
        signIn(['isBoardMember']);
        const { body } = await call(endpoint);
        const visible = endpoint === MATCH_AUDIT;
        expect('customerEmail' in body.ShopOrder).toBe(visible);
        expect('customerName' in body.ShopOrder).toBe(visible);
        expect('note' in body.ShopRefund).toBe(visible);
        expect('customerEmail' in body.MatchAuditOrderRow).toBe(visible);
        expect(body.ShopOrder.totalCents).toBe(100);
    });

    it('ships the family email only on the payment queue', async () => {
        signIn(['isBoardMember']);
        for (const endpoint of ENDPOINTS) {
            const { body } = await call(endpoint);
            expect([endpoint, 'familyEmail' in body.PaymentQueueRow]).toEqual([endpoint, endpoint === 'GET /api/finance-ops/payments']);
        }
    });

    it('for every role and every registered view, secret columns are stripped and personal ones need a personal grant', () => {
        const views: (readonly Token[])[] = [[]];
        for (const [endpoint, spec] of allRoutes()) {
            if (!ENDPOINTS.includes(endpoint)) continue;
            for (const role of VALID_ROLES) {
                views.push(spec.orderedView.find(([r]) => r === role)?.[1] ?? []);
            }
        }
        for (const tokens of views) {
            const bag = leakyBag();
            expect(stripValue('ShopifyRawEvent', bag.ShopifyRawEvent, tokens, ctx())).not.toHaveProperty('payload');
            expect(stripValue('ShopifyBulkExport', bag.ShopifyBulkExport, tokens, ctx())).not.toHaveProperty('jsonl');
            const order = stripValue('ShopOrder', bag.ShopOrder, tokens, ctx()) as Record<string, unknown>;
            expect('customerEmail' in order).toBe(tokens.includes('everyones:personal'));
        }
    });

    it('secret columns are stripped even under every grant there is', () => {
        const scopes = ['everyones', 'their_own', 'their_households', 'led_households', 'their_program_participants', 'their_program_households', 'keyholders', 'all_current_visitors'];
        const all = ['public', 'member', ...scopes.flatMap(s => ['pii', 'personal', 'internal'].map(t => `${s}:${t}`))] as Token[];
        const bag = leakyBag();
        expect(stripValue('ShopifyRawEvent', bag.ShopifyRawEvent, all, ctx())).not.toHaveProperty('payload');
        expect(stripValue('ShopifyBulkExport', bag.ShopifyBulkExport, all, ctx())).not.toHaveProperty('jsonl');
    });

    it('the match-audit report keeps its nested rows for the board', () => {
        const report = {
            configured: true,
            configuredVariants: 2,
            variantCoverage: { lines: 5, withVariant: 4 },
            orders: [{ bucket: 'MATCHED', orderLegacyId: '1', name: '#1', customerEmail: 'b@example.com', financialStatus: 'PAID', totalCents: 1, discountCodes: [], expected: ['membership'] }],
            memberships: [{ bucket: 'ORDER_MATCHED', processId: 1, membershipId: null, householdName: 'H', shopifyOrderId: '1', manualPaymentByName: null }],
            enrollments: [{ bucket: 'ORDER_MATCHED', programId: 1, programName: 'P', personId: 2, personName: 'N', shopifyOrderId: '1', compedByName: null }],
        };
        const tokens = getRoute(MATCH_AUDIT)!.orderedView[0][1];
        expect(stripValue('MatchAuditReport', report, tokens, ctx())).toEqual(report);
    });
});
