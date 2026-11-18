/**
 * @jest-environment node
 */
/**
 * resumeStatus: where a lifted block returns a household application. A paid one
 * never returns to a step before review and payment.
 */
import { resumeStatus } from '@/lib/membership/settleHouseholdBg';

const paid = new Date();

describe('resumeStatus', () => {
    it.each(['INTAKE', 'PENDING_RENEWAL', 'PENDING_EXTERNAL_ACTION'])('returns an unpaid application blocked from %s as it was', (from) => {
        expect(resumeStatus(from, { kind: 'INITIAL', paidAt: null, contractSignedAt: null }, true)).toBe(from);
    });

    it.each(['INTAKE', 'PENDING_RENEWAL', 'PENDING_EXTERNAL_ACTION', 'PENDING_PAYMENT'])('sends a paid application blocked from %s to PENDING_BG_CLEARANCE', (from) => {
        expect(resumeStatus(from, { kind: 'INITIAL', paidAt: paid, contractSignedAt: null }, false)).toBe('PENDING_BG_CLEARANCE');
    });

    it('sends an unpaid application blocked from a later step where blockedResetStatus does', () => {
        expect(resumeStatus('PENDING_PAYMENT', { kind: 'INITIAL', paidAt: null, contractSignedAt: paid }, true)).toBe('PENDING_PAYMENT');
    });
});
