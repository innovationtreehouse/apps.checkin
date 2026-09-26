/**
 * @jest-environment node
 */
/**
 * Integration tests for the PENDING_BG_REVIEW phase: 2-of-N attestation,
 * eligibility rules, sticky volunteer status, reject -> BLOCKED, board override.
 */

import { GET as REVIEW_QUEUE, POST as ATTEST } from '@/app/api/membership/reviews/route';
import { normalizeAuditData } from '@/lib/auditPayload';
import { POST as OVERRIDE } from '@/app/api/membership-ops/applications/review-override/route';
import prisma from '@/lib/prisma';
import { getServerSession } from 'next-auth/next';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));
// Don't hit Resend during tests — the reviewer ping is exercised, not actually sent.
jest.mock('@/lib/email', () => ({
    sendEmail: jest.fn().mockResolvedValue(true),
    runPaced: (tasks: Array<() => Promise<unknown>>) => Promise.all(tasks.map((t) => t())),
}));

const TAG = 'review-test';

function as(id: number, roles: { isBackgroundCheckReviewer?: boolean; isBoardMember?: boolean; isSysadmin?: boolean } = {}) {
    (getServerSession as jest.Mock).mockResolvedValue({ user: { id, isSysadmin: false, isBoardMember: false, isBackgroundCheckReviewer: false, ...roles } });
}
function req(body: unknown) {
    return new Request('http://localhost:4000/x', { method: 'POST', body: JSON.stringify(body) }) as unknown as Parameters<typeof ATTEST>[0];
}

