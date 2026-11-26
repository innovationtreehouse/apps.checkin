import { checkStanding, checkValidFor, checkValidForApplication, disputingReviews, householdQualifies, rejectionHistory, sentBackForSubject, type CheckReviewFacts, type CheckStanding } from '@/lib/membership/checkStanding';
import type { DbClient } from '@/lib/db-client';

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

    const clearedFrom = (personId: number) => ({ oldData: { status: 'PENDING_BG_REVIEW', subjectPersonId: personId }, newData: { status: 'PENDING_BG_REVIEW', action: 'board reset', subjectPersonId: null } });

    it('keeps a rejection through more than one wrong-person reset', () => {
        expect(sentBackForSubject([named(5), reset('BLOCKED'), subjectCleared, named(6), clearedFrom(6), named(5)])).toBe(true);
    });

    it('reports a rejection held for a person cleared off the review until they are named again', () => {
        expect(rejectionHistory([named(5), reset('BLOCKED'), subjectCleared]).heldRejection).toBe(true);
        expect(rejectionHistory([named(5), reset('BLOCKED'), subjectCleared, named(6)]).heldRejection).toBe(true);
        expect(rejectionHistory([named(5), reset('BLOCKED'), subjectCleared, named(5)])).toEqual({ sentBack: true, heldRejection: false });
        expect(rejectionHistory([named(5), clearedFrom(5)]).heldRejection).toBe(false);
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

describe('checkValidFor: a check counts when it is valid at the start of the year', () => {
    // Boundary Sept 1, 27-month interval: membership year 2026 starts 2026-09-01, so
    // the earliest check that counts is 2024-06-01.
    const db = (settings: { orgMembershipYearBoundary: Date | null; bgRecheckMonths: number | null } | null) =>
        ({ boardSettings: { findUnique: jest.fn().mockResolvedValue(settings) } }) as unknown as DbClient;
    const policy = db({ orgMembershipYearBoundary: new Date('2020-09-01T00:00:00Z'), bgRecheckMonths: 27 });
    const at = (iso: string) => new Date(`${iso}T00:00:00Z`);
    const counts = async (checkedOn: string, year: number) => checkStanding(at(checkedOn), [], await checkValidFor(year, policy)) === 'CLEARED';

    it('takes a check exactly 27 months before the year starts', async () => {
        expect(await checkValidFor(2026, policy)).toEqual(at('2024-06-01'));
        expect(await counts('2024-06-01', 2026)).toBe(true);
    });

    it('takes a check a day under 27 months old at the start', async () => {
        expect(await counts('2024-06-02', 2026)).toBe(true);
    });

    it('refuses a check a day over 27 months old at the start', async () => {
        expect(await counts('2024-05-31', 2026)).toBe(false);
    });

    it('is null with no year, no boundary or no interval', async () => {
        expect(await checkValidFor(null, policy)).toBeNull();
        expect(await checkValidFor(2026, db({ orgMembershipYearBoundary: null, bgRecheckMonths: 27 }))).toBeNull();
        expect(await checkValidFor(2026, db({ orgMembershipYearBoundary: new Date('2020-09-01T00:00:00Z'), bgRecheckMonths: null }))).toBeNull();
        expect(await checkValidFor(2026, db(null))).toBeNull();
    });

    describe('for a household application', () => {
        it('uses the year the application paid for', async () => {
            expect(await checkValidForApplication({ appliesToYear: 2027, membershipYear: 2026, createdAt: at('2026-03-01') }, policy)).toEqual(at('2025-06-01'));
        });

        it('uses the year it was opened for before payment', async () => {
            expect(await checkValidForApplication({ appliesToYear: null, membershipYear: 2026, createdAt: at('2026-03-01') }, policy)).toEqual(at('2024-06-01'));
        });

        it('uses the year a renewal opened for, however late it is begun', async () => {
            // Opened in the window before the 2026 boundary: it is the 2026 renewal.
            expect(await checkValidForApplication({ appliesToYear: null, membershipYear: null, createdAt: at('2026-07-15') }, policy)).toEqual(at('2024-06-01'));
        });

        it('uses the year in progress for a join outside renewal season', async () => {
            expect(await checkValidForApplication({ appliesToYear: null, membershipYear: null, createdAt: at('2026-03-01') }, policy)).toEqual(at('2023-06-01'));
        });
    });
});
