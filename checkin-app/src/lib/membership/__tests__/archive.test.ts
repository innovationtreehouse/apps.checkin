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
    auditLog: { create: jest.fn() },
};

jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        orgMembershipProcess: { findUnique: jest.fn() },
        auditLog: { findFirst: jest.fn().mockResolvedValue(null) },
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

    describe('signature pickup across a denial', () => {
        const auditFindFirst = jest.mocked(prisma.auditLog.findFirst);
        const reopen = async () => {
            findUnique.mockResolvedValue(row({ status: 'ARCHIVED', archivedFromStatus: 'PENDING_EXTERNAL_ACTION' }));
            tx.orgMembership.findUnique.mockResolvedValue({ status: 'NONE' });
            tx.orgMembershipProcess.findFirst.mockResolvedValue(null);
            tx.orgMembershipProcess.updateMany.mockResolvedValue({ count: 1 });
            await unarchiveApplication(1, 2);
            return jest.mocked(pickUpMissedSignature).mock.calls[0][1];
        };
        afterEach(() => auditFindFirst.mockReset().mockResolvedValue(null));

        it('records the signature when the household was not denied since the close', async () => {
            auditFindFirst.mockResolvedValueOnce({ id: 40 } as never).mockResolvedValueOnce(null);
            await expect(reopen()).resolves.toEqual({ refuseSigned: false, actorId: 2 });
        });

        it('refuses the signature when a denial or the restore follows the close', async () => {
            auditFindFirst.mockResolvedValueOnce({ id: 40 } as never).mockResolvedValueOnce({ id: 41 } as never);
            await expect(reopen()).resolves.toEqual({ refuseSigned: true, actorId: 2 });
            expect(auditFindFirst).toHaveBeenLastCalledWith(expect.objectContaining({
                where: { OR: expect.arrayContaining([expect.objectContaining({ tableName: 'OrgMembership', secondaryAffectedEntity: 5, id: { gt: 40 } })]) },
            }));
        });
    });
});
