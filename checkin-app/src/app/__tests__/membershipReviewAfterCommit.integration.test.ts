/**
 * @jest-environment node
 */
/**
 * What a saved clearance owes after its transaction. A denied household's board item
 * commits with the attestation, whatever happens to the email; a failed new-member
 * trigger leaves the reviewer with a success, since the clearance saved.
 */

import { attest, clearBackgroundCheck, reviewTransaction } from '@/lib/membership/review';
import { awaitingBgReview } from '@/lib/membership/lifecycle';
import { notifyBoardPaymentException } from '@/lib/membership/boardAlerts';
import { openPersonBgForNewMember } from '@/lib/membership/personBgTriggers';
import prisma from '@/lib/prisma';

jest.mock('@/lib/email', () => ({
    sendEmail: jest.fn().mockResolvedValue(true),
    runPaced: (tasks: Array<() => Promise<unknown>>) => Promise.all(tasks.map((t) => t())),
}));
jest.mock('@/lib/membership/boardAlerts', () => ({
    notifyBoardPaidReject: jest.fn(),
    notifyBoardPaymentException: jest.fn(),
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
    return { processId: proc.id, leadId: lead.id };
}

const deniedItems = (processId: number) => prisma.paymentException.count({ where: { kind: 'DENIED_HOUSEHOLD_ACTIVITY', processId } });

async function wipe() {
    const hhs = await prisma.household.findMany({ where: { name: { contains: TAG } }, select: { id: true } });
    const ids = hhs.map((h) => h.id);
    if (!ids.length) return;
    const procs = await prisma.orgMembershipProcess.findMany({ where: { orgMembership: { householdId: { in: ids } } }, select: { id: true } });
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

    beforeEach(async () => {
        await wipe();
        jest.resetAllMocks();
        revA = await makeReviewer('rev-a');
        revB = await makeReviewer('rev-b');
    });
    afterAll(wipe);

    it('keeps the denied item and the attestation when the board email fails', async () => {
        const { processId, leadId } = await makeApplicant({ membership: 'DENIED', paid: false });
        (notifyBoardPaymentException as jest.Mock).mockRejectedValue(new Error('mail down'));
        const logged = jest.spyOn(console, 'error').mockImplementation();

        await attest(revA, processId, { result: 'APPROVE', subjectPersonIds: [leadId] });
        await expect(attest(revB, processId, { result: 'APPROVE', subjectPersonIds: [leadId] })).resolves.toMatchObject({ status: 'PENDING_PAYMENT' });

        expect(logged).toHaveBeenCalledWith('clearance denied household email failed:', expect.anything(), expect.any(Error));
        logged.mockRestore();
        expect(await deniedItems(processId)).toBe(1);
        expect(await prisma.backgroundCheckAttestation.count({ where: { processId } })).toBe(2);
        expect(notifyBoardPaymentException).toHaveBeenCalledWith('DENIED_HOUSEHOLD_ACTIVITY', 'CRITICAL', expect.any(Number));
    });

    it('rolls the denied item back with its transaction', async () => {
        const { processId } = await makeApplicant({ membership: 'DENIED', paid: false });

        await expect(reviewTransaction(async (tx) => {
            await tx.$queryRaw`SELECT id FROM "OrgMembershipProcess" WHERE id = ${processId} FOR UPDATE`;
            await clearBackgroundCheck(tx, processId, revA, awaitingBgReview);
            throw new Error('later step failed');
        })).rejects.toThrow('later step failed');

        expect(await deniedItems(processId)).toBe(0);
    });

    it('reports success for a saved activation when a new-member trigger fails', async () => {
        const { processId, leadId } = await makeApplicant({ membership: 'NONE', paid: true });
        (openPersonBgForNewMember as jest.Mock).mockRejectedValue(new Error('db down'));
        const logged = jest.spyOn(console, 'error').mockImplementation();

        await attest(revA, processId, { result: 'APPROVE', subjectPersonIds: [leadId] });
        await expect(attest(revB, processId, { result: 'APPROVE', subjectPersonIds: [leadId] })).resolves.toMatchObject({ status: 'ACTIVE' });

        expect(logged).toHaveBeenCalledWith('clearance person background-check trigger failed:', expect.anything(), expect.any(Error));
        logged.mockRestore();
        expect((await prisma.orgMembershipProcess.findUnique({ where: { id: processId } }))?.status).toBe('ACTIVE');
    });
});
