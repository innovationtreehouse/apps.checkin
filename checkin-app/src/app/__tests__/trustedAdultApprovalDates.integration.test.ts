/**
 * @jest-environment node
 */
/**
 * When a trusted-adult approval ends. A first approval runs a year from the family's submission;
 * a renewal a year from the later of the previous end and its own submission; an approved change
 * keeps the end of the approval it changes while that approval runs.
 */

import {
    createTrustedAdult,
    decideReview,
    renewTrustedAdult,
    resubmitWithChanges,
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

    async function discloseApprovedDaysAgo(days: number) {
        const ta = await createTrustedAdult({
            householdId,
            trustedAdultName: 'Jane External',
            trustedAdultEmail: 'jane@example.com',
            familyContext: 'Our nanny; may collect the kids.',
            disclosedById: leadId,
        });
        const submitted = await submittedDaysAgo(ta.reviews[0].id, days);
        const approved = await approve(ta.reviews[0].id);
        return { taId: ta.id, submitted, approved };
    }

    it('a first approval lasts a year from the family submission, not from the decision', async () => {
        const { submitted, approved } = await discloseApprovedDaysAgo(20);

        expect(approved.reviewBy).toEqual(plusYear(submitted.createdAt));
    });

    it('an early renewal adds a year to the previous end', async () => {
        const { taId, approved: first } = await discloseApprovedDaysAgo(300);
        const renewal = await renewTrustedAdult(taId, leadId);

        const renewed = await approve(renewal.id);

        expect(renewed.reviewBy).toEqual(plusYear(first.reviewBy!));
    });

    it('a renewal after the previous approval lapsed runs a year from its own submission', async () => {
        const { taId, approved: first } = await discloseApprovedDaysAgo(400);
        await prisma.trustedAdultReview.update({ where: { id: first.id }, data: { status: 'EXPIRED' } });
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
        const { taId, approved: first } = await discloseApprovedDaysAgo(400);
        await prisma.trustedAdultReview.update({ where: { id: first.id }, data: { status: 'EXPIRED' } });
        const change = await submittedDaysAgo((await resubmitWithChanges(taId, leadId, {
            trustedAdultName: 'Jane External',
            trustedAdultEmail: 'jane.new@example.com',
            familyContext: 'Our nanny; may collect the kids.',
        })).id, 2);

        const changed = await approve(change.id);

        expect(changed.reviewBy).toEqual(plusYear(change.createdAt));
    });

    it('a revoked approval gives a later renewal nothing to build on', async () => {
        const { taId } = await discloseApprovedDaysAgo(100);
        await withdrawTrustedAdult(taId, leadId);
        const renewal = await submittedDaysAgo((await renewTrustedAdult(taId, leadId)).id, 2);

        const renewed = await approve(renewal.id);

        expect(renewed.reviewBy).toEqual(plusYear(renewal.createdAt));
    });
});
