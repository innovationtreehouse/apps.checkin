/**
 * @jest-environment node
 */
/**
 * settleHouseholdBg against a real database: a household's open application moves
 * only on its people's check standing (docs/in-design/person-based-bg-review.md §3.2).
 */
import type { OrgMembershipProcessStatus } from '@/generated/prisma/client';
import prisma from '@/lib/prisma';
import { settleHouseholdBg } from '@/lib/membership/settleHouseholdBg';
import { snapshotBoardSettings } from '@/test-helpers/boardSettings';
import { notifyBoardPaidReject } from '@/lib/membership/boardAlerts';

jest.mock('@/lib/email', () => ({ runPaced: (tasks: Array<() => Promise<unknown>>) => Promise.all(tasks.map((t) => t())), sendEmail: jest.fn().mockResolvedValue(true) }));
jest.mock('@/lib/finance/reconcile/liveOrder', () => ({
    recordUnreportedReversal: jest.fn().mockResolvedValue(undefined),
    recordUnreportedReversalOnProcess: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('@/lib/membership/boardAlerts', () => ({ notifyBoardPaidReject: jest.fn().mockResolvedValue(undefined), notifyBoardPaymentException: jest.fn().mockResolvedValue(undefined) }));

const TAG = 'settle-household-bg-test';
const FRESH = new Date();
const EXPIRED = new Date('2000-01-01T00:00:00Z');

let seq = 0;
let restoreBoardSettings: () => Promise<void> = async () => {};

async function family(opts: { leadCheck?: Date | null; otherCheck?: Date | null; membership?: 'NONE' | 'DENIED' | 'ACTIVE' } = {}) {
    const n = seq++;
    const household = await prisma.household.create({ data: { name: `${TAG} ${n}` } });
    const lead = await prisma.person.create({ data: { name: `Lead ${n}`, email: `lead-${n}-${TAG}@example.com`, householdId: household.id, isHouseholdLead: true, lastBackgroundCheck: opts.leadCheck === undefined ? FRESH : opts.leadCheck } });
    const other = await prisma.person.create({ data: { name: `Adult ${n}`, email: `adult-${n}-${TAG}@example.com`, householdId: household.id, lastBackgroundCheck: opts.otherCheck ?? null } });
    const membership = await prisma.orgMembership.create({ data: { householdId: household.id, status: opts.membership ?? 'NONE' } });
    return { householdId: household.id, leadId: lead.id, otherId: other.id, orgMembershipId: membership.id };
}

async function application(orgMembershipId: number, status: OrgMembershipProcessStatus, extra: { paidAt?: Date; kind?: 'INITIAL' | 'RENEWAL' } = {}) {
    const p = await prisma.orgMembershipProcess.create({ data: { orgMembershipId, kind: extra.kind ?? 'INITIAL', status, bgConsentAt: new Date(), paidAt: extra.paidAt ?? null } });
    return p.id;
}

async function checkReview(personId: number, status: OrgMembershipProcessStatus, sentBack?: 'board reset' | 'rejector changed to approve') {
    const p = await prisma.orgMembershipProcess.create({ data: { kind: 'PERSON_BG', subjectPersonId: personId, status, bgConsentAt: new Date() } });
    if (sentBack) await sendBack(p.id, sentBack);
    return p.id;
}

async function sendBack(reviewId: number, action: 'board reset' | 'rejector changed to approve', from: OrgMembershipProcessStatus = 'BLOCKED') {
    await prisma.orgMembershipProcess.update({ where: { id: reviewId }, data: { status: 'PENDING_BG_REVIEW' } });
    await prisma.auditLog.create({ data: { actorId: 0, action: 'EDIT', tableName: 'OrgMembershipProcess', affectedEntityId: reviewId, oldData: { status: from }, newData: { status: 'PENDING_BG_REVIEW', action } } });
}

/** The wrong-person reset: the review returns to no subject, then a reviewer names `personId`. */
async function renameSubject(reviewId: number, personId: number) {
    await prisma.orgMembershipProcess.update({ where: { id: reviewId }, data: { status: 'PENDING_BG_REVIEW', subjectPersonId: null } });
    await prisma.auditLog.create({ data: { actorId: 0, action: 'EDIT', tableName: 'OrgMembershipProcess', affectedEntityId: reviewId, oldData: { status: 'BLOCKED' }, newData: { status: 'PENDING_BG_REVIEW', action: 'board reset', subjectPersonId: null } } });
    await prisma.orgMembershipProcess.update({ where: { id: reviewId }, data: { subjectPersonId: personId } });
}

const row = (id: number) => prisma.orgMembershipProcess.findUniqueOrThrow({ where: { id } });

async function wipe() {
    const households = await prisma.household.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
    const ids = households.map((h) => h.id);
    const people = await prisma.person.findMany({ where: { email: { contains: TAG } }, select: { id: true } });
    const personIds = people.map((p) => p.id);
    const processes = await prisma.orgMembershipProcess.findMany({ where: { OR: [{ orgMembership: { householdId: { in: ids } } }, { subjectPersonId: { in: personIds } }, { requestedForHouseholdId: { in: ids } }] }, select: { id: true } });
    const processIds = processes.map((p) => p.id);
    const memberships = await prisma.orgMembership.findMany({ where: { householdId: { in: ids } }, select: { id: true } });
    await prisma.backgroundCheckAttestation.deleteMany({ where: { processId: { in: processIds } } });
    await prisma.auditLog.deleteMany({ where: { OR: [{ tableName: 'OrgMembershipProcess', affectedEntityId: { in: processIds } }, { tableName: 'OrgMembership', affectedEntityId: { in: memberships.map((m) => m.id) } }] } });
    await prisma.paymentException.deleteMany({ where: { processId: { in: processIds } } });
    await prisma.orgMembershipProcess.deleteMany({ where: { id: { in: processIds } } });
    await prisma.orgMembership.deleteMany({ where: { householdId: { in: ids } } });
    await prisma.person.deleteMany({ where: { id: { in: personIds } } });
    await prisma.household.deleteMany({ where: { id: { in: ids } } });
}

beforeAll(async () => {
    restoreBoardSettings = await snapshotBoardSettings();
    await prisma.boardSettings.upsert({
        where: { id: 1 },
        create: { id: 1, orgMembershipYearBoundary: new Date('2000-09-01T00:00:00Z'), bgRecheckMonths: 29 },
        update: { orgMembershipYearBoundary: new Date('2000-09-01T00:00:00Z'), bgRecheckMonths: 29 },
    });
    await wipe();
});

afterAll(async () => {
    await wipe();
    await restoreBoardSettings();
    await prisma.$disconnect();
});

beforeEach(() => jest.mocked(notifyBoardPaidReject).mockClear());

describe('settleHouseholdBg — clearing', () => {
    it('does nothing for a household with no open application', async () => {
        const f = await family();
        expect(await settleHouseholdBg(f.householdId)).toEqual([]);
    });

    it('stamps a waiting unpaid application cleared and leaves its step', async () => {
        const f = await family();
        const id = await application(f.orgMembershipId, 'PENDING_PAYMENT');
        expect(await settleHouseholdBg(f.householdId)).toEqual(['cleared']);
        const p = await row(id);
        expect(p.status).toBe('PENDING_PAYMENT');
        expect(p.bgClearedAt).not.toBeNull();
    });

    it('stamps an application at the external step without moving it', async () => {
        const f = await family();
        const id = await application(f.orgMembershipId, 'PENDING_EXTERNAL_ACTION');
        expect(await settleHouseholdBg(f.householdId)).toEqual(['cleared']);
        const p = await row(id);
        expect(p.bgClearedAt).not.toBeNull();
        expect(p.status).toBe('PENDING_EXTERNAL_ACTION'); // agreement unsigned
    });

    it('activates a paid application held on its check, and the household with it', async () => {
        const f = await family();
        const id = await application(f.orgMembershipId, 'PENDING_BG_CLEARANCE', { paidAt: new Date(), kind: 'RENEWAL' });
        expect(await settleHouseholdBg(f.householdId)).toEqual(['cleared']);
        expect((await row(id)).status).toBe('ACTIVE');
        expect((await prisma.orgMembership.findUniqueOrThrow({ where: { id: f.orgMembershipId } })).status).toBe('ACTIVE');
    });

    it('moves an unpaid application held in review on to payment', async () => {
        const f = await family();
        const id = await application(f.orgMembershipId, 'PENDING_BG_REVIEW');
        expect(await settleHouseholdBg(f.householdId)).toEqual(['cleared']);
        expect((await row(id)).status).toBe('PENDING_PAYMENT');
    });

    it('does not clear on an expired lead check, nor on a cleared non-lead alone', async () => {
        const f = await family({ leadCheck: EXPIRED, otherCheck: FRESH });
        const id = await application(f.orgMembershipId, 'PENDING_PAYMENT');
        expect(await settleHouseholdBg(f.householdId)).toEqual([]);
        expect((await row(id)).bgClearedAt).toBeNull();
    });

    it('holds the clearance while an adult\'s review is reset and waiting, without blocking', async () => {
        const f = await family();
        await checkReview(f.otherId, 'BLOCKED', 'board reset');
        const id = await application(f.orgMembershipId, 'PENDING_PAYMENT');
        expect(await settleHouseholdBg(f.householdId)).toEqual([]);
        const p = await row(id);
        expect(p.status).toBe('PENDING_PAYMENT');
        expect(p.bgClearedAt).toBeNull();
    });

    it('clears when an adult\'s review was reset from an approval, not a rejection', async () => {
        const f = await family();
        const reviewId = await checkReview(f.otherId, 'PENDING_BG_REVIEW');
        await sendBack(reviewId, 'board reset', 'PENDING_BG_REVIEW');
        const id = await application(f.orgMembershipId, 'PENDING_PAYMENT');
        expect(await settleHouseholdBg(f.householdId)).toEqual(['cleared']);
        expect((await row(id)).bgClearedAt).not.toBeNull();
    });

    it('does not carry a reset rejection onto the next person named on that review', async () => {
        const f = await family();
        const elsewhere = await family();
        const reviewId = await checkReview(elsewhere.otherId, 'BLOCKED', 'board reset');
        await renameSubject(reviewId, f.otherId);
        const id = await application(f.orgMembershipId, 'PENDING_PAYMENT');
        expect(await settleHouseholdBg(f.householdId)).toEqual(['cleared']);
        expect((await row(id)).bgClearedAt).not.toBeNull();
    });

    it('holds the clearance while a review requested for the household names nobody yet', async () => {
        const f = await family();
        await prisma.orgMembershipProcess.create({ data: { kind: 'PERSON_BG', requestedForHouseholdId: f.householdId, status: 'PENDING_BG_REVIEW', bgConsentAt: new Date() } });
        const id = await application(f.orgMembershipId, 'PENDING_PAYMENT');
        expect(await settleHouseholdBg(f.householdId)).toEqual([]);
        expect((await row(id)).bgClearedAt).toBeNull();
    });

    it('holds the clearance after a change to approve was undone', async () => {
        const f = await family();
        await checkReview(f.leadId, 'BLOCKED', 'rejector changed to approve');
        const id = await application(f.orgMembershipId, 'PENDING_PAYMENT');
        expect(await settleHouseholdBg(f.householdId)).toEqual([]);
        expect((await row(id)).bgClearedAt).toBeNull();
    });
});

describe('settleHouseholdBg — blocking and resuming', () => {
    it('blocks an open application when a non-lead adult\'s review is rejected, naming the review', async () => {
        const f = await family();
        const reviewId = await checkReview(f.otherId, 'BLOCKED');
        const id = await application(f.orgMembershipId, 'PENDING_BG_CLEARANCE', { paidAt: new Date() });
        expect(await settleHouseholdBg(f.householdId)).toEqual(['blocked']);
        expect((await row(id)).status).toBe('BLOCKED');
        const audit = await prisma.auditLog.findFirstOrThrow({ where: { tableName: 'OrgMembershipProcess', affectedEntityId: id }, orderBy: { id: 'desc' } });
        expect(audit.newData).toMatchObject({ status: 'BLOCKED', blockingReviewIds: [reviewId] });
        expect(notifyBoardPaidReject).toHaveBeenCalledWith(id);
    });

    it('drops an earlier clearance when a blocked application resumes, so payment cannot activate it', async () => {
        const f = await family();
        const id = await application(f.orgMembershipId, 'PENDING_PAYMENT');
        expect(await settleHouseholdBg(f.householdId)).toEqual(['cleared']);
        expect((await row(id)).bgClearedAt).not.toBeNull();

        const reviewId = await checkReview(f.otherId, 'BLOCKED');
        expect(await settleHouseholdBg(f.householdId)).toEqual(['blocked']);
        await sendBack(reviewId, 'board reset');
        expect(await settleHouseholdBg(f.householdId)).toEqual(['resumed']);
        const p = await row(id);
        expect(p.status).toBe('PENDING_PAYMENT');
        expect(p.bgClearedAt).toBeNull();
    });

    it('resumes and clears in one pass once the rejected adult has left and a lead is cleared', async () => {
        const f = await family();
        const reviewId = await checkReview(f.otherId, 'BLOCKED');
        const id = await application(f.orgMembershipId, 'PENDING_PAYMENT');
        await settleHouseholdBg(f.householdId);
        const elsewhere = await prisma.household.create({ data: { name: `${TAG} elsewhere ${seq++}` } });
        await prisma.person.update({ where: { id: f.otherId }, data: { householdId: elsewhere.id } });
        await sendBack(reviewId, 'board reset');
        expect(await settleHouseholdBg(f.householdId)).toEqual(['resumed', 'cleared']);
        expect((await row(id)).bgClearedAt).not.toBeNull();
    });

    it('resumes once the rejection is reset, and clears only when the person clears', async () => {
        const f = await family();
        const reviewId = await checkReview(f.otherId, 'BLOCKED');
        const id = await application(f.orgMembershipId, 'PENDING_PAYMENT');
        expect(await settleHouseholdBg(f.householdId)).toEqual(['blocked']);

        await sendBack(reviewId, 'board reset');
        expect(await settleHouseholdBg(f.householdId)).toEqual(['resumed']);
        let p = await row(id);
        expect(p.status).toBe('PENDING_PAYMENT');
        expect(p.bgClearedAt).toBeNull();

        await prisma.orgMembershipProcess.update({ where: { id: reviewId }, data: { status: 'ACTIVE', bgClearedAt: new Date() } });
        await prisma.person.update({ where: { id: f.otherId }, data: { lastBackgroundCheck: new Date() } });
        expect(await settleHouseholdBg(f.householdId)).toEqual(['cleared']);
        p = await row(id);
        expect(p.bgClearedAt).not.toBeNull();
    });

    it('stays blocked when the rejected adult leaves the household', async () => {
        const f = await family();
        await checkReview(f.otherId, 'BLOCKED');
        const id = await application(f.orgMembershipId, 'PENDING_PAYMENT');
        await settleHouseholdBg(f.householdId);
        const elsewhere = await prisma.household.create({ data: { name: `${TAG} elsewhere ${seq++}` } });
        await prisma.person.update({ where: { id: f.otherId }, data: { householdId: elsewhere.id } });
        expect(await settleHouseholdBg(f.householdId)).toEqual([]);
        expect((await row(id)).status).toBe('BLOCKED');
    });

    it('keeps a second rejection that arrives while blocked, even after that adult leaves', async () => {
        const f = await family();
        const first = await checkReview(f.leadId, 'BLOCKED');
        const id = await application(f.orgMembershipId, 'PENDING_PAYMENT');
        await settleHouseholdBg(f.householdId);
        await checkReview(f.otherId, 'BLOCKED');
        expect(await settleHouseholdBg(f.householdId)).toEqual([]);

        const elsewhere = await prisma.household.create({ data: { name: `${TAG} elsewhere ${seq++}` } });
        await prisma.person.update({ where: { id: f.otherId }, data: { householdId: elsewhere.id } });
        await sendBack(first, 'board reset');
        expect(await settleHouseholdBg(f.householdId)).toEqual([]);
        expect((await row(id)).status).toBe('BLOCKED');
    });

    it('leaves an application blocked by a household attestation alone', async () => {
        const f = await family();
        const id = await application(f.orgMembershipId, 'BLOCKED');
        expect(await settleHouseholdBg(f.householdId)).toEqual([]);
        expect((await row(id)).status).toBe('BLOCKED');
    });

    it('never moves a denied household\'s application, whatever its people\'s reviews do', async () => {
        const f = await family({ membership: 'DENIED' });
        const reviewId = await checkReview(f.otherId, 'PENDING_BG_REVIEW', 'board reset');
        const id = await application(f.orgMembershipId, 'BLOCKED');
        await prisma.auditLog.create({ data: { actorId: 0, action: 'EDIT', tableName: 'OrgMembershipProcess', affectedEntityId: id, oldData: { status: 'PENDING_PAYMENT' }, newData: { status: 'BLOCKED', reason: 'check review rejected', blockingReviewIds: [reviewId] } } });
        expect(await settleHouseholdBg(f.householdId)).toEqual(['denied']);
        expect((await row(id)).status).toBe('BLOCKED');

        const g = await family({ membership: 'DENIED' });
        const waiting = await application(g.orgMembershipId, 'PENDING_PAYMENT');
        expect(await settleHouseholdBg(g.householdId)).toEqual(['denied']);
        expect((await row(waiting)).bgClearedAt).toBeNull();
    });
});
