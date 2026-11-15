/**
 * @jest-environment node
 */
/**
 * Concurrency test for the EXTERNAL-phase advance: markContractSigned and
 * markCheckStarted both call advanceExternalIfComplete. Two concurrent callers (the
 * Zoho webhook signing the contract + a lead marking their check started) must
 * advance the process to PENDING_PAYMENT exactly once — one audit row, one
 * check review opened and one reviewer notification — and must never regress a process already past
 * PENDING_EXTERNAL_ACTION. Concurrent marks of one person open one review with one
 * audit row. Guards the check-then-act windows in lib/membership/external.ts and
 * lib/membership/checkStarted.ts.
 */

import { markContractSigned, advanceExternalIfComplete } from '@/lib/membership/external';
import { markCheckStarted } from '@/lib/membership/checkStarted';
import { normalizeAuditData } from '@/lib/auditPayload';
import { notifyReviewers } from '@/lib/membership/review';
import prisma from '@/lib/prisma';

jest.mock('@/lib/email', () => ({ runPaced: (tasks: Array<() => Promise<unknown>>) => Promise.all(tasks.map((t) => t())), sendEmail: jest.fn().mockResolvedValue(true) }));
// Bare stubs, deliberately NOT a requireActual spread: review.ts sits on an
// import cycle (review → payment → personBgTriggers → renewal → review), so an
// eager requireActual inside this factory re-enters review.ts mid-init and
// throws a TDZ ReferenceError. external.ts and checkStarted.ts only need these two symbols here;
// the real applyVolunteerFamilyStatus behavior is covered by membershipBgNonBlocking.
jest.mock('@/lib/membership/review', () => ({
    notifyReviewers: jest.fn().mockResolvedValue(undefined),
    applyVolunteerFamilyStatus: jest.fn().mockResolvedValue(undefined),
}));

const TAG = 'external-concurrency-test';

/** A fresh applicant household + membership + a process in the EXTERNAL phase. */
async function makeExternalProcess(data: Record<string, unknown> = {}): Promise<number> {
    return (await makeApplicant(data)).processId;
}

/** makeExternalProcess, plus the household's lead. */
async function makeApplicant(data: Record<string, unknown> = {}) {
    const hh = await prisma.household.create({ data: { name: `Applicant ${TAG}` } });
    const lead = await prisma.person.create({ data: { name: `Lead ${TAG}`, householdId: hh.id, isHouseholdLead: true, isDeclaredAdult: true } });
    const m = await prisma.orgMembership.create({ data: { householdId: hh.id, status: 'NONE' } });
    const proc = await prisma.orgMembershipProcess.create({
        data: { orgMembershipId: m.id, kind: 'INITIAL', status: 'PENDING_EXTERNAL_ACTION', ...data },
    });
    return { processId: proc.id, householdId: hh.id, leadId: lead.id };
}

async function advanceAudits(processId: number): Promise<number> {
    const audits = await prisma.auditLog.findMany({ where: { tableName: 'OrgMembershipProcess', affectedEntityId: processId }, select: { newData: true } });
    return audits.filter((a) => JSON.stringify(normalizeAuditData(a.newData)).includes('"status":"PENDING_PAYMENT"')).length;
}

async function wipe() {
    const hhs = await prisma.household.findMany({ where: { name: { contains: TAG } }, select: { id: true } });
    const ids = hhs.map((h) => h.id);
    if (ids.length) {
        await prisma.orgMembershipProcess.deleteMany({ where: { OR: [{ orgMembership: { householdId: { in: ids } } }, { requestedForHouseholdId: { in: ids } }] } });
        await prisma.orgMembership.deleteMany({ where: { householdId: { in: ids } } });
        await prisma.person.deleteMany({ where: { householdId: { in: ids } } });
        await prisma.household.deleteMany({ where: { id: { in: ids } } });
    }
}

