/**
 * @jest-environment node
 */
/**
 * resumeStatus: where a lifted block returns a household application. A paid, signed
 * one never returns to a step before review and payment; an unsigned one keeps its
 * agreement step.
 */
import { resumeStatus } from '@/lib/membership/settleHouseholdBg';

const paid = new Date();

describe('resumeStatus', () => {
    it.each(['INTAKE', 'PENDING_RENEWAL', 'PENDING_EXTERNAL_ACTION'])('returns an unpaid application blocked from %s as it was', (from) => {
        expect(resumeStatus(from, { kind: 'INITIAL', paidAt: null, contractSignedAt: null }, true)).toBe(from);
    });

    it.each(['INTAKE', 'PENDING_RENEWAL', 'PENDING_EXTERNAL_ACTION', 'PENDING_PAYMENT'])('sends a paid, signed application blocked from %s to PENDING_BG_CLEARANCE', (from) => {
        expect(resumeStatus(from, { kind: 'INITIAL', paidAt: paid, contractSignedAt: paid }, false)).toBe('PENDING_BG_CLEARANCE');
    });

    it.each(['INTAKE', 'PENDING_RENEWAL', 'PENDING_EXTERNAL_ACTION'])('returns a paid, unsigned application blocked from %s as it was', (from) => {
        expect(resumeStatus(from, { kind: 'INITIAL', paidAt: paid, contractSignedAt: null }, true)).toBe(from);
    });

    it.each(['PENDING_PAYMENT', 'PENDING_BG_REVIEW', 'PENDING_BG_CLEARANCE'])('sends a paid, unsigned application blocked from %s to PENDING_EXTERNAL_ACTION', (from) => {
        expect(resumeStatus(from, { kind: 'INITIAL', paidAt: paid, contractSignedAt: null }, true)).toBe('PENDING_EXTERNAL_ACTION');
    });

    it('sends an unpaid application blocked from a later step where blockedResetStatus does', () => {
        expect(resumeStatus('PENDING_PAYMENT', { kind: 'INITIAL', paidAt: null, contractSignedAt: paid }, true)).toBe('PENDING_PAYMENT');
    });
});
