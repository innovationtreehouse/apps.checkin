import { membershipAuditOutcome, programAuditOutcome } from '../paymentPlanHistory';
import { pageParam } from '../paymentPlanHistoryPage';

describe('programAuditOutcome', () => {
    it('reads an approval, a held refusal and an unheld refusal', () => {
        expect(programAuditOutcome({ status: 'ACTIVE', isPaymentPlanRequested: false, wasOrgMemberAtApproval: false })).toBe('APPROVED');
        expect(programAuditOutcome({ isPaymentPlanRequested: false, paymentPlanDeniedAt: '2026-03-01T00:00:00.000Z' })).toBe('REFUSED');
        expect(programAuditOutcome({ isPaymentPlanRequested: false, deniedAt: '2026-03-01T00:00:00.000Z', reason: 'payment_plan_denied_no_hold' })).toBe('REFUSED');
    });

    it('ignores re-enrollment and other participant edits', () => {
        expect(programAuditOutcome({ status: 'PENDING', isPaymentPlanRequested: false, paymentPlanDeniedAt: null, wasOrgMemberAtApproval: null })).toBeNull();
        expect(programAuditOutcome(null)).toBeNull();
    });

    it('ignores the whole-row snapshot a withdrawal or refund writes', () => {
        const row = { programId: 7, personId: 9, isPaymentPlanRequested: false, pendingSince: null };
        expect(programAuditOutcome({ ...row, status: 'WITHDRAWN', wasOrgMemberAtApproval: true })).toBeNull();
        expect(programAuditOutcome({ ...row, status: 'WITHDRAWN', paymentPlanDeniedAt: '2026-03-01T00:00:00.000Z' })).toBeNull();
        expect(programAuditOutcome({ ...row, status: 'ACTIVE', wasOrgMemberAtApproval: false, reason: 'refund' })).toBeNull();
    });

    it('ignores the grace-expiry sweep, which names the refusal it expires', () => {
        expect(programAuditOutcome({ reason: 'scholarship_grace_expired', graceDays: 7, paymentPlanDeniedAt: '2026-03-01T00:00:00.000Z' })).toBeNull();
    });
});

describe('membershipAuditOutcome', () => {
    it('reads an approval and a refusal, and nothing else', () => {
        expect(membershipAuditOutcome({ status: 'ACTIVE', via: 'manual', paymentPlanApproved: true })).toBe('APPROVED');
        expect(membershipAuditOutcome({ paymentPlanDenied: true, isPaymentPlanRequested: false })).toBe('REFUSED');
        expect(membershipAuditOutcome({ status: 'ACTIVE', via: 'manual' })).toBeNull();
    });
});

describe('pageParam', () => {
    const at = (q: string) => pageParam(new Request(`http://localhost/x${q}`));
    it('reads a positive page and treats anything else as the first', () => {
        expect(at('?page=2')).toBe(2);
        expect(at('')).toBe(0);
        expect(at('?page=-1')).toBe(0);
        expect(at('?page=abc')).toBe(0);
    });
});
