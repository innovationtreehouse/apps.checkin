/**
 * @jest-environment node
 */
/**
 * Unit test for the H2 fix in activate() (prisma mocked, no DB): a Shopify
 * payment (opts.via === "payment") must actually contain the membership
 * product (its Shopify variant) before a PENDING_PAYMENT process activates.
 *   - no membership variant in the order -> NOT activated, no paidAt, outcome no_item (raised by the caller).
 *   - membership variant present         -> activates as before (status ACTIVE, membership ACTIVE).
 *   - a "manual" (board) activation never had an order to check, so it's exempt regardless.
 *
 * Also covers the activation email's INITIAL/RENEWAL split: a renewing household
 * is thanked for renewing, not welcomed as if it were new.
 */
import { activate, activateByProcessId, certifyPaymentPlan } from '@/lib/membership/payment';
import { logBackendError } from '@/lib/logger';
import { openPersonBgForNewMember } from '@/lib/membership/personBgTriggers';
import { openPersonAgreementForNewMember } from '@/lib/membership/personAgreementTriggers';

jest.mock('@/lib/prisma', () => {
    const mock = {
        orgMembershipProcess: { findUnique: jest.fn(), updateMany: jest.fn() },
        boardSettings: { findUnique: jest.fn() },
        auditLog: { create: jest.fn(), findFirst: jest.fn().mockResolvedValue(null) },
        paymentException: { findFirst: jest.fn().mockResolvedValue(null) },
        person: { findMany: jest.fn().mockResolvedValue([]), findUnique: jest.fn() },
        $queryRaw: jest.fn(),
        $executeRaw: jest.fn().mockResolvedValue(0),
        $transaction: jest.fn(),
    };
    mock.$transaction.mockImplementation((cb: (tx: typeof mock) => unknown) => cb(mock));
    return { __esModule: true, default: mock };
});
jest.mock('@/lib/email', () => ({ sendEmail: jest.fn().mockResolvedValue(true) }));
jest.mock('@/lib/logger', () => ({ logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn() }, logBackendError: jest.fn() }));
jest.mock('@/lib/membership/personBgTriggers', () => ({ openPersonBgForNewMember: jest.fn() }));
jest.mock('@/lib/membership/personAgreementTriggers', () => ({ openPersonAgreementForNewMember: jest.fn() }));
jest.mock('@/lib/membership/boardAlerts', () => ({ notifyBoardPaidReject: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/lib/emailRecipients', () => ({ emailHouseholdLeads: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/lib/conflictOfInterest', () => ({ hasHouseholdConflict: jest.fn().mockResolvedValue(false) }));
jest.mock('@/lib/membership/householdStatus', () => ({
    setHouseholdStatus: jest.fn().mockResolvedValue(true),
    raiseDeniedHouseholdActivity: jest.fn().mockResolvedValue(undefined),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const prisma = require('@/lib/prisma').default;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { notifyBoardPaidReject } = require('@/lib/membership/boardAlerts');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { emailHouseholdLeads } = require('@/lib/emailRecipients');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { setHouseholdStatus, raiseDeniedHouseholdActivity } = require('@/lib/membership/householdStatus');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { hasHouseholdConflict } = require('@/lib/conflictOfInterest');

const PROCESS_ID = 5;
let household: { householdId: number; status: string };
const MEMBERSHIP_ID = 9;

beforeEach(() => {
    jest.clearAllMocks();
    prisma.person.findUnique.mockResolvedValue({ isBoardMember: true });
    prisma.boardSettings.findUnique.mockResolvedValue({ standardMembershipFeeCents: 10000, volunteerMembershipFeeCents: 2500 });
    household = { householdId: 3, status: 'NONE' };
    prisma.$queryRaw.mockImplementation((sql: TemplateStringsArray) =>
        Promise.resolve(sql.join('?').includes('FROM "OrgMembership"') ? [household] : []));
    prisma.orgMembershipProcess.updateMany.mockResolvedValue({ count: 1 });
    setHouseholdStatus.mockResolvedValue(true);
    hasHouseholdConflict.mockResolvedValue(false);
});

it('does NOT activate a PENDING_PAYMENT process when the order has no membership item', async () => {
    prisma.orgMembershipProcess.findUnique.mockResolvedValue({
        id: PROCESS_ID, status: 'PENDING_PAYMENT', paidAt: null, bgClearedAt: null, orgMembershipId: MEMBERSHIP_ID,
    });

    const { outcome } = await activateByProcessId(PROCESS_ID, 'order-1', null);

    expect(outcome).toBe('no_item');
    expect(prisma.orgMembershipProcess.updateMany).not.toHaveBeenCalled();
    expect(setHouseholdStatus).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
            data: expect.objectContaining({
                newData: expect.objectContaining({ status: 'PENDING_PAYMENT', noMembershipItem: true }),
            }),
        }),
    );
});

it('activates a PENDING_PAYMENT process when the order contains the membership item', async () => {
    prisma.orgMembershipProcess.findUnique.mockResolvedValue({
        id: PROCESS_ID, status: 'PENDING_PAYMENT', paidAt: null, bgClearedAt: new Date(), orgMembershipId: MEMBERSHIP_ID,
    });

    const { outcome } = await activateByProcessId(PROCESS_ID, 'order-2', { appliesToYear: 2026 });

    expect(outcome).toBe('active');
    expect(prisma.orgMembershipProcess.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
            where: { id: PROCESS_ID, status: 'PENDING_PAYMENT', paidAt: null },
            data: expect.objectContaining({ status: 'ACTIVE' }),
        }),
    );
    expect(setHouseholdStatus).toHaveBeenCalledWith(
        prisma, MEMBERSHIP_ID, expect.objectContaining({ from: ['NONE', 'REVOKED', 'ACTIVE'], to: 'ACTIVE' }),
    );
    expect(notifyBoardPaidReject).not.toHaveBeenCalled();
});

