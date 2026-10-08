/**
 * @jest-environment node
 */
/**
 * Boundary coverage for the income library (#1283 §6/§7). Asserts the boundary
 * layer directly, independent of the route files:
 *
 *   1. Income's tiering: every field of the four Prisma models and the five
 *      synthetic views is `internal`, except a Prisma row's `id` (`public`).
 *      No pii, personal or secret anywhere.
 *   2. The §7 pins: the synthetic views list no mirror customer column and no
 *      QuickBooks deposit `Line[]`, `PrivateNote` or entity ref, so the stripper
 *      drops them even if an adapter passes one through.
 *   3. The stripper honours the map: the finance view (everyones:internal) keeps
 *      every listed field; a public-only view keeps a row's `id` and nothing else.
 */
import { stripValue } from '@/security/stripper';
import type { CallerContext } from '@/security/access-resolvers';
import { classifications, type Token } from '@/security/core';
import * as incomeGenerated from '@/security/generated/income-classifications';
import * as incomeSynthetic from '@/security/incomeSyntheticClassifications';

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

const FINANCE_TOKENS: readonly Token[] = ['everyones:internal', 'public'];

const PRISMA_MODELS = ['PayoutReconciliation', 'IncomeItemCategory', 'IncomeQbMatchExclusion', 'IncomeAuditLog'];

const VIEW_FIELDS: Record<string, string[]> = {
    IncomePayoutView: ['payoutGid', 'issuedAt', 'status', 'netCents', 'currency', 'source'],
    IncomeBalanceTxnView: ['txnGid', 'type', 'orderGid', 'orderName', 'amountCents', 'feeCents', 'netCents', 'source'],
    IncomeQbDepositView: ['id', 'txnDate', 'totalCents', 'depositToAccount'],
    IncomeItemView: ['variantId', 'title', 'sku', 'budgetOwnerId', 'budgetOwnerName'],
    IncomeReconciliationCount: ['total', 'status', 'matched', 'opened', 'drifted'],
};

// Fields an adapter must never surface: mirror buyer columns and QB deposit detail.
const FORBIDDEN = {
    customer_email: 'a@example.com',
    customerEmail: 'a@example.com',
    customer_name: 'A Buyer',
    customerName: 'A Buyer',
    Line: [{ Amount: 10, CustomerRef: { value: '9', name: 'A Buyer' } }],
    PrivateNote: 'for A Buyer',
    EntityRef: { value: '9', name: 'A Buyer' },
    CustomerRef: { value: '9', name: 'A Buyer' },
};

function tiersOf(model: string): Record<string, string> {
    return (classifications as Record<string, Record<string, string>>)[model];
}

function sampleRow(fields: string[]): Record<string, unknown> {
    return Object.fromEntries(fields.map((f, i) => [f, `v${i}`]));
}

describe('income tiering (§7)', () => {
    it('the generated map holds exactly the four income models', () => {
        expect(Object.keys(incomeGenerated.classifications).sort()).toEqual([...PRISMA_MODELS].sort());
    });

    it.each(PRISMA_MODELS)('%s: id is public, every other field internal', (model) => {
        const tiers = tiersOf(model);
        expect(tiers).toBeDefined();
        for (const [field, tier] of Object.entries(tiers)) {
            expect([field, tier]).toEqual([field, field === 'id' ? 'public' : 'internal']);
        }
    });

    it('the synthetic map holds exactly the five views, every field internal', () => {
        expect(Object.keys(incomeSynthetic.classifications).sort()).toEqual(Object.keys(VIEW_FIELDS).sort());
        for (const [view, fields] of Object.entries(VIEW_FIELDS)) {
            const tiers = tiersOf(view);
            expect(Object.keys(tiers).sort()).toEqual([...fields].sort());
            expect(new Set(Object.values(tiers))).toEqual(new Set(['internal']));
        }
    });
});

describe('income field-stripping', () => {
    it.each(Object.entries(VIEW_FIELDS))(
        '%s: finance view keeps the listed fields and drops customer / QB-line fields',
        (view, fields) => {
            const row = { ...sampleRow(fields), ...FORBIDDEN };
            const out = stripValue(view, row, FINANCE_TOKENS, ctx()) as Record<string, unknown>;
            expect(out).toEqual(sampleRow(fields));
        },
    );

    it.each(Object.entries(VIEW_FIELDS))('%s: a public-only view exposes nothing', (view, fields) => {
        const out = stripValue(view, sampleRow(fields), ['public'], ctx()) as Record<string, unknown>;
        expect(out).toEqual({});
    });

    it.each(PRISMA_MODELS)('%s: a public-only view keeps only the row id', (model) => {
        const out = stripValue(model, sampleRow(Object.keys(tiersOf(model))), ['public'], ctx());
        expect(out).toEqual({ id: 'v0' });
    });

    it('finance reads the audit actor and before/after (§7: internal, intended view)', () => {
        const row = {
            id: 1,
            orgId: 'treehouse',
            actorUserId: 42,
            actorUsername: 'jordan',
            action: 'resolve',
            entityType: 'PayoutReconciliation',
            entityId: '7',
            before: '{"status":"OPEN"}',
            after: '{"status":"RESOLVED"}',
            reason: 'check deposit, not a payout',
        };
        expect(stripValue('IncomeAuditLog', row, FINANCE_TOKENS, ctx())).toEqual(row);
    });
});
