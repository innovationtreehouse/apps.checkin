/**
 * @jest-environment node
 */
/**
 * A paid household application blocked by an adult's rejected check review, whose
 * check stops counting as started while it is blocked (the lead's review is
 * withdrawn). When the block lifts it waits at PENDING_BG_CLEARANCE, never at a pay
 * step, and the clearance then activates it, or holds it and raises the refund.
 */
import prisma from '@/lib/prisma';
import { settleHouseholdBg } from '@/lib/membership/settleHouseholdBg';
import { householdCheckStarted } from '@/lib/membership/checkStanding';
import { recordReversal } from '@/lib/finance/reconcile/exceptions';
import { setBgRecheckPolicy } from '@/test-helpers/boardSettings';

jest.mock('@/lib/email', () => ({ runPaced: (tasks: Array<() => Promise<unknown>>) => Promise.all(tasks.map((t) => t())), sendEmail: jest.fn().mockResolvedValue(true) }));
jest.mock('@/lib/finance/reconcile/liveOrder', () => ({
    recordUnreportedReversal: jest.fn().mockResolvedValue(undefined),
    recordUnreportedReversalOnProcess: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('@/lib/membership/boardAlerts', () => ({ notifyBoardPaidReject: jest.fn().mockResolvedValue(undefined), notifyBoardPaymentException: jest.fn().mockResolvedValue(undefined) }));

const TAG = 'paid-block-resume-test';
let seq = 0;
let restorePolicy: () => Promise<void> = async () => {};

/** A household whose lead's check is started but not cleared, another adult with a rejected review, and a paid application. */
async function blockedPaidFamily() {
    const n = seq++;
    const now = new Date();
    const shopifyOrderId = `${TAG}-${n}-${Math.random().toString(36).slice(2)}`;
    const household = await prisma.household.create({ data: { name: `${TAG} ${n}` } });
    const lead = await prisma.person.create({ data: { name: `Lead ${n}`, email: `lead-${n}-${TAG}@example.com`, householdId: household.id, isHouseholdLead: true } });
    const other = await prisma.person.create({ data: { name: `Adult ${n}`, email: `adult-${n}-${TAG}@example.com`, householdId: household.id } });
    const membership = await prisma.orgMembership.create({ data: { householdId: household.id, status: 'NONE' } });
    const app = await prisma.orgMembershipProcess.create({
        data: { orgMembershipId: membership.id, kind: 'INITIAL', status: 'PENDING_BG_CLEARANCE', contractSignedAt: now, paidAt: now, shopifyOrderId },
    });
    const leadReview = await prisma.orgMembershipProcess.create({
        data: { kind: 'PERSON_BG', subjectPersonId: lead.id, requestedForHouseholdId: household.id, status: 'PENDING_BG_REVIEW', bgConsentAt: now },
    });
    const otherReview = await prisma.orgMembershipProcess.create({
        data: { kind: 'PERSON_BG', subjectPersonId: other.id, requestedForHouseholdId: household.id, status: 'BLOCKED', bgConsentAt: now },
    });
    expect(await settleHouseholdBg(household.id)).toEqual(['blocked', 'paidReject']);
    return { householdId: household.id, leadId: lead.id, otherId: other.id, orgMembershipId: membership.id, appId: app.id, leadReviewId: leadReview.id, otherReviewId: otherReview.id, shopifyOrderId };
}

type Family = Awaited<ReturnType<typeof blockedPaidFamily>>;

/** The lead's review is withdrawn, so the household's check no longer counts as started. */
async function withdrawLeadReview(f: Family) {
    await prisma.orgMembershipProcess.update({ where: { id: f.leadReviewId }, data: { status: 'ARCHIVED' } });
    expect(await householdCheckStarted(prisma, f.householdId, { bgConsentAt: null })).toBe(false);
}

/** The Board resets the rejection; the block lifts on the next settle. */
async function liftBlock(f: Family) {
    await prisma.orgMembershipProcess.update({ where: { id: f.otherReviewId }, data: { status: 'PENDING_BG_REVIEW' } });
    await prisma.auditLog.create({ data: { actorId: 0, action: 'EDIT', tableName: 'OrgMembershipProcess', affectedEntityId: f.otherReviewId, oldData: { status: 'BLOCKED' }, newData: { status: 'PENDING_BG_REVIEW', action: 'board reset' } } });
    await settleHouseholdBg(f.householdId);
}

/** Both adults' checks clear. */
async function clearChecks(f: Family) {
    const now = new Date();
    await prisma.orgMembershipProcess.update({ where: { id: f.otherReviewId }, data: { status: 'ACTIVE', bgClearedAt: now } });
    await prisma.person.updateMany({ where: { id: { in: [f.leadId, f.otherId] } }, data: { lastBackgroundCheck: now } });
    expect(await settleHouseholdBg(f.householdId)).toEqual(['cleared']);
}

const row = (id: number) => prisma.orgMembershipProcess.findUniqueOrThrow({ where: { id } });
const membershipStatus = async (id: number) => (await prisma.orgMembership.findUniqueOrThrow({ where: { id } })).status;

async function wipe() {
    await prisma.auditLog.deleteMany({ where: { tableName: 'ShopifyOrderReversal', newData: { path: ['shopifyOrderId'], string_starts_with: `${TAG}-` } } });
    await prisma.paymentException.deleteMany({ where: { shopifyOrderId: { startsWith: `${TAG}-` } } });
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
    restorePolicy = await setBgRecheckPolicy();
    await wipe();
});

afterAll(async () => {
    await wipe();
    await restorePolicy();
    await prisma.$disconnect();
});

describe('a paid application whose check stops counting as started while blocked', () => {
    it('waits at PENDING_BG_CLEARANCE when the block lifts, and activates once the checks clear', async () => {
        const f = await blockedPaidFamily();
        await withdrawLeadReview(f);
        await liftBlock(f);

        let app = await row(f.appId);
        expect(app.status).toBe('PENDING_BG_CLEARANCE');
        expect(app.bgClearedAt).toBeNull();

        await clearChecks(f);
        app = await row(f.appId);
        expect(app.status).toBe('ACTIVE');
        expect(await membershipStatus(f.orgMembershipId)).toBe('ACTIVE');
    });

    it('stays held and raises the refund to the Board when its order was refunded', async () => {
        const f = await blockedPaidFamily();
        await withdrawLeadReview(f);
        await recordReversal(f.shopifyOrderId, 'REFUND');
        await liftBlock(f);
        expect((await row(f.appId)).status).toBe('PENDING_BG_CLEARANCE');

        await clearChecks(f);
        const app = await row(f.appId);
        expect(app.status).toBe('PENDING_BG_CLEARANCE');
        expect(app.bgClearedAt).not.toBeNull();
        expect(await membershipStatus(f.orgMembershipId)).toBe('NONE');
        const raised = await prisma.paymentException.findFirst({ where: { kind: 'REVERSED_BEFORE_ACTIVATION', processId: f.appId } });
        expect(raised?.severity).toBe('CRITICAL');
    });
});
