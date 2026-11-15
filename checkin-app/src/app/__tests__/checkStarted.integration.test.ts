/**
 * @jest-environment node
 */
/**
 * "Check started" on the person, against a real database
 * (docs/rules/membership.md, Background checks for individual adults):
 *   - the advance to payment passes on a lead's check started or a review the
 *     household asked for still waiting to be named, never on another adult's;
 *   - a lifted block resumes by the same derived input;
 *   - settle opens no review naming nobody for an application without the legacy flag;
 *   - a second lead marks their own check while the agreement is unsigned (renewal);
 *   - dismissCheckStarted: when it is allowed and refused, what it closes or clears,
 *     who may call it, and that it decides nothing.
 */
import type { OrgMembershipProcessStatus } from '@/generated/prisma/client';
import prisma from '@/lib/prisma';
import { markCheckStarted } from '@/lib/membership/checkStarted';
import { advanceExternalIfComplete } from '@/lib/membership/external';
import { attest, boardResetReview, dismissCheckStarted, undoOwnApproval } from '@/lib/membership/review';
import { settleHouseholdBg } from '@/lib/membership/settleHouseholdBg';
import { householdCheckStandings } from '@/lib/membership/checkStanding';
import { snapshotBoardSettings } from '@/test-helpers/boardSettings';

