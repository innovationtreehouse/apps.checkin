/**
 * @jest-environment node
 */
/**
 * undoOwnApproval(): a reviewer withdraws their own APPROVE while the review
 * waits on its second reviewer. Covers each refusal, the happy path and its
 * audit row, the route's input checks, and the race against a concurrent second
 * approval (the shared FOR UPDATE lock lets exactly one win).
 */

import { attest, undoOwnApproval, ReviewError } from '@/lib/membership/review';
import { POST as UNDO_POST } from '@/app/api/membership/reviews/undo/route';
import { auditJson } from '@/test-helpers/expectAuditRow';
import prisma from '@/lib/prisma';
import { getServerSession } from 'next-auth/next';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));
jest.mock('@/lib/email', () => ({
    sendEmail: jest.fn().mockResolvedValue(true),
    runPaced: (tasks: Array<() => Promise<unknown>>) => Promise.all(tasks.map((t) => t())),
}));

const TAG = 'review-undo-test';

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

/** An applicant household with two leads, and the check review its consent opened, naming nobody yet. */
async function makePendingProcess(): Promise<{ processId: number; leadA: number; leadB: number }> {
    const hh = await prisma.household.create({ data: { name: `Applicant ${TAG}` } });
    const leadA = (await prisma.person.create({ data: { name: `Lead A ${TAG}`, householdId: hh.id, isHouseholdLead: true } })).id;
    const leadB = (await prisma.person.create({ data: { name: `Lead B ${TAG}`, householdId: hh.id, isHouseholdLead: true } })).id;
    await prisma.orgMembership.create({ data: { householdId: hh.id, status: 'NONE' } });
    const proc = await prisma.orgMembershipProcess.create({ data: { kind: 'PERSON_BG', requestedForHouseholdId: hh.id, status: 'PENDING_BG_REVIEW', bgConsentAt: new Date() } });
    return { processId: proc.id, leadA, leadB };
}

async function wipe() {
    const hhs = await prisma.household.findMany({
        where: { OR: [{ name: { contains: TAG } }, { householdMembers: { some: { email: { contains: TAG } } } }] },
        select: { id: true },
    });
    const ids = hhs.map((h) => h.id);
    const people = await prisma.person.findMany({ where: { OR: [{ householdId: { in: ids } }, { email: { contains: TAG } }] }, select: { id: true } });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: people.map((p) => p.id) } } });
    if (ids.length) {
        const processes = { OR: [{ orgMembership: { householdId: { in: ids } } }, { requestedForHouseholdId: { in: ids } }] };
        await prisma.backgroundCheckAttestation.deleteMany({ where: { process: processes } });
        await prisma.auditLog.deleteMany({ where: { tableName: 'OrgMembershipProcess', affectedEntityId: { in: (await prisma.orgMembershipProcess.findMany({ where: processes, select: { id: true } })).map((p) => p.id) } } });
        await prisma.orgMembershipProcess.deleteMany({ where: processes });
        await prisma.orgMembership.deleteMany({ where: { householdId: { in: ids } } });
        await prisma.person.deleteMany({ where: { householdId: { in: ids } } });
        await prisma.household.deleteMany({ where: { id: { in: ids } } });
    }
    await prisma.person.deleteMany({ where: { email: { contains: TAG } } });
}

async function codeOf(p: Promise<unknown>): Promise<string> {
    try {
        await p;
        return 'ok';
    } catch (e) {
        if (e instanceof ReviewError) return e.code;
        throw e;
    }
}

