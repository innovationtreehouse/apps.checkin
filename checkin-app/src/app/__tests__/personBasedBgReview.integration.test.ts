/**
 * @jest-environment node
 */
/**
 * Person-based background-check review against a real database
 * (docs/in-design/person-based-bg-review.md §7 PR 4): a household's consent opens a
 * check review with no person; its first decision, approve or reject, names the
 * person; every outcome settles the households it touches; the household
 * application is never reviewed itself.
 */
import type { OrgMembershipProcessStatus } from '@/generated/prisma/client';
import prisma from '@/lib/prisma';
import { markBgConsent } from '@/lib/membership/external';
import { attest, boardResetReview, eligibleReviewProcessIds, undoOwnApproval } from '@/lib/membership/review';
import { activate } from '@/lib/membership/payment';
import { archiveApplication, unarchiveApplication } from '@/lib/membership/archive';
import { settleApplicationsAwaitingCheck, settleHouseholdBg } from '@/lib/membership/settleHouseholdBg';
import { householdCheckStandings } from '@/lib/membership/checkStanding';
import { notifyBoardPaidReject } from '@/lib/membership/boardAlerts';
import { snapshotBoardSettings } from '@/test-helpers/boardSettings';

jest.mock('@/lib/email', () => ({ runPaced: (tasks: Array<() => Promise<unknown>>) => Promise.all(tasks.map((t) => t())), sendEmail: jest.fn().mockResolvedValue(true) }));
jest.mock('@/lib/finance/reconcile/liveOrder', () => ({
    recordUnreportedReversal: jest.fn().mockResolvedValue(undefined),
    recordUnreportedReversalOnProcess: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('@/lib/membership/boardAlerts', () => ({ notifyBoardPaidReject: jest.fn().mockResolvedValue(undefined), notifyBoardPaymentException: jest.fn().mockResolvedValue(undefined) }));

const TAG = 'person-based-bg-review-test';
let seq = 0;
let restoreBoardSettings: () => Promise<void> = async () => {};
let revA: number, revB: number, revC: number, board: number;

async function staff(label: string, role: 'isBackgroundCheckReviewer' | 'isBoardMember') {
    const household = await prisma.household.create({ data: { name: `${TAG} ${label} HH` } });
    const p = await prisma.person.create({ data: { name: label, email: `${label}-${TAG}@example.com`, householdId: household.id, [role]: true } });
    return p.id;
}

/** A household with two leads and one other adult, a membership, and an application at `status`. */
async function family(status: OrgMembershipProcessStatus = 'PENDING_EXTERNAL_ACTION', opts: { consent?: boolean; signed?: boolean; paid?: boolean; kind?: 'INITIAL' | 'RENEWAL'; leadCheck?: Date | null; membership?: 'NONE' | 'ACTIVE' } = {}) {
    const n = seq++;
    const household = await prisma.household.create({ data: { name: `${TAG} family ${n}` } });
    const lead = await prisma.person.create({ data: { name: `Lead ${n}`, email: `lead-${n}-${TAG}@example.com`, householdId: household.id, isHouseholdLead: true, lastBackgroundCheck: opts.leadCheck ?? null } });
    const lead2 = await prisma.person.create({ data: { name: `Lead2 ${n}`, email: `lead2-${n}-${TAG}@example.com`, householdId: household.id, isHouseholdLead: true } });
    const adult = await prisma.person.create({ data: { name: `Adult ${n}`, email: `adult-${n}-${TAG}@example.com`, householdId: household.id } });
    const membership = await prisma.orgMembership.create({ data: { householdId: household.id, status: opts.membership ?? 'NONE' } });
    const app = await prisma.orgMembershipProcess.create({
        data: {
            orgMembershipId: membership.id,
            kind: opts.kind ?? 'INITIAL',
            status,
            contractSignedAt: opts.signed === false ? null : new Date(),
            bgConsentAt: opts.consent ? new Date() : null,
            paidAt: opts.paid ? new Date() : null,
        },
    });
    return { householdId: household.id, leadId: lead.id, lead2Id: lead2.id, adultId: adult.id, orgMembershipId: membership.id, appId: app.id };
}

/** A check review of `personId`, as the sweep or the Board's submit opens one. */
async function ownReview(personId: number, status: OrgMembershipProcessStatus = 'PENDING_BG_REVIEW') {
    return (await prisma.orgMembershipProcess.create({ data: { kind: 'PERSON_BG', subjectPersonId: personId, status, bgConsentAt: new Date() } })).id;
}

const row = (id: number) => prisma.orgMembershipProcess.findUniqueOrThrow({ where: { id } });
const requested = (householdId: number) => prisma.orgMembershipProcess.findMany({ where: { kind: 'PERSON_BG', requestedForHouseholdId: householdId }, orderBy: { id: 'asc' } });
const audits = (id: number) => prisma.auditLog.findMany({ where: { tableName: 'OrgMembershipProcess', affectedEntityId: id }, orderBy: { id: 'asc' } });
const standingOf = async (householdId: number, personId: number) =>
    (await householdCheckStandings(prisma, householdId, null)).members.find((m) => m.personId === personId)?.standing;

/** Consent on the family's application, returning the review it opened. */
async function consent(f: Awaited<ReturnType<typeof family>>) {
    await markBgConsent(f.appId, f.leadId);
    const [review] = await requested(f.householdId);
    return review.id;
}

async function wipe() {
    const households = await prisma.household.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
    const ids = households.map((h) => h.id);
    const people = await prisma.person.findMany({ where: { email: { contains: TAG } }, select: { id: true } });
    const personIds = people.map((p) => p.id);
    const processes = await prisma.orgMembershipProcess.findMany({ where: { OR: [{ orgMembership: { householdId: { in: ids } } }, { subjectPersonId: { in: personIds } }, { requestedForHouseholdId: { in: ids } }] }, select: { id: true } });
    const processIds = processes.map((p) => p.id);
    const memberships = await prisma.orgMembership.findMany({ where: { householdId: { in: ids } }, select: { id: true } });
    await prisma.backgroundCheckAttestation.deleteMany({ where: { processId: { in: processIds } } });
    await prisma.auditLog.deleteMany({ where: { OR: [{ tableName: 'OrgMembershipProcess', affectedEntityId: { in: processIds } }, { tableName: 'OrgMembership', affectedEntityId: { in: memberships.map((m) => m.id) } }, { actorId: { in: personIds } }] } });
    await prisma.paymentException.deleteMany({ where: { processId: { in: processIds } } });
    await prisma.orgMembershipProcess.deleteMany({ where: { id: { in: processIds } } });
    await prisma.orgMembership.deleteMany({ where: { householdId: { in: ids } } });
    await prisma.person.deleteMany({ where: { id: { in: personIds } } });
    await prisma.household.deleteMany({ where: { id: { in: ids } } });
}

beforeAll(async () => {
    restoreBoardSettings = await snapshotBoardSettings();
    const data = { bgRecheckMonths: 29, orgMembershipYearBoundary: new Date(Date.now() + 30 * 86400_000) };
    await prisma.boardSettings.upsert({ where: { id: 1 }, create: { id: 1, ...data }, update: data });
    await wipe();
    revA = await staff('RevA', 'isBackgroundCheckReviewer');
    revB = await staff('RevB', 'isBackgroundCheckReviewer');
    revC = await staff('RevC', 'isBackgroundCheckReviewer');
    board = await staff('Board', 'isBoardMember');
});

afterAll(async () => {
    await wipe();
    await restoreBoardSettings();
    await prisma.$disconnect();
});

beforeEach(() => jest.mocked(notifyBoardPaidReject).mockClear());

describe('consent opens a check review with no person', () => {
    it('opens one review requested for the household, and a second consent reuses it', async () => {
        const f = await family();
        const reviewId = await consent(f);
        await markBgConsent(f.appId, f.lead2Id);
        const reviews = await requested(f.householdId);
        expect(reviews).toHaveLength(1);
        expect(reviews[0]).toMatchObject({ id: reviewId, subjectPersonId: null, status: 'PENDING_BG_REVIEW', requestedForHouseholdId: f.householdId });
        expect(reviews[0].bgConsentAt).not.toBeNull();
        const app = await row(f.appId);
        expect(app.status).toBe('PENDING_PAYMENT');
        expect(app.bgConsentAt).not.toBeNull();
        expect(app.bgClearedAt).toBeNull();
    });

    it('lists the review for reviewers outside the household and never the household application', async () => {
        const f = await family();
        const reviewId = await consent(f);
        const queue = await eligibleReviewProcessIds(revA);
        expect(queue).toContain(reviewId);
        expect(queue).not.toContain(f.appId);
        await prisma.person.update({ where: { id: f.leadId }, data: { isBackgroundCheckReviewer: true } });
        expect(await eligibleReviewProcessIds(f.leadId)).not.toContain(reviewId);
    });

    it('refuses a decision on the household application itself', async () => {
        const f = await family('PENDING_PAYMENT', { consent: true });
        await expect(attest(revA, f.appId, { result: 'APPROVE', subjectPersonIds: [f.leadId] })).rejects.toMatchObject({ code: 'wrong_phase' });
    });
});

describe('the first decision names the person', () => {
    it('refuses an approval or a rejection that names nobody, or someone who is not a lead', async () => {
        const f = await family();
        const reviewId = await consent(f);
        await expect(attest(revA, reviewId, { result: 'APPROVE' })).rejects.toMatchObject({ code: 'invalid_subject' });
        await expect(attest(revA, reviewId, { result: 'REJECT', note: 'concerning' })).rejects.toMatchObject({ code: 'invalid_subject' });
        await expect(attest(revA, reviewId, { result: 'APPROVE', subjectPersonIds: [f.adultId] })).rejects.toMatchObject({ code: 'invalid_subject' });
        // A subject-less rejection is never recorded.
        expect(await prisma.backgroundCheckAttestation.count({ where: { processId: reviewId } })).toBe(0);
        expect((await row(reviewId)).subjectPersonId).toBeNull();
    });

    it('names the lead on the first approval, and the second approval clears that lead and the household', async () => {
        const f = await family();
        const reviewId = await consent(f);
        await attest(revA, reviewId, { result: 'APPROVE', subjectPersonIds: [f.leadId] });
        expect((await row(reviewId)).subjectPersonId).toBe(f.leadId);
        expect((await audits(reviewId)).some((a) => (a.newData as { action?: string } | null)?.action === 'subject named')).toBe(true);

        await expect(attest(revB, reviewId, { result: 'APPROVE', subjectPersonIds: [f.lead2Id] })).rejects.toMatchObject({ code: 'invalid_subject' });
        await attest(revB, reviewId, { result: 'APPROVE', subjectPersonIds: [f.leadId] });
        expect((await row(reviewId)).status).toBe('ACTIVE');
        expect((await prisma.person.findUniqueOrThrow({ where: { id: f.leadId } })).lastBackgroundCheck).not.toBeNull();
        expect((await prisma.person.findUniqueOrThrow({ where: { id: f.lead2Id } })).lastBackgroundCheck).toBeNull();
        const app = await row(f.appId);
        expect(app.status).toBe('PENDING_PAYMENT');
        expect(app.bgClearedAt).not.toBeNull();
    });

    it("names the lead on a first rejection, blocks the review and the household's application, and alerts on a paid one", async () => {
        const f = await family('PENDING_EXTERNAL_ACTION');
        const reviewId = await consent(f);
        await activate(f.appId, { via: 'manual', actorId: board });
        expect((await row(f.appId)).status).toBe('PENDING_BG_CLEARANCE');

        await attest(revA, reviewId, { result: 'REJECT', note: 'concerning', subjectPersonIds: [f.lead2Id] });
        const review = await row(reviewId);
        expect(review).toMatchObject({ status: 'BLOCKED', subjectPersonId: f.lead2Id });
        const rejection = await prisma.backgroundCheckAttestation.findFirstOrThrow({ where: { processId: reviewId } });
        expect(rejection).toMatchObject({ result: 'REJECT', subjectPersonId: f.lead2Id });
        expect((await row(f.appId)).status).toBe('BLOCKED');
        expect(notifyBoardPaidReject).toHaveBeenCalledWith(f.appId);
    });

    it("closes the named person's own empty review in favour of this one (PBR-11)", async () => {
        const f = await family();
        const own = await ownReview(f.leadId);
        const reviewId = await consent(f);
        await attest(revA, reviewId, { result: 'APPROVE', subjectPersonIds: [f.leadId] });
        expect((await row(own)).status).toBe('ARCHIVED');
        expect((await audits(own)).at(-1)?.newData).toMatchObject({ action: 'replaced by a check review', replacedByReviewId: reviewId });
    });

    it('refuses naming a person whose own review has a decision, is blocked, or was sent back (gap 2)', async () => {
        for (const prepare of ['decided', 'blocked', 'sentBack'] as const) {
            const f = await family();
            const reviewId = await consent(f);
            const own = await ownReview(f.leadId, prepare === 'blocked' ? 'BLOCKED' : 'PENDING_BG_REVIEW');
            if (prepare === 'decided') await attest(revC, own, { result: 'APPROVE' });
            if (prepare === 'sentBack') {
                await attest(revC, own, { result: 'REJECT', note: 'concerning' });
                await boardResetReview(own, board, { reason: 'recheck' });
            }
            await expect(attest(revA, reviewId, { result: 'APPROVE', subjectPersonIds: [f.leadId] })).rejects.toMatchObject({ code: 'invalid_subject' });
            expect((await row(own)).status).not.toBe('ARCHIVED');
            expect((await row(reviewId)).subjectPersonId).toBeNull();
        }
    });
});

describe("a lead's own review and the household's consent", () => {
    it("opens no unnamed review while the lead's own review is under way, and clears when that review does", async () => {
        const f = await family();
        const own = await ownReview(f.leadId);
        await attest(revC, own, { result: 'APPROVE' });
        await markBgConsent(f.appId, f.leadId);
        expect(await requested(f.householdId)).toHaveLength(0);
        expect((await row(f.appId)).status).toBe('PENDING_PAYMENT');

        await attest(revA, own, { result: 'APPROVE' });
        expect((await row(own)).status).toBe('ACTIVE');
        expect((await row(f.appId)).bgClearedAt).not.toBeNull();
    });

    it("closes an unnamed review once the lead's own review clears the household", async () => {
        const f = await family();
        const reviewId = await consent(f);
        const own = await ownReview(f.leadId);
        await attest(revC, own, { result: 'APPROVE' });
        await attest(revA, own, { result: 'APPROVE' });
        expect((await row(reviewId)).status).toBe('ARCHIVED');
        expect((await row(f.appId)).bgClearedAt).not.toBeNull();
    });

    it('refuses closing an unnamed review that still carries a rejection a wrong-person reset left', async () => {
        const f = await family();
        const reviewId = await consent(f);
        await attest(revA, reviewId, { result: 'REJECT', note: 'concerning', subjectPersonIds: [f.leadId] });
        await boardResetReview(reviewId, board, { reason: 'the other parent', wrongPerson: true });
        await expect(archiveApplication(reviewId, board)).rejects.toMatchObject({ code: 'wrong_phase' });
        expect((await row(reviewId)).status).toBe('PENDING_BG_REVIEW');
    });
});

describe('ruling D: the Volunteer Family tick', () => {
    it('writes Volunteer Family on the requested household at once, on a rejection too, audited, never stored on the review', async () => {
        const f = await family();
        const reviewId = await consent(f);
        await attest(revA, reviewId, { result: 'REJECT', note: 'concerning', isMarkedVolunteerFamily: true, subjectPersonIds: [f.leadId] });
        expect((await prisma.orgMembership.findUniqueOrThrow({ where: { id: f.orgMembershipId } })).isVolunteerFamily).toBe(true);
        const audit = await prisma.auditLog.findFirstOrThrow({ where: { tableName: 'OrgMembership', affectedEntityId: f.orgMembershipId } });
        expect(audit).toMatchObject({ actorId: revA, newData: expect.objectContaining({ isVolunteerFamily: true }) });
        expect((await prisma.backgroundCheckAttestation.findFirstOrThrow({ where: { processId: reviewId } })).isMarkedVolunteerFamily).toBe(false);
    });

    it('refuses the tick on a review no household asked for', async () => {
        const f = await family();
        const own = await ownReview(f.adultId);
        await expect(attest(revA, own, { result: 'APPROVE', isMarkedVolunteerFamily: true })).rejects.toMatchObject({ code: 'invalid_input' });
        expect(await prisma.backgroundCheckAttestation.count({ where: { processId: own } })).toBe(0);
    });
});

describe('rulings A and B: who stays disputed', () => {
    it('A: a rejection changed to approve stays disputed through an undo until two new approvals', async () => {
        const f = await family();
        const reviewId = await consent(f);
        await attest(revA, reviewId, { result: 'REJECT', note: 'concerning', subjectPersonIds: [f.leadId] });
        await attest(revA, reviewId, { result: 'APPROVE' });
        expect((await row(reviewId)).status).toBe('PENDING_BG_REVIEW');
        expect(await standingOf(f.householdId, f.leadId)).toBe('DISPUTED');
        const app = await row(f.appId);
        expect(app.status).toBe('PENDING_PAYMENT');
        expect(app.bgClearedAt).toBeNull();

        await undoOwnApproval(revA, reviewId, 'second thoughts');
        expect(await standingOf(f.householdId, f.leadId)).toBe('DISPUTED');
        await attest(revB, reviewId, { result: 'APPROVE' });
        await attest(revC, reviewId, { result: 'APPROVE' });
        expect((await row(reviewId)).status).toBe('ACTIVE');
        expect((await row(f.appId)).bgClearedAt).not.toBeNull();
    });

    it('B: a Board reset of a rejection disputes; a reset of a review in progress is a plain start-over', async () => {
        const f = await family();
        const reviewId = await consent(f);
        await attest(revA, reviewId, { result: 'REJECT', note: 'concerning', subjectPersonIds: [f.leadId] });
        await boardResetReview(reviewId, board, { reason: 'recheck' });
        expect((await row(reviewId)).subjectPersonId).toBe(f.leadId);
        expect(await standingOf(f.householdId, f.leadId)).toBe('DISPUTED');

        const g = await family();
        const other = await consent(g);
        await attest(revA, other, { result: 'APPROVE', subjectPersonIds: [g.leadId] });
        await boardResetReview(other, board, { reason: 'misclick' });
        expect((await row(other)).subjectPersonId).toBe(g.leadId);
        expect(await standingOf(g.householdId, g.leadId)).toBe('PENDING');
    });
});

describe('gap 1: only the wrong-person reset clears the person', () => {
    it('clears the subject with an audit row carrying the reason and subjectPersonId: null', async () => {
        const f = await family();
        const reviewId = await consent(f);
        await attest(revA, reviewId, { result: 'APPROVE', subjectPersonIds: [f.leadId] });
        await boardResetReview(reviewId, board, { reason: 'report is the other parent', wrongPerson: true });
        expect((await row(reviewId)).subjectPersonId).toBeNull();
        expect((await audits(reviewId)).at(-1)).toMatchObject({
            oldData: expect.objectContaining({ subjectPersonId: f.leadId }),
            newData: expect.objectContaining({ action: 'board reset', reason: 'report is the other parent', subjectPersonId: null }),
        });
        await attest(revB, reviewId, { result: 'APPROVE', subjectPersonIds: [f.lead2Id] });
        expect((await row(reviewId)).subjectPersonId).toBe(f.lead2Id);
    });

    it('refuses the wrong-person reset on a review no household asked for', async () => {
        const f = await family();
        const own = await ownReview(f.adultId);
        await expect(boardResetReview(own, board, { reason: 'x', wrongPerson: true })).rejects.toMatchObject({ code: 'invalid_input' });
        expect((await row(own)).subjectPersonId).toBe(f.adultId);
    });

    it('keeps the earlier rejection when the cleared person is named again, and starts fresh for someone else (#3201 note)', async () => {
        const f = await family();
        const reviewId = await consent(f);
        await attest(revA, reviewId, { result: 'REJECT', note: 'concerning', subjectPersonIds: [f.leadId] });
        await boardResetReview(reviewId, board, { reason: 'maybe the wrong report', wrongPerson: true });
        await attest(revB, reviewId, { result: 'APPROVE', subjectPersonIds: [f.leadId] });
        expect(await standingOf(f.householdId, f.leadId)).toBe('DISPUTED');

        const g = await family();
        const other = await consent(g);
        await attest(revA, other, { result: 'REJECT', note: 'concerning', subjectPersonIds: [g.leadId] });
        await boardResetReview(other, board, { reason: 'the other parent', wrongPerson: true });
        await attest(revB, other, { result: 'APPROVE', subjectPersonIds: [g.lead2Id] });
        expect(await standingOf(g.householdId, g.lead2Id)).toBe('PENDING');
    });
});

describe('gap 2: a sent-back review is never closed', () => {
    it('refuses closing a review whose rejection was sent back', async () => {
        const f = await family();
        const own = await ownReview(f.adultId);
        await attest(revA, own, { result: 'REJECT', note: 'concerning' });
        await boardResetReview(own, board, { reason: 'recheck' });
        await expect(archiveApplication(own, board)).rejects.toMatchObject({ code: 'wrong_phase' });
        expect((await row(own)).status).toBe('PENDING_BG_REVIEW');
    });
});

describe('gap 3: activation re-reads every adult under its lock', () => {
    it('records a payment arriving after a rejection but does not activate it', async () => {
        const f = await family('PENDING_PAYMENT', { consent: true });
        await prisma.orgMembershipProcess.update({ where: { id: f.appId }, data: { bgClearedAt: new Date() } });
        await ownReview(f.adultId, 'BLOCKED'); // rejected, not yet settled onto the application

        await activate(f.appId, { via: 'manual', actorId: board });
        const app = await row(f.appId);
        expect(app.paidAt).not.toBeNull();
        expect(app.bgClearedAt).toBeNull();
        expect(app.status).toBe('BLOCKED');
        expect((await prisma.orgMembership.findUniqueOrThrow({ where: { id: f.orgMembershipId } })).status).toBe('NONE');
    });
});

describe('gap 4: blocking from the early steps and resuming where it was', () => {
    it.each(['INTAKE', 'PENDING_RENEWAL', 'PENDING_EXTERNAL_ACTION'] as const)('blocks an application at %s and resumes it there', async (status) => {
        const f = await family(status, { kind: status === 'PENDING_RENEWAL' ? 'RENEWAL' : 'INITIAL', membership: status === 'PENDING_RENEWAL' ? 'ACTIVE' : 'NONE', signed: false });
        const own = await ownReview(f.adultId);
        await attest(revA, own, { result: 'REJECT', note: 'concerning' });
        expect((await row(f.appId)).status).toBe('BLOCKED');
        await boardResetReview(own, board, { reason: 'recheck' });
        expect((await row(f.appId)).status).toBe(status);
    });

    it('resumes a payment-step application with no consent at the external step, never at payment', async () => {
        const f = await family('PENDING_PAYMENT', { consent: false });
        const own = await ownReview(f.adultId);
        await attest(revA, own, { result: 'REJECT', note: 'concerning' });
        await boardResetReview(own, board, { reason: 'recheck' });
        expect((await row(f.appId)).status).toBe('PENDING_EXTERNAL_ACTION');
    });

    it('settles on reopen: a reopened application with a rejected adult is blocked', async () => {
        const f = await family('PENDING_PAYMENT', { consent: true });
        await archiveApplication(f.appId, board);
        await ownReview(f.adultId, 'BLOCKED');
        await unarchiveApplication(f.appId, board);
        expect((await row(f.appId)).status).toBe('BLOCKED');
    });
});

describe('gap 5: the opener counts only reviews that still serve the household', () => {
    it("opens a new review when the household's review named someone who has since left", async () => {
        const f = await family();
        const reviewId = await consent(f);
        await attest(revA, reviewId, { result: 'APPROVE', subjectPersonIds: [f.leadId] });
        const elsewhere = await prisma.household.create({ data: { name: `${TAG} moved ${seq++}` } });
        await prisma.person.update({ where: { id: f.leadId }, data: { householdId: elsewhere.id } });
        expect(await settleHouseholdBg(f.householdId)).toContain('opened');
        const reviews = await requested(f.householdId);
        expect(reviews).toHaveLength(2);
        expect(reviews[1].subjectPersonId).toBeNull();
    });
});

describe('gap 6: the Board self-reset bar covers the requested household', () => {
    it("refuses a Board member resetting a review their own household asked for", async () => {
        const f = await family();
        const reviewId = await consent(f);
        await prisma.person.update({ where: { id: f.lead2Id }, data: { isBoardMember: true } });
        await expect(boardResetReview(reviewId, f.lead2Id, { reason: 'x' })).rejects.toMatchObject({ code: 'same_household_applicant' });
    });
});

describe('gap 8: household rows blocked before cutover', () => {
    it('still resets a household row blocked by a household attestation, and refuses one a check review blocked', async () => {
        const f = await family('PENDING_PAYMENT', { consent: true });
        await prisma.backgroundCheckAttestation.create({ data: { processId: f.appId, reviewerId: revA, result: 'REJECT', note: 'legacy' } });
        await prisma.orgMembershipProcess.update({ where: { id: f.appId }, data: { status: 'BLOCKED' } });
        await prisma.auditLog.create({ data: { actorId: revA, action: 'EDIT', tableName: 'OrgMembershipProcess', affectedEntityId: f.appId, oldData: { status: 'PENDING_PAYMENT' }, newData: { status: 'BLOCKED', reason: 'reviewer reject' } } });
        await boardResetReview(f.appId, board, { reason: 'legacy cleanup' });
        expect((await row(f.appId)).status).toBe('PENDING_PAYMENT');
        expect(await prisma.backgroundCheckAttestation.count({ where: { processId: f.appId } })).toBe(0);

        const g = await family('PENDING_PAYMENT', { consent: true });
        const own = await ownReview(g.adultId);
        await attest(revA, own, { result: 'REJECT', note: 'concerning' });
        expect((await row(g.appId)).status).toBe('BLOCKED');
        await expect(boardResetReview(g.appId, board, { reason: 'x' })).rejects.toMatchObject({ code: 'wrong_phase' });
        expect((await row(g.appId)).status).toBe('BLOCKED');
    });

    it('refuses resetting a household application that is still waiting', async () => {
        const f = await family('PENDING_PAYMENT', { consent: true });
        await expect(boardResetReview(f.appId, board, { reason: 'x' })).rejects.toMatchObject({ code: 'wrong_phase' });
    });
});

describe('an outcome settles both households', () => {
    it("blocks the subject's new household and reopens a review for the one that asked", async () => {
        const f = await family();
        const reviewId = await consent(f);
        await attest(revA, reviewId, { result: 'APPROVE', subjectPersonIds: [f.leadId] });
        const g = await family('PENDING_PAYMENT', { consent: true });
        await prisma.person.update({ where: { id: f.leadId }, data: { householdId: g.householdId } });

        await expect(attest(revB, reviewId, { result: 'REJECT', note: 'concerning' })).resolves.toMatchObject({ status: 'BLOCKED' });
        expect((await row(g.appId)).status).toBe('BLOCKED');
        expect((await row(f.appId)).status).not.toBe('BLOCKED');
        expect((await requested(f.householdId)).filter((r) => r.subjectPersonId === null)).toHaveLength(1);
    });
});

describe('cutover: the daily settle opens a review for an application already waiting', () => {
    it('opens one for an application with consent and no review, leaving its old attestations as history', async () => {
        const f = await family('PENDING_PAYMENT', { consent: true });
        await prisma.backgroundCheckAttestation.create({ data: { processId: f.appId, reviewerId: revA, result: 'APPROVE', subjectPersonId: f.leadId } });
        const result = await settleApplicationsAwaitingCheck();
        expect(result.opened).toBeGreaterThanOrEqual(1);
        expect(await requested(f.householdId)).toHaveLength(1);
        expect(await prisma.backgroundCheckAttestation.count({ where: { processId: f.appId } })).toBe(1);
        expect((await row(f.appId)).bgClearedAt).toBeNull();
        expect((await settleApplicationsAwaitingCheck()).opened).toBe(0);
    });
});
