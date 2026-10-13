/**
 * @jest-environment node
 */
/**
 * A refused self-grant on the review path leaves a SelfGrantRefusal audit row
 * behind, including when the refusal is raised inside a transaction that rolls back.
 */

import { attest, clearBackgroundCheck, overrideBlocked, reviewTransaction, SelfGrantRefusedError } from '@/lib/membership/review';
import { awaitingBgReview } from '@/lib/membership/lifecycle';
import { SELF_GRANT_REFUSAL_TABLE } from '@/lib/membership/selfGrantGuard';
import prisma from '@/lib/prisma';

jest.mock('@/lib/email', () => ({
    sendEmail: jest.fn().mockResolvedValue(true),
    runPaced: (tasks: Array<() => Promise<unknown>>) => Promise.all(tasks.map((t) => t())),
}));

const TAG = 'self-grant-refusal-audit-test';

async function wipe() {
    const hhs = await prisma.household.findMany({ where: { name: { contains: TAG } }, select: { id: true } });
    const ids = hhs.map((h) => h.id);
    if (!ids.length) return;
    const people = await prisma.person.findMany({ where: { householdId: { in: ids } }, select: { id: true } });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: people.map((p) => p.id) } } });
    await prisma.backgroundCheckAttestation.deleteMany({ where: { process: { orgMembership: { householdId: { in: ids } } } } });
    await prisma.orgMembershipProcess.deleteMany({ where: { orgMembership: { householdId: { in: ids } } } });
    await prisma.orgMembership.deleteMany({ where: { householdId: { in: ids } } });
    await prisma.person.deleteMany({ where: { householdId: { in: ids } } });
    await prisma.household.deleteMany({ where: { id: { in: ids } } });
}

/** A household whose lead is also a reviewer, with a process at `status`. */
async function makeOwnHouseholdReview(status: 'PENDING_BG_REVIEW' | 'BLOCKED') {
    const hh = await prisma.household.create({ data: { name: `Applicant ${TAG}` } });
    const lead = await prisma.person.create({ data: { name: `Lead ${TAG}`, householdId: hh.id, isHouseholdLead: true, isBackgroundCheckReviewer: true } });
    const m = await prisma.orgMembership.create({ data: { householdId: hh.id, status: 'NONE' } });
    const proc = await prisma.orgMembershipProcess.create({ data: { orgMembershipId: m.id, kind: 'INITIAL', status } });
    return { processId: proc.id, leadId: lead.id };
}

const refusalRows = (actorId: number) => prisma.auditLog.findMany({ where: { actorId, tableName: SELF_GRANT_REFUSAL_TABLE } });

describe('self-grant refusal audit rows', () => {
    beforeEach(wipe);
    afterAll(async () => {
        await wipe();
        await prisma.$disconnect();
    });

    it('keeps the row when clearance refuses inside its transaction', async () => {
        const { processId, leadId } = await makeOwnHouseholdReview('PENDING_BG_REVIEW');

        await expect(reviewTransaction((tx) => clearBackgroundCheck(tx, processId, leadId, awaitingBgReview))).rejects.toBeInstanceOf(SelfGrantRefusedError);

        expect(await refusalRows(leadId)).toHaveLength(1);
        expect((await prisma.orgMembershipProcess.findUniqueOrThrow({ where: { id: processId } })).bgClearedAt).toBeNull();
    });

    it('records a refused attestation on the reviewer\'s own household', async () => {
        const { processId, leadId } = await makeOwnHouseholdReview('PENDING_BG_REVIEW');

        await expect(attest(leadId, processId, { result: 'APPROVE', subjectPersonIds: [leadId] })).rejects.toMatchObject({ code: 'same_household_applicant' });

        expect(await refusalRows(leadId)).toHaveLength(1);
        expect(await prisma.backgroundCheckAttestation.count({ where: { processId } })).toBe(0);
    });

    it('records a refused board override on the actor\'s own household', async () => {
        const { processId, leadId } = await makeOwnHouseholdReview('BLOCKED');

        await expect(overrideBlocked(processId, leadId, 'reset')).rejects.toMatchObject({ code: 'same_household_applicant' });

        expect(await refusalRows(leadId)).toHaveLength(1);
    });
});