describe('EXTERNAL advance concurrency', () => {
    beforeAll(wipe);
    beforeEach(() => (notifyReviewers as jest.Mock).mockClear());
    afterAll(async () => {
        await wipe();
        await prisma.$disconnect();
    });

    it("concurrent contract-sign + a lead's check started advance exactly once", async () => {
        const { processId, leadId } = await makeApplicant();

        // Both external actions land at the same instant; each triggers an advance attempt.
        await Promise.all([
            markContractSigned(processId),
            markCheckStarted(leadId, leadId),
        ]);

        const proc = await prisma.orgMembershipProcess.findUnique({ where: { id: processId } });
        expect(proc?.status).toBe('PENDING_PAYMENT');

        // Exactly one advance audit row, one check review opened for the household, and one reviewer ping.
        expect(await advanceAudits(processId)).toBe(1);
        const app = await prisma.orgMembershipProcess.findUniqueOrThrow({ where: { id: processId }, select: { orgMembership: { select: { householdId: true } } } });
        expect(await prisma.orgMembershipProcess.count({ where: { kind: 'PERSON_BG', requestedForHouseholdId: app.orgMembership!.householdId } })).toBe(1);
        expect(notifyReviewers as jest.Mock).toHaveBeenCalledTimes(1);

        // Each mutation's audit row carries its own actor: SYSTEM_ACTOR for the contract sign
        // (default), the lead for the check-started mark, which lands on the lead's own review.
        const all = await prisma.auditLog.findMany({ where: { tableName: 'OrgMembershipProcess', affectedEntityId: processId }, select: { newData: true, actorId: true } });
        expect(all.find((a) => JSON.stringify(normalizeAuditData(a.newData)).includes('"contractSignedAt":true'))?.actorId).toBe(0);
        const review = await prisma.orgMembershipProcess.findFirstOrThrow({ where: { kind: 'PERSON_BG', subjectPersonId: leadId } });
        const mark = await prisma.auditLog.findFirstOrThrow({ where: { tableName: 'OrgMembershipProcess', affectedEntityId: review.id, action: 'CREATE' } });
        expect(mark.actorId).toBe(leadId);
        expect(normalizeAuditData(mark.newData)).toMatchObject({ checkStarted: true, subjectPersonId: leadId, requestedForHouseholdId: app.orgMembership!.householdId });
        expect((await prisma.orgMembershipProcess.findUniqueOrThrow({ where: { id: processId } })).bgConsentAt).toBeNull();
    });

    it('concurrent marks of one person open one review, write one audit row and ping the reviewers once', async () => {
        const { leadId } = await makeApplicant();

        await Promise.all([markCheckStarted(leadId, leadId), markCheckStarted(leadId, leadId), markCheckStarted(leadId, leadId)]);

        const reviews = await prisma.orgMembershipProcess.findMany({ where: { kind: 'PERSON_BG', subjectPersonId: leadId } });
        expect(reviews).toHaveLength(1);
        expect(await prisma.auditLog.count({ where: { tableName: 'OrgMembershipProcess', affectedEntityId: reviews[0].id } })).toBe(1);
        expect(notifyReviewers as jest.Mock).toHaveBeenCalledTimes(1);
    });

    it('second markContractSigned is a no-op (one contractSignedAt audit, idempotent)', async () => {
        const processId = await makeExternalProcess();

        await Promise.all([markContractSigned(processId), markContractSigned(processId)]);

        const audits = await prisma.auditLog.findMany({ where: { tableName: 'OrgMembershipProcess', affectedEntityId: processId }, select: { newData: true, actorId: true } });
        const signed = audits.filter((a) => JSON.stringify(normalizeAuditData(a.newData)).includes('"contractSignedAt":true'));
        expect(signed).toHaveLength(1);
        expect(signed[0].actorId).toBe(0); // markContractSigned default actor = SYSTEM_ACTOR
    });

    it('does not regress a process already past PENDING_EXTERNAL_ACTION', async () => {
        // Both external actions are done, but the process has since moved to BLOCKED.
        const processId = await makeExternalProcess({
            contractSignedAt: new Date(),
            bgConsentAt: new Date(),
            status: 'BLOCKED',
        });

        const result = await advanceExternalIfComplete(processId);

        expect(result?.status).toBe('BLOCKED');
        const proc = await prisma.orgMembershipProcess.findUnique({ where: { id: processId } });
        expect(proc?.status).toBe('BLOCKED');
        expect(await advanceAudits(processId)).toBe(0);
        expect(notifyReviewers as jest.Mock).not.toHaveBeenCalled();
    });
});
