/**
 * @jest-environment node
 */
/**
 * Boundary coverage for the receipt library (#1265 §3/§6):
 *
 *   1. File bytes are `pii`, never `secret`, file-only (a file route names
 *      them), and no JSON response view lists a file column, so the stripper
 *      drops them under any token set.
 *   2. Donor and reimbursee names are `pii`: an internal-only view keeps the
 *      money and ids and strips them; the finance view (pii + internal) sees them.
 *   3. ReceiptView (the flattened Receipt + ReceiptDetail row) tiers every field
 *      exactly as the generated models do.
 */
import '@/security/registry';
import { stripValue } from '@/security/stripper';
import type { CallerContext } from '@/security/access-resolvers';
import type { Token } from '@/security/core';
import * as receiptGenerated from '@/security/generated/receipt-classifications';
import * as receiptSynthetic from '@/security/receiptSyntheticClassifications';

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

const INTERNAL_ONLY: readonly Token[] = ['everyones:internal', 'public'];
const FINANCE_VIEW: readonly Token[] = ['everyones:pii', 'everyones:personal', 'everyones:internal', 'public'];

const BYTES = Buffer.from('%PDF-1.7');

function omit(obj: Record<string, unknown>, ...keys: string[]): Record<string, unknown> {
    return Object.fromEntries(Object.entries(obj).filter(([k]) => !keys.includes(k)));
}

const receiptView = () => ({
    id: 'r-1',
    orgId: 'treehouse',
    uploadedByUserId: 7,
    fileBlob: BYTES,
    needsReimbursement: true,
    reimbursementFor: 'Sam Lee',
    reimburseePersonId: 7,
    isInKind: true,
    donorFirstName: 'Pat',
    donorLastName: 'Doe',
    donorCompanyName: 'Doe Hardware',
    retailer: 'Acme',
    receiptTotalCents: 6989,
    state: 'financial_review',
    validationNotes: 'rejected: wrong store',
    lineItems: [{ id: 1, receiptId: 'r-1', lineNumber: 1, description: 'Arduino', totalPriceCents: 6989 }],
    reimbursement: { paidOn: null },
});

describe('receipt file bytes', () => {
    it.each([
        ['Receipt', 'fileBlob'],
        ['ReceiptMailItem', 'fileBlob'],
    ] as const)('%s.%s is pii, never secret', (model, field) => {
        const tiers = receiptGenerated.classifications[model] as Record<string, string>;
        expect(tiers[field]).toBe('pii');
    });

    it('no synthetic view lists a file column', () => {
        for (const fields of Object.values(receiptSynthetic.classifications)) {
            expect(Object.keys(fields)).not.toContain('fileBlob');
        }
    });

    it.each([
        ['internal-only', INTERNAL_ONLY],
        ['finance', FINANCE_VIEW],
    ] as const)('ReceiptView drops the file bytes under the %s view', (_name, tokens) => {
        const out = stripValue('ReceiptView', receiptView(), tokens, ctx()) as Record<string, unknown>;
        expect(out).not.toHaveProperty('fileBlob');
        expect(out.id).toBe('r-1');
    });

    it.each([
        ['Receipt', 'internal-only', INTERNAL_ONLY],
        ['Receipt', 'finance', FINANCE_VIEW],
        ['ReceiptMailItem', 'internal-only', INTERNAL_ONLY],
        ['ReceiptMailItem', 'finance', FINANCE_VIEW],
    ] as const)('raw %s drops the file bytes under the %s view', (model, _name, tokens) => {
        const out = stripValue(model, { id: 'r-1', fileBlob: BYTES, mimeType: 'application/pdf' }, tokens, ctx());
        expect(out).toEqual({ id: 'r-1', mimeType: 'application/pdf' });
    });
});

describe('receipt donor and reimbursee names', () => {
    it('an internal-only view keeps money and ids and strips the names and free text', () => {
        const out = stripValue('ReceiptView', receiptView(), INTERNAL_ONLY, ctx()) as Record<string, unknown>;
        expect(out.receiptTotalCents).toBe(6989);
        expect(out.reimburseePersonId).toBe(7);
        expect(out.isInKind).toBe(true);
        expect(out.lineItems).toEqual([{ id: 1, receiptId: 'r-1', lineNumber: 1, description: 'Arduino', totalPriceCents: 6989 }]);
        expect(out.reimbursement).toEqual({ paidOn: null });
        for (const f of ['reimbursementFor', 'donorFirstName', 'donorLastName', 'donorCompanyName', 'validationNotes']) {
            expect(out).not.toHaveProperty(f);
        }
    });

    it('the raw Receipt model strips the same names under an internal-only view', () => {
        const row = omit(receiptView(), 'lineItems', 'reimbursement');
        const out = stripValue('Receipt', row, INTERNAL_ONLY, ctx()) as Record<string, unknown>;
        expect(out.uploadedByUserId).toBe(7);
        for (const f of ['reimbursementFor', 'donorFirstName', 'donorLastName', 'donorCompanyName']) {
            expect(out).not.toHaveProperty(f);
        }
    });

    it('the finance view sees the names', () => {
        const out = stripValue('ReceiptView', receiptView(), FINANCE_VIEW, ctx()) as Record<string, unknown>;
        expect(out.reimbursementFor).toBe('Sam Lee');
        expect(out.donorFirstName).toBe('Pat');
        expect(out.donorCompanyName).toBe('Doe Hardware');
        expect(out.validationNotes).toBe('rejected: wrong store');
    });

    it('an internal-only view strips the audit actor name, values and the mail sender', () => {
        const log = { id: 1, receiptId: 'r-1', userId: 7, username: 'Sam Lee', action: 'field_edit', valueBefore: 'Acme', valueAfter: 'Acme Inc' };
        expect(stripValue('ReceiptAuditLog', log, INTERNAL_ONLY, ctx())).toEqual({ id: 1, receiptId: 'r-1', userId: 7, action: 'field_edit' });
        const mail = { id: 1, senderAddress: 'sam@example.com', status: 'held' };
        expect(stripValue('ReceiptMailItem', mail, INTERNAL_ONLY, ctx())).toEqual({ id: 1, status: 'held' });
    });
});

describe('ReceiptView tiering', () => {
    it('matches the generated Receipt and ReceiptDetail tiers field for field', () => {
        const receipt = omit(receiptGenerated.classifications.Receipt, 'fileBlob');
        const detail = omit(receiptGenerated.classifications.ReceiptDetail, 'id', 'orgId');
        const view = omit(receiptSynthetic.classifications.ReceiptView, 'financialReviewReasons', 'complete', 'reimbursement');
        expect(view).toEqual({ ...receipt, ...detail });
    });

    it('ReceiptLineView is ReceiptLineItem plus the owner stamp', () => {
        const { uploadedByUserId, ...line } = receiptSynthetic.classifications.ReceiptLineView;
        expect(uploadedByUserId).toBe('internal');
        expect(line).toEqual(receiptGenerated.classifications.ReceiptLineItem);
    });
});
