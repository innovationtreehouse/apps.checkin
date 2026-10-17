/**
 * @jest-environment node
 */
/**
 * Concurrency test for the EXTERNAL-phase advance: markContractSigned and
 * markBgConsent both call advanceExternalIfComplete. Two concurrent callers (the
 * Zoho webhook signing the contract + a board "mark bg consent" action) must
 * advance the process to PENDING_BG_REVIEW exactly once — one audit row, one
 * reviewer notification — and must never regress a process already past
 * PENDING_EXTERNAL_ACTION. Regression guard for the TOCTOU race fixed in
 * lib/membership/external.ts.
 */

import { markContractSigned, markBgConsent, advanceExternalIfComplete } from '@/lib/membership/external';
import { normalizeAuditData } from '@/lib/auditPayload';
import { notifyReviewers } from '@/lib/membership/review';
import prisma from '@/lib/prisma';

jest.mock('@/lib/email', () => ({ runPaced: (tasks: Array<() => Promise<unknown>>) => Promise.all(tasks.map((t) => t())), sendEmail: jest.fn().mockResolvedValue(true) }));
// Bare stubs, deliberately NOT a requireActual spread: review.ts sits on an
// import cycle (review → payment → personBgTriggers → renewal → review), so an
// eager requireActual inside this factory re-enters review.ts mid-init and
// throws a TDZ ReferenceError. external.ts only needs these two symbols here;
// the real applyVolunteerStatus behavior is covered by membershipBgNonBlocking.
jest.mock('@/lib/membership/review', () => ({
    notifyReviewers: jest.fn().mockResolvedValue(undefined),
    applyVolunteerStatus: jest.fn().mockResolvedValue(undefined),
}));

const TAG = 'external-concurrency-test';

/** A fresh applicant household + membership + a process in the EXTERNAL phase. */
async function makeExternalProcess(data: Record<string, unknown> = {}): Promise<number> {
    const hh = await prisma.household.create({ data: { name: `Applicant ${TAG}` } });
    const m = await prisma.orgMembership.create({ data: { householdId: hh.id, status: 'NONE' } });
    const proc = await prisma.orgMembershipProcess.create({
        data: { orgMembershipId: m.id, kind: 'INITIAL', status: 'PENDING_EXTERNAL_ACTION', ...data },
    });
    return proc.id;
}

async function advanceAudits(processId: number): Promise<number> {
    const audits = await prisma.auditLog.findMany({ where: { tableName: 'OrgMembershipProcess', affectedEntityId: processId }, select: { newData: true } });
    return audits.filter((a) => JSON.stringify(normalizeAuditData(a.newData)).includes('"status":"PENDING_PAYMENT"')).length;
}

async function wipe() {
    const hhs = await prisma.household.findMany({ where: { name: { contains: TAG } }, select: { id: true } });
    const ids = hhs.map((h) => h.id);
    if (ids.length) {
        await prisma.orgMembershipProcess.deleteMany({ where: { orgMembership: { householdId: { in: ids } } } });
        await prisma.orgMembership.deleteMany({ where: { householdId: { in: ids } } });
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

    it('concurrent contract-sign + bg-consent advance exactly once', async () => {
        const processId = await makeExternalProcess();

        // Both external actions land at the same instant; each triggers an advance attempt.
        await Promise.all([
            markContractSigned(processId),
            markBgConsent(processId, 1),
        ]);

        const proc = await prisma.orgMembershipProcess.findUnique({ where: { id: processId } });
        expect(proc?.status).toBe('PENDING_PAYMENT');

        // Exactly one advance audit row + exactly one reviewer ping.
        expect(await advanceAudits(processId)).toBe(1);
        expect(notifyReviewers as jest.Mock).toHaveBeenCalledTimes(1);

        // Each mutation's audit row carries its own actor: SYSTEM_ACTOR for the contract sign
        // (default), the board member's id (1) for the bg-consent mark.
        const all = await prisma.auditLog.findMany({ where: { tableName: 'OrgMembershipProcess', affectedEntityId: processId }, select: { newData: true, actorId: true } });
        expect(all.find((a) => JSON.stringify(normalizeAuditData(a.newData)).includes('"contractSignedAt":true'))?.actorId).toBe(0);
        expect(all.find((a) => JSON.stringify(normalizeAuditData(a.newData)).includes('"bgConsentAt":true'))?.actorId).toBe(1);
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
