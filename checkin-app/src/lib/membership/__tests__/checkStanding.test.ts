import { checkStanding, disputingReviews, householdQualifies, type CheckReviewFacts, type CheckStanding } from '@/lib/membership/checkStanding';

const THRESHOLD = new Date('2026-01-01T00:00:00Z');
const FRESH = new Date('2026-06-01T00:00:00Z');
const EXPIRED = new Date('2025-06-01T00:00:00Z');

const review = (over: Partial<CheckReviewFacts> = {}): CheckReviewFacts => ({ id: 1, status: 'PENDING_BG_REVIEW', bgConsentAt: true, sentBack: false, ...over });

describe('checkStanding', () => {
    it('is CLEARED on a check inside the window with no review against it', () => {
        expect(checkStanding(FRESH, [], THRESHOLD)).toBe('CLEARED');
    });

    it('counts a check dated exactly at the threshold as inside the window', () => {
        expect(checkStanding(THRESHOLD, [], THRESHOLD)).toBe('CLEARED');
    });

    it('is not CLEARED on an expired check, or on any check under an unset policy', () => {
        expect(checkStanding(EXPIRED, [], THRESHOLD)).toBe('NONE');
        expect(checkStanding(FRESH, [], null)).toBe('NONE');
    });

    it('is DISPUTED on a blocked review, even over a valid clearance', () => {
        expect(checkStanding(FRESH, [review({ status: 'BLOCKED' })], THRESHOLD)).toBe('DISPUTED');
    });

    it('is DISPUTED on a Board-reset or changed-to-approve review still waiting, including after an undo left it with no approvals', () => {
        expect(checkStanding(FRESH, [review({ sentBack: true })], THRESHOLD)).toBe('DISPUTED');
        expect(checkStanding(null, [review({ sentBack: true, bgConsentAt: false })], THRESHOLD)).toBe('DISPUTED');
    });

    it('is PENDING on an open review with consent and nothing disputed', () => {
        expect(checkStanding(null, [review()], THRESHOLD)).toBe('PENDING');
        expect(checkStanding(EXPIRED, [review()], THRESHOLD)).toBe('PENDING');
    });

    it('stays CLEARED while a later review of a valid check is open', () => {
        expect(checkStanding(FRESH, [review()], THRESHOLD)).toBe('CLEARED');
    });

    it('is NONE on an open review that has no consent yet', () => {
        expect(checkStanding(null, [review({ bgConsentAt: false })], THRESHOLD)).toBe('NONE');
    });

    it('ignores a review that has cleared since it was sent back', () => {
        expect(checkStanding(FRESH, [review({ status: 'ACTIVE', sentBack: true })], THRESHOLD)).toBe('CLEARED');
        expect(disputingReviews([review({ status: 'ACTIVE', sentBack: true })])).toEqual([]);
    });
});

describe('householdQualifies', () => {
    const lead = (standing: CheckStanding) => ({ isHouseholdLead: true, standing });
    const other = (standing: CheckStanding) => ({ isHouseholdLead: false, standing });

    it('qualifies on one cleared lead', () => {
        expect(householdQualifies([lead('CLEARED'), lead('NONE'), other('NONE')])).toBe(true);
    });

    it('does not qualify with no leads, even when another adult is cleared', () => {
        expect(householdQualifies([])).toBe(false);
        expect(householdQualifies([other('CLEARED')])).toBe(false);
    });

    it('does not qualify when no lead is cleared (expired, pending or none)', () => {
        expect(householdQualifies([lead('NONE'), lead('PENDING')])).toBe(false);
    });

    it('does not qualify when a non-lead adult is disputed', () => {
        expect(householdQualifies([lead('CLEARED'), other('DISPUTED')])).toBe(false);
    });

    it('does not qualify when the other lead is disputed, nor when the only cleared lead is', () => {
        expect(householdQualifies([lead('CLEARED'), lead('DISPUTED')])).toBe(false);
        expect(householdQualifies([lead('DISPUTED')])).toBe(false);
    });
});