it('welcomes an INITIAL household on activation', async () => {
    prisma.orgMembershipProcess.findUnique.mockResolvedValue({
        id: PROCESS_ID, kind: 'INITIAL', status: 'PENDING_PAYMENT', paidAt: null, bgClearedAt: new Date(), orgMembershipId: MEMBERSHIP_ID,
    });

    await activateByProcessId(PROCESS_ID, 'order-3', { appliesToYear: 2026 });

    expect(emailHouseholdLeads.mock.calls[0][1]).toBe('membership.welcome');
});

it('thanks a RENEWAL household for renewing instead of welcoming it', async () => {
    prisma.orgMembershipProcess.findUnique.mockResolvedValue({
        id: PROCESS_ID, kind: 'RENEWAL', status: 'PENDING_PAYMENT', paidAt: null, bgClearedAt: new Date(), orgMembershipId: MEMBERSHIP_ID,
    });

    await activateByProcessId(PROCESS_ID, 'order-4', { appliesToYear: 2026 });

    expect(emailHouseholdLeads.mock.calls[0][1]).toBe('membership.renewed');
});

describe('work after the payment commits', () => {
    const openBg = openPersonBgForNewMember as jest.Mock;
    const openAgreement = openPersonAgreementForNewMember as jest.Mock;

    beforeEach(() => {
        openBg.mockResolvedValue(undefined);
        openAgreement.mockResolvedValue(undefined);
    });

    it('a failed trigger leaves the activation reported, logs it, and still runs the next trigger', async () => {
        prisma.orgMembershipProcess.findUnique.mockResolvedValue({
            id: PROCESS_ID, kind: 'INITIAL', status: 'PENDING_PAYMENT', paidAt: null, bgClearedAt: new Date(), orgMembershipId: MEMBERSHIP_ID,
        });
        const failure = new Error('trigger failed');
        openBg.mockRejectedValue(failure);

        const { outcome } = await activateByProcessId(PROCESS_ID, 'order-5', { appliesToYear: 2026 });

        expect(outcome).toBe('active');
        expect(openAgreement).toHaveBeenCalledWith(3, expect.any(Date));
        expect(logBackendError).toHaveBeenCalledWith(failure, expect.stringContaining('background-check trigger'), { processId: PROCESS_ID, householdId: 3 });
    });

    it('a board certify succeeds when a trigger fails', async () => {
        prisma.orgMembershipProcess.findUnique.mockResolvedValue({
            id: PROCESS_ID, kind: 'INITIAL', status: 'PENDING_PAYMENT', paidAt: null, bgClearedAt: new Date(), orgMembershipId: MEMBERSHIP_ID,
        });
        openAgreement.mockRejectedValue(new Error('trigger failed'));

        await expect(activate(PROCESS_ID, { via: 'manual', actorId: 1 })).resolves.toBeDefined();
    });

    it('a failed raise on a DENIED household still throws, so the webhook redelivers', async () => {
        prisma.orgMembershipProcess.findUnique.mockResolvedValue({
            id: PROCESS_ID, status: 'PENDING_PAYMENT', paidAt: null, bgClearedAt: null, orgMembershipId: MEMBERSHIP_ID,
        });
        household.status = 'DENIED';
        const failure = new Error('raise failed');
        raiseDeniedHouseholdActivity.mockRejectedValueOnce(failure);

        await expect(activateByProcessId(PROCESS_ID, 'order-6', { appliesToYear: 2026 })).rejects.toBe(failure);
    });
});

