/**
 * @jest-environment node
 */
/**
 * A household application paid before its agreement is signed: an order lands while
 * the application is BLOCKED at the agreement step. Once the block lifts and the
 * agreement is signed, it goes to PENDING_BG_CLEARANCE, never to the pay step, and
 * the clearance then activates it, or holds it and raises the refund. An unpaid
 * application still goes to PENDING_PAYMENT. An unsigned application never activates
 * on payment or settle: it waits at the agreement step until signed.
 */
import prisma from '@/lib/prisma';
import { settleHouseholdBg } from '@/lib/membership/settleHouseholdBg';
import { markContractSigned } from '@/lib/membership/external';
import { activateByProcessId } from '@/lib/membership/payment';
import { recordReversal } from '@/lib/finance/reconcile/exceptions';
import { setBgRecheckPolicy } from '@/test-helpers/boardSettings';

jest.mock('@/lib/email', () => ({ runPaced: (tasks: Array<() => Promise<unknown>>) => Promise.all(tasks.map((t) => t())), sendEmail: jest.fn().mockResolvedValue(true) }));
jest.mock('@/lib/finance/reconcile/liveOrder', () => ({
    recordUnreportedReversal: jest.fn().mockResolvedValue(undefined),
    recordUnreportedReversalOnProcess: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('@/lib/membership/boardAlerts', () => ({ notifyBoardPaidReject: jest.fn().mockResolvedValue(undefined), notifyBoardPaymentException: jest.fn().mockResolvedValue(undefined) }));

const TAG = 'paid-before-signing-test';
let seq = 0;
let restorePolicy: () => Promise<void> = async () => {};

/** A household whose lead's check is started, another adult with a rejected review, and an unsigned application blocked at the agreement step. */
async function blockedUnsignedFamily() {
    const n = seq++;
    const now = new Date();
    const shopifyOrderId = `${TAG}-${n}-${Math.random().toString(36).slice(2)}`;
    const household = await prisma.household.create({ data: { name: `${TAG} ${n}` } });
    const lead = await prisma.person.create({ data: { name: `Lead ${n}`, email: `lead-${n}-${TAG}@example.com`, householdId: household.id, isHouseholdLead: true } });
    const other = await prisma.person.create({ data: { name: `Adult ${n}`, email: `adult-${n}-${TAG}@example.com`, householdId: household.id } });
    const membership = await prisma.orgMembership.create({ data: { householdId: household.id, status: 'NONE' } });
    const app = await prisma.orgMembershipProcess.create({
        data: { orgMembershipId: membership.id, kind: 'INITIAL', status: 'PENDING_EXTERNAL_ACTION' },
    });
    const leadReview = await prisma.orgMembershipProcess.create({
        data: { kind: 'PERSON_BG', subjectPersonId: lead.id, requestedForHouseholdId: household.id, status: 'PENDING_BG_REVIEW', bgConsentAt: now },
    });
    const otherReview = await prisma.orgMembershipProcess.create({
        data: { kind: 'PERSON_BG', subjectPersonId: other.id, requestedForHouseholdId: household.id, status: 'BLOCKED', bgConsentAt: now },
    });
    expect(await settleHouseholdBg(household.id)).toEqual(['blocked']);
    return { householdId: household.id, leadId: lead.id, otherId: other.id, orgMembershipId: membership.id, appId: app.id, leadReviewId: leadReview.id, otherReviewId: otherReview.id, shopifyOrderId };
}

type Family = Awaited<ReturnType<typeof blockedUnsignedFamily>>;

/** The membership order lands on the blocked application, and its money is recorded. */
async function payWhileBlocked(f: Family) {
    const { outcome } = await activateByProcessId(f.appId, f.shopifyOrderId, { appliesToYear: 2026 });
    expect(outcome).toBe('paid_while_blocked');
}

/** The Board resets the rejection; the block lifts on the next settle and the application returns to its agreement step. */
async function liftBlock(f: Family) {
    await prisma.orgMembershipProcess.update({ where: { id: f.otherReviewId }, data: { status: 'PENDING_BG_REVIEW' } });
    await prisma.auditLog.create({ data: { actorId: 0, action: 'EDIT', tableName: 'OrgMembershipProcess', affectedEntityId: f.otherReviewId, oldData: { status: 'BLOCKED' }, newData: { status: 'PENDING_BG_REVIEW', action: 'board reset' } } });
    await settleHouseholdBg(f.householdId);
    expect((await row(f.appId)).status).toBe('PENDING_EXTERNAL_ACTION');
}

/** Both adults' checks clear. */
async function clearChecks(f: Family) {
    const now = new Date();
    await prisma.orgMembershipProcess.updateMany({ where: { id: { in: [f.leadReviewId, f.otherReviewId] } }, data: { status: 'ACTIVE', bgClearedAt: now } });
    await prisma.person.updateMany({ where: { id: { in: [f.leadId, f.otherId] } }, data: { lastBackgroundCheck: now } });
    return settleHouseholdBg(f.householdId);
}

/** A one-adult household whose lead's check has cleared, and an unsigned application at `status`. */
async function clearedUnsignedFamily(status: 'PENDING_PAYMENT' | 'PENDING_BG_CLEARANCE', bgCleared: boolean) {
    const n = seq++;
    const now = new Date();
    const shopifyOrderId = `${TAG}-${n}-${Math.random().toString(36).slice(2)}`;
    const household = await prisma.household.create({ data: { name: `${TAG} ${n}` } });
    const lead = await prisma.person.create({ data: { name: `Lead ${n}`, email: `lead-${n}-${TAG}@example.com`, householdId: household.id, isHouseholdLead: true, lastBackgroundCheck: now } });
    const membership = await prisma.orgMembership.create({ data: { householdId: household.id, status: 'NONE' } });
    const app = await prisma.orgMembershipProcess.create({
        data: { orgMembershipId: membership.id, kind: 'INITIAL', status, bgConsentAt: now, bgClearedAt: bgCleared ? now : null },
    });
    await prisma.orgMembershipProcess.create({
        data: { kind: 'PERSON_BG', subjectPersonId: lead.id, requestedForHouseholdId: household.id, status: 'ACTIVE', bgConsentAt: now, bgClearedAt: now },
    });
    return { householdId: household.id, orgMembershipId: membership.id, appId: app.id, shopifyOrderId };
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

describe('an application paid while blocked, before its agreement is signed', () => {
    it('goes to PENDING_BG_CLEARANCE when signed, and activates once the checks clear', async () => {
        const f = await blockedUnsignedFamily();
        await payWhileBlocked(f);
        await liftBlock(f);

        await markContractSigned(f.appId);
        let app = await row(f.appId);
        expect(app.status).toBe('PENDING_BG_CLEARANCE');
        expect(app.paidAt).not.toBeNull();

        expect(await clearChecks(f)).toEqual(['cleared']);
        app = await row(f.appId);
        expect(app.status).toBe('ACTIVE');
        expect(await membershipStatus(f.orgMembershipId)).toBe('ACTIVE');
    });

    it('activates on signing when the checks cleared first', async () => {
        const f = await blockedUnsignedFamily();
        await payWhileBlocked(f);
        await liftBlock(f);
        expect(await clearChecks(f)).toEqual(['cleared']);
        expect((await row(f.appId)).status).toBe('PENDING_EXTERNAL_ACTION');

        await markContractSigned(f.appId);
        const app = await row(f.appId);
        expect(app.status).toBe('ACTIVE');
        expect(app.bgClearedAt).not.toBeNull();
        expect(await membershipStatus(f.orgMembershipId)).toBe('ACTIVE');
    });

    it('stays held and raises the refund to the Board when its order was refunded', async () => {
        const f = await blockedUnsignedFamily();
        await payWhileBlocked(f);
        await recordReversal(f.shopifyOrderId, 'REFUND');
        await liftBlock(f);

        await markContractSigned(f.appId);
        expect((await row(f.appId)).status).toBe('PENDING_BG_CLEARANCE');

        expect(await clearChecks(f)).toEqual(['cleared']);
        const app = await row(f.appId);
        expect(app.status).toBe('PENDING_BG_CLEARANCE');
        expect(app.bgClearedAt).not.toBeNull();
        expect(await membershipStatus(f.orgMembershipId)).toBe('NONE');
        const raised = await prisma.paymentException.findFirst({ where: { kind: 'REVERSED_BEFORE_ACTIVATION', processId: f.appId } });
        expect(raised?.severity).toBe('CRITICAL');
    });

    it('an unpaid application still goes to PENDING_PAYMENT when signed', async () => {
        const f = await blockedUnsignedFamily();
        await liftBlock(f);

        await markContractSigned(f.appId);
        const app = await row(f.appId);
        expect(app.status).toBe('PENDING_PAYMENT');
        expect(app.paidAt).toBeNull();
    });
});

describe('an unsigned application never activates unsigned', () => {
    it('paid at PENDING_PAYMENT waits at the agreement step, and activates once signed', async () => {
        const f = await clearedUnsignedFamily('PENDING_PAYMENT', true);

        expect((await activateByProcessId(f.appId, f.shopifyOrderId, { appliesToYear: 2026 })).outcome).toBe('held');
        let app = await row(f.appId);
        expect(app.status).toBe('PENDING_EXTERNAL_ACTION');
        expect(app.paidAt).not.toBeNull();
        expect(await membershipStatus(f.orgMembershipId)).toBe('NONE');

        await markContractSigned(f.appId);
        app = await row(f.appId);
        expect(app.status).toBe('ACTIVE');
        expect(app.bgClearedAt).not.toBeNull();
        expect(await membershipStatus(f.orgMembershipId)).toBe('ACTIVE');
    });

    it('unpaid, cleared by settle, waits at the agreement step and goes to PENDING_PAYMENT once signed', async () => {
        const f = await clearedUnsignedFamily('PENDING_BG_CLEARANCE', false);

        expect(await settleHouseholdBg(f.householdId)).toEqual(['cleared']);
        let app = await row(f.appId);
        expect(app.status).toBe('PENDING_EXTERNAL_ACTION');
        expect(app.bgClearedAt).not.toBeNull();
        expect(app.paidAt).toBeNull();

        await markContractSigned(f.appId);
        app = await row(f.appId);
        expect(app.status).toBe('PENDING_PAYMENT');
        expect(await membershipStatus(f.orgMembershipId)).toBe('NONE');
    });
});
