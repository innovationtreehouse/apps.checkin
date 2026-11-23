/**
 * @jest-environment node
 */
/**
 * A household background-check settle that fails after its event leaves the application
 * stuck in its step, on the Problems list, with one Board email; Retry clears it. A Board
 * settings change that moves the check yardstick settles every waiting application.
 */
import prisma from '@/lib/prisma';
import { emailBoardMembers } from '@/lib/emailRecipients';
import { checkValidForApplication } from '@/lib/membership/checkStanding';
import { advanceExternalIfComplete } from '@/lib/membership/external';
import { retryStuckSettle, settleAfterEvent, settleApplicationsAwaitingCheck, stuckSettles } from '@/lib/membership/settleHouseholdBg';
import { setBgRecheckPolicy } from '@/test-helpers/boardSettings';

jest.mock('@/lib/email', () => ({ runPaced: (tasks: Array<() => Promise<unknown>>) => Promise.all(tasks.map((t) => t())), sendEmail: jest.fn().mockResolvedValue(true) }));
jest.mock('@/lib/emailRecipients', () => ({ ...jest.requireActual('@/lib/emailRecipients'), emailBoardMembers: jest.fn().mockResolvedValue(1) }));
jest.mock('@/lib/finance/reconcile/liveOrder', () => ({
    recordUnreportedReversal: jest.fn().mockResolvedValue(undefined),
    recordUnreportedReversalOnProcess: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('@/lib/membership/checkStanding', () => {
    const actual = jest.requireActual('@/lib/membership/checkStanding');
    return { ...actual, checkValidForApplication: jest.fn((...args: Parameters<typeof actual.checkValidForApplication>) => actual.checkValidForApplication(...args)) };
});
jest.mock('@/lib/membership/external', () => {
    const actual = jest.requireActual('@/lib/membership/external');
    return { ...actual, advanceExternalIfComplete: jest.fn((...args: Parameters<typeof actual.advanceExternalIfComplete>) => actual.advanceExternalIfComplete(...args)) };
});

const TAG = 'stuck-settle-test';
let seq = 0;
let restorePolicy: () => Promise<void> = async () => {};

/** A household whose lead holds a check done today, with an INITIAL application waiting on it. */
async function waitingFamily(fields: { contractSignedAt?: Date; paidAt?: Date } = {}) {
    const n = seq++;
    const household = await prisma.household.create({ data: { name: `${TAG} ${n}` } });
    await prisma.person.create({ data: { name: `Lead ${n}`, email: `lead-${n}-${TAG}@example.com`, householdId: household.id, isHouseholdLead: true, lastBackgroundCheck: new Date() } });
    const membership = await prisma.orgMembership.create({ data: { householdId: household.id, status: 'NONE' } });
    const app = await prisma.orgMembershipProcess.create({ data: { orgMembershipId: membership.id, kind: 'INITIAL', status: 'PENDING_EXTERNAL_ACTION', ...fields } });
    return { householdId: household.id, appId: app.id };
}

const row = (id: number) => prisma.orgMembershipProcess.findUniqueOrThrow({ where: { id } });
const stuckEmails = () => jest.mocked(emailBoardMembers).mock.calls.filter(([key]) => key === 'board.bgSettleStuck');
const failNextSettle = () => jest.mocked(checkValidForApplication).mockRejectedValueOnce(new Error('database went away'));

async function wipe() {
    const households = await prisma.household.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
    const ids = households.map((h) => h.id);
    const processes = await prisma.orgMembershipProcess.findMany({ where: { OR: [{ orgMembership: { householdId: { in: ids } } }, { requestedForHouseholdId: { in: ids } }] }, select: { id: true } });
    const processIds = processes.map((p) => p.id);
    await prisma.auditLog.deleteMany({ where: { tableName: 'OrgMembershipProcess', affectedEntityId: { in: processIds } } });
    await prisma.orgMembershipProcess.deleteMany({ where: { id: { in: processIds } } });
    await prisma.orgMembership.deleteMany({ where: { householdId: { in: ids } } });
    await prisma.person.deleteMany({ where: { email: { contains: TAG } } });
    await prisma.household.deleteMany({ where: { id: { in: ids } } });
}

beforeAll(async () => {
    restorePolicy = await setBgRecheckPolicy();
    await wipe();
});

beforeEach(() => jest.mocked(emailBoardMembers).mockClear());

afterAll(async () => {
    await wipe();
    await restorePolicy();
    await prisma.$disconnect();
});

describe('a settle that fails after its event', () => {
    it('sticks once, emails the Board once, and Retry clears it', async () => {
        const f = await waitingFamily();

        failNextSettle();
        expect(await settleAfterEvent(f.householdId, 'intake')).toEqual([]);
        const first = await row(f.appId);
        expect(first).toMatchObject({ status: 'PENDING_EXTERNAL_ACTION', bgClearedAt: null, bgSettleError: 'database went away' });
        expect(first.bgSettleFailedAt).not.toBeNull();
        expect(await stuckSettles()).toContainEqual({ id: String(f.appId), step: 'background-check settle', href: `/membership-ops/households/${f.householdId}`, failedAt: first.bgSettleFailedAt });
        expect(stuckEmails()).toEqual([['board.bgSettleStuck', expect.objectContaining({ processId: String(f.appId) }), expect.any(String)]]);

        jest.mocked(checkValidForApplication).mockRejectedValueOnce(new Error('still down'));
        await settleAfterEvent(f.householdId, 'renewal');
        expect(await row(f.appId)).toMatchObject({ bgSettleFailedAt: first.bgSettleFailedAt, bgSettleError: 'still down' });
        expect(stuckEmails()).toHaveLength(1);

        failNextSettle();
        await expect(retryStuckSettle({ id: String(f.appId), step: 'background-check settle' })).rejects.toMatchObject({ status: 409 });
        expect(stuckEmails()).toHaveLength(1);

        await retryStuckSettle({ id: String(f.appId), step: 'background-check settle' });
        const cleared = await row(f.appId);
        expect(cleared).toMatchObject({ bgSettleFailedAt: null, bgSettleError: null });
        expect(cleared.bgClearedAt).not.toBeNull();
        expect((await stuckSettles()).map((i) => i.id)).not.toContain(String(f.appId));
        await expect(retryStuckSettle({ id: String(f.appId), step: 'background-check settle' })).rejects.toMatchObject({ status: 404 });
    });

    it('is cleared by the next event whose settle succeeds', async () => {
        const f = await waitingFamily();
        failNextSettle();
        await settleAfterEvent(f.householdId, 'intake');
        expect((await row(f.appId)).bgSettleFailedAt).not.toBeNull();

        await settleAfterEvent(f.householdId, 'check started');
        expect(await row(f.appId)).toMatchObject({ bgSettleFailedAt: null, bgSettleError: null });
    });

    it('sticks when the advance after a committed stamp fails, and Retry runs the advance', async () => {
        const f = await waitingFamily({ contractSignedAt: new Date() });
        jest.mocked(advanceExternalIfComplete).mockRejectedValueOnce(new Error('advance lost'));

        await settleAfterEvent(f.householdId, 'intake');
        const stuck = await row(f.appId);
        expect(stuck).toMatchObject({ status: 'PENDING_EXTERNAL_ACTION', bgSettleError: 'advance lost' });
        expect(stuck.bgClearedAt).not.toBeNull();
        expect(stuck.bgSettleFailedAt).not.toBeNull();

        await retryStuckSettle({ id: String(f.appId), step: 'background-check settle' });
        expect(await row(f.appId)).toMatchObject({ status: 'PENDING_PAYMENT', bgSettleFailedAt: null, bgSettleError: null });
    });

    it('stays stuck when a paid application advances on Retry and its own settle fails', async () => {
        const realCheck = jest.requireActual<typeof import('@/lib/membership/checkStanding')>('@/lib/membership/checkStanding').checkValidForApplication;
        const f = await waitingFamily({ contractSignedAt: new Date(), paidAt: new Date() });
        jest.mocked(advanceExternalIfComplete).mockRejectedValueOnce(new Error('advance lost'));
        await settleAfterEvent(f.householdId, 'intake');
        const first = await row(f.appId);
        expect(first.bgSettleFailedAt).not.toBeNull();

        // The Retry's own settle reads the yardstick first; the paid advance's settle fails on the second read.
        jest.mocked(checkValidForApplication).mockImplementationOnce(realCheck).mockRejectedValueOnce(new Error('nested settle lost'));
        await expect(retryStuckSettle({ id: String(f.appId), step: 'background-check settle' })).rejects.toMatchObject({ status: 409 });
        expect(await row(f.appId)).toMatchObject({ status: 'PENDING_BG_CLEARANCE', bgClearedAt: null, bgSettleFailedAt: first.bgSettleFailedAt, bgSettleError: 'nested settle lost' });
        expect((await stuckSettles()).map((i) => i.id)).toContain(String(f.appId));
        expect(stuckEmails()).toHaveLength(1);
    });
});

describe('a Board settings change that moves the check yardstick', () => {
    it('settles every application waiting on its check', async () => {
        await prisma.boardSettings.update({ where: { id: 1 }, data: { bgRecheckMonths: 0 } });
        const f = await waitingFamily();
        await settleAfterEvent(f.householdId, 'intake');
        expect((await row(f.appId)).bgClearedAt).toBeNull();

        await prisma.boardSettings.update({ where: { id: 1 }, data: { bgRecheckMonths: 29 } });
        await settleApplicationsAwaitingCheck('a Board settings change');
        expect((await row(f.appId)).bgClearedAt).not.toBeNull();
    });
});
