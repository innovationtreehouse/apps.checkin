/**
 * @jest-environment node
 */
/**
 * The receipt OWN and FINANCE views carry a bare `public` token, which admits a
 * `public` field on any row the route returns, with no row gate. Today only
 * receipt ids are `public` on those models. This test pins that set, so a new
 * `public` field on a model these views return fails here and must be judged
 * against every submitter's view of every other person's receipt.
 */
import '@/security/registry';
import { allRoutes, classifications, modelRelations, type Token } from '@/security/core';

const OWN: readonly Token[] = ['their_own:personal', 'their_own:internal', 'public'];
const FINANCE: readonly Token[] = ['everyones:pii', 'everyones:personal', 'everyones:internal', 'public'];

const sameTokens = (a: readonly Token[], b: readonly Token[]) =>
    a.length === b.length && a.every(t => b.includes(t));

function reachable(model: string, seen: Set<string>): void {
    if (seen.has(model)) return;
    seen.add(model);
    for (const rel of Object.values(modelRelations(model))) reachable(rel.model, seen);
}

function publicFieldsReturnedByReceiptViews(): string[] {
    const models = new Set<string>();
    for (const [endpoint, route] of allRoutes()) {
        if (!endpoint.includes(' /api/receipts')) continue;
        const usesView = route.orderedView.some(([, tokens]) => sameTokens(tokens, OWN) || sameTokens(tokens, FINANCE));
        if (!usesView) continue;
        for (const model of route.returns ?? []) reachable(model, models);
    }
    const fields: string[] = [];
    for (const model of models) {
        const tiers = (classifications as Record<string, Record<string, string> | undefined>)[model] ?? {};
        for (const [field, tier] of Object.entries(tiers)) {
            if (tier === 'public') fields.push(`${model}.${field}`);
        }
    }
    return fields.sort();
}

const RECEIPT_IDS = [
    'Receipt.id',
    'ReceiptDuplicateGroup.dismissed',
    'ReceiptDuplicateMember.copyOfId',
    'ReceiptDuplicateMember.id',
    'ReceiptDuplicateQueueRow.id',
    'ReceiptView.copyOfId',
    'ReceiptView.id',
];

describe('the receipt OWN and FINANCE views', () => {
    it('return no public field but the receipt ids', () => {
        expect(publicFieldsReturnedByReceiptViews()).toEqual(RECEIPT_IDS);
    });
});
