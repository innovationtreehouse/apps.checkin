/**
 * @jest-environment node
 */
/**
 * Unit test for the variant check in activate() (prisma mocked, no DB): a Shopify
 * payment (opts.via === "payment") must actually contain the membership
 * product (its Shopify variant) before a PENDING_PAYMENT process activates.
 *   - no membership variant in the order -> NOT activated, no paidAt, outcome no_item (raised by the caller).
 *   - membership variant present         -> activates (status ACTIVE, membership ACTIVE).
 *   - a "manual" (board) activation never had an order to check, so it's exempt regardless.
 *
 * Also covers the activation email's INITIAL/RENEWAL split: a renewing household
 * is thanked for renewing, not welcomed as if it were new.
 */
import { activate, activateByProcessId, certifyPaymentPlan } from '@/lib/membership/payment';
import { logBackendError } from '@/lib/logger';
import { openPersonBgForNewMember } from '@/lib/membership/personBgTriggers';
import { openPersonAgreementForNewMember } from '@/lib/membership/personAgreementTriggers';
import { householdHasDisputedCheck } from '@/lib/membership/checkStanding';
import { settleAfterEvent } from '@/lib/membership/settleHouseholdBg';

jest.mock('@/lib/prisma', () => {
    const mock = {
        orgMembershipProcess: { findUnique: jest.fn(), updateMany: jest.fn() },
        boardSettings: { findUnique: jest.fn() },
        auditLog: { create: jest.fn(), findFirst: jest.fn().mockResolvedValue(null) },
        paymentException: { findFirst: jest.fn().mockResolvedValue(null) },
        clearanceStepFailure: { upsert: jest.fn().mockResolvedValue({}) },
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
jest.mock('@/lib/membership/checkStanding', () => ({ householdHasDisputedCheck: jest.fn().mockResolvedValue(false) }));
jest.mock('@/lib/membership/settleHouseholdBg', () => ({ settleAfterEvent: jest.fn().mockResolvedValue([]) }));
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
    jest.mocked(householdHasDisputedCheck).mockResolvedValue(false);
});

it('holds a cleared payment unactivated, unstamped, when someone in the household is disputed, then settles the household', async () => {
    prisma.orgMembershipProcess.findUnique.mockResolvedValue({
        id: PROCESS_ID, kind: 'INITIAL', status: 'PENDING_PAYMENT', paidAt: null, contractSignedAt: new Date(), bgClearedAt: new Date(), orgMembershipId: MEMBERSHIP_ID,
    });
    jest.mocked(householdHasDisputedCheck).mockResolvedValue(true);

    const { outcome } = await activateByProcessId(PROCESS_ID, 'order-disputed', { appliesToYear: 2026 });

    expect(outcome).toBe('held');
    expect(householdHasDisputedCheck).toHaveBeenCalledWith(prisma, household.householdId);
    expect(prisma.orgMembershipProcess.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'PENDING_BG_CLEARANCE', bgClearedAt: null }) }),
    );
    expect(setHouseholdStatus).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ newData: expect.objectContaining({ status: 'PENDING_BG_CLEARANCE', bgCleared: false, reason: expect.stringContaining('disputed') }) }),
    }));
    expect(settleAfterEvent).toHaveBeenCalledWith(household.householdId, expect.any(String), {}, expect.anything());
});

it('holds a cleared, unsigned payment at the agreement step instead of activating it', async () => {
    prisma.orgMembershipProcess.findUnique.mockResolvedValue({
        id: PROCESS_ID, kind: 'INITIAL', status: 'PENDING_PAYMENT', paidAt: null, contractSignedAt: null, bgClearedAt: new Date(), orgMembershipId: MEMBERSHIP_ID,
    });

    const { outcome } = await activateByProcessId(PROCESS_ID, 'order-unsigned', { appliesToYear: 2026 });

    expect(outcome).toBe('held');
    expect(setHouseholdStatus).not.toHaveBeenCalled();
    expect(prisma.orgMembershipProcess.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'PENDING_EXTERNAL_ACTION' }) }),
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ newData: expect.objectContaining({ status: 'PENDING_EXTERNAL_ACTION', paid: true, contractSigned: false }) }),
    }));
});