describe('undoOwnApproval()', () => {
    let revA: number, revB: number;

    beforeAll(async () => {
        await wipe();
        revA = await makeReviewer('RevA');
        revB = await makeReviewer('RevB');
    });

    afterAll(async () => {
        await wipe();
        await prisma.$disconnect();
    });

    it('withdraws the approval, keeps the person it named, and audits the old row', async () => {
        const { processId, leadA, leadB } = await makePendingProcess();
        await attest(revA, processId, { result: 'APPROVE', subjectPersonIds: [leadA], note: 'read Lead A' });
        const before = await prisma.backgroundCheckAttestation.findFirstOrThrow({ where: { processId, reviewerId: revA } });

        await undoOwnApproval(revA, processId, 'read the wrong report');

        expect(await prisma.backgroundCheckAttestation.count({ where: { processId } })).toBe(0);
        const proc = await prisma.orgMembershipProcess.findUniqueOrThrow({ where: { id: processId } });
        expect(proc.status).toBe('PENDING_BG_REVIEW');
        expect(proc.bgClearedAt).toBeNull();
        expect(proc.subjectPersonId).toBe(leadA);

        const audit = await prisma.auditLog.findFirstOrThrow({ where: { tableName: 'BackgroundCheckAttestation', affectedEntityId: before.id, action: 'DELETE' } });
        expect(audit.actorId).toBe(revA);
        expect(audit.secondaryAffectedEntity).toBe(processId);
        expect(auditJson(audit.oldData)).toMatchObject({ processId, reviewerId: revA, subjectPersonId: leadA, result: 'APPROVE', note: 'read Lead A' });
        expect(auditJson(audit.newData)).toEqual({ reason: 'read the wrong report', action: 'reviewer undo' });

        // Only the Board's wrong-person reset clears the person: the next approval may not name another lead.
        expect(await codeOf(attest(revB, processId, { result: 'APPROVE', subjectPersonIds: [leadB] }))).toBe('invalid_subject');
        await attest(revB, processId, { result: 'APPROVE' });
    });

    it('refuses when the caller has no attestation on the process', async () => {
        const { processId, leadA } = await makePendingProcess();
        await attest(revB, processId, { result: 'APPROVE', subjectPersonIds: [leadA] });
        expect(await codeOf(undoOwnApproval(revA, processId, 'not mine'))).toBe('not_undoable');
        expect(await prisma.backgroundCheckAttestation.count({ where: { processId } })).toBe(1);
    });

    it('refuses to undo a REJECT', async () => {
        const { processId, leadA } = await makePendingProcess();
        await attest(revA, processId, { result: 'REJECT', note: 'concerning', subjectPersonIds: [leadA] });
        await expect(undoOwnApproval(revA, processId, 'changed my mind')).rejects.toThrow('A rejection cannot be undone');
        expect((await prisma.orgMembershipProcess.findUniqueOrThrow({ where: { id: processId } })).status).toBe('BLOCKED');
    });

    it('refuses once the second approval has cleared the check', async () => {
        const { processId, leadA } = await makePendingProcess();
        await attest(revA, processId, { result: 'APPROVE', subjectPersonIds: [leadA] });
        await attest(revB, processId, { result: 'APPROVE' });
        await expect(undoOwnApproval(revA, processId, 'too late')).rejects.toThrow('already cleared');
        expect(await prisma.backgroundCheckAttestation.count({ where: { processId } })).toBe(2);
    });

    it('refuses when the process is not in review', async () => {
        const { processId, leadA } = await makePendingProcess();
        await attest(revA, processId, { result: 'APPROVE', subjectPersonIds: [leadA] });
        await prisma.orgMembershipProcess.update({ where: { id: processId }, data: { status: 'BLOCKED' } });
        expect(await codeOf(undoOwnApproval(revA, processId, 'out of phase'))).toBe('wrong_phase');
        expect(await prisma.backgroundCheckAttestation.count({ where: { processId } })).toBe(1);
    });

    it('races a concurrent second approval cleanly — one wins', async () => {
        const { processId, leadA } = await makePendingProcess();
        await attest(revA, processId, { result: 'APPROVE', subjectPersonIds: [leadA] });

        const [undo, second] = await Promise.all([
            codeOf(undoOwnApproval(revA, processId, 'race')),
            codeOf(attest(revB, processId, { result: 'APPROVE' })),
        ]);
        expect(second).toBe('ok');

        const proc = await prisma.orgMembershipProcess.findUniqueOrThrow({ where: { id: processId } });
        const reviewers = (await prisma.backgroundCheckAttestation.findMany({ where: { processId } })).map((a) => a.reviewerId).sort();
        if (undo === 'ok') {
            // Undo first: B's approval is now the only one, and nothing cleared.
            expect(reviewers).toEqual([revB]);
            expect(proc.bgClearedAt).toBeNull();
        } else {
            // Second approval first: the check cleared and the undo was refused.
            expect(undo).toBe('not_undoable');
            expect(reviewers).toEqual([revA, revB].sort());
            expect(proc.bgClearedAt).not.toBeNull();
        }
    });

    describe('POST /api/membership/reviews/undo', () => {
        const post = (body: unknown) => UNDO_POST(new Request('http://localhost/api/membership/reviews/undo', { method: 'POST', body: JSON.stringify(body) }) as never);

        it('400s without a reason and leaves the approval', async () => {
            const { processId, leadA } = await makePendingProcess();
            await attest(revA, processId, { result: 'APPROVE', subjectPersonIds: [leadA] });
            (getServerSession as jest.Mock).mockResolvedValue({ user: { id: revA, isBackgroundCheckReviewer: true } });
            expect((await post({ processId, reason: '   ' })).status).toBe(400);
            expect(await prisma.backgroundCheckAttestation.count({ where: { processId } })).toBe(1);
        });

        it('403s a caller who is not a reviewer', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({ user: { id: revA } });
            expect((await post({ processId: 1, reason: 'x' })).status).toBe(403);
        });

        it('undoes through the route and maps a refusal to 409', async () => {
            const { processId, leadA } = await makePendingProcess();
            await attest(revA, processId, { result: 'APPROVE', subjectPersonIds: [leadA] });
            (getServerSession as jest.Mock).mockResolvedValue({ user: { id: revA, isBackgroundCheckReviewer: true } });
            expect((await post({ processId, reason: 'wrong report' })).status).toBe(200);
            expect((await post({ processId, reason: 'again' })).status).toBe(409);
        });
    });
});
