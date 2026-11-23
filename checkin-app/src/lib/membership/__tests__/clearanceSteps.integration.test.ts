/**
 * @jest-environment node
 */
/**
 * A step owed after a clearance that fails is kept as a stuck item on the Problems list,
 * timed by its first failure; Retry re-runs only that step, and a repeated run raises once.
 */
import prisma from '@/lib/prisma';
import { raisePaymentException } from '@/lib/finance/reconcile/exceptions';
import { retryClearanceStep, stuckClearanceSteps } from '@/lib/membership/clearanceSteps';
import { openPersonAgreementForNewMember } from '@/lib/membership/personAgreementTriggers';
import { openPersonBgForNewMember } from '@/lib/membership/personBgTriggers';
import { activate } from '@/lib/membership/payment';
import { notifyClearanceOutcome } from '@/lib/membership/review';

jest.mock('@/lib/membership/boardAlerts', () => ({ ...jest.requireActual('@/lib/membership/boardAlerts'), notifyBoardPaymentException: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/lib/membership/payment', () => ({ ...jest.requireActual('@/lib/membership/payment'), sendCongrats: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/lib/finance/reconcile/exceptions', () => {
    const actual = jest.requireActual('@/lib/finance/reconcile/exceptions');
    return { ...actual, raisePaymentException: jest.fn((...args: Parameters<typeof actual.raisePaymentException>) => actual.raisePaymentException(...args)) };
});
jest.mock('@/lib/membership/personBgTriggers', () => {
    const actual = jest.requireActual('@/lib/membership/personBgTriggers');
    return { ...actual, openPersonBgForNewMember: jest.fn((...args: Parameters<typeof actual.openPersonBgForNewMember>) => actual.openPersonBgForNewMember(...args)) };
});
jest.mock('@/lib/membership/personAgreementTriggers', () => {
    const actual = jest.requireActual('@/lib/membership/personAgreementTriggers');
    return { ...actual, openPersonAgreementForNewMember: jest.fn((...args: Parameters<typeof actual.openPersonAgreementForNewMember>) => actual.openPersonAgreementForNewMember(...args)) };
});

const TAG = 'clearance-step-test';
let seq = 0;

async function family(fields: { status: 'ACTIVE' | 'PENDING_BG_CLEARANCE' | 'PENDING_PAYMENT'; shopifyOrderId?: string; bgClearedAt?: Date; contractSignedAt?: Date }) {
    const n = seq++;
    const household = await prisma.household.create({ data: { name: `${TAG} ${n}` } });
    await prisma.person.create({ data: { name: `Lead ${n}`, email: `lead-${n}-${TAG}@example.com`, householdId: household.id, isHouseholdLead: true, lastBackgroundCheck: new Date() } });
    const membership = await prisma.orgMembership.create({ data: { householdId: household.id, status: fields.status === 'ACTIVE' ? 'ACTIVE' : 'NONE' } });
    const app = await prisma.orgMembershipProcess.create({ data: { orgMembershipId: membership.id, kind: 'INITIAL', ...fields } });
    return { householdId: household.id, appId: app.id };
}

const stuckRows = (processId: number) => prisma.clearanceStepFailure.findMany({ where: { processId }, orderBy: { step: 'asc' } });

async function wipe() {
    const households = await prisma.household.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
    const ids = households.map((h) => h.id);
    const processIds = (await prisma.orgMembershipProcess.findMany({ where: { orgMembership: { householdId: { in: ids } } }, select: { id: true } })).map((p) => p.id);
    const membershipIds = (await prisma.orgMembership.findMany({ where: { householdId: { in: ids } }, select: { id: true } })).map((m) => m.id);
    await prisma.auditLog.deleteMany({
        where: {
            OR: [
                { tableName: 'OrgMembershipProcess', affectedEntityId: { in: processIds } },
                { tableName: 'OrgMembership', affectedEntityId: { in: membershipIds } },
            ],
        },
    });
    await prisma.paymentException.deleteMany({ where: { processId: { in: processIds } } });
    await prisma.orgMembershipProcess.deleteMany({ where: { id: { in: processIds } } });
    await prisma.orgMembership.deleteMany({ where: { householdId: { in: ids } } });
    await prisma.person.deleteMany({ where: { email: { contains: TAG } } });
    await prisma.household.deleteMany({ where: { id: { in: ids } } });
}

beforeEach(wipe);
afterAll(async () => {
    await wipe();
    await prisma.$disconnect();
});

describe('a failed step after a clearance', () => {
    it('keeps only the failed trigger stuck, and Retry clears it', async () => {
        const { householdId, appId } = await family({ status: 'ACTIVE' });
        jest.mocked(openPersonAgreementForNewMember).mockRejectedValueOnce(new Error('database went away'));

        await notifyClearanceOutcome({ status: 'ACTIVE', activated: true, processId: appId, householdId, isInitial: true });

        const [row] = await stuckRows(appId);
        expect(row).toMatchObject({ step: 'PERSON_AGREEMENT_TRIGGER', error: 'database went away' });
        expect(await stuckRows(appId)).toHaveLength(1);
        expect((await stuckClearanceSteps()).filter((i) => i.id === String(appId))).toEqual([
            { id: String(appId), step: 'person agreement trigger', href: `/membership-ops/households/${householdId}`, failedAt: row.failedAt },
        ]);

        jest.mocked(openPersonBgForNewMember).mockClear();
        await retryClearanceStep({ id: String(appId), step: 'person agreement trigger' });

        expect(openPersonAgreementForNewMember).toHaveBeenLastCalledWith(householdId, row.failedAt);
        expect(openPersonBgForNewMember).not.toHaveBeenCalled();
        expect(await stuckRows(appId)).toEqual([]);
        await expect(retryClearanceStep({ id: String(appId), step: 'person agreement trigger' })).rejects.toMatchObject({ status: 404 });
    });

    it('keeps the first failure time while later failures update the error', async () => {
        const { householdId, appId } = await family({ status: 'ACTIVE' });
        jest.mocked(openPersonBgForNewMember).mockRejectedValueOnce(new Error('first')).mockRejectedValueOnce(new Error('second'));

        await notifyClearanceOutcome({ status: 'ACTIVE', activated: true, processId: appId, householdId, isInitial: true });
        const [first] = await stuckRows(appId);

        await expect(retryClearanceStep({ id: String(appId), step: 'person background-check trigger' })).rejects.toMatchObject({ status: 409 });

        const [after] = await stuckRows(appId);
        expect(after).toMatchObject({ step: 'PERSON_BG_TRIGGER', error: 'second', failedAt: first.failedAt });
    });

    it('keeps a failed trigger after a paid activation stuck, and Retry clears it', async () => {
        const { householdId, appId } = await family({ status: 'PENDING_PAYMENT', bgClearedAt: new Date(), contractSignedAt: new Date() });
        jest.mocked(openPersonBgForNewMember).mockRejectedValueOnce(new Error('database went away'));

        const activated = await activate(appId, { via: 'manual' });

        expect(activated?.status).toBe('ACTIVE');
        const [row] = await stuckRows(appId);
        expect(await stuckRows(appId)).toHaveLength(1);
        expect(row).toMatchObject({ step: 'PERSON_BG_TRIGGER', error: 'database went away' });
        expect(openPersonAgreementForNewMember).toHaveBeenLastCalledWith(householdId, row.failedAt);

        await retryClearanceStep({ id: String(appId), step: 'person background-check trigger' });

        expect(openPersonBgForNewMember).toHaveBeenLastCalledWith(householdId, row.failedAt);
        expect(await stuckRows(appId)).toEqual([]);
    });

    it('raises a refunded order once however often the raise runs', async () => {
        const { appId } = await family({ status: 'PENDING_BG_CLEARANCE', shopifyOrderId: `${TAG}-order` });
        jest.mocked(raisePaymentException).mockRejectedValueOnce(new Error('database went away'));
        const outcome = { status: 'PENDING_BG_CLEARANCE' as const, activated: false, processId: appId, householdId: null, isInitial: false, refunded: { shopifyOrderId: `${TAG}-order` } };

        await notifyClearanceOutcome(outcome);
        expect((await stuckRows(appId)).map((r) => r.step)).toEqual(['REFUNDED_ORDER_RAISE']);

        await retryClearanceStep({ id: String(appId), step: 'refunded order raise' });
        await notifyClearanceOutcome(outcome);

        expect(await stuckRows(appId)).toEqual([]);
        expect(await prisma.paymentException.count({ where: { processId: appId, kind: 'REVERSED_BEFORE_ACTIVATION' } })).toBe(1);
    });
});
