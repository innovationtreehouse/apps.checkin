/**
 * @jest-environment node
 */
/**
 * Concurrency test for attest(): two reviewers attesting the same check review at
 * the same time must serialize on the FOR UPDATE lock so the review clears exactly
 * once (no double clearance / double background-date stamp). Guards the
 * check-then-act window in lib/membership/review.ts.
 */

import { attest, ReviewError } from '@/lib/membership/review';
import { normalizeAuditData } from '@/lib/auditPayload';
import prisma from '@/lib/prisma';

jest.mock('@/lib/email', () => ({
    sendEmail: jest.fn().mockResolvedValue(true),
    runPaced: (tasks: Array<() => Promise<unknown>>) => Promise.all(tasks.map((t) => t())),
}));

const TAG = 'review-concurrency-test';

/** A background-check reviewer in their own (distinct) household. */
async function makeReviewer(label: string): Promise<number> {
    const r = await prisma.person.create({
        data: {
            email: `${label}-${TAG}@example.com`,
            name: label,
            isBackgroundCheckReviewer: true,
            household: { create: { name: `${label} HH ${TAG}` } },
        },
    });
    return r.id;
}

/** A fresh applicant household and a check review of its lead, awaiting review. */
async function makePendingProcess(): Promise<{ processId: number; leadId: number }> {
    const hh = await prisma.household.create({ data: { name: `Applicant ${TAG}` } });
    const lead = await prisma.person.create({ data: { name: `Applicant Lead ${TAG}`, householdId: hh.id, isHouseholdLead: true } });
    const proc = await prisma.orgMembershipProcess.create({
        data: { kind: 'PERSON_BG', subjectPersonId: lead.id, requestedForHouseholdId: hh.id, status: 'PENDING_BG_REVIEW', bgConsentAt: new Date() },
    });
    return { processId: proc.id, leadId: lead.id };
}

async function wipe() {
    const hhs = await prisma.household.findMany({
        where: { OR: [{ name: { contains: TAG } }, { householdMembers: { some: { email: { contains: TAG } } } }] },
        select: { id: true },
    });
    const ids = hhs.map((h) => h.id);
    if (ids.length) {
        const processes = { OR: [{ orgMembership: { householdId: { in: ids } } }, { requestedForHouseholdId: { in: ids } }] };
        await prisma.backgroundCheckAttestation.deleteMany({ where: { process: processes } });
        await prisma.orgMembershipProcess.deleteMany({ where: processes });
        await prisma.orgMembership.deleteMany({ where: { householdId: { in: ids } } });
        await prisma.person.deleteMany({ where: { householdId: { in: ids } } });
        await prisma.household.deleteMany({ where: { id: { in: ids } } });
    }
    await prisma.person.deleteMany({ where: { email: { contains: TAG } } });
}

describe('attest() concurrency', () => {
    let revA: number, revB: number, revC: number;

    beforeAll(async () => {
        await wipe();
        revA = await makeReviewer('RevA');
        revB = await makeReviewer('RevB');
        revC = await makeReviewer('RevC');
    });

    afterAll(async () => {
        await wipe();
        await prisma.$disconnect();
    });

    it('two concurrent APPROVEs clear the review exactly once', async () => {
        const { processId, leadId } = await makePendingProcess();

        // One approval already on record; two more reviewers attest concurrently.
        // Without the lock, both could read 1 prior APPROVE and both clear (double
        // background-date stamp). The FOR UPDATE lock serializes them so the loser
        // re-reads a cleared review and bails with wrong_phase.
        await attest(revA, processId, { result: 'APPROVE', subjectPersonIds: [leadId] });

        const [b, c] = await Promise.allSettled([
            attest(revB, processId, { result: 'APPROVE', subjectPersonIds: [leadId] }),
            attest(revC, processId, { result: 'APPROVE', subjectPersonIds: [leadId] }),
        ]);

        const statuses = [b, c].map((r) => (r.status === 'fulfilled' ? (r.value as { status: string }).status : (r.reason as ReviewError).code));
        expect(statuses.filter((s) => s === 'ACTIVE')).toHaveLength(1);
        expect(statuses.filter((s) => s === 'wrong_phase')).toHaveLength(1);

        // The winner is whichever attest returned ACTIVE — its id is what the clearance audit must carry.
        const winner = b.status === 'fulfilled' && (b.value as { status: string }).status === 'ACTIVE' ? revB : revC;

        const proc = await prisma.orgMembershipProcess.findUnique({ where: { id: processId } });
        expect(proc?.status).toBe('ACTIVE');

        // The loser created no attestation (it threw before the create): 2 total, not 3.
        const attestations = await prisma.backgroundCheckAttestation.count({ where: { processId } });
        expect(attestations).toBe(2);

        // The clearance ran exactly once → exactly one ACTIVE audit row, stamped with the winner's id.
        const audits = await prisma.auditLog.findMany({ where: { tableName: 'OrgMembershipProcess', affectedEntityId: processId }, select: { newData: true, actorId: true } });
        const advances = audits.filter((a) => JSON.stringify(normalizeAuditData(a.newData)).includes('"status":"ACTIVE"'));
        expect(advances).toHaveLength(1);
        expect(advances[0].actorId).toBe(winner); // not revA (prior approver) nor the loser
    });

    it('a REJECT audit carries the rejecting reviewer\'s id, not another reviewer\'s', async () => {
        const { processId } = await makePendingProcess();
        // revB rejects; revA never touches this process.
        await attest(revB, processId, { result: 'REJECT' });

        const blocked = await prisma.auditLog.findFirst({ where: { tableName: 'OrgMembershipProcess', affectedEntityId: processId }, orderBy: { id: 'desc' } });
        expect(JSON.stringify(normalizeAuditData(blocked?.newData))).toContain('"status":"BLOCKED"');
        expect(blocked?.actorId).toBe(revB);
        expect(blocked?.actorId).not.toBe(revA);
    });
});
