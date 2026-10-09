/**
 * @jest-environment node
 */
/**
 * Boundary coverage for the bulk-donation classifications (#1280 §4). Tiers are
 * per field: gift amounts are `internal`, donor identity is `pii`. A view that
 * grants `internal` but not `pii` is the de-identified view — amounts with no
 * names — and the FINANCE/BOARD view (pii + internal) sees both.
 */
import { stripValue } from '@/security/stripper';
import type { CallerContext } from '@/security/access-resolvers';
import type { Token } from '@/security/core';

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
const FINANCE_VIEW: readonly Token[] = ['everyones:pii', 'everyones:internal', 'public'];

const transaction = () => ({
    id: 1,
    orgId: 'treehouse',
    transactionId: 'BNV-1',
    companyName: 'Acme',
    donationAmountCents: 2500,
    matchAmountCents: 2500,
    donorFirstName: 'Pat',
    donorLastName: 'Doe',
    donorComment: 'in memory of Sam',
    ownerId: 3,
});

describe('bulk-donation field-stripping (Transaction)', () => {
    it('an internal-only view keeps the amounts and strips donor identity', () => {
        const out = stripValue('Transaction', transaction(), INTERNAL_ONLY, ctx()) as Record<string, unknown>;
        expect(out.donationAmountCents).toBe(2500);
        expect(out.matchAmountCents).toBe(2500);
        expect(out.companyName).toBe('Acme');
        expect(out.ownerId).toBe(3);
        expect(out.donorFirstName).toBeUndefined();
        expect(out.donorLastName).toBeUndefined();
        expect(out.donorComment).toBeUndefined();
    });

    it('the finance view (pii + internal) sees amounts and donor identity', () => {
        const out = stripValue('Transaction', transaction(), FINANCE_VIEW, ctx()) as Record<string, unknown>;
        expect(out.donationAmountCents).toBe(2500);
        expect(out.donorFirstName).toBe('Pat');
        expect(out.donorLastName).toBe('Doe');
        expect(out.donorComment).toBe('in memory of Sam');
    });

    it('donor identity is stripped through the DisbursementHold relation too', () => {
        const hold = { id: 9, reason: 'NO_MATCH', status: 'PENDING', transaction: transaction() };
        const out = stripValue('DisbursementHold', hold, INTERNAL_ONLY, ctx()) as { transaction: Record<string, unknown> };
        expect(out.transaction.donationAmountCents).toBe(2500);
        expect(out.transaction.donorFirstName).toBeUndefined();
        expect(out.transaction.donorComment).toBeUndefined();
    });
});

describe('bulk-donation field-stripping (comment rules and QB candidates)', () => {
    it('an internal-only view strips the comment-rule text', () => {
        const rule = { id: 1, comment: 'for the robotics team', ownerId: 3 };
        const out = stripValue('TransactionCommentRule', rule, INTERNAL_ONLY, ctx()) as Record<string, unknown>;
        expect(out.ownerId).toBe(3);
        expect(out.comment).toBeUndefined();
    });

    it('an internal-only view keeps the candidate amount and strips the memo', () => {
        const candidate = { id: 'qb-7', type: 'Deposit', date: '2026-10-01', amountCents: 5000, memo: 'Pat Doe gift' };
        const out = stripValue('DonationQbCandidateView', candidate, INTERNAL_ONLY, ctx()) as Record<string, unknown>;
        expect(out.amountCents).toBe(5000);
        expect(out.memo).toBeUndefined();
    });

    it('nav counts are public', () => {
        const out = stripValue('DonationNavCounts', { unassignedQueue: 4, disbursementHolds: 1 }, ['public'], ctx());
        expect(out).toEqual({ unassignedQueue: 4, disbursementHolds: 1 });
    });
});