it('an unsigned, disputed payment keeps the dispute reason on its audit row', async () => {
    prisma.orgMembershipProcess.findUnique.mockResolvedValue({
        id: PROCESS_ID, kind: 'INITIAL', status: 'PENDING_PAYMENT', paidAt: null, contractSignedAt: null, bgClearedAt: new Date(), orgMembershipId: MEMBERSHIP_ID,
    });
    jest.mocked(householdHasDisputedCheck).mockResolvedValue(true);

    expect((await activateByProcessId(PROCESS_ID, 'order-unsigned-disputed', { appliesToYear: 2026 })).outcome).toBe('held');
    expect(prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ newData: expect.objectContaining({ status: 'PENDING_EXTERNAL_ACTION', contractSigned: false, bgCleared: false, reason: expect.stringContaining('disputed') }) }),
    }));
    expect(settleAfterEvent).toHaveBeenCalledWith(household.householdId, expect.any(String), {}, expect.anything());
});

it('does NOT activate a PENDING_PAYMENT process when the order has no membership item', async () => {
    prisma.orgMembershipProcess.findUnique.mockResolvedValue({
        id: PROCESS_ID, status: 'PENDING_PAYMENT', paidAt: null, contractSignedAt: new Date(), bgClearedAt: null, orgMembershipId: MEMBERSHIP_ID,
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
        id: PROCESS_ID, status: 'PENDING_PAYMENT', paidAt: null, contractSignedAt: new Date(), bgClearedAt: new Date(), orgMembershipId: MEMBERSHIP_ID,
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
        id: PROCESS_ID, kind: 'INITIAL', status: 'PENDING_PAYMENT', paidAt: null, contractSignedAt: new Date(), bgClearedAt: new Date(), orgMembershipId: MEMBERSHIP_ID,
    });

    await activateByProcessId(PROCESS_ID, 'order-3', { appliesToYear: 2026 });

    expect(emailHouseholdLeads.mock.calls[0][1]).toBe('membership.welcome');
});

it('thanks a RENEWAL household for renewing instead of welcoming it', async () => {
    prisma.orgMembershipProcess.findUnique.mockResolvedValue({
        id: PROCESS_ID, kind: 'RENEWAL', status: 'PENDING_PAYMENT', paidAt: null, contractSignedAt: new Date(), bgClearedAt: new Date(), orgMembershipId: MEMBERSHIP_ID,
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

    it('a failed trigger leaves the activation reported, keeps a stuck item, and still runs the next trigger', async () => {
        prisma.orgMembershipProcess.findUnique.mockResolvedValue({
            id: PROCESS_ID, kind: 'INITIAL', status: 'PENDING_PAYMENT', paidAt: null, contractSignedAt: new Date(), bgClearedAt: new Date(), orgMembershipId: MEMBERSHIP_ID,
        });
        const failure = new Error('trigger failed');
        openBg.mockRejectedValue(failure);

        const { outcome } = await activateByProcessId(PROCESS_ID, 'order-5', { appliesToYear: 2026 });

        expect(outcome).toBe('active');
        expect(openAgreement).toHaveBeenCalledWith(3, PROCESS_ID, expect.any(Date));
        expect(logBackendError).toHaveBeenCalledWith(failure, expect.stringContaining('background-check trigger'), { processId: PROCESS_ID, householdId: 3 });
        expect(prisma.clearanceStepFailure.upsert).toHaveBeenCalledTimes(1);
        expect(prisma.clearanceStepFailure.upsert).toHaveBeenCalledWith(expect.objectContaining({
            create: expect.objectContaining({ processId: PROCESS_ID, step: 'PERSON_BG_TRIGGER', error: 'trigger failed' }),
        }));
    });

    it('a board certify succeeds when a trigger fails', async () => {
        prisma.orgMembershipProcess.findUnique.mockResolvedValue({
            id: PROCESS_ID, kind: 'INITIAL', status: 'PENDING_PAYMENT', paidAt: null, contractSignedAt: new Date(), bgClearedAt: new Date(), orgMembershipId: MEMBERSHIP_ID,
        });
        openAgreement.mockRejectedValue(new Error('trigger failed'));

        await expect(activate(PROCESS_ID, { via: 'manual', actorId: 1 })).resolves.toBeDefined();
        expect(prisma.clearanceStepFailure.upsert).toHaveBeenCalledWith(expect.objectContaining({
            create: expect.objectContaining({ processId: PROCESS_ID, step: 'PERSON_AGREEMENT_TRIGGER' }),
        }));
    });

    it('a failed raise on a DENIED household still throws, so the webhook redelivers', async () => {
        prisma.orgMembershipProcess.findUnique.mockResolvedValue({
            id: PROCESS_ID, status: 'PENDING_PAYMENT', paidAt: null, contractSignedAt: new Date(), bgClearedAt: null, orgMembershipId: MEMBERSHIP_ID,
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
        id: PROCESS_ID, status: 'PENDING_PAYMENT', paidAt: null, contractSignedAt: new Date(), bgClearedAt: new Date(), orgMembershipId: MEMBERSHIP_ID,
    });

    await activate(PROCESS_ID, { via: 'manual', actorId: 1 });

    expect(prisma.orgMembershipProcess.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'ACTIVE' }) }),
    );
    expect(notifyBoardPaidReject).not.toHaveBeenCalled();
});