it('a manual (board) activation is exempt from the membership-item check', async () => {
    // certifyPaymentPlan never has a Shopify order to check (via !== "payment"),
    // so it activates with no membership line to check.
    prisma.orgMembershipProcess.findUnique.mockResolvedValue({
        id: PROCESS_ID, status: 'PENDING_PAYMENT', paidAt: null, bgClearedAt: new Date(), orgMembershipId: MEMBERSHIP_ID,
    });

    await activate(PROCESS_ID, { via: 'manual', actorId: 1 });

    expect(prisma.orgMembershipProcess.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'ACTIVE' }) }),
    );
    expect(notifyBoardPaidReject).not.toHaveBeenCalled();
});

describe('payments that land on nothing awaiting them', () => {
    const proc = (over: object) => ({ id: PROCESS_ID, kind: 'INITIAL', status: 'PENDING_PAYMENT', paidAt: null, bgClearedAt: new Date(), orgMembershipId: MEMBERSHIP_ID, shopifyOrderId: null, ...over });

    it('a redelivery of the recorded order is a plain noop', async () => {
        prisma.orgMembershipProcess.findUnique.mockResolvedValue(proc({ status: 'ACTIVE', paidAt: new Date(), shopifyOrderId: 'order-1' }));
        expect((await activateByProcessId(PROCESS_ID, 'order-1', { appliesToYear: 2026 })).outcome).toBe('noop');
    });

    it.each([
        ['a second order on a paid process', { status: 'ACTIVE', paidAt: new Date(), shopifyOrderId: 'order-1' }],
        ['an order after a board certify', { status: 'ACTIVE', paidAt: new Date() }],
        ['an order after the application was closed', { status: 'ARCHIVED' }],
        ['an order before payment was due', { status: 'PENDING_BG_REVIEW' }],
        ['a second order on a paid BLOCKED process', { status: 'BLOCKED', paidAt: new Date(), shopifyOrderId: 'order-1' }],
    ])('%s is nothing_due and writes nothing', async (_label, over) => {
        prisma.orgMembershipProcess.findUnique.mockResolvedValue(proc(over));
        expect((await activateByProcessId(PROCESS_ID, 'order-2', { appliesToYear: 2026 })).outcome).toBe('nothing_due');
        expect(prisma.orgMembershipProcess.updateMany).not.toHaveBeenCalled();
        expect(setHouseholdStatus).not.toHaveBeenCalled();
    });

    it('a DENIED household changes nothing and raises the board item', async () => {
        prisma.orgMembershipProcess.findUnique.mockResolvedValue(proc({}));
        household.status = 'DENIED';
        expect((await activateByProcessId(PROCESS_ID, 'order-2', { appliesToYear: 2026 })).outcome).toBe('denied');
        expect(prisma.orgMembershipProcess.updateMany).not.toHaveBeenCalled();
        expect(raiseDeniedHouseholdActivity).toHaveBeenCalledWith(expect.objectContaining({ householdId: 3, processId: PROCESS_ID }));
        expect(emailHouseholdLeads).not.toHaveBeenCalled();
    });

    it('an order on a paid application of a DENIED household is raised as DENIED, not nothing_due', async () => {
        prisma.orgMembershipProcess.findUnique.mockResolvedValue(proc({ status: 'PENDING_BG_CLEARANCE', paidAt: new Date() }));
        household.status = 'DENIED';
        expect((await activateByProcessId(PROCESS_ID, 'order-2', { appliesToYear: 2026 })).outcome).toBe('denied');
        expect(prisma.orgMembershipProcess.updateMany).not.toHaveBeenCalled();
        expect(raiseDeniedHouseholdActivity).toHaveBeenCalledWith(expect.objectContaining({ householdId: 3, processId: PROCESS_ID }));
    });

    it('a redelivery of the recorded order on a DENIED household stays a noop', async () => {
        prisma.orgMembershipProcess.findUnique.mockResolvedValue(proc({ status: 'ACTIVE', paidAt: new Date(), shopifyOrderId: 'order-1' }));
        household.status = 'DENIED';
        expect((await activateByProcessId(PROCESS_ID, 'order-1', { appliesToYear: 2026 })).outcome).toBe('noop');
        expect(raiseDeniedHouseholdActivity).not.toHaveBeenCalled();
    });

    it('a deny that lands before the household write leaves the process untouched', async () => {
        prisma.orgMembershipProcess.findUnique.mockResolvedValue(proc({}));
        setHouseholdStatus.mockResolvedValue(false);
        expect((await activateByProcessId(PROCESS_ID, 'order-2', { appliesToYear: 2026 })).outcome).toBe('denied');
        expect(prisma.orgMembershipProcess.updateMany).not.toHaveBeenCalled();
        expect(raiseDeniedHouseholdActivity).toHaveBeenCalled();
    });
});

