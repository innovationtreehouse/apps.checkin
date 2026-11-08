import { checkStanding, disputingReviews, householdQualifies, sentBackForSubject, type CheckReviewFacts, type CheckStanding } from '@/lib/membership/checkStanding';

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

    it('is DISPUTED on a review whose rejection was sent back and still waits, including after an undo left it with no approvals', () => {
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

describe('sentBackForSubject', () => {
    const reset = (from: string) => ({ oldData: { status: from }, newData: { status: 'PENDING_BG_REVIEW', action: 'board reset' } });
    const changedToApprove = { oldData: { status: 'BLOCKED' }, newData: { status: 'PENDING_BG_REVIEW', action: 'rejector changed to approve' } };
    const undo = { oldData: { result: 'APPROVE' }, newData: { action: 'reviewer undo' } };
    const subjectCleared = { oldData: { status: 'BLOCKED', subjectPersonId: 5 }, newData: { status: 'PENDING_BG_REVIEW', action: 'board reset', subjectPersonId: null } };

    it('sends back a Board reset of a rejection', () => {
        expect(sentBackForSubject([reset('BLOCKED')])).toBe(true);
    });

    it('treats a Board reset of a review with no rejection as a plain start-over', () => {
        expect(sentBackForSubject([reset('PENDING_BG_REVIEW')])).toBe(false);
        expect(sentBackForSubject([])).toBe(false);
    });

    it('keeps a rejection changed to approve sent back, including after that approval is undone', () => {
        expect(sentBackForSubject([changedToApprove])).toBe(true);
        expect(sentBackForSubject([changedToApprove, undo])).toBe(true);
        expect(sentBackForSubject([changedToApprove, reset('PENDING_BG_REVIEW')])).toBe(true);
    });

    it('treats the reset that clears the named person as a plain start-over', () => {
        expect(sentBackForSubject([subjectCleared])).toBe(false);
    });

    it('starts a fresh history for the next person named after the subject is cleared', () => {
        expect(sentBackForSubject([reset('BLOCKED'), subjectCleared])).toBe(false);
        expect(sentBackForSubject([changedToApprove, undo, subjectCleared])).toBe(false);
        expect(sentBackForSubject([reset('BLOCKED'), subjectCleared, reset('BLOCKED')])).toBe(true);
    });

    const named = (personId: number) => ({ oldData: { subjectPersonId: null }, newData: { action: 'subject named', subjectPersonId: personId } });

    it('keeps the earlier rejection when the person cleared off the review is named again', () => {
        expect(sentBackForSubject([subjectCleared, named(5)])).toBe(true);
        expect(sentBackForSubject([changedToApprove, undo, subjectCleared, named(5)])).toBe(true);
    });

    it('starts fresh when a different person is named after the subject is cleared', () => {
        expect(sentBackForSubject([subjectCleared, named(6)])).toBe(false);
    });

    it('keeps nothing for the same person when the cleared review had not been sent back', () => {
        const clearedInProgress = { oldData: { status: 'PENDING_BG_REVIEW', subjectPersonId: 5 }, newData: { status: 'PENDING_BG_REVIEW', action: 'board reset', subjectPersonId: null } };
        expect(sentBackForSubject([clearedInProgress, named(5)])).toBe(false);
    });
});

describe('householdQualifies', () => {
    const lead = (standing: CheckStanding) => ({ isHouseholdLead: true, standing });
    const other = (standing: CheckStanding) => ({ isHouseholdLead: false, standing });
    const householdQualifiesOn = (members: { isHouseholdLead: boolean; standing: CheckStanding }[]) => householdQualifies({ members, awaitingNaming: false });

    it('qualifies on one cleared lead', () => {
        expect(householdQualifiesOn([lead('CLEARED'), lead('NONE'), other('NONE')])).toBe(true);
    });

    it('does not qualify with no leads, even when another adult is cleared', () => {
        expect(householdQualifiesOn([])).toBe(false);
        expect(householdQualifiesOn([other('CLEARED')])).toBe(false);
    });

    it('does not qualify when no lead is cleared (expired, pending or none)', () => {
        expect(householdQualifiesOn([lead('NONE'), lead('PENDING')])).toBe(false);
    });

    it('does not qualify when a non-lead adult is disputed', () => {
        expect(householdQualifiesOn([lead('CLEARED'), other('DISPUTED')])).toBe(false);
    });

    it('does not qualify when the other lead is disputed, nor when the only cleared lead is', () => {
        expect(householdQualifiesOn([lead('CLEARED'), lead('DISPUTED')])).toBe(false);
        expect(householdQualifiesOn([lead('DISPUTED')])).toBe(false);
    });

    it('does not qualify while an open review is waiting for its first reviewer to name a person', () => {
        expect(householdQualifies({ members: [lead('CLEARED')], awaitingNaming: true })).toBe(false);
    });
});