describe('Membership BG review API', () => {
    let rev1: number, rev2: number, rev1b: number, revInApplicant: number, nonReviewer: number, board: number;
    let applicantHh: number;

    async function makeApplicantProcess(label: string, parentEmail?: string) {
        const hh = await prisma.household.create({ data: { name: `${label} ${TAG}` } });
        // A parent/guardian is a household lead.
        const parent = await prisma.person.create({ data: { name: `${label} Parent`, householdId: hh.id, ...(parentEmail ? { email: parentEmail } : {}) } });
        await prisma.person.update({ where: { id: parent.id }, data: { isHouseholdLead: true } });
        const m = await prisma.orgMembership.create({ data: { householdId: hh.id, status: 'NONE' } });
        const p = await prisma.orgMembershipProcess.create({ data: { orgMembershipId: m.id, kind: 'INITIAL', status: 'PENDING_BG_REVIEW' } });
        return { householdId: hh.id, orgMembershipId: m.id, processId: p.id, leadId: parent.id };
    }

    // Build a process in an arbitrary kind/status (for non-BLOCKED + renewal-branch tests).
    async function makeProcess(label: string, kind: 'INITIAL' | 'RENEWAL', status: 'PENDING_PAYMENT' | 'RENEWAL_PENDING_BG') {
        const hh = await prisma.household.create({ data: { name: `${label} ${TAG}` } });
        const parent = await prisma.person.create({ data: { name: `${label} Parent`, householdId: hh.id } });
        await prisma.person.update({ where: { id: parent.id }, data: { isHouseholdLead: true } });
        const m = await prisma.orgMembership.create({ data: { householdId: hh.id, status: 'NONE' } });
        const p = await prisma.orgMembershipProcess.create({ data: { orgMembershipId: m.id, kind, status } });
        return { householdId: hh.id, orgMembershipId: m.id, processId: p.id, leadId: parent.id };
    }

    async function wipe() {
        const hhs = await prisma.household.findMany({ where: { OR: [{ name: { contains: TAG } }, { householdMembers: { some: { email: { contains: TAG } } } }] }, select: { id: true } });
        const ids = hhs.map((h) => h.id);
        if (ids.length) {
            await prisma.backgroundCheckAttestation.deleteMany({ where: { process: { orgMembership: { householdId: { in: ids } } } } });
            await prisma.orgMembershipProcess.deleteMany({ where: { orgMembership: { householdId: { in: ids } } } });
            await prisma.orgMembership.deleteMany({ where: { householdId: { in: ids } } });
            await prisma.person.deleteMany({ where: { householdId: { in: ids } } });
            await prisma.household.deleteMany({ where: { id: { in: ids } } });
        }
        await prisma.volunteerDesignation.deleteMany({ where: { email: { contains: TAG } } });
        await prisma.person.deleteMany({ where: { email: { contains: TAG } } });
    }

    beforeAll(async () => {
        await wipe();
        const mk = async (slug: string, role: object, householdId?: number) => {
            const data = householdId
                ? { email: `${slug}-${TAG}@example.com`, name: slug, householdId, ...role }
                : { email: `${slug}-${TAG}@example.com`, name: slug, household: { create: { name: `${slug} HH ${TAG}` } }, ...role };
            return prisma.person.create({ data });
        };
        const r1 = await mk('rev1', { isBackgroundCheckReviewer: true });
        rev1 = r1.id;
        rev1b = (await mk('rev1b', { isBackgroundCheckReviewer: true }, r1.householdId!)).id; // shares rev1's household
        rev2 = (await mk('rev2', { isBackgroundCheckReviewer: true })).id;
        board = (await mk('board', { isBoardMember: true })).id;
        nonReviewer = (await mk('plain', {})).id;

        const app = await makeApplicantProcess('Applicant');
        applicantHh = app.householdId;
        revInApplicant = (await mk('revapp', { isBackgroundCheckReviewer: true }, applicantHh)).id; // in applicant household
    });

    afterAll(async () => {
        await wipe();
        await prisma.$disconnect();
    });

    it('rejects a non-reviewer (403)', async () => {
        as(nonReviewer);
        const proc = await makeApplicantProcess('NR');
        const res = await ATTEST(req({ processId: proc.processId, result: 'APPROVE' }) as never);
        expect(res.status).toBe(403);
    });

    it('blocks a reviewer in the applicant household', async () => {
        as(revInApplicant, { isBackgroundCheckReviewer: true });
        const proc = await prisma.orgMembershipProcess.findFirst({ where: { orgMembership: { householdId: applicantHh } } });
        const res = await ATTEST(req({ processId: proc!.id, result: 'APPROVE' }) as never);
        const data = await res.json();
        expect(res.status).toBe(403);
        expect(data.code).toBe('same_household_applicant');
    });

    it('2 distinct reviewers approving advances to PENDING_PAYMENT, stamps BG date, applies marked volunteer', async () => {
        const proc = await makeApplicantProcess('Approve');
        as(rev1, { isBackgroundCheckReviewer: true });
        const r1 = await ATTEST(req({ processId: proc.processId, result: 'APPROVE', subjectPersonIds: [proc.leadId] }) as never);
        expect((await r1.json()).outcome.status).toBe('PENDING_BG_REVIEW');

        // same reviewer again -> already_attested
        const dup = await ATTEST(req({ processId: proc.processId, result: 'APPROVE', subjectPersonIds: [proc.leadId] }) as never);
        expect(dup.status).toBe(409);

        // reviewer sharing rev1's household -> blocked
        as(rev1b, { isBackgroundCheckReviewer: true });
        const shared = await ATTEST(req({ processId: proc.processId, result: 'APPROVE', subjectPersonIds: [proc.leadId] }) as never);
        expect((await shared.json()).code).toBe('same_household_reviewer');

        // rev2 approves with volunteer checkbox -> advances
        as(rev2, { isBackgroundCheckReviewer: true });
        const r2 = await ATTEST(req({ processId: proc.processId, result: 'APPROVE', isMarkedVolunteer: true, subjectPersonIds: [proc.leadId] }) as never);
        expect((await r2.json()).outcome.status).toBe('PENDING_PAYMENT');

        const updated = await prisma.orgMembershipProcess.findUnique({ where: { id: proc.processId } });
        expect(updated?.status).toBe('PENDING_PAYMENT');
        const membership = await prisma.orgMembership.findUnique({ where: { id: proc.orgMembershipId } });
        expect(membership?.isVolunteer).toBe(true);
        const parent = await prisma.person.findFirst({ where: { householdId: proc.householdId, isHouseholdLead: true } });
        expect(parent?.lastBackgroundCheck).not.toBeNull();

        // The advance audit records the reviewer whose attestation triggered it (rev2), not rev1/SYSTEM.
        const audits = await prisma.auditLog.findMany({ where: { tableName: 'OrgMembershipProcess', affectedEntityId: proc.processId }, orderBy: { id: 'desc' } });
        const advance = audits.find((a) => JSON.stringify(normalizeAuditData(a.newData)).includes('"status":"PENDING_PAYMENT"'));
        expect(advance?.actorId).toBe(rev2);
    });

    it('applies volunteer status from a pre-designation (Gmail dot-insensitive), without a checkbox', async () => {
        // Gmail drops dots, so vol.parent... matches the dotless designation. Non-Gmail
        // domains keep dots significant (see volunteerMatch.test.ts) — that's the fix.
        const proc = await makeApplicantProcess('Predesig', `vol.parent-${TAG}@gmail.com`);
        await prisma.volunteerDesignation.create({ data: { email: `volparent-${TAG}@gmail.com` } }); // no dot
        as(rev1, { isBackgroundCheckReviewer: true });
        await ATTEST(req({ processId: proc.processId, result: 'APPROVE', subjectPersonIds: [proc.leadId] }) as never);
        as(rev2, { isBackgroundCheckReviewer: true });
        await ATTEST(req({ processId: proc.processId, result: 'APPROVE', subjectPersonIds: [proc.leadId] }) as never);
        const membership = await prisma.orgMembership.findUnique({ where: { id: proc.orgMembershipId } });
        expect(membership?.isVolunteer).toBe(true);
    });

    it('a single REJECT blocks the application', async () => {
        const proc = await makeApplicantProcess('Reject');
        as(rev1, { isBackgroundCheckReviewer: true });
        const res = await ATTEST(req({ processId: proc.processId, result: 'REJECT', note: 'Check came back with a concerning record' }) as never);
        expect((await res.json()).outcome.status).toBe('BLOCKED');
        const updated = await prisma.orgMembershipProcess.findUnique({ where: { id: proc.processId } });
        expect(updated?.status).toBe('BLOCKED');

        // The BLOCKED audit records the rejecting reviewer.
        const audit = await prisma.auditLog.findFirst({ where: { tableName: 'OrgMembershipProcess', affectedEntityId: proc.processId }, orderBy: { id: 'desc' } });
        expect(audit?.actorId).toBe(rev1);
        expect(normalizeAuditData(audit?.newData)).toMatchObject({ status: 'BLOCKED', note: 'Check came back with a concerning record' });

        const attestation = await prisma.backgroundCheckAttestation.findFirst({ where: { processId: proc.processId, reviewerId: rev1 } });
        expect(attestation?.note).toBe('Check came back with a concerning record');
    });

    it('REJECT without a note is rejected (400), no attestation written', async () => {
        const proc = await makeApplicantProcess('RejectNoNote');
        as(rev1, { isBackgroundCheckReviewer: true });
        const res = await ATTEST(req({ processId: proc.processId, result: 'REJECT' }) as never);
        expect(res.status).toBe(400);

        const res2 = await ATTEST(req({ processId: proc.processId, result: 'REJECT', note: '   ' }) as never);
        expect(res2.status).toBe(400);

        expect(await prisma.backgroundCheckAttestation.count({ where: { processId: proc.processId } })).toBe(0);
    });

    it('APPROVE without a note succeeds (200) and stores a null note', async () => {
        const proc = await makeApplicantProcess('ApproveNoNote');
        as(rev1, { isBackgroundCheckReviewer: true });
        const res = await ATTEST(req({ processId: proc.processId, result: 'APPROVE', subjectPersonIds: [proc.leadId] }) as never);
        expect(res.status).toBe(200);
        const attestation = await prisma.backgroundCheckAttestation.findFirst({ where: { processId: proc.processId, reviewerId: rev1 } });
        expect(attestation?.note).toBeNull();
    });

    it('APPROVE with a note stores it on the attestation', async () => {
        const proc = await makeApplicantProcess('ApproveWithNote');
        as(rev1, { isBackgroundCheckReviewer: true });
        const res = await ATTEST(req({ processId: proc.processId, result: 'APPROVE', note: 'Looks clean, quick review', subjectPersonIds: [proc.leadId] }) as never);
        expect(res.status).toBe(200);
        const attestation = await prisma.backgroundCheckAttestation.findFirst({ where: { processId: proc.processId, reviewerId: rev1 } });
        expect(attestation?.note).toBe('Looks clean, quick review');
    });

    it('board reset on a BLOCKED app clears attestations and returns it to review', async () => {
        const proc = await makeApplicantProcess('ResetMe');
        as(rev1, { isBackgroundCheckReviewer: true });
        await ATTEST(req({ processId: proc.processId, result: 'REJECT', note: 'Needs another look' }) as never);

        as(board, { isBoardMember: true });
        const res = await OVERRIDE(req({ processId: proc.processId, action: 'reset' }) as never);
        expect(res.status).toBe(200);
        const updated = await prisma.orgMembershipProcess.findUnique({ where: { id: proc.processId } });
        expect(updated?.status).toBe('PENDING_PAYMENT');
        const count = await prisma.backgroundCheckAttestation.count({ where: { processId: proc.processId } });
        expect(count).toBe(0);

        // The reset audit records the acting board member and the action.
        const audit = await prisma.auditLog.findFirst({ where: { tableName: 'OrgMembershipProcess', affectedEntityId: proc.processId }, orderBy: { id: 'desc' } });
        expect(audit?.actorId).toBe(board);
        expect(normalizeAuditData(audit?.newData)).toMatchObject({ action: 'board reset' });
    });

    it('board override-approve on a BLOCKED app forces it to PENDING_PAYMENT', async () => {
        const proc = await makeApplicantProcess('ForceApprove');
        as(rev1, { isBackgroundCheckReviewer: true });
        await ATTEST(req({ processId: proc.processId, result: 'REJECT', note: 'Needs another look' }) as never);

        as(board, { isBoardMember: true });
        const res = await OVERRIDE(req({ processId: proc.processId, action: 'approve', subjectPersonIds: [proc.leadId] }) as never);
        expect(res.status).toBe(200);
        const updated = await prisma.orgMembershipProcess.findUnique({ where: { id: proc.processId } });
        expect(updated?.status).toBe('PENDING_PAYMENT');
        // The override stamps the adults it named, and only those.
        expect((await prisma.person.findUnique({ where: { id: proc.leadId } }))?.lastBackgroundCheck).not.toBeNull();

        // The advance audit records the acting board member.
        const audits = await prisma.auditLog.findMany({ where: { tableName: 'OrgMembershipProcess', affectedEntityId: proc.processId }, orderBy: { id: 'desc' } });
        const advance = audits.find((a) => JSON.stringify(normalizeAuditData(a.newData)).includes('"status":"PENDING_PAYMENT"'));
        expect(advance?.actorId).toBe(board);
    });

    it('override (approve/reset) on a non-BLOCKED process is rejected (409 wrong_phase), status unchanged', async () => {
        const proc = await makeProcess('NotBlocked', 'INITIAL', 'PENDING_PAYMENT');
        as(board, { isBoardMember: true });

        for (const action of ['approve', 'reset'] as const) {
            const res = await OVERRIDE(req({ processId: proc.processId, action }) as never);
            expect(res.status).toBe(409);
            expect((await res.json()).code).toBe('wrong_phase');
            const after = await prisma.orgMembershipProcess.findUnique({ where: { id: proc.processId } });
            expect(after?.status).toBe('PENDING_PAYMENT');
        }
    });

    it('board reset on a BLOCKED RENEWAL without consent restarts the request flow (PENDING_EXTERNAL_ACTION), attestations cleared', async () => {
        const proc = await makeProcess('RenewalReset', 'RENEWAL', 'RENEWAL_PENDING_BG');

        // A reject from an eligible reviewer (different household) blocks it.
        as(rev1, { isBackgroundCheckReviewer: true });
        const rej = await ATTEST(req({ processId: proc.processId, result: 'REJECT', note: 'Needs another look' }) as never);
        expect((await rej.json()).outcome.status).toBe('BLOCKED');

        as(board, { isBoardMember: true });
        const res = await OVERRIDE(req({ processId: proc.processId, action: 'reset' }) as never);
        expect(res.status).toBe(200);
        // No consent was ever recorded, so the reset must restart the member-facing
        // request flow — the parallel review queue can't list an unconsented renewal
        // (PENDING_PAYMENT rows only enter it once bgConsentAt is set).
        const after = await prisma.orgMembershipProcess.findUnique({ where: { id: proc.processId } });
        expect(after?.status).toBe('PENDING_EXTERNAL_ACTION');
        expect(await prisma.backgroundCheckAttestation.count({ where: { processId: proc.processId } })).toBe(0);
    });

    it('non-board cannot override', async () => {
        as(nonReviewer);
        const res = await OVERRIDE(req({ processId: 1, action: 'reset' }) as never);
        expect(res.status).toBe(403);
    });

    it('attest on an already-decided (BLOCKED) process is rejected (409 wrong_phase), no new attestation or audit', async () => {
        const proc = await makeApplicantProcess('AlreadyDecided');
        as(rev1, { isBackgroundCheckReviewer: true });
        await ATTEST(req({ processId: proc.processId, result: 'REJECT', note: 'Needs another look' }) as never); // → BLOCKED (1 attestation, 1 audit)
        const attBefore = await prisma.backgroundCheckAttestation.count({ where: { processId: proc.processId } });
        const auditBefore = await prisma.auditLog.count({ where: { tableName: 'OrgMembershipProcess', affectedEntityId: proc.processId } });

        // A fresh eligible reviewer (different household) tries to attest the now-decided app.
        as(rev2, { isBackgroundCheckReviewer: true });
        const res = await ATTEST(req({ processId: proc.processId, result: 'APPROVE' }) as never);
        expect(res.status).toBe(409);
        expect((await res.json()).code).toBe('wrong_phase');

        // The phase guard precedes the attestation create, so nothing was written.
        expect(await prisma.backgroundCheckAttestation.count({ where: { processId: proc.processId } })).toBe(attBefore);
        expect(await prisma.auditLog.count({ where: { tableName: 'OrgMembershipProcess', affectedEntityId: proc.processId } })).toBe(auditBefore);
    });

    it('attest on a non-existent process returns 404 not_found', async () => {
        as(rev1, { isBackgroundCheckReviewer: true });
        const res = await ATTEST(req({ processId: 999999999, result: 'APPROVE' }) as never);
        expect(res.status).toBe(404);
        expect((await res.json()).code).toBe('not_found');
    });

    it('override on a non-existent process returns 404 not_found', async () => {
        as(board, { isBoardMember: true });
        const res = await OVERRIDE(req({ processId: 999999999, action: 'reset' }) as never);
        expect(res.status).toBe(404);
        expect((await res.json()).code).toBe('not_found');
    });

    it('queue lists eligible apps for a reviewer and excludes their own-household applicants', async () => {
        as(rev2, { isBackgroundCheckReviewer: true });
        const res = await REVIEW_QUEUE(req({}) as never);
        const data = await res.json();
        expect(Array.isArray(data.queue)).toBe(true);
        // Model-shaped rows now: id + _count.attestations + household leads (parents).
        for (const item of data.queue) {
            expect(typeof item.id).toBe('number');
            expect(item._count).toBeDefined();
        }
    });

    it('?mine=1 lists an application the reviewer approved until it clears', async () => {
        const proc = await makeApplicantProcess('Mine');
        const get = (url: string) => REVIEW_QUEUE(new Request(url) as never).then((r) => r.json());
        const ids = (data: { queue: { id: number }[] }) => data.queue.map((q) => q.id);

        as(rev1, { isBackgroundCheckReviewer: true });
        await ATTEST(req({ processId: proc.processId, result: 'APPROVE', subjectPersonIds: [proc.leadId] }) as never);
        expect(ids(await get('http://localhost:4000/api/membership/reviews'))).not.toContain(proc.processId);
        expect(ids(await get('http://localhost:4000/api/membership/reviews?mine=1'))).toContain(proc.processId);

        // Another reviewer's approvals are not theirs to see here.
        as(rev2, { isBackgroundCheckReviewer: true });
        expect(ids(await get('http://localhost:4000/api/membership/reviews?mine=1'))).not.toContain(proc.processId);

        await ATTEST(req({ processId: proc.processId, result: 'APPROVE', subjectPersonIds: [proc.leadId] }) as never);
        as(rev1, { isBackgroundCheckReviewer: true });
        expect(ids(await get('http://localhost:4000/api/membership/reviews?mine=1'))).not.toContain(proc.processId);
    });

    it('queue returns only parents (leads) and never exposes children', async () => {
        // Self-contained applicant household: one parent (lead) + one child (non-lead).
        const hh = await prisma.household.create({ data: { name: `ChildExcl ${TAG}` } });
        const parent = await prisma.person.create({ data: { name: 'Excl Parent', email: `exclparent-${TAG}@example.com`, householdId: hh.id } });
        await prisma.person.update({ where: { id: parent.id }, data: { isHouseholdLead: true } });
        await prisma.person.create({ data: { name: 'Excl Child', email: `exclchild-${TAG}@example.com`, householdId: hh.id } });
        const m = await prisma.orgMembership.create({ data: { householdId: hh.id, status: 'NONE' } });
        await prisma.orgMembershipProcess.create({ data: { orgMembershipId: m.id, kind: 'INITIAL', status: 'PENDING_BG_REVIEW' } });

        as(rev2, { isBackgroundCheckReviewer: true }); // different household → eligible
        const data = await (await REVIEW_QUEUE(req({}) as never)).json();
        const blob = JSON.stringify(data);

        // Parent (lead) is present; the child's PII never leaves the server.
        expect(blob).toContain('Excl Parent');
        expect(blob).toContain('exclparent');
        expect(blob).not.toContain('Excl Child');
        expect(blob).not.toContain('exclchild');
    });
});
