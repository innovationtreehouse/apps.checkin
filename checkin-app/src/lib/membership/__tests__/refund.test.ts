/**
 * @jest-environment node
 */
import prisma from '@/lib/prisma';
import { recordDeniedStoreRefund, recordRefund } from '@/lib/membership/refund';
import { hasHouseholdConflict } from '@/lib/conflictOfInterest';
import type { OrgMembershipProcess } from '@/generated/prisma/client';

const tx = {
    orgMembershipProcess: { updateMany: jest.fn() },
    auditLog: { create: jest.fn() },
    $queryRaw: jest.fn(),
};

/** The household status the refund reads under the membership lock. */
const householdAt = (status: string) => tx.$queryRaw.mockResolvedValue([{ status }]);

jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        orgMembershipProcess: { findUnique: jest.fn() },
        $transaction: jest.fn(),
    },
}));
jest.mock('@/lib/membership/review', () => ({
    ...jest.requireActual('@/lib/membership/review'),
    applicantHousehold: jest.fn().mockResolvedValue(5),
}));
jest.mock('@/lib/conflictOfInterest', () => ({ hasHouseholdConflict: jest.fn().mockResolvedValue(false) }));

const findUnique = jest.mocked(prisma.orgMembershipProcess.findUnique);
jest.mocked(prisma.$transaction).mockImplementation(((cb: (t: typeof tx) => unknown) => cb(tx)) as unknown as typeof prisma.$transaction);

type Row = OrgMembershipProcess & { orgMembership: { status: string } | null };

function row(over: Partial<OrgMembershipProcess> & { household?: string } = {}): Row {
    const { household = 'DENIED', ...rest } = over;
    const base = { id: 1, kind: 'INITIAL', status: 'PENDING_BG_CLEARANCE', orgMembershipId: 9, paidAt: new Date('2026-11-01'), shopifyOrderId: 'o1' };
    return { ...base, ...rest, orgMembership: { status: household } } as Row;
}

describe('recordDeniedStoreRefund', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        tx.orgMembershipProcess.updateMany.mockResolvedValue({ count: 1 });
    });

    it('clears the payment of a denied household and closes the application, under the store-refund system actor', async () => {
        findUnique.mockResolvedValue(row());
        householdAt('DENIED');
        expect(await recordDeniedStoreRefund(1, 'o1')).toBe(true);
        expect(tx.orgMembershipProcess.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({ id: 1, paidAt: { not: null } }),
            data: expect.objectContaining({ paidAt: null, status: 'ARCHIVED', archivedFromStatus: 'PENDING_PAYMENT' }),
        }));
        expect(tx.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({
            actorId: 0,
            actorSystem: 'webhook:shopify-refund',
            oldData: expect.objectContaining({ shopifyOrderId: 'o1' }),
            newData: expect.objectContaining({ status: 'ARCHIVED', refundRecorded: true, paidAt: null, closeReason: 'household denied' }),
        }) });
        expect(hasHouseholdConflict).not.toHaveBeenCalled();
    });

    it.each([
        ['a household that is not denied', row({ household: 'NONE' })],
        ['another order than the one paid', row({ shopifyOrderId: 'o2' })],
        ['an unpaid application', row({ paidAt: null })],
        ['an ACTIVE membership', row({ status: 'ACTIVE' })],
    ])('records nothing on %s', async (_label, r) => {
        findUnique.mockResolvedValue(r);
        expect(await recordDeniedStoreRefund(1, 'o1')).toBe(false);
        expect(tx.orgMembershipProcess.updateMany).not.toHaveBeenCalled();
    });

    it('returns false when another writer cleared the payment first', async () => {
        findUnique.mockResolvedValue(row());
        householdAt('DENIED');
        tx.orgMembershipProcess.updateMany.mockResolvedValue({ count: 0 });
        expect(await recordDeniedStoreRefund(1, 'o1')).toBe(false);
        expect(tx.auditLog.create).not.toHaveBeenCalled();
    });
});

describe('recordRefund (Board)', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        tx.orgMembershipProcess.updateMany.mockResolvedValue({ count: 1 });
    });

    it('records the refund under the board member', async () => {
        findUnique.mockResolvedValue(row({ household: 'NONE' }));
        householdAt('NONE');
        expect(await recordRefund(1, 7, 'Refunded')).toEqual({ status: 'PENDING_PAYMENT' });
        expect(tx.orgMembershipProcess.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.not.objectContaining({ archivedFromStatus: expect.anything() }),
        }));
        expect(tx.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ actorId: 7, actorSystem: null }) });
    });

    it.each([
        ['a clearance wait', 'PENDING_BG_CLEARANCE', 'PENDING_PAYMENT'],
        ['a held application', 'BLOCKED', 'BLOCKED'],
        ['an unsigned application', 'PENDING_EXTERNAL_ACTION', 'PENDING_EXTERNAL_ACTION'],
    ])('closes %s on a denied household, to reopen at the step the refund leaves it in', async (_label, status, from) => {
        findUnique.mockResolvedValue(row({ status: status as OrgMembershipProcess['status'] }));
        householdAt('DENIED');
        expect(await recordRefund(1, 7, 'Refunded')).toEqual({ status: 'ARCHIVED' });
        expect(tx.$queryRaw).toHaveBeenCalled();
        expect(tx.orgMembershipProcess.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ paidAt: null, status: 'ARCHIVED', archivedFromStatus: from }),
        }));
    });

    it('refuses an applicant in the same household', async () => {
        findUnique.mockResolvedValue(row());
        jest.mocked(hasHouseholdConflict).mockResolvedValueOnce(true);
        await expect(recordRefund(1, 7, 'Refunded')).rejects.toMatchObject({ code: 'same_household_applicant' });
        expect(tx.orgMembershipProcess.updateMany).not.toHaveBeenCalled();
    });
});
