/**
 * @jest-environment node
 */
/**
 * When a trusted-adult approval ends. A first approval runs a year from the family's submission;
 * a renewal a year from the later of the previous end and its own submission; an approved change
 * keeps the end of the approval it changes while that approval runs. An approval that would
 * already have lapsed is refused.
 */

import {
    createTrustedAdult,
    decideReview,
    renewTrustedAdult,
    resetReview,
    resubmitWithChanges,
    revokeReview,
    withdrawTrustedAdult,
} from '@/lib/trusted-adult/service';
import prisma from '@/lib/prisma';

jest.mock('@/lib/email', () => ({
    sendEmail: jest.fn().mockResolvedValue(true),
    runPaced: (tasks: Array<() => Promise<unknown>>) => Promise.all(tasks.map((t) => t())),
}));

const TAG = 'trustedadult-approval-dates-test';
const SHARED = 'Grandma may pick up the kids.';
const DAY_MS = 86400000;

function plusYear(d: Date): Date {
    const out = new Date(d);
    out.setUTCDate(out.getUTCDate() + 365);
    return out;
}

describe('trusted-adult approval dates', () => {
    let householdId = 0;
    let leadId = 0;
    let boardId = 0;

    async function wipe() {
        const hhs = await prisma.household.findMany({ where: { name: { contains: TAG } }, select: { id: true } });
        const ids = hhs.map((h) => h.id);
        if (ids.length) {
            await prisma.trustedAdultReview.deleteMany({ where: { householdId: { in: ids } } });
            await prisma.trustedAdult.deleteMany({ where: { householdId: { in: ids } } });
            await prisma.person.deleteMany({ where: { householdId: { in: ids } } });
            await prisma.household.deleteMany({ where: { id: { in: ids } } });
        }
    }

    beforeAll(async () => {
        await wipe();
        householdId = (await prisma.household.create({ data: { name: `Family HH ${TAG}` } })).id;
        leadId = (await prisma.person.create({
            data: { name: 'Lead', email: `lead-${TAG}@ex.com`, householdId, isHouseholdLead: true },
        })).id;
        const boardHh = await prisma.household.create({ data: { name: `Board HH ${TAG}` } });
        boardId = (await prisma.person.create({
            data: { name: 'Boardie', email: `board-${TAG}@ex.com`, isBoardMember: true, householdId: boardHh.id },
        })).id;
    });

    afterAll(async () => {
        await wipe();
        await prisma.$disconnect();
    });

    beforeEach(async () => {
        await prisma.trustedAdultReview.deleteMany({ where: { householdId } });
        await prisma.trustedAdult.deleteMany({ where: { householdId } });
    });

    const submittedDaysAgo = (reviewId: number, days: number) =>
        prisma.trustedAdultReview.update({ where: { id: reviewId }, data: { createdAt: new Date(Date.now() - days * DAY_MS) } });

    const approve = async (reviewId: number) => {
        await decideReview(reviewId, boardId, { decision: 'APPROVE', sharedNote: SHARED });
        return prisma.trustedAdultReview.findUniqueOrThrow({ where: { id: reviewId } });
    };

    const disclose = () =>
        createTrustedAdult({
            householdId,
            trustedAdultName: 'Jane External',
            trustedAdultEmail: 'jane@example.com',
            familyContext: 'Our nanny; may collect the kids.',
            disclosedById: leadId,
        });

    const expectLapsedRefusal = async (reviewId: number) => {
        await expect(decideReview(reviewId, boardId, { decision: 'APPROVE', sharedNote: SHARED })).rejects.toMatchObject({
            code: 'wrong_phase',
            message: expect.stringContaining('already have lapsed'),
        });
        expect(await prisma.trustedAdultReview.findUniqueOrThrow({ where: { id: reviewId } })).toMatchObject({
            status: 'PENDING_BOARD_REVIEW',
            reviewBy: null,
        });
    };

    async function discloseApprovedDaysAgo(days: number) {
        const ta = await disclose();
        const submitted = await submittedDaysAgo(ta.reviews[0].id, days);
        const approved = await approve(ta.reviews[0].id);
        return { taId: ta.id, submitted, approved };
    }

    it('a first approval lasts a year from the family submission, not from the decision', async () => {
        const { submitted, approved } = await discloseApprovedDaysAgo(20);

        expect(approved.reviewBy).toEqual(plusYear(submitted.createdAt));
    });

    it('refuses a renewal before the expiry warning window opens', async () => {
        const { taId } = await discloseApprovedDaysAgo(20);

        await expect(renewTrustedAdult(taId, leadId)).rejects.toMatchObject({
            code: 'wrong_phase',
            message: expect.stringContaining('You can renew it from 30 days before then'),
        });
        expect(await prisma.trustedAdultReview.count({ where: { trustedAdultId: taId } })).toBe(1);
    });

    it('a renewal inside the warning window adds a year to the previous end', async () => {
        const { taId, approved: first } = await discloseApprovedDaysAgo(340);
        const renewal = await renewTrustedAdult(taId, leadId);

        const renewed = await approve(renewal.id);

        expect(renewed.reviewBy).toEqual(plusYear(first.reviewBy!));
    });

    it('a renewal after the previous approval lapsed runs a year from its own submission', async () => {
        const { taId, approved: first } = await discloseApprovedDaysAgo(100);
        await prisma.trustedAdultReview.update({ where: { id: first.id }, data: { status: 'EXPIRED', reviewBy: new Date(Date.now() - 10 * DAY_MS) } });
        const renewal = await submittedDaysAgo((await renewTrustedAdult(taId, leadId)).id, 2);

        const renewed = await approve(renewal.id);

        expect(renewed.reviewBy).toEqual(plusYear(renewal.createdAt));
    });

    it('an approved change keeps the end of the approval it changes', async () => {
        const { taId, approved: first } = await discloseApprovedDaysAgo(100);
        const change = await resubmitWithChanges(taId, leadId, {
            trustedAdultName: 'Jane External',
            trustedAdultEmail: 'jane.new@example.com',
            familyContext: 'Our nanny; may collect the kids.',
        });

        const changed = await approve(change.id);

        expect(changed.reviewBy).toEqual(first.reviewBy);
    });

    it('a change submitted after the approval lapsed runs a year from its own submission', async () => {
        const { taId, approved: first } = await discloseApprovedDaysAgo(100);
        await prisma.trustedAdultReview.update({ where: { id: first.id }, data: { status: 'EXPIRED', reviewBy: new Date(Date.now() - 10 * DAY_MS) } });
        const change = await submittedDaysAgo((await resubmitWithChanges(taId, leadId, {
            trustedAdultName: 'Jane External',
            trustedAdultEmail: 'jane.new@example.com',
            familyContext: 'Our nanny; may collect the kids.',
        })).id, 2);

        const changed = await approve(change.id);

        expect(changed.reviewBy).toEqual(plusYear(change.createdAt));
    });

    it('refuses to approve a first review submitted more than a year ago', async () => {
        const ta = await disclose();
        await submittedDaysAgo(ta.reviews[0].id, 400);

        await expectLapsedRefusal(ta.reviews[0].id);
    });

    it('refuses to re-approve, after a reset, a denial submitted more than a year ago', async () => {
        const ta = await disclose();
        await submittedDaysAgo(ta.reviews[0].id, 400);
        await decideReview(ta.reviews[0].id, boardId, { decision: 'DENY' });
        await resetReview(ta.reviews[0].id, boardId, 'Denied by mistake.');

        await expectLapsedRefusal(ta.reviews[0].id);
    });

    it('refuses a change submitted while the approval ran but decided after it lapsed', async () => {
        const { taId, approved: first } = await discloseApprovedDaysAgo(100);
        const change = await resubmitWithChanges(taId, leadId, {
            trustedAdultName: 'Jane External',
            trustedAdultEmail: 'jane.new@example.com',
            familyContext: 'Our nanny; may collect the kids.',
        });
        await submittedDaysAgo(change.id, 10);
        await prisma.trustedAdultReview.update({ where: { id: first.id }, data: { reviewBy: new Date(Date.now() - 5 * DAY_MS) } });

        await expectLapsedRefusal(change.id);
    });

    it('a revoked approval gives a later renewal nothing to build on', async () => {
        const { taId } = await discloseApprovedDaysAgo(100);
        await withdrawTrustedAdult(taId, leadId);
        const renewal = await submittedDaysAgo((await renewTrustedAdult(taId, leadId)).id, 2);

        const renewed = await approve(renewal.id);

        expect(renewed.reviewBy).toEqual(plusYear(renewal.createdAt));
    });

    const approveChange = async (taId: number) =>
        approve((await resubmitWithChanges(taId, leadId, {
            trustedAdultName: 'Jane External',
            trustedAdultEmail: 'jane.new@example.com',
            familyContext: 'Our nanny; may collect the kids.',
        })).id);

    it('a board revoke also ends a retired approval, so a later renewal has nothing to build on', async () => {
        const { taId } = await discloseApprovedDaysAgo(30);
        const changed = await approveChange(taId);
        await revokeReview(changed.id, boardId);
        const renewal = await submittedDaysAgo((await renewTrustedAdult(taId, leadId)).id, 2);

        const renewed = await approve(renewal.id);

        expect(renewed.reviewBy).toEqual(plusYear(renewal.createdAt));
    });

    it('Deny & Revoke also ends a retired approval, so a later renewal has nothing to build on', async () => {
        const { taId } = await discloseApprovedDaysAgo(30);
        await approveChange(taId);
        const second = await resubmitWithChanges(taId, leadId, { trustedAdultName: 'x', trustedAdultEmail: 'x@y.com', familyContext: 'x' });
        await decideReview(second.id, boardId, { decision: 'DENY', revokePriorApprovals: true });
        const renewal = await submittedDaysAgo((await renewTrustedAdult(taId, leadId)).id, 2);

        const renewed = await approve(renewal.id);

        expect(renewed.reviewBy).toEqual(plusYear(renewal.createdAt));
    });
});
