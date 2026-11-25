/**
 * @jest-environment node
 */
import prisma from '@/lib/prisma';
import { archiveApplication, unarchiveApplication } from '@/lib/membership/archive';
import type { OrgMembershipProcess } from '@/generated/prisma/client';
import { settleAfterEvent } from '@/lib/membership/settleHouseholdBg';
import { pickUpMissedSignature } from '@/lib/membership/external';

const tx = {
    $queryRaw: jest.fn(),
    boardSettings: { findUnique: jest.fn() },
    orgMembership: { findUnique: jest.fn() },
    orgMembershipProcess: { findFirst: jest.fn(), findUnique: jest.fn(), updateMany: jest.fn() },
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
jest.mock('@/lib/membership/settleHouseholdBg', () => ({ settleAfterEvent: jest.fn().mockResolvedValue([]) }));
jest.mock('@/lib/logger', () => ({ ...jest.requireActual('@/lib/logger'), logBackendError: jest.fn() }));
jest.mock('@/lib/conflictOfInterest', () => ({ hasHouseholdConflict: jest.fn().mockResolvedValue(false) }));
jest.mock('@/lib/membership/external', () => ({
    advanceExternalIfComplete: jest.fn().mockResolvedValue(null),
    pickUpMissedSignature: jest.fn().mockResolvedValue(undefined),
}));

const findUnique = jest.mocked(prisma.orgMembershipProcess.findUnique);
jest.mocked(prisma.$transaction).mockImplementation(((cb: (t: typeof tx) => unknown) => cb(tx)) as unknown as typeof prisma.$transaction);

function row(over: Partial<OrgMembershipProcess>): OrgMembershipProcess {
    return { id: 1, kind: 'INITIAL', status: 'PENDING_PAYMENT', orgMembershipId: 9, subjectPersonId: null, paidAt: null, archivedFromStatus: null, createdAt: new Date('2026-01-15T12:00:00.000Z'), ...over } as OrgMembershipProcess;
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
        tx.orgMembershipProcess.findUnique.mockResolvedValue({ status: 'PENDING_BG_CLEARANCE' });
        await expect(archiveApplication(1, 2)).rejects.toMatchObject({ code: 'wrong_phase' });
        expect(tx.auditLog.create).not.toHaveBeenCalled();
    });

    it('loses to a concurrent close of the same application: succeeds as a no-op, no second audit row', async () => {
        findUnique.mockResolvedValue(row({ status: 'PENDING_PAYMENT' }));
        tx.orgMembershipProcess.updateMany.mockResolvedValue({ count: 0 });
        tx.orgMembershipProcess.findUnique.mockResolvedValue({ status: 'ARCHIVED' });
        await expect(archiveApplication(1, 2)).resolves.toEqual({ status: 'ARCHIVED' });
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
        expect(settleAfterEvent).toHaveBeenCalledWith(5, expect.any(String), {}, expect.anything());
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

describe('unarchiveApplication (Reopen) within the membership year', () => {
    // Boundary Aug 1, so each renewal window opens Jun 1.
    const boundary = new Date('2020-08-01T00:00:00.000Z');
    const at = (iso: string) => jest.useFakeTimers({ now: new Date(iso) });

    beforeEach(() => {
        jest.clearAllMocks();
        tx.boardSettings.findUnique.mockResolvedValue({ orgMembershipYearBoundary: boundary });
        tx.orgMembership.findUnique.mockResolvedValue({ status: 'ACTIVE' });
        tx.orgMembershipProcess.findFirst.mockResolvedValue(null);
        tx.orgMembershipProcess.updateMany.mockResolvedValue({ count: 1 });
    });
    afterEach(() => jest.useRealTimers());

    const renewal = (createdAt: string) =>
        row({ kind: 'RENEWAL', status: 'ARCHIVED', archivedFromStatus: 'PENDING_RENEWAL', createdAt: new Date(createdAt) });

    it('reopens inside the same year', async () => {
        at('2026-12-01T12:00:00.000Z');
        findUnique.mockResolvedValue(renewal('2026-07-01T12:00:00.000Z'));
        await expect(unarchiveApplication(1, 2)).resolves.toEqual({ status: 'PENDING_RENEWAL' });
    });

    it("refuses once the next year's renewal window has opened", async () => {
        at('2027-06-02T12:00:00.000Z');
        findUnique.mockResolvedValue(renewal('2026-07-01T12:00:00.000Z'));
        await expect(unarchiveApplication(1, 2)).rejects.toMatchObject({
            code: 'wrong_phase',
            message: "This application is for 2026-2027. The 2027-2028 renewal period has started, so it can't be reopened; use the new renewal.",
        });
        expect(tx.orgMembershipProcess.updateMany).not.toHaveBeenCalled();
    });

    it('reopens as before when no boundary is configured', async () => {
        at('2027-06-02T12:00:00.000Z');
        tx.boardSettings.findUnique.mockResolvedValue({ orgMembershipYearBoundary: null });
        findUnique.mockResolvedValue(renewal('2020-07-01T12:00:00.000Z'));
        await expect(unarchiveApplication(1, 2)).resolves.toEqual({ status: 'PENDING_RENEWAL' });
    });

    it('dates an off-season joining application to the year live at its creation', async () => {
        tx.orgMembership.findUnique.mockResolvedValue({ status: 'PENDING' });
        findUnique.mockResolvedValue(row({ kind: 'INITIAL', status: 'ARCHIVED', archivedFromStatus: 'INTAKE', createdAt: new Date('2026-03-01T12:00:00.000Z') }));

        at('2026-05-31T12:00:00.000Z');
        await expect(unarchiveApplication(1, 2)).resolves.toEqual({ status: 'INTAKE' });

        at('2026-06-01T12:00:00.000Z');
        await expect(unarchiveApplication(1, 2)).rejects.toMatchObject({
            message: "This application is for 2025-2026. The 2026-2027 renewal period has started, so it can't be reopened; start a new application.",
        });
    });

    describe('a paid row closed with no year', () => {
        const paid = (over: Partial<OrgMembershipProcess>) => row({
            kind: 'RENEWAL', status: 'ARCHIVED', archivedFromStatus: 'PENDING_BG_CLEARANCE',
            createdAt: new Date('2026-06-05T12:00:00.000Z'), paidAt: new Date('2026-06-10T12:00:00.000Z'), appliesToYear: null, ...over,
        });
        const written = () => tx.orgMembershipProcess.updateMany.mock.calls[0][0].data;

        it('reopens with the year its payment falls in, and audits it', async () => {
            at('2026-12-01T12:00:00.000Z');
            findUnique.mockResolvedValue(paid({}));
            await unarchiveApplication(1, 2);
            expect(written()).toMatchObject({ status: 'PENDING_BG_CLEARANCE', appliesToYear: 2026 });
            expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
                data: expect.objectContaining({ newData: expect.objectContaining({ appliesToYear: 2026 }) }),
            }));
        });

        it('places a payment before the window opens in the year before', async () => {
            at('2026-12-01T12:00:00.000Z');
            findUnique.mockResolvedValue(paid({ createdAt: new Date('2026-06-01T12:00:00.000Z'), paidAt: new Date('2026-05-31T12:00:00.000Z') }));
            await unarchiveApplication(1, 2);
            expect(written()).toMatchObject({ appliesToYear: 2025 });
        });

        it.each([
            ['a recorded year', { appliesToYear: 2025 }],
            ['no payment', { paidAt: null }],
        ] as const)('leaves the year alone with %s', async (_label, over) => {
            at('2026-12-01T12:00:00.000Z');
            findUnique.mockResolvedValue(paid(over));
            await unarchiveApplication(1, 2);
            expect(written()).not.toHaveProperty('appliesToYear');
        });

        it('writes no year when no boundary is configured', async () => {
            at('2026-12-01T12:00:00.000Z');
            tx.boardSettings.findUnique.mockResolvedValue({ orgMembershipYearBoundary: null });
            findUnique.mockResolvedValue(paid({}));
            await unarchiveApplication(1, 2);
            expect(written()).not.toHaveProperty('appliesToYear');
        });
    });

    it('leaves per-person kinds alone', async () => {
        at('2027-06-02T12:00:00.000Z');
        findUnique.mockResolvedValue(row({ kind: 'PERSON_BG', orgMembershipId: null, subjectPersonId: 7, status: 'ARCHIVED', archivedFromStatus: 'PENDING_BG_REVIEW', createdAt: new Date('2020-07-01T12:00:00.000Z') }));
        await expect(unarchiveApplication(1, 2)).resolves.toEqual({ status: 'PENDING_BG_REVIEW' });
    });
});