describe('payments that land on nothing awaiting them', () => {
    const proc = (over: object) => ({ id: PROCESS_ID, kind: 'INITIAL', status: 'PENDING_PAYMENT', paidAt: null, contractSignedAt: new Date(), bgClearedAt: new Date(), orgMembershipId: MEMBERSHIP_ID, shopifyOrderId: null, ...over });

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
        await expect(certifyPaymentPlan(PROCESS_ID, 1, { year: 2026 })).rejects.toMatchObject({ code: 'wrong_phase' });
        expect(prisma.$queryRaw).toHaveBeenCalled();
        expect(prisma.orgMembershipProcess.updateMany).not.toHaveBeenCalled();
    });

    it('refuses an actor who is not a Board member, even a sysadmin', async () => {
        prisma.person.findUnique.mockResolvedValue({ isBoardMember: false });
        await expect(certifyPaymentPlan(PROCESS_ID, 1, { year: 2026 })).rejects.toMatchObject({ code: 'forbidden' });
        expect(prisma.person.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 1 } }));
        expect(prisma.orgMembershipProcess.updateMany).not.toHaveBeenCalled();
    });

    it("refuses the actor's own household", async () => {
        prisma.orgMembershipProcess.findUnique.mockResolvedValue({ id: PROCESS_ID, status: 'PENDING_PAYMENT', paidAt: null, contractSignedAt: new Date(), orgMembershipId: MEMBERSHIP_ID, orgMembership: { householdId: 3 } });
        hasHouseholdConflict.mockResolvedValue(true);
        await expect(certifyPaymentPlan(PROCESS_ID, 1, { year: 2026 })).rejects.toMatchObject({ code: 'forbidden' });
        expect(hasHouseholdConflict).toHaveBeenCalledWith(prisma, 1, 3);
        expect(prisma.orgMembershipProcess.updateMany).not.toHaveBeenCalled();
    });

    it('reads the household status with FOR UPDATE, before the process lock', async () => {
        prisma.orgMembershipProcess.findUnique.mockResolvedValue({ id: PROCESS_ID, status: 'PENDING_PAYMENT', paidAt: null, contractSignedAt: new Date(), orgMembershipId: MEMBERSHIP_ID, orgMembership: { householdId: 3 } });
        await certifyPaymentPlan(PROCESS_ID, 1, { year: 2026 });
        const sqls = prisma.$queryRaw.mock.calls.map(([sql]: [TemplateStringsArray]) => sql.join('?'));
        expect(sqls).toEqual([
            expect.stringMatching(/FROM "OrgMembership" WHERE id = \? FOR UPDATE/),
            expect.stringMatching(/FROM "OrgMembershipProcess" WHERE id = \? FOR UPDATE/),
        ]);
    });

    it('refuses a DENIED household', async () => {
        prisma.orgMembershipProcess.findUnique.mockResolvedValue({ id: PROCESS_ID, status: 'PENDING_PAYMENT', paidAt: null, contractSignedAt: new Date(), orgMembershipId: MEMBERSHIP_ID });
        household.status = 'DENIED';
        await expect(certifyPaymentPlan(PROCESS_ID, 1, { year: 2026 })).rejects.toMatchObject({ code: 'wrong_phase' });
        expect(prisma.orgMembershipProcess.updateMany).not.toHaveBeenCalled();
    });
});

