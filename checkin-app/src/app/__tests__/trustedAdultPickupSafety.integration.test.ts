/**
 * @jest-environment node
 */
/**
 * Who stays on the pickup list. One live approval per adult, a Board override that
 * takes the adult off the list, a stale force-approve that cannot put them back,
 * and an expiry date that counts without waiting for the nightly sweep.
 */

import { GET as OPERATIONAL } from '@/app/api/trusted-adults/operational/route';
import {
    createTrustedAdult,
    decideReview,
    overrideReview,
    renewTrustedAdult,
    resubmitWithChanges,
    runExpirySweep,
    withdrawTrustedAdult,
    TrustedAdultError,
} from '@/lib/trusted-adult/service';
import prisma from '@/lib/prisma';
import { getServerSession } from 'next-auth/next';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));
const sendEmail = jest.fn().mockResolvedValue(true);
jest.mock('@/lib/email', () => ({
    sendEmail: (...a: unknown[]) => sendEmail(...a),
    runPaced: (tasks: Array<() => Promise<unknown>>) => Promise.all(tasks.map((t) => t())),
}));

const TAG = 'trustedadult-pickup-safety-test';
const SHARED = 'Grandma may pick up the kids.';
const DAY_MS = 86400000;

describe('trusted-adult pickup list safety', () => {
    let householdId = 0;
    let leadId = 0;
    let boardId = 0;
    let boardHouseholdId = 0;

    async function wipe() {
        const hhs = await prisma.household.findMany({ where: { name: { contains: TAG } }, select: { id: true } });
        const ids = hhs.map((h) => h.id);
        if (ids.length) {
            await prisma.trustedAdultReview.deleteMany({ where: { householdId: { in: ids } } });
            await prisma.trustedAdult.deleteMany({ where: { householdId: { in: ids } } });
            await prisma.orgMembership.deleteMany({ where: { householdId: { in: ids } } });
            await prisma.person.deleteMany({ where: { householdId: { in: ids } } });
            await prisma.household.deleteMany({ where: { id: { in: ids } } });
        }
    }

    beforeAll(async () => {
        await wipe();
        const hh = await prisma.household.create({ data: { name: `Family HH ${TAG}` } });
        householdId = hh.id;
        leadId = (await prisma.person.create({
            data: { name: 'Lead', email: `lead-${TAG}@ex.com`, householdId, isHouseholdLead: true },
        })).id;
        const boardHh = await prisma.household.create({ data: { name: `Board HH ${TAG}` } });
        boardHouseholdId = boardHh.id;
        boardId = (await prisma.person.create({
            data: { name: 'Boardie', email: `board-${TAG}@ex.com`, isBoardMember: true, householdId: boardHh.id },
        })).id;
    });

    afterAll(async () => {
        await wipe();
        await prisma.$disconnect();
    });

    beforeEach(async () => {
        jest.restoreAllMocks();
        sendEmail.mockClear();
        await prisma.trustedAdultReview.deleteMany({ where: { householdId } });
        await prisma.trustedAdult.deleteMany({ where: { householdId } });
        await prisma.orgMembership.deleteMany({ where: { householdId } });
    });

    const disclose = () =>
        createTrustedAdult({
            householdId,
            trustedAdultName: 'Jane External',
            trustedAdultEmail: 'jane@example.com',
            familyContext: 'Our nanny; may collect the kids.',
            disclosedById: leadId,
        });

    async function discloseApproved() {
        const ta = await disclose();
        await decideReview(ta.reviews[0].id, boardId, { decision: 'APPROVE', sharedNote: SHARED });
        return { taId: ta.id, firstReviewId: ta.reviews[0].id };
    }

    async function onPickupList(taId: number): Promise<boolean> {
        (getServerSession as jest.Mock).mockResolvedValue({
            user: { id: boardId, householdId: boardHouseholdId, isSysadmin: false, isBoardMember: true, isKeyholder: false, isBackgroundCheckReviewer: false },
        });
        const body = await (await OPERATIONAL(new Request('http://localhost:4000/api/trusted-adults/operational') as never)).json();
        return body.trustedAdults.some((t: { id: number }) => t.id === taId);
    }

    const statuses = async (taId: number) =>
        (await prisma.trustedAdultReview.findMany({ where: { trustedAdultId: taId }, orderBy: { id: 'asc' } })).map((r) => String(r.status));

    const lapse = (reviewId: number) =>
        prisma.trustedAdultReview.update({ where: { id: reviewId }, data: { reviewBy: new Date(Date.now() - DAY_MS) } });

    describe('one live approval per adult', () => {
        it('approving a renewal retires the prior approval, and audits it', async () => {
            const { taId, firstReviewId } = await discloseApproved();
            const renewal = await renewTrustedAdult(taId, leadId);
            await decideReview(renewal.id, boardId, { decision: 'APPROVE', sharedNote: SHARED });

            expect(await statuses(taId)).toEqual(['SUPERSEDED', 'APPROVED']);
            const audits = await prisma.auditLog.findMany({ where: { tableName: 'TrustedAdult', affectedEntityId: taId } });
            expect(audits.some((a) => JSON.stringify(a.newData).includes('SUPERSEDED') && JSON.stringify(a.newData).includes(String(firstReviewId)))).toBe(true);
        });

        it('approving a MODIFIED review retires the prior approval', async () => {
            const { taId } = await discloseApproved();
            const changed = await resubmitWithChanges(taId, leadId, {
                trustedAdultName: 'Jane Changed',
                trustedAdultEmail: 'jane@example.com',
                familyContext: 'Updated.',
            });
            await decideReview(changed.id, boardId, { decision: 'APPROVE', sharedNote: SHARED });
            expect(await statuses(taId)).toEqual(['SUPERSEDED', 'APPROVED']);
        });

        it('a pending renewal leaves the prior approval live', async () => {
            const { taId } = await discloseApproved();
            await renewTrustedAdult(taId, leadId);
            expect(await statuses(taId)).toEqual(['APPROVED', 'PENDING_BOARD_REVIEW']);
            expect(await onPickupList(taId)).toBe(true);
        });
    });

    describe('Board override', () => {
        it('revoking a renewed adult takes them off the pickup list', async () => {
            const { taId } = await discloseApproved();
            const renewal = await renewTrustedAdult(taId, leadId);
            await decideReview(renewal.id, boardId, { decision: 'APPROVE', sharedNote: SHARED });

            await overrideReview(renewal.id, boardId, 'revoke');

            expect(await onPickupList(taId)).toBe(false);
        });

        it('revoke on a declined change also ends the approval beneath it', async () => {
            const { taId } = await discloseApproved();
            const renewal = await renewTrustedAdult(taId, leadId);
            await decideReview(renewal.id, boardId, { decision: 'DENY' });
            expect(await onPickupList(taId)).toBe(true);

            await overrideReview(renewal.id, boardId, 'revoke');

            expect(await onPickupList(taId)).toBe(false);
        });

        it('force deny on an already-declined change is refused and leaves the approval standing, with no email', async () => {
            const { taId } = await discloseApproved();
            const renewal = await renewTrustedAdult(taId, leadId);
            await decideReview(renewal.id, boardId, { decision: 'DENY' });
            sendEmail.mockClear();

            await expect(overrideReview(renewal.id, boardId, 'deny')).rejects.toMatchObject({ code: 'wrong_phase' });

            expect(await statuses(taId)).toEqual(['APPROVED', 'DENIED']);
            expect(await onPickupList(taId)).toBe(true);
            expect(sendEmail).not.toHaveBeenCalled();
        });

        it('force deny on a pending change leaves the earlier approval standing', async () => {
            const { taId } = await discloseApproved();
            const renewal = await renewTrustedAdult(taId, leadId);

            await overrideReview(renewal.id, boardId, 'deny');

            expect(await statuses(taId)).toEqual(['APPROVED', 'DENIED']);
            expect(await onPickupList(taId)).toBe(true);
        });

        it('force deny on an approval also ends an older approval still on the adult', async () => {
            const { taId, firstReviewId } = await discloseApproved();
            const older = await prisma.trustedAdultReview.create({
                data: { trustedAdultId: taId, householdId, kind: 'RENEWAL', status: 'APPROVED', reviewBy: new Date(Date.now() + DAY_MS) },
            });

            await overrideReview(older.id, boardId, 'deny');

            expect(await statuses(taId)).toEqual(['REVOKED', 'DENIED']);
            expect(firstReviewId).toBeLessThan(older.id);
            expect(await onPickupList(taId)).toBe(false);
        });

        it('revoke from a stale page on a superseded review still ends the live approval', async () => {
            const { taId, firstReviewId } = await discloseApproved();
            const renewal = await renewTrustedAdult(taId, leadId);
            await decideReview(renewal.id, boardId, { decision: 'APPROVE', sharedNote: SHARED });

            await overrideReview(firstReviewId, boardId, 'revoke');

            expect(await onPickupList(taId)).toBe(false);
        });

        it('force-approve from a stale page refuses an adult the household withdrew', async () => {
            const { taId, firstReviewId } = await discloseApproved();
            await withdrawTrustedAdult(taId, leadId);

            await expect(overrideReview(firstReviewId, boardId, 'approve', SHARED)).rejects.toMatchObject({ code: 'wrong_phase' });

            expect(await statuses(taId)).toEqual(['REVOKED']);
            expect(await onPickupList(taId)).toBe(false);
        });

        it('force-approve refuses a review the household has since moved past', async () => {
            const ta = await disclose();
            await decideReview(ta.reviews[0].id, boardId, { decision: 'DENY' });
            await renewTrustedAdult(ta.id, leadId);

            await expect(overrideReview(ta.reviews[0].id, boardId, 'approve', SHARED)).rejects.toBeInstanceOf(TrustedAdultError);

            expect(await statuses(ta.id)).toEqual(['DENIED', 'PENDING_BOARD_REVIEW']);
        });

        it('force-approve refuses when the household is denied', async () => {
            const ta = await disclose();
            await decideReview(ta.reviews[0].id, boardId, { decision: 'DENY' });
            await prisma.orgMembership.create({ data: { householdId, status: 'DENIED' } });

            await expect(overrideReview(ta.reviews[0].id, boardId, 'approve', SHARED)).rejects.toMatchObject({ code: 'wrong_phase' });

            expect(await statuses(ta.id)).toEqual(['DENIED']);
        });

        it('force-approve retires any other live approval rather than colliding with it', async () => {
            const { taId } = await discloseApproved();
            const renewal = await renewTrustedAdult(taId, leadId);
            await decideReview(renewal.id, boardId, { decision: 'DENY' });

            await overrideReview(renewal.id, boardId, 'approve', SHARED);

            expect(await statuses(taId)).toEqual(['SUPERSEDED', 'APPROVED']);
        });
    });

    describe('expiry counts without the sweep', () => {
        it('a lapsed approval leaves the pickup list before any sweep runs', async () => {
            const { taId, firstReviewId } = await discloseApproved();
            expect(await onPickupList(taId)).toBe(true);

            await lapse(firstReviewId);

            expect(await statuses(taId)).toEqual(['APPROVED']);
            expect(await onPickupList(taId)).toBe(false);
        });

        it('denying a change does not tell the family a lapsed approval still stands', async () => {
            const { taId, firstReviewId } = await discloseApproved();
            const renewal = await renewTrustedAdult(taId, leadId);
            await lapse(firstReviewId);
            sendEmail.mockClear();

            await decideReview(renewal.id, boardId, { decision: 'DENY' });

            expect(sendEmail).toHaveBeenCalled();
            expect(JSON.stringify(sendEmail.mock.calls)).not.toContain('valid until');
        });

        it('Deny & Revoke also retires a lapsed approval, so the sweep sends no later "expired" email', async () => {
            const { taId, firstReviewId } = await discloseApproved();
            const renewal = await renewTrustedAdult(taId, leadId);
            await lapse(firstReviewId);

            await decideReview(renewal.id, boardId, { decision: 'DENY', revokePriorApprovals: true });

            expect(await statuses(taId)).toEqual(['REVOKED', 'DENIED']);
        });
    });

    describe('expiry sweep', () => {
        it('flips a lapsed approval and notifies the family once', async () => {
            const { taId, firstReviewId } = await discloseApproved();
            await lapse(firstReviewId);
            sendEmail.mockClear();

            const first = await runExpirySweep(new Date());
            expect(first.expired).toBe(1);
            expect(await statuses(taId)).toEqual(['EXPIRED']);
            const emails = sendEmail.mock.calls.length;
            expect(emails).toBeGreaterThan(0);

            await runExpirySweep(new Date());
            expect(sendEmail.mock.calls.length).toBe(emails);
        });

        it('a household denial committing between the read and the write stays revoked, with no expired email', async () => {
            const { taId, firstReviewId } = await discloseApproved();
            await lapse(firstReviewId);
            sendEmail.mockClear();

            // Revokes the row just after the sweep has read it as lapsed.
            type FindMany = (args: { where?: { reviewBy?: { lte?: Date; gt?: Date } } }) => Promise<unknown>;
            const delegate = prisma.trustedAdultReview as unknown as { findMany: FindMany };
            const realFindMany = delegate.findMany.bind(delegate);
            let raced = false;
            jest.spyOn(delegate, 'findMany').mockImplementation(async (args) => {
                const rows = await realFindMany(args);
                const readsLapsed = !!args.where?.reviewBy?.lte && !args.where.reviewBy.gt;
                if (readsLapsed && !raced) {
                    raced = true;
                    await prisma.trustedAdultReview.update({ where: { id: firstReviewId }, data: { status: 'REVOKED' } });
                }
                return rows;
            });
            const auditsBefore = await prisma.auditLog.count({ where: { tableName: 'TrustedAdult', affectedEntityId: taId } });

            const result = await runExpirySweep(new Date());

            expect(raced).toBe(true);
            expect(result.expired).toBe(0);
            expect(await statuses(taId)).toEqual(['REVOKED']);
            expect(sendEmail).not.toHaveBeenCalled();
            expect(await prisma.auditLog.count({ where: { tableName: 'TrustedAdult', affectedEntityId: taId } })).toBe(auditsBefore);
        });
    });
});
