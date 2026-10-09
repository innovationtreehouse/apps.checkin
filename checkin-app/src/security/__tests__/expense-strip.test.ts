/**
 * @jest-environment node
 */
/**
 * Boundary coverage for the expense classifications (#1272 §5). Money, vendor,
 * QuickBooks refs and settings are `internal`; person ids, usernames and the
 * reimbursee are `pii`; free text and stored payloads are `personal`. So a view
 * that grants `internal` only (a bucket approver's filtered rows) sees amounts
 * but not who signed, who is reimbursed or what anyone wrote, and the
 * FINANCE/BOARD view (pii + personal + internal) sees all of it.
 */
import { stripValue } from '@/security/stripper';
import type { CallerContext } from '@/security/access-resolvers';
import type { Token } from '@/security/core';
import * as expenseGenerated from '@/security/generated/expense-classifications';
import * as expenseSynthetic from '@/security/expenseSyntheticClassifications';

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

const INTERNAL_ONLY: readonly Token[] = ['everyones:internal', 'public'];
const FINANCE_VIEW: readonly Token[] = ['everyones:pii', 'everyones:personal', 'everyones:internal', 'public'];

const expenseMaps: Record<string, Record<string, string>> = {
    ...expenseGenerated.classifications,
    ...expenseSynthetic.classifications,
};

const strip = (model: string, row: object, tokens: readonly Token[]) =>
    stripValue(model, row, tokens, ctx) as Record<string, unknown>;

describe('expense tiering', () => {
    it('has no secret and no public field anywhere', () => {
        for (const [model, fields] of Object.entries(expenseMaps)) {
            for (const [field, tier] of Object.entries(fields)) {
                expect(`${model}.${field}:${tier}`).toMatch(/:(internal|personal|pii)$/);
            }
        }
    });

    it('tiers who signed, every actor and the reimbursee pii', () => {
        const pii = Object.entries(expenseGenerated.classifications)
            .flatMap(([model, fields]) => Object.entries(fields).filter(([, t]) => t === 'pii').map(([f]) => `${model}.${f}`))
            .sort();
        expect(pii).toEqual([
            'Expense.reimburseePersonId',
            'Expense.reimbursementFor',
            'Expense.submitterId',
            'ExpenseAuditLog.userId',
            'ExpenseAuditLog.username',
            'ExpenseFlag.checkedOffByUserId',
            'ExpenseFlag.checkedOffByUsername',
            'ExpenseLineItem.capitalOwnerId',
            'ExpenseLineSignoff.signerUserId',
            'ExpenseLineSignoff.signerUsername',
            'ExpenseOrgSettingsChange.actorUserId',
            'ExpenseOrgSettingsChange.actorUsername',
            'ExpenseQbMatchExclusion.excludedByUserId',
            'ExpenseQbMatchExclusion.excludedByUsername',
            'LineItemOwnerApproval.decidedByUserId',
        ]);
    });

    it('tiers the org settings internal', () => {
        expect(new Set(Object.values(expenseGenerated.classifications.ExpenseOrgSettings))).toEqual(new Set(['internal']));
    });
});

describe('expense stripper', () => {
    const expense = () => ({
        id: 'e-1',
        orgId: 'treehouse',
        submitterId: 7,
        vendorName: 'Acme',
        receiptTotalCents: 4200,
        needsReimbursement: true,
        reimbursementFor: 'Pat Doe',
        reimburseePersonId: 8,
        state: 'owner_approval',
    });

    it('an internal-only view keeps the money and strips the submitter and reimbursee', () => {
        expect(strip('Expense', expense(), INTERNAL_ONLY)).toEqual({
            id: 'e-1',
            orgId: 'treehouse',
            vendorName: 'Acme',
            receiptTotalCents: 4200,
            needsReimbursement: true,
            state: 'owner_approval',
        });
    });

    it('the finance view sees the submitter and reimbursee', () => {
        expect(strip('Expense', expense(), FINANCE_VIEW)).toEqual(expense());
    });

    it('an internal-only view strips who signed, through the line relation too', () => {
        const signoff = { id: 1, expenseId: 'e-1', lineItemId: 3, seat: 'TREASURER', signerUserId: 9, signerUsername: 'jordan' };
        expect(strip('ExpenseLineSignoff', signoff, INTERNAL_ONLY)).toEqual({ id: 1, expenseId: 'e-1', lineItemId: 3, seat: 'TREASURER' });

        const line = { id: 3, totalPriceCents: 4200, signoffs: [signoff] };
        expect(strip('ExpenseLineItem', line, INTERNAL_ONLY)).toEqual({
            id: 3,
            totalPriceCents: 4200,
            signoffs: [{ id: 1, expenseId: 'e-1', lineItemId: 3, seat: 'TREASURER' }],
        });
        expect(strip('ExpenseLineSignoff', signoff, FINANCE_VIEW)).toEqual(signoff);
    });

    it('an internal-only view strips the approver and notes on an approval', () => {
        const approval = { id: 2, lineItemId: 3, ownerId: 5, status: 'approved', decidedByUserId: 9, notes: 'ok by me' };
        expect(strip('LineItemOwnerApproval', approval, INTERNAL_ONLY)).toEqual({ id: 2, lineItemId: 3, ownerId: 5, status: 'approved' });
    });

    it('an internal-only view strips the stored intake payload', () => {
        const row = { id: 1, receiptId: 'r-1', status: 'applied', payloadJson: '{"reimbursementFor":"Pat Doe"}' };
        expect(strip('ReceivedExpensePayload', row, INTERNAL_ONLY)).toEqual({ id: 1, receiptId: 'r-1', status: 'applied' });
    });

    it('an internal-only view keeps a candidate amount and strips its vendor', () => {
        const candidate = { id: 'qb-7', txnDate: '2026-10-01', totalCents: 4200, accountRef: '35', vendorRef: '81' };
        expect(strip('ExpenseQbCandidateView', candidate, INTERNAL_ONLY)).toEqual({
            id: 'qb-7',
            txnDate: '2026-10-01',
            totalCents: 4200,
            accountRef: '35',
        });
    });

    it('a public-only view sees nothing, settings included', () => {
        const settings = { orgId: 'treehouse', boardReviewTotalCents: 200000, noteInLieuLimitCents: 5000 };
        expect(strip('ExpenseOrgSettings', settings, ['public'])).toEqual({});
        expect(strip('ExpenseOrgSettings', settings, INTERNAL_ONLY)).toEqual(settings);
        expect(strip('Expense', expense(), ['public'])).toEqual({});
    });
});