describe('BLOCKED', () => {
    it('records a real membership payment and stays BLOCKED', async () => {
        prisma.orgMembershipProcess.findUnique.mockResolvedValue({ id: PROCESS_ID, status: 'BLOCKED', paidAt: null, orgMembershipId: MEMBERSHIP_ID });
        expect((await activateByProcessId(PROCESS_ID, 'order-5', { appliesToYear: 2026 })).outcome).toBe('paid_while_blocked');
        expect(prisma.orgMembershipProcess.updateMany).toHaveBeenCalledWith({
            where: { id: PROCESS_ID, status: 'BLOCKED', paidAt: null },
            data: expect.objectContaining({ shopifyOrderId: 'order-5' }),
        });
        expect(prisma.orgMembershipProcess.updateMany.mock.calls[0][0].data.appliesToYear).toBe(2026);
        expect(notifyBoardPaidReject).toHaveBeenCalledWith(PROCESS_ID);
    });

    it('checks the membership item before stamping paidAt', async () => {
        prisma.orgMembershipProcess.findUnique.mockResolvedValue({ id: PROCESS_ID, status: 'BLOCKED', paidAt: null, orgMembershipId: MEMBERSHIP_ID });
        expect((await activateByProcessId(PROCESS_ID, 'order-6', null)).outcome).toBe('no_item');
        expect(prisma.orgMembershipProcess.updateMany).not.toHaveBeenCalled();
    });
});