describe('the year a settlement records', () => {
    const awaiting = { id: PROCESS_ID, status: 'PENDING_PAYMENT', paidAt: null, contractSignedAt: new Date(), bgClearedAt: null, orgMembershipId: MEMBERSHIP_ID, membershipYear: 2026, createdAt: new Date(Date.UTC(2026, 9, 1)) };
    const recordedYear = () => prisma.orgMembershipProcess.updateMany.mock.calls[0][0].data.appliesToYear;

    beforeEach(() => {
        prisma.orgMembershipProcess.findUnique.mockResolvedValue(awaiting);
        prisma.boardSettings.findUnique.mockResolvedValue({ orgMembershipYearBoundary: new Date(Date.UTC(2000, 8, 1)) });
    });

    it('a Shopify payment records the year of its line', async () => {
        await activateByProcessId(PROCESS_ID, 'order-7', { appliesToYear: 2031 });
        expect(recordedYear()).toBe(2031);
    });

    it('a board certify records the year it is given', async () => {
        await certifyPaymentPlan(PROCESS_ID, 1, { year: 2026 });
        expect(recordedYear()).toBe(2026);
    });

    it("refuses a year other than the application's own without the acknowledgement, writing nothing", async () => {
        await expect(certifyPaymentPlan(PROCESS_ID, 1, { year: 2027 })).rejects.toMatchObject({
            code: 'wrong_phase',
            message: expect.stringContaining('This application is for 2026-2027. You are recording a payment for 2027-2028.'),
        });
        expect(prisma.orgMembershipProcess.updateMany).not.toHaveBeenCalled();
    });

    it('records an acknowledged mismatched year, with both years and the acknowledgement on the audit row', async () => {
        await certifyPaymentPlan(PROCESS_ID, 1, { year: 2027, acknowledgeYearMismatch: true });
        expect(recordedYear()).toBe(2027);
        expect(prisma.orgMembershipProcess.updateMany.mock.calls[0][0].data).not.toHaveProperty('membershipYear');
        expect(prisma.auditLog.create.mock.calls[0][0].data.newData).toMatchObject({ appliesToYear: 2027, membershipYear: 2026, acknowledgeYearMismatch: true });
    });

    it('judges a row stored without a year by the live year at its creation', async () => {
        prisma.orgMembershipProcess.findUnique.mockResolvedValue({ ...awaiting, membershipYear: null, createdAt: new Date(Date.UTC(2027, 6, 2)) });
        await expect(certifyPaymentPlan(PROCESS_ID, 1, { year: 2026 })).rejects.toMatchObject({ message: expect.stringContaining('This application is for 2027-2028.') });
    });

    it("a board grant's year and reason go on the certify's own audit row; a certify adds no grantedYear", async () => {
        await certifyPaymentPlan(PROCESS_ID, 1, { year: 2026, reason: 'Paid by check', grant: true });
        expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
        expect(prisma.auditLog.create.mock.calls[0][0].data).toMatchObject({
            secondaryAffectedEntity: expect.any(Number),
            newData: { grantedYear: 2026, reason: 'Paid by check', certificationNote: 'Paid by check', appliesToYear: 2026, membershipYear: 2026 },
        });

        prisma.auditLog.create.mockClear();
        prisma.orgMembershipProcess.findUnique.mockResolvedValue(awaiting);
        await certifyPaymentPlan(PROCESS_ID, 1, { year: 2026, reason: 'Paid by check' });
        expect(prisma.auditLog.create.mock.calls[0][0].data.newData).not.toHaveProperty('grantedYear');
        expect(prisma.auditLog.create.mock.calls[0][0].data).not.toHaveProperty('secondaryAffectedEntity');
    });
});

