/**
 * @jest-environment node
 */
import prisma from '@/lib/prisma';
import { archiveApplication, unarchiveApplication } from '@/lib/membership/archive';
import type { OrgMembershipProcess } from '@/generated/prisma/client';
import { settleHouseholdBg } from '@/lib/membership/settleHouseholdBg';
import { pickUpMissedSignature } from '@/lib/membership/external';

const tx = {
    $queryRaw: jest.fn(),
    orgMembership: { findUnique: jest.fn() },
    orgMembershipProcess: { findFirst: jest.fn(), updateMany: jest.fn() },
    auditLog: { create: jest.fn(), findFirst: jest.fn() },
};

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
    reviewHouseholds: jest.fn().mockResolvedValue([5]),
}));
jest.mock('@/lib/membership/settleHouseholdBg', () => ({ settleHouseholdBg: jest.fn().mockResolvedValue([]) }));
jest.mock('@/lib/conflictOfInterest', () => ({ hasHouseholdConflict: jest.fn().mockResolvedValue(false) }));
jest.mock('@/lib/membership/external', () => ({
    advanceExternalIfComplete: jest.fn().mockResolvedValue(null),
    pickUpMissedSignature: jest.fn().mockResolvedValue(undefined),
}));

const findUnique = jest.mocked(prisma.orgMembershipProcess.findUnique);
jest.mocked(prisma.$transaction).mockImplementation(((cb: (t: typeof tx) => unknown) => cb(tx)) as unknown as typeof prisma.$transaction);

function row(over: Partial<OrgMembershipProcess>): OrgMembershipProcess {
    return { id: 1, kind: 'INITIAL', status: 'PENDING_PAYMENT', orgMembershipId: 9, subjectPersonId: null, paidAt: null, archivedFromStatus: null, ...over } as OrgMembershipProcess;
}

describe('archiveApplication (Close application)', () => {
    beforeEach(() => jest.clearAllMocks());

    it.each([
        ['paid', { status: 'PENDING_PAYMENT', paidAt: new Date() }],
        ['BLOCKED', { status: 'BLOCKED' }],
        ['PENDING_BG_CLEARANCE', { status: 'PENDING_BG_CLEARANCE', paidAt: new Date() }],
        ['ACTIVE', { status: 'ACTIVE' }],
    ] as const)('refuses a %s application without writing', async (_label, over) => {
        findUnique.mockResolvedValue(row(over));
        await expect(archiveApplication(1, 2)).rejects.toMatchObject({ code: 'wrong_phase' });
        expect(tx.orgMembershipProcess.updateMany).not.toHaveBeenCalled();
    });

    it('CASes on the status it read and on paidAt null', async () => {
        findUnique.mockResolvedValue(row({ status: 'INTAKE' }));
        tx.orgMembershipProcess.updateMany.mockResolvedValue({ count: 1 });
        await archiveApplication(1, 2);
        expect(tx.orgMembershipProcess.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 1, status: 'INTAKE', paidAt: null },
        }));
        expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    });

    it('loses to a payment that lands between the read and the write: refuses, no audit row', async () => {
        findUnique.mockResolvedValue(row({ status: 'PENDING_PAYMENT' }));
        tx.orgMembershipProcess.updateMany.mockResolvedValue({ count: 0 });
        await expect(archiveApplication(1, 2)).rejects.toMatchObject({ code: 'wrong_phase' });
        expect(tx.auditLog.create).not.toHaveBeenCalled();
    });
});

describe('unarchiveApplication (Reopen)', () => {
    beforeEach(() => jest.clearAllMocks());

    it('refuses a joining application once the household is ACTIVE', async () => {
        findUnique.mockResolvedValue(row({ status: 'ARCHIVED', archivedFromStatus: 'INTAKE' }));
        tx.orgMembership.findUnique.mockResolvedValue({ status: 'ACTIVE' });
        await expect(unarchiveApplication(1, 2)).rejects.toMatchObject({ code: 'wrong_phase', message: expect.stringMatching(/already an active member/) });
        expect(tx.orgMembershipProcess.updateMany).not.toHaveBeenCalled();
    });

    it('still reopens a renewal on an ACTIVE household', async () => {
        findUnique.mockResolvedValue(row({ kind: 'RENEWAL', status: 'ARCHIVED', archivedFromStatus: 'PENDING_RENEWAL' }));
        tx.orgMembership.findUnique.mockResolvedValue({ status: 'ACTIVE' });
        tx.orgMembershipProcess.findFirst.mockResolvedValue(null);
        tx.orgMembershipProcess.updateMany.mockResolvedValue({ count: 1 });
        await expect(unarchiveApplication(1, 2)).resolves.toEqual({ status: 'PENDING_RENEWAL' });
        // Reopen settles the household on its people's check standing.
        expect(settleHouseholdBg).toHaveBeenCalledWith(5);
    });

    describe('signing request across a denial', () => {
        const reopen = async () => {
            findUnique.mockResolvedValue(row({ status: 'ARCHIVED', archivedFromStatus: 'PENDING_EXTERNAL_ACTION', zohoEnvelopeId: 'req-1', zohoActionId: 'act-1', zohoSignerPersonId: 7, contractSignedAt: null }));
            tx.orgMembership.findUnique.mockResolvedValue({ status: 'NONE' });
            tx.orgMembershipProcess.findFirst.mockResolvedValue(null);
            tx.orgMembershipProcess.updateMany.mockResolvedValue({ count: 1 });
            await unarchiveApplication(1, 2);
            return tx.orgMembershipProcess.updateMany.mock.calls[0][0].data;
        };
        afterEach(() => tx.auditLog.findFirst.mockReset());

        it('keeps the request and asks Zoho when the household was not denied since the close', async () => {
            tx.auditLog.findFirst.mockResolvedValueOnce({ id: 40 }).mockResolvedValueOnce(null);
            expect(await reopen()).not.toHaveProperty('zohoEnvelopeId');
            expect(pickUpMissedSignature).toHaveBeenCalled();
        });

        it('forgets the request in the reopen write when a denial, a restore or the restore close follows the close', async () => {
            tx.auditLog.findFirst.mockResolvedValueOnce({ id: 40 }).mockResolvedValueOnce({ id: 41 });
            expect(await reopen()).toMatchObject({ zohoEnvelopeId: null, zohoActionId: null, zohoSignerPersonId: null });
            expect(pickUpMissedSignature).not.toHaveBeenCalled();
            expect(tx.auditLog.findFirst).toHaveBeenLastCalledWith(expect.objectContaining({
                where: {
                    OR: [
                        { id: 40, newData: { path: ['reason'], equals: 'household restored' } },
                        expect.objectContaining({ tableName: 'OrgMembership', secondaryAffectedEntity: 5, id: { gt: 40 } }),
                    ],
                },
            }));
            expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
                data: expect.objectContaining({ newData: expect.objectContaining({ zohoEnvelopeId: null, reason: 'household denied since close' }) }),
            }));
        });
    });
});
