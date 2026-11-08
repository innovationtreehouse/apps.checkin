/**
 * @jest-environment node
 */
/**
 * Integration tests for the check-review routes: 2-of-N attestation on a review a
 * household's consent opened, eligibility rules, the Volunteer Family tick, reject ->
 * BLOCKED, and the board reset.
 */

import { GET as REVIEW_QUEUE, POST as ATTEST } from '@/app/api/membership/reviews/route';
import { normalizeAuditData } from '@/lib/auditPayload';
import { POST as OVERRIDE } from '@/app/api/membership-ops/applications/review-override/route';
import prisma from '@/lib/prisma';
import { setBgRecheckPolicy } from '@/test-helpers/boardSettings';
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
    let restorePolicy: () => Promise<void> = async () => {};

    /** An applicant at payment with consent recorded, and the check review that consent opened (`processId`), naming nobody. */
    async function makeApplicantProcess(label: string, parentEmail?: string) {
        const hh = await prisma.household.create({ data: { name: `${label} ${TAG}` } });
        // A parent/guardian is a household lead.
        const parent = await prisma.person.create({ data: { name: `${label} Parent`, householdId: hh.id, ...(parentEmail ? { email: parentEmail } : {}) } });
        await prisma.person.update({ where: { id: parent.id }, data: { isHouseholdLead: true } });
        const m = await prisma.orgMembership.create({ data: { householdId: hh.id, status: 'NONE' } });
        const now = new Date();
        const app = await prisma.orgMembershipProcess.create({ data: { orgMembershipId: m.id, kind: 'INITIAL', status: 'PENDING_PAYMENT', contractSignedAt: now, bgConsentAt: now } });
        const p = await prisma.orgMembershipProcess.create({ data: { kind: 'PERSON_BG', requestedForHouseholdId: hh.id, status: 'PENDING_BG_REVIEW', bgConsentAt: now } });
        return { householdId: hh.id, orgMembershipId: m.id, appId: app.id, processId: p.id, leadId: parent.id };
    }

    // Build a household process in an arbitrary kind/status (for the household-row reset tests).
    async function makeProcess(label: string, kind: 'INITIAL' | 'RENEWAL', status: 'PENDING_PAYMENT' | 'BLOCKED') {
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
            const processes = { OR: [{ orgMembership: { householdId: { in: ids } } }, { requestedForHouseholdId: { in: ids } }] };
            await prisma.backgroundCheckAttestation.deleteMany({ where: { process: processes } });
            await prisma.orgMembershipProcess.deleteMany({ where: processes });
            await prisma.orgMembership.deleteMany({ where: { householdId: { in: ids } } });
            await prisma.person.deleteMany({ where: { householdId: { in: ids } } });
            await prisma.household.deleteMany({ where: { id: { in: ids } } });
        }
        await prisma.volunteerDesignation.deleteMany({ where: { email: { contains: TAG } } });
        await prisma.person.deleteMany({ where: { email: { contains: TAG } } });
    }

    beforeAll(async () => {
        await wipe();
        restorePolicy = await setBgRecheckPolicy();
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
        await restorePolicy();
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
        const proc = await prisma.orgMembershipProcess.findFirst({ where: { requestedForHouseholdId: applicantHh } });
        const res = await ATTEST(req({ processId: proc!.id, result: 'APPROVE' }) as never);
        const data = await res.json();
        expect(res.status).toBe(403);
        expect(data.code).toBe('same_household_applicant');
    });

    it('2 distinct reviewers approving clear the lead, stamp the application cleared, and the tick marks Volunteer Family', async () => {
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

        // rev2 approves with the volunteer tick -> clears
        as(rev2, { isBackgroundCheckReviewer: true });
        const r2 = await ATTEST(req({ processId: proc.processId, result: 'APPROVE', isMarkedVolunteerFamily: true }) as never);
        expect((await r2.json()).outcome.status).toBe('ACTIVE');

        const app = await prisma.orgMembershipProcess.findUnique({ where: { id: proc.appId } });
        expect(app?.status).toBe('PENDING_PAYMENT');
        expect(app?.bgClearedAt).not.toBeNull();
        const membership = await prisma.orgMembership.findUnique({ where: { id: proc.orgMembershipId } });
        expect(membership?.isVolunteerFamily).toBe(true);
        const parent = await prisma.person.findFirst({ where: { householdId: proc.householdId, isHouseholdLead: true } });
        expect(parent?.lastBackgroundCheck).not.toBeNull();

        // The clearance audit records the reviewer whose attestation triggered it (rev2), not rev1/SYSTEM.
        const audits = await prisma.auditLog.findMany({ where: { tableName: 'OrgMembershipProcess', affectedEntityId: proc.processId }, orderBy: { id: 'desc' } });
        const cleared = audits.find((a) => JSON.stringify(normalizeAuditData(a.newData)).includes('"status":"ACTIVE"'));
        expect(cleared?.actorId).toBe(rev2);
    });

    it('applies volunteer status from a pre-designation (Gmail dot-insensitive), without a checkbox', async () => {
        // Gmail drops dots, so vol.parent... matches the dotless designation. Non-Gmail
        // domains keep dots significant (see volunteerMatch.test.ts).
        const proc = await makeApplicantProcess('Predesig', `vol.parent-${TAG}@gmail.com`);
        await prisma.account.create({ data: { userId: proc.leadId, type: 'oauth', provider: 'google', providerAccountId: `predesig-${TAG}-${proc.leadId}` } });
        await prisma.volunteerDesignation.create({ data: { email: `volparent-${TAG}@gmail.com` } }); // no dot
        as(rev1, { isBackgroundCheckReviewer: true });
        await ATTEST(req({ processId: proc.processId, result: 'APPROVE', subjectPersonIds: [proc.leadId] }) as never);
        as(rev2, { isBackgroundCheckReviewer: true });
        await ATTEST(req({ processId: proc.processId, result: 'APPROVE' }) as never);
        const membership = await prisma.orgMembership.findUnique({ where: { id: proc.orgMembershipId } });
        expect(membership?.isVolunteerFamily).toBe(true);
    });

    it('does not apply a pre-designation to a lead whose address was never verified at sign-in', async () => {
        const proc = await makeApplicantProcess('PredesigUnverified', `unverified-parent-${TAG}@example.com`);
        await prisma.volunteerDesignation.create({ data: { email: `unverified-parent-${TAG}@example.com` } });
        as(rev1, { isBackgroundCheckReviewer: true });
        await ATTEST(req({ processId: proc.processId, result: 'APPROVE', subjectPersonIds: [proc.leadId] }) as never);
        as(rev2, { isBackgroundCheckReviewer: true });
        await ATTEST(req({ processId: proc.processId, result: 'APPROVE' }) as never);
        const membership = await prisma.orgMembership.findUnique({ where: { id: proc.orgMembershipId } });
        expect(membership?.isVolunteerFamily).toBe(false);
    });

    it('a single REJECT, naming the lead, blocks the review and the application', async () => {
        const proc = await makeApplicantProcess('Reject');
        as(rev1, { isBackgroundCheckReviewer: true });
        const res = await ATTEST(req({ processId: proc.processId, result: 'REJECT', note: 'Check came back with a concerning record', subjectPersonIds: [proc.leadId] }) as never);
        expect((await res.json()).outcome.status).toBe('BLOCKED');
        const updated = await prisma.orgMembershipProcess.findUnique({ where: { id: proc.processId } });
        expect(updated?.status).toBe('BLOCKED');
        expect(updated?.subjectPersonId).toBe(proc.leadId);
        expect((await prisma.orgMembershipProcess.findUnique({ where: { id: proc.appId } }))?.status).toBe('BLOCKED');

        // The BLOCKED audit records the rejecting reviewer.
        const audit = await prisma.auditLog.findFirst({ where: { tableName: 'OrgMembershipProcess', affectedEntityId: proc.processId }, orderBy: { id: 'desc' } });
        expect(audit?.actorId).toBe(rev1);
        expect(normalizeAuditData(audit?.newData)).toMatchObject({ status: 'BLOCKED', note: 'Check came back with a concerning record', subjectPersonId: proc.leadId });

        const attestation = await prisma.backgroundCheckAttestation.findFirst({ where: { processId: proc.processId, reviewerId: rev1 } });
        expect(attestation?.note).toBe('Check came back with a concerning record');
    });

    it('REJECT naming nobody on a review with no person is rejected (400), no attestation written', async () => {
        const proc = await makeApplicantProcess('RejectUnnamed');
        as(rev1, { isBackgroundCheckReviewer: true });
        const res = await ATTEST(req({ processId: proc.processId, result: 'REJECT', note: 'concerning' }) as never);
        expect(res.status).toBe(400);
        expect((await res.json()).code).toBe('invalid_subject');
        expect(await prisma.backgroundCheckAttestation.count({ where: { processId: proc.processId } })).toBe(0);
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

    it('board reset of a BLOCKED review needs a reason, clears attestations, returns it to review and resumes the application', async () => {
        const proc = await makeApplicantProcess('ResetMe');
        as(rev1, { isBackgroundCheckReviewer: true });
        await ATTEST(req({ processId: proc.processId, result: 'REJECT', note: 'Needs another look', subjectPersonIds: [proc.leadId] }) as never);

        as(board, { isBoardMember: true });
        expect((await OVERRIDE(req({ processId: proc.processId, action: 'reset' }) as never)).status).toBe(400);
        const res = await OVERRIDE(req({ processId: proc.processId, action: 'reset', reason: 'second look' }) as never);
        expect(res.status).toBe(200);
        const updated = await prisma.orgMembershipProcess.findUnique({ where: { id: proc.processId } });
        expect(updated?.status).toBe('PENDING_BG_REVIEW');
        expect(updated?.subjectPersonId).toBe(proc.leadId);
        expect((await prisma.orgMembershipProcess.findUnique({ where: { id: proc.appId } }))?.status).toBe('PENDING_PAYMENT');
        const count = await prisma.backgroundCheckAttestation.count({ where: { processId: proc.processId } });
        expect(count).toBe(0);

        // The reset audit records the acting board member and the action.
        const audit = await prisma.auditLog.findFirst({ where: { tableName: 'OrgMembershipProcess', affectedEntityId: proc.processId }, orderBy: { id: 'desc' } });
        expect(audit?.actorId).toBe(board);
        expect(normalizeAuditData(audit?.newData)).toMatchObject({ action: 'board reset', reason: 'second look' });
        // The deleted rejection and its note are kept in the audit row.
        expect(normalizeAuditData(audit?.oldData)).toMatchObject({
            status: 'BLOCKED',
            attestations: [expect.objectContaining({ reviewerId: rev1, result: 'REJECT', note: 'Needs another look' })],
        });
    });

    it('the board cannot override-approve a BLOCKED app (Board ruling B5/B25): 400, still blocked, nothing stamped', async () => {
        const proc = await makeApplicantProcess('ForceApprove');
        as(rev1, { isBackgroundCheckReviewer: true });
        await ATTEST(req({ processId: proc.processId, result: 'REJECT', note: 'Needs another look', subjectPersonIds: [proc.leadId] }) as never);

        as(board, { isBoardMember: true });
        const res = await OVERRIDE(req({ processId: proc.processId, action: 'approve', subjectPersonIds: [proc.leadId] }) as never);
        expect(res.status).toBe(400);
        const updated = await prisma.orgMembershipProcess.findUnique({ where: { id: proc.processId } });
        expect(updated?.status).toBe('BLOCKED');
        expect(updated?.bgClearedAt).toBeNull();
        expect((await prisma.person.findUnique({ where: { id: proc.leadId } }))?.lastBackgroundCheck).toBeNull();
        expect(await prisma.backgroundCheckAttestation.count({ where: { processId: proc.processId } })).toBe(1);
    });

    it('reset on a process neither blocked nor in review is rejected (409 wrong_phase), status unchanged', async () => {
        const proc = await makeProcess('NotBlocked', 'INITIAL', 'PENDING_PAYMENT');
        as(board, { isBoardMember: true });

        const res = await OVERRIDE(req({ processId: proc.processId, action: 'reset', reason: 'x' }) as never);
        expect(res.status).toBe(409);
        expect((await res.json()).code).toBe('wrong_phase');
        const after = await prisma.orgMembershipProcess.findUnique({ where: { id: proc.processId } });
        expect(after?.status).toBe('PENDING_PAYMENT');
    });

    it('board reset of a household row a household attestation blocked restarts a renewal without consent at the external step', async () => {
        const proc = await makeProcess('RenewalReset', 'RENEWAL', 'BLOCKED');
        await prisma.backgroundCheckAttestation.create({ data: { processId: proc.processId, reviewerId: rev1, result: 'REJECT', note: 'legacy' } });

        as(board, { isBoardMember: true });
        const res = await OVERRIDE(req({ processId: proc.processId, action: 'reset', reason: 'legacy cleanup' }) as never);
        expect(res.status).toBe(200);
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
        await ATTEST(req({ processId: proc.processId, result: 'REJECT', note: 'Needs another look', subjectPersonIds: [proc.leadId] }) as never); // → BLOCKED
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
        const res = await OVERRIDE(req({ processId: 999999999, action: 'reset', reason: 'x' }) as never);
        expect(res.status).toBe(404);
        expect((await res.json()).code).toBe('not_found');
    });

    it('queue lists eligible apps for a reviewer and excludes their own-household applicants', async () => {
        as(rev2, { isBackgroundCheckReviewer: true });
        const res = await REVIEW_QUEUE(req({}) as never);
        const data = await res.json();
        expect(Array.isArray(data.queue)).toBe(true);
        // Model-shaped rows: id + _count.attestations + household leads (parents).
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

        await ATTEST(req({ processId: proc.processId, result: 'APPROVE' }) as never);
        as(rev1, { isBackgroundCheckReviewer: true });
        expect(ids(await get('http://localhost:4000/api/membership/reviews?mine=1'))).not.toContain(proc.processId);
    });

    it('queue returns only parents (leads) and never exposes children', async () => {
        // Self-contained applicant household: one parent (lead) + one child (non-lead).
        const hh = await prisma.household.create({ data: { name: `ChildExcl ${TAG}` } });
        const parent = await prisma.person.create({ data: { name: 'Excl Parent', email: `exclparent-${TAG}@example.com`, householdId: hh.id } });
        await prisma.person.update({ where: { id: parent.id }, data: { isHouseholdLead: true } });
        await prisma.person.create({ data: { name: 'Excl Child', email: `exclchild-${TAG}@example.com`, householdId: hh.id } });
        await prisma.orgMembershipProcess.create({ data: { kind: 'PERSON_BG', requestedForHouseholdId: hh.id, status: 'PENDING_BG_REVIEW', bgConsentAt: new Date() } });

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
