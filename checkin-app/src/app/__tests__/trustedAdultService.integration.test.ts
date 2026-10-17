/**
 * @jest-environment node
 */
/**
 * Integration tests for Trusted Adult management: household-scoped disclosure,
 * single-board-member decision (approve requires the shared note), one-click
 * renewal, the 1-year expiry sweep (warn-then-expire), withdrawal, override, and
 * the household-lead guard.
 */

import { normalizeAuditData } from '@/lib/auditPayload';
import {
    createTrustedAdult,
    decideReview,
    renewTrustedAdult,
    resubmitWithChanges,
    withdrawTrustedAdult,
    hideTrustedAdult,
    overrideReview,
    runExpirySweep,
} from '@/lib/trusted-adult/service';
import prisma from '@/lib/prisma';

const sendEmail = jest.fn().mockResolvedValue(true);
jest.mock('@/lib/email', () => ({
    sendEmail: (...a: unknown[]) => sendEmail(...a),
    runPaced: (tasks: Array<() => Promise<unknown>>) => Promise.all(tasks.map((t) => t())),
}));

const TAG = 'trustedadult-test';
const SHARED = 'Grandma may pick up the kids.';

describe('Trusted Adults service', () => {
    let householdId = 0;
    let leadId = 0;
    let outsiderId = 0;
    let boardId = 0;
    let boardLeadId = 0; // board member who is ALSO a lead of householdId — the self-conflict actor

    async function wipe() {
        const hhs = await prisma.household.findMany({ where: { name: { contains: TAG } }, select: { id: true } });
        const ids = hhs.map((h) => h.id);
        if (ids.length) {
            await prisma.trustedAdultReview.deleteMany({ where: { householdId: { in: ids } } });
            await prisma.trustedAdult.deleteMany({ where: { householdId: { in: ids } } });
        }
        await prisma.person.deleteMany({ where: { householdId: { in: ids } } });
        await prisma.household.deleteMany({ where: { id: { in: ids } } });
    }

    beforeAll(async () => {
        await wipe();
        const hh = await prisma.household.create({ data: { name: `Family HH ${TAG}` } });
        householdId = hh.id;
        const lead = await prisma.person.create({ data: { name: 'Lead', email: `lead-${TAG}@ex.com`, householdId: hh.id } });
        leadId = lead.id;
        await prisma.person.update({ where: { id: lead.id }, data: { isHouseholdLead: true } });

        // A board member who is also a lead of the disclosing household: overriding this
        // household's own review is a conflict of interest (force-approve Grandma for their kids).
        const boardLead = await prisma.person.create({
            data: { name: 'BoardLead', email: `boardlead-${TAG}@ex.com`, isBoardMember: true, householdId: hh.id },
        });
        boardLeadId = boardLead.id;
        await prisma.person.update({ where: { id: boardLead.id }, data: { isHouseholdLead: true } });

        const outHh = await prisma.household.create({ data: { name: `Outsider HH ${TAG}` } });
        outsiderId = (await prisma.person.create({ data: { name: 'Outsider', householdId: outHh.id } })).id;
        const boardHh = await prisma.household.create({ data: { name: `Board HH ${TAG}` } });
        boardId = (await prisma.person.create({ data: { name: 'Boardie', email: `board-${TAG}@ex.com`, isBoardMember: true, householdId: boardHh.id } })).id;
    });

    afterAll(async () => {
        await wipe();
        await prisma.$disconnect();
    });

    beforeEach(() => sendEmail.mockClear());

    // Newest audit row for a trusted adult. Each action appends one row keyed by the
    // TrustedAdult id, so "newest" is the row the just-run action wrote. Queries
    // prisma.auditLog directly so it survives the audit() write becoming transactional.
    const latestAudit = (taId: number) =>
        prisma.auditLog.findFirst({ where: { tableName: 'TrustedAdult', affectedEntityId: taId }, orderBy: { id: 'desc' } });

    async function discloseOne() {
        return createTrustedAdult({
            householdId,
            trustedAdultName: 'Jane External',
            trustedAdultEmail: 'jane@example.com',
            familyContext: 'Our nanny; may collect the kids on weekdays.',
            disclosedById: leadId,
        });
    }

    it('creates a trusted adult with an INITIAL review pending board review and pings the board', async () => {
        const ta = await discloseOne();
        expect(ta.householdId).toBe(householdId);
        expect(ta.reviews).toHaveLength(1);
        expect(ta.reviews[0].kind).toBe('INITIAL');
        expect(ta.reviews[0].status).toBe('PENDING_BOARD_REVIEW');
        expect(sendEmail).toHaveBeenCalled(); // board notified

        const audit = await latestAudit(ta.id);
        expect(audit?.actorId).toBe(leadId); // the disclosing lead, not SYSTEM_ACTOR
        expect(audit?.action).toBe('CREATE');
        expect(normalizeAuditData(audit?.newData)).toMatchObject({ created: true, status: 'PENDING_BOARD_REVIEW' });
    });

    it('rejects a disclosure missing name, contact, or family context', async () => {
        await expect(
            createTrustedAdult({ householdId, trustedAdultName: '', trustedAdultEmail: 'x@y.com', familyContext: 'x', disclosedById: leadId }),
        ).rejects.toMatchObject({ code: 'bad_input' });
        await expect( // neither phone nor email
            createTrustedAdult({ householdId, trustedAdultName: 'x', familyContext: 'x', disclosedById: leadId }),
        ).rejects.toMatchObject({ code: 'bad_input' });
        await expect( // malformed email
            createTrustedAdult({ householdId, trustedAdultName: 'x', trustedAdultEmail: 'nope', familyContext: 'x', disclosedById: leadId }),
        ).rejects.toMatchObject({ code: 'bad_input' });
        await expect(
            createTrustedAdult({ householdId, trustedAdultName: 'x', trustedAdultEmail: 'x@y.com', familyContext: '', disclosedById: leadId }),
        ).rejects.toMatchObject({ code: 'bad_input' });
    });

    it('approve requires a shared note, and stamps a one-year review-by date', async () => {
        const ta = await discloseOne();
        await expect(decideReview(ta.reviews[0].id, boardId, { decision: 'APPROVE' })).rejects.toMatchObject({ code: 'bad_input' });
        const before = Date.now();
        const out = await decideReview(ta.reviews[0].id, boardId, { decision: 'APPROVE', sharedNote: SHARED });
        expect(out.status).toBe('APPROVED');
        expect(out.decidedById).toBe(boardId);
        expect(out.sharedNote).toBe(SHARED);
        const days = (out.reviewBy!.getTime() - before) / 86400000;
        expect(days).toBeGreaterThan(360);
        expect(days).toBeLessThan(370);

        const audit = await latestAudit(ta.id);
        expect(audit?.actorId).toBe(boardId); // the deciding board member
        expect(normalizeAuditData(audit?.newData)).toMatchObject({ status: 'APPROVED', decision: 'APPROVE' });
    });

    it('refuses a decider with a conflict of interest: own household, or being the counterparty', async () => {
        // Same household as the disclosure (the lead) — can't decide their own household's review.
        const ta = await discloseOne();
        await expect(decideReview(ta.reviews[0].id, leadId, { decision: 'APPROVE', sharedNote: SHARED }))
            .rejects.toMatchObject({ code: 'forbidden' });

        // Board member is the counterparty (the trusted adult themselves) — also blocked,
        // even though they live in a different household.
        const selfTa = await createTrustedAdult({
            householdId,
            trustedAdultPersonId: boardId,
            trustedAdultName: 'Boardie',
            trustedAdultEmail: 'boardie@example.com',
            familyContext: 'A board member who is also our trusted adult.',
            disclosedById: leadId,
        });
        await expect(decideReview(selfTa.reviews[0].id, boardId, { decision: 'DENY' }))
            .rejects.toMatchObject({ code: 'forbidden' });
    });

    it('REQUEST_INFO moves to PENDING_SUBJECT_ACTION and emails the family', async () => {
        const ta = await discloseOne();
        const out = await decideReview(ta.reviews[0].id, boardId, { decision: 'REQUEST_INFO', note: 'Please clarify dates.' });
        expect(out.status).toBe('PENDING_SUBJECT_ACTION');
        expect(sendEmail).toHaveBeenCalledWith(`lead-${TAG}@ex.com`, expect.stringContaining('more information'), expect.any(String));

        const audit = await latestAudit(ta.id);
        expect(audit?.actorId).toBe(boardId);
        expect(normalizeAuditData(audit?.newData)).toMatchObject({ status: 'PENDING_SUBJECT_ACTION', decision: 'REQUEST_INFO' });
    });

    it('audit records the deciding/overriding board member on DENY and override-deny', async () => {
        const ta = await discloseOne();
        await decideReview(ta.reviews[0].id, boardId, { decision: 'DENY' });
        const denyAudit = await latestAudit(ta.id);
        expect(denyAudit?.actorId).toBe(boardId);
        expect(normalizeAuditData(denyAudit?.newData)).toMatchObject({ status: 'DENIED', decision: 'DENY' });

        const ta2 = await discloseOne();
        await overrideReview(ta2.reviews[0].id, boardId, 'deny');
        const overrideAudit = await latestAudit(ta2.id);
        expect(overrideAudit?.actorId).toBe(boardId);
        expect(normalizeAuditData(overrideAudit?.newData)).toMatchObject({ status: 'DENIED', override: 'deny' });
    });

    it('renewal opens a fresh review reusing the same trusted adult, and refuses while one is open', async () => {
        const ta = await discloseOne();
        await decideReview(ta.reviews[0].id, boardId, { decision: 'APPROVE', sharedNote: SHARED });
        const review = await renewTrustedAdult(ta.id, leadId);
        expect(review.kind).toBe('RENEWAL');
        expect(review.status).toBe('PENDING_BOARD_REVIEW');
        expect(review.trustedAdultId).toBe(ta.id);

        const audit = await latestAudit(ta.id);
        expect(audit?.actorId).toBe(leadId); // the renewing lead
        expect(audit?.action).toBe('CREATE');
        expect(normalizeAuditData(audit?.newData)).toMatchObject({ renewal: review.id, status: 'PENDING_BOARD_REVIEW' });

        await expect(renewTrustedAdult(ta.id, leadId)).rejects.toMatchObject({ code: 'already_open' });
    });

    it('only a household lead may renew; an outsider may not', async () => {
        const ta = await discloseOne();
        await decideReview(ta.reviews[0].id, boardId, { decision: 'APPROVE', sharedNote: SHARED });
        await expect(renewTrustedAdult(ta.id, outsiderId)).rejects.toMatchObject({ code: 'forbidden' });
        const review = await renewTrustedAdult(ta.id, leadId);
        expect(review.status).toBe('PENDING_BOARD_REVIEW');
    });

    it('resubmit-with-changes opens a MODIFIED review holding the proposed edits, WITHOUT disturbing a live approval', async () => {
        const ta = await discloseOne();
        const approved = await decideReview(ta.reviews[0].id, boardId, { decision: 'APPROVE', sharedNote: SHARED });

        const modReview = await resubmitWithChanges(ta.id, leadId, {
            trustedAdultName: 'Jane External-Smith',
            trustedAdultPhone: '512-555-0199',
            trustedAdultEmail: 'jane.smith@example.com',
            familyContext: 'Now married; new number. Weekday pickups only.',
        });
        expect(modReview.kind).toBe('MODIFIED');
        expect(modReview.status).toBe('PENDING_BOARD_REVIEW');
        expect(modReview.proposedName).toBe('Jane External-Smith');

        // Non-destructive: parent facts and the prior APPROVED review are untouched, so
        // the front desk keeps seeing the approved record while this change is pending.
        const parent = await prisma.trustedAdult.findUnique({ where: { id: ta.id } });
        expect(parent?.trustedAdultName).toBe('Jane External');
        expect(parent?.familyContext).toBe('Our nanny; may collect the kids on weekdays.');
        const priorStill = await prisma.trustedAdultReview.findUnique({ where: { id: approved.id } });
        expect(priorStill?.status).toBe('APPROVED');

        // Only a lead, and never while a review is already open.
        await expect(
            resubmitWithChanges(ta.id, outsiderId, { trustedAdultName: 'x', trustedAdultEmail: 'x@y.com', familyContext: 'x' }),
        ).rejects.toMatchObject({ code: 'forbidden' });
        await expect(
            resubmitWithChanges(ta.id, leadId, { trustedAdultName: 'x', trustedAdultEmail: 'x@y.com', familyContext: 'x' }),
        ).rejects.toMatchObject({ code: 'already_open' });
    });

    it('approving a MODIFIED review promotes the proposed edits onto the parent; denying discards them', async () => {
        // Deny path: parent stays on the old facts, prior approval stays live.
        const denied = await discloseOne();
        const approvedD = await decideReview(denied.reviews[0].id, boardId, { decision: 'APPROVE', sharedNote: SHARED });
        const modD = await resubmitWithChanges(denied.id, leadId, {
            trustedAdultName: 'Should Not Land', trustedAdultEmail: 'nope@example.com', familyContext: 'discarded',
        });
        await decideReview(modD.id, boardId, { decision: 'DENY' });
        const parentD = await prisma.trustedAdult.findUnique({ where: { id: denied.id } });
        expect(parentD?.trustedAdultName).toBe('Jane External');
        expect((await prisma.trustedAdultReview.findUnique({ where: { id: approvedD.id } }))?.status).toBe('APPROVED');

        // Approve path: the proposed edits become the parent's facts.
        const ok = await discloseOne();
        await decideReview(ok.reviews[0].id, boardId, { decision: 'APPROVE', sharedNote: SHARED });
        const modOk = await resubmitWithChanges(ok.id, leadId, {
            trustedAdultName: 'Jane Promoted', trustedAdultPhone: '512-555-0100', trustedAdultEmail: 'promoted@example.com', familyContext: 'new scope',
        });
        await decideReview(modOk.id, boardId, { decision: 'APPROVE', sharedNote: 'Updated: Jane Promoted may pick up.' });
        const parentOk = await prisma.trustedAdult.findUnique({ where: { id: ok.id } });
        expect(parentOk?.trustedAdultName).toBe('Jane Promoted');
        expect(parentOk?.familyContext).toBe('new scope');
        expect(parentOk?.trustedAdultEmail).toBe('promoted@example.com');
    });

    it('plain Deny of a change leaves the live approval intact; Deny & Revoke kills it', async () => {
        // Plain Deny: prior approval survives (the adult stays authorized at the front desk).
        const keep = await discloseOne();
        const approvedK = await decideReview(keep.reviews[0].id, boardId, { decision: 'APPROVE', sharedNote: SHARED });
        const modK = await resubmitWithChanges(keep.id, leadId, { trustedAdultName: 'x', trustedAdultEmail: 'x@y.com', familyContext: 'x' });
        await decideReview(modK.id, boardId, { decision: 'DENY' });
        expect((await prisma.trustedAdultReview.findUnique({ where: { id: approvedK.id } }))?.status).toBe('APPROVED');

        // Deny & Revoke: the change is denied AND every live approval is revoked, so no
        // APPROVED review remains and the adult drops off the pickup list.
        const kill = await discloseOne();
        const approvedR = await decideReview(kill.reviews[0].id, boardId, { decision: 'APPROVE', sharedNote: SHARED });
        const modR = await resubmitWithChanges(kill.id, leadId, { trustedAdultName: 'y', trustedAdultEmail: 'y@z.com', familyContext: 'y' });
        await decideReview(modR.id, boardId, { decision: 'DENY', revokePriorApprovals: true });
        expect((await prisma.trustedAdultReview.findUnique({ where: { id: modR.id } }))?.status).toBe('DENIED');
        expect((await prisma.trustedAdultReview.findUnique({ where: { id: approvedR.id } }))?.status).toBe('REVOKED');
        expect(await prisma.trustedAdultReview.count({ where: { trustedAdultId: kill.id, status: 'APPROVED' } })).toBe(0);
    });

    it('a board member cannot Deny & Revoke their own household review', async () => {
        const ta = await discloseOne();
        const approved = await decideReview(ta.reviews[0].id, boardId, { decision: 'APPROVE', sharedNote: SHARED });
        const mod = await resubmitWithChanges(ta.id, leadId, { trustedAdultName: 'z', trustedAdultEmail: 'z@z.com', familyContext: 'z' });
        await expect(
            decideReview(mod.id, boardLeadId, { decision: 'DENY', revokePriorApprovals: true }),
        ).rejects.toMatchObject({ code: 'forbidden' });
        // Nothing changed: the change is still pending and the approval still live.
        expect((await prisma.trustedAdultReview.findUnique({ where: { id: mod.id } }))?.status).toBe('PENDING_BOARD_REVIEW');
        expect((await prisma.trustedAdultReview.findUnique({ where: { id: approved.id } }))?.status).toBe('APPROVED');
    });

    it('withdraw scope=change cancels only the pending change (approval stays); default withdraw revokes all', async () => {
        // Cancel the change: only the pending MODIFIED review is revoked; the approval remains.
        const ta = await discloseOne();
        const approved = await decideReview(ta.reviews[0].id, boardId, { decision: 'APPROVE', sharedNote: SHARED });
        const mod = await resubmitWithChanges(ta.id, leadId, { trustedAdultName: 'q', trustedAdultEmail: 'q@q.com', familyContext: 'q' });
        await withdrawTrustedAdult(ta.id, leadId, { latestReviewOnly: true });
        expect((await prisma.trustedAdultReview.findUnique({ where: { id: mod.id } }))?.status).toBe('REVOKED');
        expect((await prisma.trustedAdultReview.findUnique({ where: { id: approved.id } }))?.status).toBe('APPROVED');

        // With no pending change left, scope=change has nothing to cancel.
        await expect(withdrawTrustedAdult(ta.id, leadId, { latestReviewOnly: true })).rejects.toMatchObject({ code: 'wrong_phase' });

        // Default withdraw now revokes the surviving approval.
        await withdrawTrustedAdult(ta.id, leadId);
        expect((await prisma.trustedAdultReview.findUnique({ where: { id: approved.id } }))?.status).toBe('REVOKED');
    });

    it('expiry sweep warns the family 30 days out (once), then expires lapsed approvals', async () => {
        const ta = await discloseOne();
        const r = await decideReview(ta.reviews[0].id, boardId, { decision: 'APPROVE', sharedNote: SHARED });

        const soon = new Date(Date.now() + 10 * 86400000);
        await prisma.trustedAdultReview.update({ where: { id: r.id }, data: { reviewBy: soon, expiryWarningSentAt: null } });
        const warnRun = await runExpirySweep(new Date());
        expect(warnRun.warned).toBeGreaterThanOrEqual(1);
        expect(sendEmail).toHaveBeenCalledWith(`lead-${TAG}@ex.com`, expect.stringContaining('expiring'), expect.any(String));

        const again = await prisma.trustedAdultReview.findUnique({ where: { id: r.id } });
        expect(again!.expiryWarningSentAt).not.toBeNull();

        await prisma.trustedAdultReview.update({ where: { id: r.id }, data: { reviewBy: new Date(Date.now() - 86400000) } });
        sendEmail.mockClear();
        const expireRun = await runExpirySweep(new Date());
        expect(expireRun.expired).toBeGreaterThanOrEqual(1);
        const expired = await prisma.trustedAdultReview.findUnique({ where: { id: r.id } });
        expect(expired!.status).toBe('EXPIRED');

        // Expiring drops the adult off the pickup list, so the family hears about it that
        // day — not only from the warning a month earlier.
        expect(sendEmail).toHaveBeenCalledWith(
            `lead-${TAG}@ex.com`,
            'Trusted adult approval expired: Jane External',
            expect.stringContaining('no longer authorized at the front desk'),
        );

        // The system, not a person, drives the nightly expiry transition.
        const audit = await latestAudit(ta.id);
        expect(audit?.actorId).toBe(0); // SYSTEM_ACTOR
        expect(normalizeAuditData(audit?.newData)).toMatchObject({ status: 'EXPIRED' });

        // The flip is its own dedup: an EXPIRED review is no longer selectable, so the
        // next night's run neither re-expires nor re-notifies.
        sendEmail.mockClear();
        const rerun = await runExpirySweep(new Date());
        expect(rerun.expired).toBe(0);
        expect(sendEmail).not.toHaveBeenCalledWith(expect.anything(), expect.stringContaining('expired'), expect.anything());
    });

    it('a failed expiry email still leaves the review EXPIRED and audited', async () => {
        const ta = await discloseOne();
        const r = await decideReview(ta.reviews[0].id, boardId, { decision: 'APPROVE', sharedNote: SHARED });
        await prisma.trustedAdultReview.update({ where: { id: r.id }, data: { reviewBy: new Date(Date.now() - 86400000) } });

        sendEmail.mockRejectedValueOnce(new Error('smtp down'));
        try {
            const run = await runExpirySweep(new Date());
            expect(run.expired).toBeGreaterThanOrEqual(1);
            // The rejected send is the expiry notice itself, not some other email.
            expect(sendEmail).toHaveBeenCalledWith(
                `lead-${TAG}@ex.com`,
                'Trusted adult approval expired: Jane External',
                expect.any(String),
            );
        } finally {
            // mockReset, not mockResolvedValue: an unconsumed ...Once rejection would
            // otherwise leak into the next test.
            sendEmail.mockReset();
            sendEmail.mockResolvedValue(true);
        }

        expect((await prisma.trustedAdultReview.findUnique({ where: { id: r.id } }))!.status).toBe('EXPIRED');
        const audit = await latestAudit(ta.id);
        expect(audit?.actorId).toBe(0); // SYSTEM_ACTOR
        expect(normalizeAuditData(audit?.newData)).toMatchObject({ status: 'EXPIRED' });
    });

    it('a lead can withdraw; board override can force-revoke; force-approve needs a note', async () => {
        const ta = await discloseOne();
        await withdrawTrustedAdult(ta.id, leadId);
        const latest = await prisma.trustedAdultReview.findFirst({ where: { trustedAdultId: ta.id }, orderBy: { id: 'desc' } });
        expect(latest!.status).toBe('REVOKED');

        const withdrawAudit = await latestAudit(ta.id);
        expect(withdrawAudit?.actorId).toBe(leadId); // the withdrawing lead
        expect(normalizeAuditData(withdrawAudit?.newData)).toMatchObject({ status: 'REVOKED' });

        const ta2 = await discloseOne();
        const reviewId = ta2.reviews[0].id;
        await expect(overrideReview(reviewId, boardId, 'approve')).rejects.toMatchObject({ code: 'bad_input' });
        const approved = await overrideReview(reviewId, boardId, 'approve', SHARED);
        expect(approved.status).toBe('APPROVED');
        const approveAudit = await latestAudit(ta2.id);
        expect(approveAudit?.actorId).toBe(boardId); // the overriding board member
        expect(normalizeAuditData(approveAudit?.newData)).toMatchObject({ status: 'APPROVED', override: 'approve' });

        const revoked = await overrideReview(reviewId, boardId, 'revoke');
        expect(revoked.status).toBe('REVOKED');
        const revokeAudit = await latestAudit(ta2.id);
        expect(revokeAudit?.actorId).toBe(boardId);
        expect(normalizeAuditData(revokeAudit?.newData)).toMatchObject({ status: 'REVOKED', override: 'revoke' });
    });

    // Regression: a renewal after approval leaves TWO APPROVED reviews (renew doesn't
    // retire the prior approval). Withdraw must revoke BOTH — the pickup list shows a
    // TA while ANY review is APPROVED, so revoking only the latest kept it on the list.
    it('withdraw revokes every APPROVED review, so a renewed-then-approved TA leaves none live', async () => {
        const ta = await discloseOne();
        await decideReview(ta.reviews[0].id, boardId, { decision: 'APPROVE', sharedNote: SHARED });

        // Resubmit while the first approval is still live → a second review, also approved.
        const renewed = await renewTrustedAdult(ta.id, leadId);
        await decideReview(renewed.id, boardId, { decision: 'APPROVE', sharedNote: SHARED });
        expect(await prisma.trustedAdultReview.count({ where: { trustedAdultId: ta.id, status: 'APPROVED' } })).toBe(2);

        await withdrawTrustedAdult(ta.id, leadId);

        // No APPROVED review survives — the /operational `some: APPROVED` filter now drops it.
        expect(await prisma.trustedAdultReview.count({ where: { trustedAdultId: ta.id, status: 'APPROVED' } })).toBe(0);
        const remaining = await prisma.trustedAdultReview.findMany({ where: { trustedAdultId: ta.id } });
        expect(remaining.every((r) => r.status === 'REVOKED')).toBe(true);
    });

    it('hide only works on a withdrawn TA; sets hiddenAt so /mine filters it, and is idempotent', async () => {
        const ta = await discloseOne();
        // Not yet withdrawn — hide is refused, row stays visible.
        await expect(hideTrustedAdult(ta.id, leadId)).rejects.toMatchObject({ code: 'wrong_phase' });

        await withdrawTrustedAdult(ta.id, leadId);
        const hidden = await hideTrustedAdult(ta.id, leadId);
        expect(hidden.hiddenAt).toBeInstanceOf(Date);

        // The record is KEPT, just flagged — /mine's `hiddenAt: null` filter drops it.
        const still = await prisma.trustedAdult.findUnique({ where: { id: ta.id } });
        expect(still?.hiddenAt).toBeInstanceOf(Date);

        // Idempotent: hiding again returns without error or a second timestamp change.
        const again = await hideTrustedAdult(ta.id, leadId);
        expect(again.hiddenAt).toEqual(hidden.hiddenAt);

        const audit = await latestAudit(ta.id);
        expect(normalizeAuditData(audit?.newData)).toMatchObject({ hiddenAt: expect.anything() });
    });

    // overrideReview's defining job: force a terminal state regardless of the review's
    // CURRENT phase (no phase guard, unlike decideReview). These pin that contract by
    // overriding reviews that are ALREADY terminal, and assert the audit oldData.status
    // reflects the prior terminal state — not a fresh PENDING one.

    it('override-revokes a LIVE APPROVED review and audits the prior APPROVED state', async () => {
        const ta = await discloseOne();
        await decideReview(ta.reviews[0].id, boardId, { decision: 'APPROVE', sharedNote: SHARED });

        const revoked = await overrideReview(ta.reviews[0].id, boardId, 'revoke');
        expect(revoked.status).toBe('REVOKED');

        const audit = await latestAudit(ta.id);
        expect(normalizeAuditData(audit?.oldData)).toMatchObject({ status: 'APPROVED' });
        expect(normalizeAuditData(audit?.newData)).toMatchObject({ status: 'REVOKED', override: 'revoke' });
    });

    it('override-approves an already DENIED review and audits the prior DENIED state', async () => {
        const ta = await discloseOne();
        await decideReview(ta.reviews[0].id, boardId, { decision: 'DENY' });

        const approved = await overrideReview(ta.reviews[0].id, boardId, 'approve', SHARED);
        expect(approved.status).toBe('APPROVED');

        const audit = await latestAudit(ta.id);
        expect(normalizeAuditData(audit?.oldData)).toMatchObject({ status: 'DENIED' });
        expect(normalizeAuditData(audit?.newData)).toMatchObject({ status: 'APPROVED', override: 'approve' });
    });

    it('re-overrides an already-overridden terminal review with no phase guard', async () => {
        const ta = await discloseOne();
        await overrideReview(ta.reviews[0].id, boardId, 'revoke'); // terminal: REVOKED

        // No wrong_phase / throw — board can flip a terminal review again.
        const reapproved = await overrideReview(ta.reviews[0].id, boardId, 'approve', SHARED);
        expect(reapproved.status).toBe('APPROVED');

        const audit = await latestAudit(ta.id);
        expect(normalizeAuditData(audit?.oldData)).toMatchObject({ status: 'REVOKED' });
        expect(normalizeAuditData(audit?.newData)).toMatchObject({ status: 'APPROVED', override: 'approve' });
    });

    // Conflict of interest on the OVERRIDE path — mirrors decideReview's rule, and no
    // role is exempt. A board member who leads the disclosing household must not override
    // its own review (they'd force-approve their own trusted adult); nor may a sysadmin.
    it('refuses a board member overriding their OWN household review, leaving DB + audit untouched', async () => {
        const ta = await discloseOne();
        const reviewId = ta.reviews[0].id;
        const before = await prisma.trustedAdultReview.findUnique({ where: { id: reviewId } });
        const auditBefore = await latestAudit(ta.id);

        await expect(overrideReview(reviewId, boardLeadId, 'approve', SHARED)).rejects.toMatchObject({ code: 'forbidden' });

        // State machine and audit log both unchanged — the rejected override wrote nothing.
        const after = await prisma.trustedAdultReview.findUnique({ where: { id: reviewId } });
        expect(after!.status).toBe(before!.status);
        expect(after!.decidedById).toBeNull();
        const auditAfter = await latestAudit(ta.id);
        expect(auditAfter?.id).toBe(auditBefore?.id); // no new audit row appended
    });

    it('allows a cross-household board member to override (no conflict)', async () => {
        const ta = await discloseOne(); // householdId; boardId lives in a different household
        const revoked = await overrideReview(ta.reviews[0].id, boardId, 'revoke');
        expect(revoked.status).toBe('REVOKED');
    });

    // decideReview acts ONLY on PENDING_BOARD_REVIEW (unlike overrideReview, which has
    // no phase guard). Deciding any other state is a no-op 409 — pin that for each
    // non-pending status, asserting the status is untouched and no audit row is written.
    it('decideReview on a non-PENDING_BOARD_REVIEW review is wrong_phase, status unchanged, no new audit', async () => {
        for (const status of ['APPROVED', 'DENIED', 'REVOKED', 'EXPIRED', 'PENDING_SUBJECT_ACTION'] as const) {
            const ta = await discloseOne();
            const reviewId = ta.reviews[0].id;
            await prisma.trustedAdultReview.update({ where: { id: reviewId }, data: { status } });
            const auditBefore = await prisma.auditLog.count({ where: { tableName: 'TrustedAdult', affectedEntityId: ta.id } });

            // DENY needs no sharedNote, so it reaches the phase guard (not bad_input first).
            await expect(decideReview(reviewId, boardId, { decision: 'DENY' })).rejects.toMatchObject({ code: 'wrong_phase' });

            const after = await prisma.trustedAdultReview.findUnique({ where: { id: reviewId } });
            expect(after!.status).toBe(status); // untouched
            expect(await prisma.auditLog.count({ where: { tableName: 'TrustedAdult', affectedEntityId: ta.id } })).toBe(auditBefore);
        }
    });

    // PENDING_SUBJECT_ACTION (board asked for info) is a dead-end in the service: there is
    // NO resubmit/re-decide path. The board can't re-decide (wrong_phase), the family can't
    // open a fresh review (already_open) — the only exits are withdraw or board override.
    it('PENDING_SUBJECT_ACTION is a dead-end: no re-decide, no renew; only withdraw/override exits it', async () => {
        const ta = await discloseOne();
        const reviewId = ta.reviews[0].id;
        await decideReview(reviewId, boardId, { decision: 'REQUEST_INFO', note: 'Need dates.' });
        expect((await prisma.trustedAdultReview.findUnique({ where: { id: reviewId } }))!.status).toBe('PENDING_SUBJECT_ACTION');

        // Board can't re-decide it; family can't open a parallel review while one is in flight.
        await expect(decideReview(reviewId, boardId, { decision: 'DENY' })).rejects.toMatchObject({ code: 'wrong_phase' });
        await expect(renewTrustedAdult(ta.id, leadId)).rejects.toMatchObject({ code: 'already_open' });

        // The escape hatch: a lead can withdraw it → REVOKED.
        const withdrawn = await withdrawTrustedAdult(ta.id, leadId);
        expect(withdrawn.status).toBe('REVOKED');
    });
});

