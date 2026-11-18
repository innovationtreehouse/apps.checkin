/**
 * @jest-environment node
 */
/**
 * blockedResetStatus: the step a lifted block returns an application to. A paid
 * household application never goes back to a pay step.
 */
import { blockedResetStatus } from '@/lib/membership/review';

const signed = new Date();
const paid = new Date();

describe('blockedResetStatus', () => {
    it('sends a check review back to waiting for review', () => {
        expect(blockedResetStatus({ kind: 'PERSON_BG', paidAt: null, contractSignedAt: null }, false)).toBe('PENDING_BG_REVIEW');
    });

    it.each([
        ['check started', true],
        ['check not started', false],
    ])('holds a paid application at PENDING_BG_CLEARANCE, %s', (_label, checkStarted) => {
        expect(blockedResetStatus({ kind: 'INITIAL', paidAt: paid, contractSignedAt: signed }, checkStarted)).toBe('PENDING_BG_CLEARANCE');
        expect(blockedResetStatus({ kind: 'RENEWAL', paidAt: paid, contractSignedAt: signed }, checkStarted)).toBe('PENDING_BG_CLEARANCE');
    });

    it('sends an unpaid application back to the external step when its check is not started or it is unsigned', () => {
        expect(blockedResetStatus({ kind: 'INITIAL', paidAt: null, contractSignedAt: signed }, false)).toBe('PENDING_EXTERNAL_ACTION');
        expect(blockedResetStatus({ kind: 'INITIAL', paidAt: null, contractSignedAt: null }, true)).toBe('PENDING_EXTERNAL_ACTION');
    });

    it('sends a signed, unpaid application with its check started to payment', () => {
        expect(blockedResetStatus({ kind: 'INITIAL', paidAt: null, contractSignedAt: signed }, true)).toBe('PENDING_PAYMENT');
    });
});
