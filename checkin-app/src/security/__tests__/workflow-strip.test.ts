/**
 * @jest-environment node
 */
/**
 * Boundary coverage for the workflow-mapping classifications (#1289 §5):
 *
 *   1. The stored receipt blob is `personal` and the schema carries no `pii`.
 *   2. No workflow model, generated or synthetic, names a submitter or
 *      reimbursement field — the parsed projections are the only receipt
 *      content a route can return.
 *   3. The stripper, under the read view's tokens (public + everyones:internal),
 *      drops the blob and any submitter/reimbursement key a projection grows,
 *      and keeps the nested line items.
 */
import { stripValue } from '@/security/stripper';
import type { CallerContext } from '@/security/access-resolvers';
import type { Token } from '@/security/core';
import * as workflowGenerated from '@/security/generated/workflow-classifications';
import * as workflowSynthetic from '@/security/workflowSyntheticClassifications';

const READ_TOKENS: readonly Token[] = ['everyones:internal', 'public'];

const ctx: CallerContext = {
    selfId: 1,
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

const FORBIDDEN_FIELDS = ['submitterId', 'needsReimbursement', 'reimbursementFor', 'reimburseePersonId', 'localUserId'];

const workflowMaps: Record<string, Record<string, string>> = {
    ...workflowGenerated.classifications,
    ...workflowSynthetic.classifications,
};

describe('workflow-mapping classifications', () => {
    it('tiers the stored receipt blob personal and nothing pii', () => {
        expect(workflowGenerated.classifications.ReceivedReceipt.receiptJson).toBe('personal');
        for (const [model, fields] of Object.entries(workflowMaps)) {
            for (const [field, tier] of Object.entries(fields)) {
                expect(`${model}.${field}:${tier}`).not.toMatch(/:(pii|secret)$/);
            }
        }
    });

    it('declares no submitter or reimbursement field on any workflow model', () => {
        const declared = Object.entries(workflowMaps).flatMap(([model, fields]) =>
            Object.keys(fields).map(f => `${model}.${f}`),
        );
        const leaked = declared.filter(mf => FORBIDDEN_FIELDS.includes(mf.split('.')[1]));
        expect(leaked).toEqual([]);
    });
});

describe('workflow-mapping stripper under the read view', () => {
    it('drops the receipt blob from a raw row', () => {
        const out = stripValue(
            'ReceivedReceipt',
            { id: 7, orgId: 'org-1', receiptId: 'r-1', state: 'pending_review', receiptJson: '{"submitterId":3}' },
            READ_TOKENS,
            ctx,
        ) as Record<string, unknown>;
        expect(out).toEqual({ id: 7, orgId: 'org-1', receiptId: 'r-1', state: 'pending_review' });
    });

    it('keeps line items and drops submitter/reimbursement keys on the detail view', () => {
        const out = stripValue(
            'WorkflowReceiptView',
            {
                receiptId: 'r-1',
                vendorName: 'Acme',
                receiptTotalCents: 1200,
                submitterId: 3,
                reimburseePersonId: 4,
                reimbursementFor: 'Pat',
                lineItems: [{ lineNumber: 1, description: 'M3 bolts', unitPriceCents: 600, submitterId: 3 }],
            },
            READ_TOKENS,
            ctx,
        ) as Record<string, unknown>;
        expect(out).toEqual({
            receiptId: 'r-1',
            vendorName: 'Acme',
            receiptTotalCents: 1200,
            lineItems: [{ lineNumber: 1, description: 'M3 bolts', unitPriceCents: 600 }],
        });
    });

    it('a public-only view sees no money or vendor', () => {
        const out = stripValue(
            'WorkflowReceiptSummary',
            { id: 7, state: 'apply_failed', vendorName: 'Acme', receiptTotalCents: 1200, lineItemCount: 2 },
            ['public'],
            ctx,
        );
        expect(out).toEqual({ id: 7, state: 'apply_failed', lineItemCount: 2 });
    });
});
