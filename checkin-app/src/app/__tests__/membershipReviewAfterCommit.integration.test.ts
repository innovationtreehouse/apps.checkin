/**
 * @jest-environment node
 */
/**
 * What a saved clearance owes after its transaction. An approval on a denied household
 * is refused before anything is saved; a failed new-member trigger, run when the
 * household's settle activates it, leaves the reviewer with a success, since the
 * clearance saved, and stays as a stuck item.
 */

import { attest } from '@/lib/membership/review';
import { openPersonBgForNewMember } from '@/lib/membership/personBgTriggers';
import prisma from '@/lib/prisma';
import { setBgRecheckPolicy } from '@/test-helpers/boardSettings';

jest.mock('@/lib/email', () => ({
    sendEmail: jest.fn().mockResolvedValue(true),
    runPaced: (tasks: Array<() => Promise<unknown>>) => Promise.all(tasks.map((t) => t())),
}));
jest.mock('@/lib/membership/boardAlerts', () => ({
    notifyBoardPaidReject: jest.fn(),
    notifyBoardCheckRejected: jest.fn(),
}));
jest.mock('@/lib/membership/personBgTriggers', () => ({ openPersonBgForNewMember: jest.fn() }));

const TAG = 'review-after-commit-test';

async function makeReviewer(label: string) {
    const p = await prisma.person.create({
        data: { email: `${label}-${TAG}@example.com`, name: label, isBackgroundCheckReviewer: true, household: { create: { name: `${label} HH ${TAG}` } } },
    });
    return p.id;
}

async function makeApplicant(data: { membership: 'NONE' | 'DENIED'; paid: boolean }) {
    const hh = await prisma.household.create({ data: { name: `Applicant ${TAG} ${Math.random()}` } });
    const lead = await prisma.person.create({ data: { email: `lead-${Math.random()}-${TAG}@example.com`, name: 'Lead', householdId: hh.id, isHouseholdLead: true } });
    const m = await prisma.orgMembership.create({ data: { householdId: hh.id, status: data.membership } });
    const now = new Date();
    const proc = await prisma.orgMembershipProcess.create({
        data: {
            orgMembershipId: m.id,
            kind: 'INITIAL',
            status: data.paid ? 'PENDING_BG_CLEARANCE' : 'PENDING_PAYMENT',
            contractSignedAt: now,
            bgConsentAt: now,
            paidAt: data.paid ? now : null,
        },
    });
    // The household's consent opened a check review; its first reviewer named the lead.
    const review = await prisma.orgMembershipProcess.create({
        data: { kind: 'PERSON_BG', subjectPersonId: lead.id, requestedForHouseholdId: hh.id, status: 'PENDING_BG_REVIEW', bgConsentAt: now },
    });
    return { processId: proc.id, reviewId: review.id, leadId: lead.id };
}

const deniedItems = (processId: number) => prisma.paymentException.count({ where: { kind: 'DENIED_HOUSEHOLD_ACTIVITY', processId } });

async function wipe() {
    const hhs = await prisma.household.findMany({ where: { name: { contains: TAG } }, select: { id: true } });
    const ids = hhs.map((h) => h.id);
    if (!ids.length) return;
    const procs = await prisma.orgMembershipProcess.findMany({ where: { OR: [{ orgMembership: { householdId: { in: ids } } }, { requestedForHouseholdId: { in: ids } }] }, select: { id: true } });
    const processIds = procs.map((p) => p.id);
    await prisma.paymentException.deleteMany({ where: { processId: { in: processIds } } });
    await prisma.auditLog.deleteMany({ where: { tableName: 'OrgMembershipProcess', affectedEntityId: { in: processIds } } });
    await prisma.backgroundCheckAttestation.deleteMany({ where: { processId: { in: processIds } } });
    await prisma.orgMembershipProcess.deleteMany({ where: { id: { in: processIds } } });
    await prisma.orgMembership.deleteMany({ where: { householdId: { in: ids } } });
    await prisma.person.deleteMany({ where: { householdId: { in: ids } } });
    await prisma.household.deleteMany({ where: { id: { in: ids } } });
}

describe('after a clearance commits', () => {
    let revA: number;
    let revB: number;
    let restorePolicy: () => Promise<void> = async () => {};

    beforeAll(async () => {
        restorePolicy = await setBgRecheckPolicy();
    });
    beforeEach(async () => {
        await wipe();
        jest.resetAllMocks();
        revA = await makeReviewer('rev-a');
        revB = await makeReviewer('rev-b');
    });
    afterAll(async () => {
        await wipe();
        await restorePolicy();
    });

    it('refuses an approval on a denied household, saving nothing and raising no item; a rejection still lands', async () => {
        const { reviewId } = await makeApplicant({ membership: 'DENIED', paid: false });

        await expect(attest(revA, reviewId, { result: 'APPROVE' })).rejects.toMatchObject({ code: 'wrong_phase' });
        expect(await prisma.backgroundCheckAttestation.count({ where: { processId: reviewId } })).toBe(0);
        expect(await deniedItems(reviewId)).toBe(0);

        await expect(attest(revB, reviewId, { result: 'REJECT' })).resolves.toMatchObject({ status: 'BLOCKED' });
        expect(await prisma.backgroundCheckAttestation.count({ where: { processId: reviewId, result: 'REJECT' } })).toBe(1);
    });

    it('reports success for a saved activation when a new-member trigger fails, and keeps the trigger stuck', async () => {
        const { processId, reviewId } = await makeApplicant({ membership: 'NONE', paid: true });
        (openPersonBgForNewMember as jest.Mock).mockRejectedValue(new Error('db down'));

        await attest(revA, reviewId, { result: 'APPROVE' });
        await expect(attest(revB, reviewId, { result: 'APPROVE' })).resolves.toMatchObject({ status: 'ACTIVE' });

        expect((await prisma.orgMembershipProcess.findUnique({ where: { id: processId } }))?.status).toBe('ACTIVE');
        expect(await prisma.clearanceStepFailure.findMany({ where: { processId }, select: { step: true, error: true } })).toEqual([{ step: 'PERSON_BG_TRIGGER', error: 'db down' }]);
    });
});