describe('certifyPaymentPlan checks under the row lock', () => {
    it('rejects a process that is no longer awaiting payment', async () => {
        prisma.orgMembershipProcess.findUnique.mockResolvedValue({ id: PROCESS_ID, status: 'ARCHIVED', paidAt: null, orgMembershipId: MEMBERSHIP_ID });
        await expect(certifyPaymentPlan(PROCESS_ID, 1)).rejects.toMatchObject({ code: 'wrong_phase' });
        expect(prisma.$queryRaw).toHaveBeenCalled();
        expect(prisma.orgMembershipProcess.updateMany).not.toHaveBeenCalled();
    });

    it('refuses an actor who is not a Board member, even a sysadmin', async () => {
        prisma.person.findUnique.mockResolvedValue({ isBoardMember: false });
        await expect(certifyPaymentPlan(PROCESS_ID, 1)).rejects.toMatchObject({ code: 'forbidden' });
        expect(prisma.person.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 1 } }));
        expect(prisma.orgMembershipProcess.updateMany).not.toHaveBeenCalled();
    });

    it("refuses the actor's own household", async () => {
        prisma.orgMembershipProcess.findUnique.mockResolvedValue({ id: PROCESS_ID, status: 'PENDING_PAYMENT', paidAt: null, orgMembershipId: MEMBERSHIP_ID, orgMembership: { householdId: 3 } });
        hasHouseholdConflict.mockResolvedValue(true);
        await expect(certifyPaymentPlan(PROCESS_ID, 1)).rejects.toMatchObject({ code: 'forbidden' });
        expect(hasHouseholdConflict).toHaveBeenCalledWith(prisma, 1, 3);
        expect(prisma.orgMembershipProcess.updateMany).not.toHaveBeenCalled();
    });

    it('reads the household status with FOR UPDATE, after the process lock', async () => {
        prisma.orgMembershipProcess.findUnique.mockResolvedValue({ id: PROCESS_ID, status: 'PENDING_PAYMENT', paidAt: null, orgMembershipId: MEMBERSHIP_ID, orgMembership: { householdId: 3 } });
        await certifyPaymentPlan(PROCESS_ID, 1);
        const sqls = prisma.$queryRaw.mock.calls.map(([sql]: [TemplateStringsArray]) => sql.join('?'));
        expect(sqls).toEqual([
            expect.stringMatching(/FROM "OrgMembershipProcess" WHERE id = \? FOR UPDATE/),
            expect.stringMatching(/FROM "OrgMembership" WHERE id = \? FOR UPDATE/),
        ]);
    });

    it('refuses a DENIED household', async () => {
        prisma.orgMembershipProcess.findUnique.mockResolvedValue({ id: PROCESS_ID, status: 'PENDING_PAYMENT', paidAt: null, orgMembershipId: MEMBERSHIP_ID });
        household.status = 'DENIED';
        await expect(certifyPaymentPlan(PROCESS_ID, 1)).rejects.toMatchObject({ code: 'wrong_phase' });
        expect(prisma.orgMembershipProcess.updateMany).not.toHaveBeenCalled();
    });
});

describe('the year a settlement records', () => {
    const awaiting = { id: PROCESS_ID, status: 'PENDING_PAYMENT', paidAt: null, bgClearedAt: null, orgMembershipId: MEMBERSHIP_ID };
    const recordedYear = () => prisma.orgMembershipProcess.updateMany.mock.calls[0][0].data.appliesToYear;

    beforeEach(() => {
        prisma.orgMembershipProcess.findUnique.mockResolvedValue(awaiting);
        prisma.boardSettings.findUnique.mockResolvedValue({ orgMembershipYearBoundary: new Date(Date.UTC(2000, 8, 1)) });
    });
    afterEach(() => jest.useRealTimers());
    const at = (date: Date) => jest.useFakeTimers({ now: date, doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate', 'setTimeout'] });

    it('a Shopify payment records the year of its line', async () => {
        await activateByProcessId(PROCESS_ID, 'order-7', { appliesToYear: 2031 });
        expect(recordedYear()).toBe(2031);
    });

    it.each([
        ['the day before the renewal window opens', new Date(Date.UTC(2027, 5, 30)), 2026],
        ['the day the renewal window opens', new Date(Date.UTC(2027, 6, 1)), 2027],
    ])('a board certify with no year records the live year on %s', async (_label, now, year) => {
        at(now);
        await certifyPaymentPlan(PROCESS_ID, 1);
        expect(recordedYear()).toBe(year);
    });

    it('a board certify records the year it is given', async () => {
        at(new Date(Date.UTC(2027, 6, 15)));
        await certifyPaymentPlan(PROCESS_ID, 1, { year: 2026 });
        expect(recordedYear()).toBe(2026);
    });

    it('a board certify records no year when no boundary is set', async () => {
        prisma.boardSettings.findUnique.mockResolvedValue({ orgMembershipYearBoundary: null });
        await certifyPaymentPlan(PROCESS_ID, 1);
        expect(recordedYear()).toBeNull();
    });
});