describe('a payment-plan approval certifies the request year', () => {
    // Boundary 1 Sep: the renewal window opens 1 Jul, so 15 Jul 2027 is live year 2027 inside 2026-2027.
    const request = { id: PROCESS_ID, status: 'PENDING_PAYMENT', paidAt: null, contractSignedAt: new Date(), bgClearedAt: null, orgMembershipId: MEMBERSHIP_ID, isPaymentPlanRequested: true, createdAt: new Date(Date.UTC(2027, 0, 10)) };
    const recordedYear = () => prisma.orgMembershipProcess.updateMany.mock.calls[0][0].data.appliesToYear;
    const at = (date: Date) => jest.useFakeTimers({ now: date, doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate', 'setTimeout'] });

    beforeEach(() => {
        prisma.boardSettings.findUnique.mockResolvedValue({ orgMembershipYearBoundary: new Date(Date.UTC(2000, 8, 1)) });
    });
    afterEach(() => jest.useRealTimers());

    it('keeps the year it was requested for when approved after the live year moves on', async () => {
        prisma.orgMembershipProcess.findUnique.mockResolvedValue({ ...request, paymentPlanYear: 2026, stageEnteredAt: request.createdAt });
        at(new Date(Date.UTC(2027, 6, 15)));
        await certifyPaymentPlan(PROCESS_ID, 1, { reason: 'Plan agreed', requireRequested: true });
        expect(recordedYear()).toBe(2026);
    });

    it('refuses a request with no stored year, writing nothing', async () => {
        prisma.orgMembershipProcess.findUnique.mockResolvedValue({ ...request, paymentPlanYear: null, stageEnteredAt: new Date(Date.UTC(2025, 5, 1)) });
        await expect(certifyPaymentPlan(PROCESS_ID, 1, { reason: 'Plan agreed', requireRequested: true }))
            .rejects.toMatchObject({ code: 'wrong_phase', message: 'This request has no membership year. Deny it; the family can ask again.' });
        expect(prisma.orgMembershipProcess.updateMany).not.toHaveBeenCalled();
    });

    it("is never refused for a request year that differs from the application's", async () => {
        prisma.orgMembershipProcess.findUnique.mockResolvedValue({ ...request, membershipYear: 2025, paymentPlanYear: 2026, stageEnteredAt: request.createdAt });
        at(new Date(Date.UTC(2027, 6, 15)));
        await certifyPaymentPlan(PROCESS_ID, 1, { reason: 'Plan agreed', requireRequested: true });
        expect(recordedYear()).toBe(2026);
    });

    it('approves the stored year on the day before its cutoff', async () => {
        prisma.orgMembershipProcess.findUnique.mockResolvedValue({ ...request, paymentPlanYear: 2026, stageEnteredAt: request.createdAt });
        at(new Date(Date.UTC(2027, 7, 31, 23, 59)));
        await certifyPaymentPlan(PROCESS_ID, 1, { reason: 'Plan agreed', requireRequested: true });
        expect(recordedYear()).toBe(2026);
    });

    it("refuses a request on its year's cutoff date, writing nothing", async () => {
        prisma.orgMembershipProcess.findUnique.mockResolvedValue({ ...request, paymentPlanYear: 2026, stageEnteredAt: request.createdAt });
        at(new Date(Date.UTC(2027, 8, 1, 12)));
        await expect(certifyPaymentPlan(PROCESS_ID, 1, { reason: 'Plan agreed', requireRequested: true }))
            .rejects.toMatchObject({ code: 'wrong_phase', message: expect.stringContaining('2026-2027, which has ended') });
        expect(prisma.orgMembershipProcess.updateMany).not.toHaveBeenCalled();
    });
});