jest.mock('@/lib/email', () => ({ runPaced: (tasks: Array<() => Promise<unknown>>) => Promise.all(tasks.map((t) => t())), sendEmail: jest.fn().mockResolvedValue(true) }));
jest.mock('@/lib/finance/reconcile/liveOrder', () => ({
    recordUnreportedReversal: jest.fn().mockResolvedValue(undefined),
    recordUnreportedReversalOnProcess: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('@/lib/membership/boardAlerts', () => ({ notifyBoardPaidReject: jest.fn().mockResolvedValue(undefined), notifyBoardCheckRejected: jest.fn().mockResolvedValue(undefined), notifyBoardPaymentException: jest.fn().mockResolvedValue(undefined) }));

const TAG = 'check-started-integration-test';
let seq = 0;
let restoreBoardSettings: () => Promise<void> = async () => {};
let revA: number, revB: number, board: number, sysadmin: number;

async function staff(label: string, roles: Record<string, boolean>) {
    const household = await prisma.household.create({ data: { name: `${TAG} ${label} HH` } });
    return (await prisma.person.create({ data: { name: label, email: `${label}-${TAG}@example.com`, householdId: household.id, ...roles } })).id;
}

/** A household with two leads and an adult child, a membership, and an application at `status`. */
async function family(status: OrgMembershipProcessStatus = 'PENDING_EXTERNAL_ACTION', opts: { kind?: 'INITIAL' | 'RENEWAL'; signed?: boolean; membership?: 'NONE' | 'ACTIVE' } = {}) {
    const n = seq++;
    const household = await prisma.household.create({ data: { name: `${TAG} family ${n}` } });
    const person = (label: string, lead: boolean) =>
        prisma.person.create({ data: { name: `${label} ${n}`, email: `${label}-${n}-${TAG}@example.com`, householdId: household.id, isHouseholdLead: lead, isDeclaredAdult: true } });
    const lead = await person('lead', true);
    const lead2 = await person('lead2', true);
    const adult = await person('adult', false);
    const membership = await prisma.orgMembership.create({ data: { householdId: household.id, status: opts.membership ?? 'NONE' } });
    const app = await prisma.orgMembershipProcess.create({
        data: { orgMembershipId: membership.id, kind: opts.kind ?? 'INITIAL', status, contractSignedAt: opts.signed === false ? null : new Date() },
    });
    return { householdId: household.id, leadId: lead.id, lead2Id: lead2.id, adultId: adult.id, appId: app.id };
}

const row = (id: number) => prisma.orgMembershipProcess.findUniqueOrThrow({ where: { id } });
const reviewOf = (personId: number) => prisma.orgMembershipProcess.findFirstOrThrow({ where: { kind: 'PERSON_BG', subjectPersonId: personId }, orderBy: { id: 'desc' } });
const audits = (id: number) => prisma.auditLog.findMany({ where: { tableName: 'OrgMembershipProcess', affectedEntityId: id }, orderBy: { id: 'asc' } });

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
    revA = await staff('RevA', { isBackgroundCheckReviewer: true });
    revB = await staff('RevB', { isBackgroundCheckReviewer: true });
    board = await staff('Board', { isBoardMember: true });
    sysadmin = await staff('Sysadmin', { isSysadmin: true });
});

afterAll(async () => {
    await wipe();
    await restoreBoardSettings();
    await prisma.$disconnect();
});

describe('the advance gate reads the household from its people', () => {
    it("passes on a lead's check started, leaving the application's own flag unset", async () => {
        const f = await family();
        await markCheckStarted(f.leadId, f.leadId);
        const app = await row(f.appId);
        expect(app.status).toBe('PENDING_PAYMENT');
        expect(app.bgConsentAt).toBeNull();
    });

    it("does not pass on another adult's check started", async () => {
        const f = await family();
        await markCheckStarted(f.adultId, f.leadId);
        expect((await row(f.appId)).status).toBe('PENDING_EXTERNAL_ACTION');
        expect((await reviewOf(f.adultId)).bgConsentAt).not.toBeNull();
    });

    it('passes on a review the household asked for that still names nobody', async () => {
        const f = await family();
        await prisma.orgMembershipProcess.create({ data: { kind: 'PERSON_BG', status: 'PENDING_BG_REVIEW', requestedForHouseholdId: f.householdId, bgConsentAt: new Date() } });
        await advanceExternalIfComplete(f.appId);
        expect((await row(f.appId)).status).toBe('PENDING_PAYMENT');
    });

    it('the legacy household flag still passes', async () => {
        const f = await family();
        await prisma.orgMembershipProcess.update({ where: { id: f.appId }, data: { bgConsentAt: new Date() } });
        await advanceExternalIfComplete(f.appId);
        expect((await row(f.appId)).status).toBe('PENDING_PAYMENT');
    });
});

describe('settle', () => {
    it('opens no review naming nobody for an application without the legacy flag', async () => {
        const f = await family();
        await settleHouseholdBg(f.householdId);
        expect(await prisma.orgMembershipProcess.count({ where: { kind: 'PERSON_BG', requestedForHouseholdId: f.householdId } })).toBe(0);
    });

    it("a block lifted from payment resumes there while a lead's check is started, and at the agreement step once it is not", async () => {
        for (const started of [true, false]) {
            const f = await family();
            const leadReview = (await markCheckStarted(f.leadId, f.leadId)).processId!;
            expect((await row(f.appId)).status).toBe('PENDING_PAYMENT');
            if (!started) await dismissCheckStarted(leadReview, revB, 'opened by mistake');
            const adultReview = (await markCheckStarted(f.adultId, f.leadId)).processId!;
            await attest(revA, adultReview, { result: 'REJECT', note: 'concern' });
            expect((await row(f.appId)).status).toBe('BLOCKED');
            await boardResetReview(adultReview, board, { reason: 'recheck' });
            expect((await row(f.appId)).status).toBe(started ? 'PENDING_PAYMENT' : 'PENDING_EXTERNAL_ACTION');
        }
    });
});

describe('a second lead on a renewal', () => {
    it('marks their own check while the agreement is unsigned, and their review enters the queue', async () => {
        const f = await family('PENDING_EXTERNAL_ACTION', { kind: 'RENEWAL', signed: false, membership: 'ACTIVE' });
        await markCheckStarted(f.leadId, f.leadId);
        await markCheckStarted(f.lead2Id, f.lead2Id);
        const second = await reviewOf(f.lead2Id);
        expect(second).toMatchObject({ status: 'PENDING_BG_REVIEW', requestedForHouseholdId: f.householdId });
        expect(second.bgConsentAt).not.toBeNull();
        expect((await row(f.appId)).status).toBe('PENDING_EXTERNAL_ACTION');
    });
});

describe("the reviewer's Volunteer Family tick", () => {
    const isVolunteer = async (householdId: number) => (await prisma.orgMembership.findUniqueOrThrow({ where: { householdId } })).isVolunteerFamily;

    it("is written onto the household from a review of one of its leads", async () => {
        const f = await family();
        const reviewId = (await markCheckStarted(f.leadId, f.leadId)).processId!;
        await attest(revA, reviewId, { result: 'APPROVE', isMarkedVolunteerFamily: true });
        expect(await isVolunteer(f.householdId)).toBe(true);
    });

    it("is refused on a review of another adult in the household, writing nothing", async () => {
        const f = await family();
        const reviewId = (await markCheckStarted(f.adultId, f.leadId)).processId!;
        await expect(attest(revA, reviewId, { result: 'APPROVE', isMarkedVolunteerFamily: true })).rejects.toMatchObject({ code: 'invalid_input' });
        expect(await isVolunteer(f.householdId)).toBe(false);
        expect(await prisma.backgroundCheckAttestation.count({ where: { processId: reviewId } })).toBe(0);
    });
});

describe('dismissCheckStarted', () => {
    async function markedReview() {
        const f = await family();
        const reviewId = (await markCheckStarted(f.adultId, f.leadId)).processId!;
        return { f, reviewId };
    }

    it('closes a review the mark created, with one audit row, deciding nothing', async () => {
        const { f, reviewId } = await markedReview();
        await dismissCheckStarted(reviewId, revA, 'never took the check');
        const review = await row(reviewId);
        expect(review).toMatchObject({ status: 'ARCHIVED', archivedFromStatus: 'PENDING_BG_REVIEW' });
        const rows = await audits(reviewId);
        expect(rows).toHaveLength(2);
        expect(rows[1]).toMatchObject({ actorId: revA, newData: expect.objectContaining({ checkStarted: false, action: 'dismissed: opened by mistake', reason: 'never took the check' }) });
        expect(await prisma.backgroundCheckAttestation.count({ where: { processId: reviewId } })).toBe(0);
        const standing = (await householdCheckStandings(prisma, f.householdId, null)).members.find((m) => m.personId === f.adultId)?.standing;
        expect(standing).toBe('NONE');
        expect((await row(f.appId)).status).toBe('PENDING_EXTERNAL_ACTION');
    });

    it('only clears the flag on a review that existed before the mark, so the owed check stays open', async () => {
        const f = await family();
        const owed = await prisma.orgMembershipProcess.create({ data: { kind: 'PERSON_BG', status: 'PENDING_BG_REVIEW', subjectPersonId: f.adultId } });
        await prisma.auditLog.create({ data: { actorId: 0, action: 'CREATE', tableName: 'OrgMembershipProcess', affectedEntityId: owed.id, newData: { kind: 'PERSON_BG', subjectPersonId: f.adultId } } });
        await markCheckStarted(f.adultId, f.leadId);
        await dismissCheckStarted(owed.id, board, 'wrong person marked');
        expect(await row(owed.id)).toMatchObject({ status: 'PENDING_BG_REVIEW', bgConsentAt: null });
    });

    it('leaves an application already moved on to payment where it is', async () => {
        const f = await family();
        const reviewId = (await markCheckStarted(f.leadId, f.leadId)).processId!;
        expect((await row(f.appId)).status).toBe('PENDING_PAYMENT');
        await dismissCheckStarted(reviewId, revA, 'opened by mistake');
        expect((await row(f.appId)).status).toBe('PENDING_PAYMENT');
        expect((await row(f.appId)).bgClearedAt).toBeNull();
    });

    it('is allowed after a Board reset of approvals, after an undone approval, and after a wrong-person reset of a review never rejected', async () => {
        const reset = await markedReview();
        await attest(revA, reset.reviewId, { result: 'APPROVE' });
        await boardResetReview(reset.reviewId, board, { reason: 'start over' });
        await expect(dismissCheckStarted(reset.reviewId, revB, 'never took it')).resolves.toBeUndefined();

        const undone = await markedReview();
        await attest(revA, undone.reviewId, { result: 'APPROVE' });
        await undoOwnApproval(revA, undone.reviewId, 'misclick');
        await expect(dismissCheckStarted(undone.reviewId, revB, 'never took it')).resolves.toBeUndefined();

        const wrong = await markedReview();
        await boardResetReview(wrong.reviewId, board, { reason: 'similar names', wrongPerson: true });
        await dismissCheckStarted(wrong.reviewId, revB, 'never took it');
        expect((await row(wrong.reviewId)).status).toBe('ARCHIVED');
    });

    it('is refused with a live attestation, on a blocked or cleared review, and on one sent back', async () => {
        const approved = await markedReview();
        await attest(revA, approved.reviewId, { result: 'APPROVE' });
        await expect(dismissCheckStarted(approved.reviewId, revB, 'x')).rejects.toMatchObject({ code: 'wrong_phase' });

        const blocked = await markedReview();
        await attest(revA, blocked.reviewId, { result: 'REJECT', note: 'concern' });
        await expect(dismissCheckStarted(blocked.reviewId, revB, 'x')).rejects.toMatchObject({ code: 'wrong_phase' });

        await boardResetReview(blocked.reviewId, board, { reason: 'recheck' });
        await expect(dismissCheckStarted(blocked.reviewId, revB, 'x')).rejects.toMatchObject({ code: 'wrong_phase' });

        const switched = await markedReview();
        await attest(revA, switched.reviewId, { result: 'REJECT', note: 'concern' });
        await attest(revA, switched.reviewId, { result: 'APPROVE' });
        await undoOwnApproval(revA, switched.reviewId, 'again');
        await expect(dismissCheckStarted(switched.reviewId, revB, 'x')).rejects.toMatchObject({ code: 'wrong_phase' });

        const cleared = await markedReview();
        await attest(revA, cleared.reviewId, { result: 'APPROVE' });
        await attest(revB, cleared.reviewId, { result: 'APPROVE' });
        await expect(dismissCheckStarted(cleared.reviewId, board, 'x')).rejects.toMatchObject({ code: 'wrong_phase' });
    });

    it('is refused on an unnamed review holding a rejection', async () => {
        const rejected = await markedReview();
        await attest(revA, rejected.reviewId, { result: 'REJECT', note: 'concern' });
        await boardResetReview(rejected.reviewId, board, { reason: 'the other one', wrongPerson: true });
        await expect(dismissCheckStarted(rejected.reviewId, revB, 'x')).rejects.toMatchObject({ code: 'wrong_phase' });
    });

    it('needs a reason, and only a reviewer or a Board member outside the household', async () => {
        const { f, reviewId } = await markedReview();
        await expect(dismissCheckStarted(reviewId, revA, '  ')).rejects.toMatchObject({ code: 'invalid_input' });
        await expect(dismissCheckStarted(reviewId, sysadmin, 'x')).rejects.toMatchObject({ code: 'not_reviewer' });
        await expect(dismissCheckStarted(reviewId, f.leadId, 'x')).rejects.toMatchObject({ code: 'not_reviewer' });
        await prisma.person.update({ where: { id: f.lead2Id }, data: { isBackgroundCheckReviewer: true } });
        await expect(dismissCheckStarted(reviewId, f.lead2Id, 'x')).rejects.toMatchObject({ code: 'same_household_applicant' });
        expect((await row(reviewId)).status).toBe('PENDING_BG_REVIEW');
    });

    it('racing a first decision, exactly one lands', async () => {
        const { reviewId } = await markedReview();
        const [decision, dismissal] = await Promise.allSettled([
            attest(revA, reviewId, { result: 'APPROVE' }),
            dismissCheckStarted(reviewId, revB, 'race'),
        ]);
        expect([decision.status, dismissal.status].filter((s) => s === 'fulfilled')).toHaveLength(1);
    });
});
