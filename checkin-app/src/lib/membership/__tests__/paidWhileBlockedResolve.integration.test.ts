/**
 * @jest-environment node
 */
/**
 * A store payment lands on a household application BLOCKED by an adult's rejected
 * check review, raising PAID_WHILE_BLOCKED. When the block lifts and the household
 * activates on that order, the problem resolves itself; a denied household or a
 * refunded order leaves it open for the Board.
 */
import prisma from '@/lib/prisma';
import { settleHouseholdBg } from '@/lib/membership/settleHouseholdBg';
import { activateByProcessId } from '@/lib/membership/payment';
import { raiseMembershipPaymentOutcome } from '@/lib/finance/reconcile/membership';
import { recordReversal } from '@/lib/finance/reconcile/exceptions';
import { setBgRecheckPolicy } from '@/test-helpers/boardSettings';
import type { OrgMembershipProcessStatus } from '@/generated/prisma/client';

jest.mock('@/lib/email', () => ({ runPaced: (tasks: Array<() => Promise<unknown>>) => Promise.all(tasks.map((t) => t())), sendEmail: jest.fn().mockResolvedValue(true) }));
jest.mock('@/lib/finance/reconcile/liveOrder', () => ({
    recordUnreportedReversal: jest.fn().mockResolvedValue(undefined),
    recordUnreportedReversalOnProcess: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('@/lib/membership/boardAlerts', () => ({ notifyBoardPaidReject: jest.fn().mockResolvedValue(undefined), notifyBoardPaymentException: jest.fn().mockResolvedValue(undefined) }));

const TAG = 'paid-while-blocked-resolve-test';
let seq = 0;
let restorePolicy: () => Promise<void> = async () => {};

/**
 * A household blocked from `from` by another adult's rejected review, then paid by
 * store order. With `leadCleared` false the lead's own review is still open, so the
 * household does not qualify when the block lifts.
 */
async function paidWhileBlocked(from: OrgMembershipProcessStatus, leadCleared = true, raise = true, signed = true) {
    const n = seq++;
    const now = new Date();
    const shopifyOrderId = `${TAG}-${n}-${Math.random().toString(36).slice(2)}`;
    const household = await prisma.household.create({ data: { name: `${TAG} ${n}` } });
    const lead = await prisma.person.create({ data: { name: `Lead ${n}`, email: `lead-${n}-${TAG}@example.com`, householdId: household.id, isHouseholdLead: true, lastBackgroundCheck: leadCleared ? now : null } });
    const other = await prisma.person.create({ data: { name: `Adult ${n}`, email: `adult-${n}-${TAG}@example.com`, householdId: household.id } });
    const membership = await prisma.orgMembership.create({ data: { householdId: household.id, status: 'NONE' } });
    const app = await prisma.orgMembershipProcess.create({
        data: { orgMembershipId: membership.id, kind: 'INITIAL', status: from, bgConsentAt: now, contractSignedAt: signed ? now : null },
    });
    if (!leadCleared) {
        await prisma.orgMembershipProcess.create({ data: { kind: 'PERSON_BG', subjectPersonId: lead.id, requestedForHouseholdId: household.id, status: 'PENDING_BG_REVIEW', bgConsentAt: now } });
    }
    const otherReview = await prisma.orgMembershipProcess.create({
        data: { kind: 'PERSON_BG', subjectPersonId: other.id, requestedForHouseholdId: household.id, status: 'BLOCKED', bgConsentAt: now },
    });
    expect(await settleHouseholdBg(household.id)).toEqual(['blocked']);

    const { outcome } = await activateByProcessId(app.id, shopifyOrderId, { appliesToYear: null });
    expect(outcome).toBe('paid_while_blocked');
    if (raise) {
        await raiseMembershipPaymentOutcome(outcome, { shopifyOrderId, processId: app.id });
        expect((await problem(app.id, shopifyOrderId)).status).toBe('OPEN');
    }
    return { householdId: household.id, otherId: other.id, orgMembershipId: membership.id, appId: app.id, otherReviewId: otherReview.id, shopifyOrderId };
}

type Family = Awaited<ReturnType<typeof paidWhileBlocked>>;

/** The rejector changes to approve: the other adult's check clears. */
async function liftBlock(f: Family) {
    const now = new Date();
    await prisma.orgMembershipProcess.update({ where: { id: f.otherReviewId }, data: { status: 'ACTIVE', bgClearedAt: now } });
    await prisma.person.update({ where: { id: f.otherId }, data: { lastBackgroundCheck: now } });
    return settleHouseholdBg(f.householdId);
}

const problem = (processId: number, shopifyOrderId: string) =>
    prisma.paymentException.findFirstOrThrow({ where: { kind: 'PAID_WHILE_BLOCKED', processId, shopifyOrderId } });
const row = (id: number) => prisma.orgMembershipProcess.findUniqueOrThrow({ where: { id } });
const membershipStatus = async (id: number) => (await prisma.orgMembership.findUniqueOrThrow({ where: { id } })).status;

async function wipe() {
    await prisma.auditLog.deleteMany({ where: { tableName: 'ShopifyOrderReversal', newData: { path: ['shopifyOrderId'], string_starts_with: `${TAG}-` } } });
    const exceptions = await prisma.paymentException.findMany({ where: { shopifyOrderId: { startsWith: `${TAG}-` } }, select: { id: true } });
    await prisma.auditLog.deleteMany({ where: { tableName: 'PaymentException', affectedEntityId: { in: exceptions.map((e) => e.id) } } });
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

describe('PAID_WHILE_BLOCKED when the block lifts', () => {
    it('resolves itself when the household activates on that order', async () => {
        const f = await paidWhileBlocked('PENDING_PAYMENT');
        expect(await liftBlock(f)).toEqual(['resumed', 'cleared']);
        expect((await row(f.appId)).status).toBe('ACTIVE');
        expect(await membershipStatus(f.orgMembershipId)).toBe('ACTIVE');

        const resolved = await problem(f.appId, f.shopifyOrderId);
        expect(resolved).toMatchObject({ status: 'RESOLVED', resolvedById: null, resolutionNote: 'household activated on this payment; no refund needed' });
        expect(resolved.resolvedAt).not.toBeNull();
        const audit = await prisma.auditLog.findFirst({ where: { tableName: 'PaymentException', affectedEntityId: resolved.id } });
        expect(audit).toMatchObject({ actorId: 0, actorSystem: 'system:membership-bg-settle', action: 'EDIT' });
    });

    it('stays open when the household is denied', async () => {
        const f = await paidWhileBlocked('PENDING_PAYMENT');
        await prisma.orgMembership.update({ where: { id: f.orgMembershipId }, data: { status: 'DENIED' } });
        expect(await liftBlock(f)).toEqual(['denied']);
        expect((await problem(f.appId, f.shopifyOrderId)).status).toBe('OPEN');
    });

    it('stays open when the order was refunded', async () => {
        const f = await paidWhileBlocked('PENDING_PAYMENT');
        await recordReversal(f.shopifyOrderId, 'REFUND');
        await liftBlock(f);
        expect((await row(f.appId)).status).toBe('PENDING_BG_CLEARANCE');
        expect(await membershipStatus(f.orgMembershipId)).toBe('NONE');
        expect((await problem(f.appId, f.shopifyOrderId)).status).toBe('OPEN');
    });
});

describe('a PAID_WHILE_BLOCKED raise that arrives after the household activated', () => {
    it('raises nothing on the order the application activated on', async () => {
        const f = await paidWhileBlocked('PENDING_PAYMENT', true, false);
        expect(await liftBlock(f)).toEqual(['resumed', 'cleared']);
        await raiseMembershipPaymentOutcome('paid_while_blocked', { shopifyOrderId: f.shopifyOrderId, processId: f.appId });
        expect(await prisma.paymentException.count({ where: { kind: 'PAID_WHILE_BLOCKED', processId: f.appId } })).toBe(0);
    });
});

describe('a paid application blocked from PENDING_EXTERNAL_ACTION', () => {
    it('resumes at PENDING_BG_CLEARANCE, not the step it was blocked from', async () => {
        const f = await paidWhileBlocked('PENDING_EXTERNAL_ACTION', false);
        expect(await liftBlock(f)).toEqual(['resumed']);
        expect((await row(f.appId)).status).toBe('PENDING_BG_CLEARANCE');
        expect((await problem(f.appId, f.shopifyOrderId)).status).toBe('OPEN');
    });

    it('returns to PENDING_EXTERNAL_ACTION when its agreement is unsigned, keeping the item open', async () => {
        const f = await paidWhileBlocked('PENDING_EXTERNAL_ACTION', true, true, false);
        expect(await liftBlock(f)).toEqual(['resumed', 'cleared']);
        const app = await row(f.appId);
        expect(app.status).toBe('PENDING_EXTERNAL_ACTION');
        expect(await membershipStatus(f.orgMembershipId)).toBe('NONE');
        expect((await problem(f.appId, f.shopifyOrderId)).status).toBe('OPEN');
    });
});
