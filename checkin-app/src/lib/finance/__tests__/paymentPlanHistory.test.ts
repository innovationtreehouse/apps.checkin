import { MEMBERSHIP_STAMPED_APPROVAL, membershipAuditOutcome, programAuditOutcome } from '../paymentPlanHistory';
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

    it('ignores a past grace-expiry audit row, which names the refusal it expired', () => {
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

type Row = Record<string, unknown>;
type Clause = Record<string, unknown> & { OR?: Clause[] };

// Evaluates the `{ not: null }`, literal and OR clauses the stamped-approval filter uses.
function matches(row: Row, where: Clause): boolean {
    return Object.entries(where).every(([field, cond]) => {
        if (field === 'OR') return (cond as Clause[]).some((c) => matches(row, c));
        if (cond !== null && typeof cond === 'object' && 'not' in cond) return row[field] !== (cond as { not: unknown }).not;
        return row[field] === cond;
    });
}

describe('MEMBERSHIP_STAMPED_APPROVAL', () => {
    const certified = { manualPaymentById: 7, isPaymentPlanRequested: false, paymentPlanYear: 2026, scholarshipRequestKind: 'PAYMENT_PLAN' };
    const stamped = (row: Row) => matches(row, MEMBERSHIP_STAMPED_APPROVAL as Clause);

    it('takes a certified payment on a request that carried no kind', () => {
        expect(stamped({ ...certified, scholarshipRequestKind: null })).toBe(true);
    });

    it('takes a request from before the year column by its kind', () => {
        expect(stamped({ ...certified, paymentPlanYear: null })).toBe(true);
    });

    it('skips a process that never asked, an uncertified payment, and an open request', () => {
        expect(stamped({ ...certified, paymentPlanYear: null, scholarshipRequestKind: null })).toBe(false);
        expect(stamped({ ...certified, manualPaymentById: null })).toBe(false);
        expect(stamped({ ...certified, isPaymentPlanRequested: true })).toBe(false);
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
