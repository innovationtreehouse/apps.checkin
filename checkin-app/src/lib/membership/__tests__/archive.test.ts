/**
 * @jest-environment node
 */
import prisma from '@/lib/prisma';
import { archiveApplication, unarchiveApplication } from '@/lib/membership/archive';
import type { OrgMembershipProcess } from '@/generated/prisma/client';

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
        $transaction: jest.fn(),
    },
}));
jest.mock('@/lib/membership/review', () => ({
    ...jest.requireActual('@/lib/membership/review'),
    applicantHousehold: jest.fn().mockResolvedValue(5),
}));
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
    });
});
