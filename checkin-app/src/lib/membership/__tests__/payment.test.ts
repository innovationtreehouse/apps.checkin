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

jest.mock('@/lib/prisma', () => {
    const mock = {
        orgMembershipProcess: { findUnique: jest.fn(), updateMany: jest.fn() },
        boardSettings: { findUnique: jest.fn() },
        auditLog: { create: jest.fn() },
        person: { findMany: jest.fn().mockResolvedValue([]), findUnique: jest.fn() },
        $queryRaw: jest.fn(),
        $transaction: jest.fn(),
    };
    mock.$transaction.mockImplementation((cb: (tx: typeof mock) => unknown) => cb(mock));
    return { __esModule: true, default: mock };
});
jest.mock('@/lib/email', () => ({ sendEmail: jest.fn().mockResolvedValue(true) }));
jest.mock('@/lib/logger', () => ({ logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn() } }));
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

    const { outcome } = await activateByProcessId(PROCESS_ID, 'order-1', false);

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

    const { outcome } = await activateByProcessId(PROCESS_ID, 'order-2', true);

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

    await activateByProcessId(PROCESS_ID, 'order-3', true);

    const [, subject, body] = emailHouseholdLeads.mock.calls[0];
    expect(subject).toBe('Welcome to the Treehouse — your membership is active!');
    expect(body).toContain('Welcome to the Innovation Treehouse community');
});

it('thanks a RENEWAL household for renewing instead of welcoming it', async () => {
    prisma.orgMembershipProcess.findUnique.mockResolvedValue({
        id: PROCESS_ID, kind: 'RENEWAL', status: 'PENDING_PAYMENT', paidAt: null, bgClearedAt: new Date(), orgMembershipId: MEMBERSHIP_ID,
    });

    await activateByProcessId(PROCESS_ID, 'order-4', true);

    const [, subject, body] = emailHouseholdLeads.mock.calls[0];
    expect(subject).toBe('Thank you for renewing — your Treehouse membership is active!');
    expect(subject).not.toContain('Welcome');
    expect(body).toContain('Thank you for renewing');
});

it('a manual (board) activation is exempt from the membership-item check', async () => {
    // certifyPaymentPlan never has a Shopify order to check (via !== "payment"),
    // so it activates even though no hasMembershipItem is passed at all.
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
        expect((await activateByProcessId(PROCESS_ID, 'order-1', true)).outcome).toBe('noop');
    });

    it.each([
        ['a second order on a paid process', { status: 'ACTIVE', paidAt: new Date(), shopifyOrderId: 'order-1' }],
        ['an order after a board certify', { status: 'ACTIVE', paidAt: new Date() }],
        ['an order after the application was closed', { status: 'ARCHIVED' }],
        ['an order before payment was due', { status: 'PENDING_BG_REVIEW' }],
        ['a second order on a paid BLOCKED process', { status: 'BLOCKED', paidAt: new Date(), shopifyOrderId: 'order-1' }],
    ])('%s is nothing_due and writes nothing', async (_label, over) => {
        prisma.orgMembershipProcess.findUnique.mockResolvedValue(proc(over));
        expect((await activateByProcessId(PROCESS_ID, 'order-2', true)).outcome).toBe('nothing_due');
        expect(prisma.orgMembershipProcess.updateMany).not.toHaveBeenCalled();
        expect(setHouseholdStatus).not.toHaveBeenCalled();
    });

    it('a DENIED household changes nothing and raises the board item', async () => {
        prisma.orgMembershipProcess.findUnique.mockResolvedValue(proc({}));
        household.status = 'DENIED';
        expect((await activateByProcessId(PROCESS_ID, 'order-2', true)).outcome).toBe('denied');
        expect(prisma.orgMembershipProcess.updateMany).not.toHaveBeenCalled();
        expect(raiseDeniedHouseholdActivity).toHaveBeenCalledWith(expect.objectContaining({ householdId: 3, processId: PROCESS_ID }));
        expect(emailHouseholdLeads).not.toHaveBeenCalled();
    });

    it('a deny that lands before the household write leaves the process untouched', async () => {
        prisma.orgMembershipProcess.findUnique.mockResolvedValue(proc({}));
        setHouseholdStatus.mockResolvedValue(false);
        expect((await activateByProcessId(PROCESS_ID, 'order-2', true)).outcome).toBe('denied');
        expect(prisma.orgMembershipProcess.updateMany).not.toHaveBeenCalled();
        expect(raiseDeniedHouseholdActivity).toHaveBeenCalled();
    });
});

describe('BLOCKED', () => {
    it('records a real membership payment and stays BLOCKED', async () => {
        prisma.orgMembershipProcess.findUnique.mockResolvedValue({ id: PROCESS_ID, status: 'BLOCKED', paidAt: null, orgMembershipId: MEMBERSHIP_ID });
        expect((await activateByProcessId(PROCESS_ID, 'order-5', true)).outcome).toBe('paid_while_blocked');
        expect(prisma.orgMembershipProcess.updateMany).toHaveBeenCalledWith({
            where: { id: PROCESS_ID, status: 'BLOCKED', paidAt: null },
            data: expect.objectContaining({ shopifyOrderId: 'order-5' }),
        });
        expect(notifyBoardPaidReject).toHaveBeenCalledWith(PROCESS_ID);
    });

    it('checks the membership item before stamping paidAt', async () => {
        prisma.orgMembershipProcess.findUnique.mockResolvedValue({ id: PROCESS_ID, status: 'BLOCKED', paidAt: null, orgMembershipId: MEMBERSHIP_ID });
        expect((await activateByProcessId(PROCESS_ID, 'order-6', false)).outcome).toBe('no_item');
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