// Edge cases for the nightly expiry sweep. runExpirySweep returns DB-wide
// warned/expired counts, so these use exact === assertions — a loose >= would hide
// a sweep that double-counts or mis-targets. That exactness is safe only because no
// other APPROVED rows qualify during a run: this describe runs after the block
// above (whose afterAll already wiped its rows) and the seed creates no trusted
// adults, so the only qualifiers are the rows each test crafts under SWEEP_TAG.
describe('runExpirySweep edge cases', () => {
    const SWEEP_TAG = 'trustedadult-sweep-test';
    const DAY = 86400000;
    let householdId = 0;
    let leadId = 0;

    async function wipe() {
        const hhs = await prisma.household.findMany({ where: { name: { contains: SWEEP_TAG } }, select: { id: true } });
        const ids = hhs.map((h) => h.id);
        if (ids.length) {
            await prisma.trustedAdultReview.deleteMany({ where: { householdId: { in: ids } } });
            await prisma.trustedAdult.deleteMany({ where: { householdId: { in: ids } } });
        }
        await prisma.person.deleteMany({ where: { householdId: { in: ids } } });
        await prisma.household.deleteMany({ where: { id: { in: ids } } });
    }

    // Create a review in any status with a chosen reviewBy — bypasses the service so
    // we can seed DENIED/REVOKED/PENDING rows the public API never produces directly.
    async function seedReview(
        status: 'APPROVED' | 'PENDING_BOARD_REVIEW' | 'DENIED' | 'REVOKED',
        reviewBy: Date | null,
        expiryWarningSentAt: Date | null = null,
    ) {
        const ta = await prisma.trustedAdult.create({
            data: {
                householdId,
                trustedAdultName: `Sweep ${SWEEP_TAG}`,
                trustedAdultEmail: 'sweep@example.com',
                familyContext: 'ctx',
                disclosedById: leadId,
            },
        });
        return prisma.trustedAdultReview.create({
            data: { householdId, trustedAdultId: ta.id, kind: 'INITIAL', status, reviewBy, expiryWarningSentAt },
        });
    }

    beforeAll(async () => {
        await wipe();
        const hh = await prisma.household.create({ data: { name: `Sweep HH ${SWEEP_TAG}` } });
        householdId = hh.id;
        const lead = await prisma.person.create({ data: { name: 'SweepLead', email: `sweeplead-${SWEEP_TAG}@ex.com`, householdId: hh.id } });
        leadId = lead.id;
        await prisma.person.update({ where: { id: lead.id }, data: { isHouseholdLead: true } });
    });

    afterAll(async () => {
        await wipe();
        await prisma.$disconnect();
    });

    // Each test crafts its own rows, so clear them (and the email spy) between tests.
    beforeEach(async () => {
        await prisma.trustedAdultReview.deleteMany({ where: { householdId } });
        await prisma.trustedAdult.deleteMany({ where: { householdId } });
        sendEmail.mockClear();
    });

    it('ignores non-APPROVED reviews even when reviewBy has passed', async () => {
        const now = new Date();
        const past = new Date(now.getTime() - 5 * DAY);
        const pending = await seedReview('PENDING_BOARD_REVIEW', past);
        const denied = await seedReview('DENIED', past);
        const revoked = await seedReview('REVOKED', past);

        const run = await runExpirySweep(now);
        expect(run.warned).toBe(0);
        expect(run.expired).toBe(0);
        expect(sendEmail).not.toHaveBeenCalled();

        for (const r of [pending, denied, revoked]) {
            const after = await prisma.trustedAdultReview.findUnique({ where: { id: r.id } });
            expect(after!.status).toBe(r.status); // untouched
            expect(after!.expiryWarningSentAt).toBeNull(); // no warn stamp
        }
    });

    it('warns once: a second sweep returns warned 0 and sends no second email', async () => {
        const now = new Date();
        const soon = new Date(now.getTime() + 10 * DAY); // inside the 30-day warn window, still future
        const r = await seedReview('APPROVED', soon);

        const first = await runExpirySweep(now);
        expect(first.warned).toBe(1);
        expect(first.expired).toBe(0);
        expect(sendEmail).toHaveBeenCalledTimes(1);
        expect(sendEmail).toHaveBeenCalledWith(`sweeplead-${SWEEP_TAG}@ex.com`, expect.stringContaining('expiring'), expect.any(String));
        const warned = await prisma.trustedAdultReview.findUnique({ where: { id: r.id } });
        expect(warned!.expiryWarningSentAt).not.toBeNull();

        sendEmail.mockClear();
        const second = await runExpirySweep(now);
        expect(second.warned).toBe(0); // guard holds
        expect(second.expired).toBe(0);
        expect(sendEmail).not.toHaveBeenCalled();
    });

    // Regression (#1618): "expiring" is per adult, not per review. An adult who renewed
    // early carries a stale in-window approval PLUS a live renewal that outlives it — the
    // renewal is their current authorization, so the stale row must NOT trigger a warning.
    // A genuinely single expiring approval still must.
    it('warns once per ADULT on the current authorization: a live renewal suppresses the stale in-window row', async () => {
        const now = new Date();
        const soon = new Date(now.getTime() + 10 * DAY); // inside the 30-day warn window
        const far = new Date(now.getTime() + 300 * DAY); // well past it

        // Adult A: renewed early — stale approval in the window, renewal far out.
        const renewedTa = await prisma.trustedAdult.create({
            data: { householdId, trustedAdultName: `Renewed ${SWEEP_TAG}`, trustedAdultEmail: 'r@example.com', familyContext: 'ctx', disclosedById: leadId },
        });
        const staleRow = await prisma.trustedAdultReview.create({
            data: { householdId, trustedAdultId: renewedTa.id, kind: 'INITIAL', status: 'APPROVED', reviewBy: soon },
        });
        await prisma.trustedAdultReview.create({
            data: { householdId, trustedAdultId: renewedTa.id, kind: 'RENEWAL', status: 'APPROVED', reviewBy: far },
        });

        // Adult B: one approval, in the window, nothing behind it — genuinely expiring.
        const lone = await seedReview('APPROVED', soon);

        const run = await runExpirySweep(now);

        // Only adult B is warned. Adult A's stale row is superseded — not warned, not stamped.
        expect(run.warned).toBe(1);
        expect((await prisma.trustedAdultReview.findUnique({ where: { id: staleRow.id } }))!.expiryWarningSentAt).toBeNull();
        expect((await prisma.trustedAdultReview.findUnique({ where: { id: lone.id } }))!.expiryWarningSentAt).not.toBeNull();
        expect(sendEmail).toHaveBeenCalledTimes(1);
        expect(sendEmail).toHaveBeenCalledWith(`sweeplead-${SWEEP_TAG}@ex.com`, expect.stringContaining('expiring'), expect.any(String));
    });

    it('expires at the boundary: reviewBy == now and reviewBy in the past both EXPIRE, never warn', async () => {
        const now = new Date();
        const atNow = await seedReview('APPROVED', new Date(now.getTime())); // reviewBy === now → lte:now, not gt:now
        const past = await seedReview('APPROVED', new Date(now.getTime() - 1 * DAY)); // already lapsed

        const run = await runExpirySweep(now);
        expect(run.warned).toBe(0); // boundary row expires, it does not get a fresh warning
        expect(run.expired).toBe(2);
        // Each expiry emails the family; neither row gets the 30-days-out warning.
        expect(sendEmail).toHaveBeenCalledTimes(2);
        expect(sendEmail).not.toHaveBeenCalledWith(expect.anything(), expect.stringContaining('expiring'), expect.anything());

        for (const r of [atNow, past]) {
            const after = await prisma.trustedAdultReview.findUnique({ where: { id: r.id } });
            expect(after!.status).toBe('EXPIRED');
            expect(after!.expiryWarningSentAt).toBeNull(); // expired, never warned
        }
    });

    // Regression: renewing early leaves the adult with TWO APPROVED reviews (renew never
    // retires the prior one). When the OLD row lapses the sweep must still expire it, but
    // the family is NOT de-authorized — /operational lists a TA while ANY review is
    // APPROVED. Asserts both directions so the fix can't be "stop emailing".
    it('a renewed adult whose old review lapses gets no de-authorization email; a genuinely lapsed one still does', async () => {
        const now = new Date();
        const past = new Date(now.getTime() - 1 * DAY);
        const future = new Date(now.getTime() + 300 * DAY);

        // Adult A: original approval lapsing now, plus a board-approved renewal still live.
        const renewedTa = await prisma.trustedAdult.create({
            data: { householdId, trustedAdultName: `Renewed Grandma ${SWEEP_TAG}`, trustedAdultEmail: 'gran@example.com', familyContext: 'ctx', disclosedById: leadId },
        });
        const staleRow = await prisma.trustedAdultReview.create({
            data: { householdId, trustedAdultId: renewedTa.id, kind: 'INITIAL', status: 'APPROVED', reviewBy: past },
        });
        const renewalRow = await prisma.trustedAdultReview.create({
            data: { householdId, trustedAdultId: renewedTa.id, kind: 'RENEWAL', status: 'APPROVED', reviewBy: future },
        });

        // Adult B: one approval, lapsed, nothing behind it — genuinely de-authorized.
        const lapsedRow = await seedReview('APPROVED', past);

        const run = await runExpirySweep(now);

        // Both stale rows flip: expiry is per-review bookkeeping and is unchanged.
        expect(run.expired).toBe(2);
        expect((await prisma.trustedAdultReview.findUnique({ where: { id: staleRow.id } }))!.status).toBe('EXPIRED');
        expect((await prisma.trustedAdultReview.findUnique({ where: { id: lapsedRow.id } }))!.status).toBe('EXPIRED');
        // The renewal is untouched, so /operational's `some: APPROVED` rule still lists adult A.
        expect((await prisma.trustedAdultReview.findUnique({ where: { id: renewalRow.id } }))!.status).toBe('APPROVED');
        expect(await prisma.trustedAdult.count({ where: { id: renewedTa.id, reviews: { some: { status: 'APPROVED' } } } })).toBe(1);
        // ...and adult B really is off the list.
        expect(await prisma.trustedAdult.count({ where: { id: lapsedRow.trustedAdultId, reviews: { some: { status: 'APPROVED' } } } })).toBe(0);

        // Direction 1: the genuinely lapsed adult's family is still told.
        expect(sendEmail).toHaveBeenCalledWith(
            `sweeplead-${SWEEP_TAG}@ex.com`,
            `Trusted adult approval expired: Sweep ${SWEEP_TAG}`,
            expect.stringContaining('no longer authorized at the front desk'),
        );
        // Direction 2: the renewed adult's family is NOT told they lost someone they still have.
        expect(sendEmail).not.toHaveBeenCalledWith(expect.anything(), expect.stringContaining('Renewed Grandma'), expect.anything());
        expect(sendEmail).toHaveBeenCalledTimes(1);
    });

    // Pins "one notice per ADULT, not one per row" — a property of statement ORDER: each
    // row's flip commits before the next row's authorization check reads, so only the last
    // row to lapse finds no approval and mails. Batch the flips into one upfront
    // transaction and every row sees zero approvals: one email per row again. The
    // `expired` assertion pins the other half — `continue` stays AFTER `expired++`, so
    // per-review bookkeeping is byte-identical to the pre-fix behaviour.
    it('two lapsed reviews on ONE adult expire both rows but send exactly one de-authorization email', async () => {
        const now = new Date();
        const ta = await prisma.trustedAdult.create({
            data: { householdId, trustedAdultName: `Twice Lapsed ${SWEEP_TAG}`, trustedAdultEmail: 'twice@example.com', familyContext: 'ctx', disclosedById: leadId },
        });
        // A year-old original and the renewal that replaced it, both now past reviewBy.
        const older = await prisma.trustedAdultReview.create({
            data: { householdId, trustedAdultId: ta.id, kind: 'INITIAL', status: 'APPROVED', reviewBy: new Date(now.getTime() - 400 * DAY) },
        });
        const newer = await prisma.trustedAdultReview.create({
            data: { householdId, trustedAdultId: ta.id, kind: 'RENEWAL', status: 'APPROVED', reviewBy: new Date(now.getTime() - 1 * DAY) },
        });

        const run = await runExpirySweep(now);

        // Per-review bookkeeping unchanged: both rows counted, both flipped.
        expect(run.expired).toBe(2);
        expect((await prisma.trustedAdultReview.findUnique({ where: { id: older.id } }))!.status).toBe('EXPIRED');
        expect((await prisma.trustedAdultReview.findUnique({ where: { id: newer.id } }))!.status).toBe('EXPIRED');
        // The adult really is de-authorized now, so the notice is owed — exactly once.
        expect(await prisma.trustedAdult.count({ where: { id: ta.id, reviews: { some: { status: 'APPROVED' } } } })).toBe(0);
        expect(sendEmail).toHaveBeenCalledTimes(1);
        expect(sendEmail).toHaveBeenCalledWith(
            `sweeplead-${SWEEP_TAG}@ex.com`,
            `Trusted adult approval expired: Twice Lapsed ${SWEEP_TAG}`,
            expect.stringContaining('no longer authorized at the front desk'),
        );
    });
});
