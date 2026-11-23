/**
 * @jest-environment node
 */
/**
 * POST /api/facility/visits/restore through the real handler(): sysadmin and
 * board may restore a removed visit; the restore clears the tombstone and audits
 * it in the same transaction.
 */
import type { NextRequest } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { POST } from '../route';
import { invalidateAttendanceCache } from '@/lib/getFullAttendance';
import { ARCHIVED_HOUSEHOLD_REFUSAL } from '@/lib/household/archiveGuard';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));

const tx = {
    $executeRaw: jest.fn(),
    $queryRaw: jest.fn(),
    visit: { findUnique: jest.fn(), findMany: jest.fn(), update: jest.fn() },
    person: { findMany: jest.fn() },
    auditLog: { create: jest.fn() },
};
const outerFindUnique = jest.fn();
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        visit: { findUnique: (...a: unknown[]) => outerFindUnique(...a) },
        $transaction: (fn: (t: typeof tx) => unknown) => fn(tx),
    },
}));
jest.mock('@/lib/getFullAttendance', () => ({ invalidateAttendanceCache: jest.fn() }));

const req = (body: unknown) =>
    new Request('http://localhost/api/facility/visits/restore', {
        method: 'POST',
        body: JSON.stringify(body),
    }) as unknown as NextRequest;

const removed = {
    id: 11,
    personId: 2,
    arrivedAt: new Date('2026-11-01T14:00:00Z'),
    departedAt: new Date('2026-11-01T16:00:00Z'),
    deletedAt: new Date('2026-11-02T10:00:00Z'),
    deletedById: 9,
};

beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(getServerSession).mockResolvedValue({ user: { id: 5, isSysadmin: true } });
    outerFindUnique.mockResolvedValue({ personId: 2 });
    tx.visit.findUnique.mockResolvedValue(removed);
    tx.visit.findMany.mockResolvedValue([]);
    tx.visit.update.mockResolvedValue({ ...removed, deletedAt: null, deletedById: null });
    tx.person.findMany.mockResolvedValue([{ id: 2, householdId: 3 }]);
    tx.$queryRaw.mockResolvedValue([{ archivedAt: null }]);
});

it.each([
    ['sysadmin', { id: 5, isSysadmin: true }],
    ['board member', { id: 6, isBoardMember: true }],
])('a %s restores a removed visit: it counts again and the restore is audited', async (_who, user) => {
    jest.mocked(getServerSession).mockResolvedValue({ user });

    const res = await POST(req({ visitId: 11 }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
    expect(tx.visit.update).toHaveBeenCalledWith({ where: { id: 11 }, data: { deletedAt: null, deletedById: null } });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
            actorId: user.id,
            action: 'EDIT',
            tableName: 'Visit',
            affectedEntityId: 11,
            secondaryAffectedEntity: 2,
            oldData: expect.objectContaining({ deletedById: 9 }),
            newData: expect.objectContaining({ type: 'staff_restore', deletedAt: null }),
        }),
    });
    expect(invalidateAttendanceCache).toHaveBeenCalledTimes(1);
});

it.each([
    ['operations', { id: 7, isOperations: true }],
    ['plain member', { id: 8 }],
])('refuses a %s', async (_who, user) => {
    jest.mocked(getServerSession).mockResolvedValue({ user });

    expect((await POST(req({ visitId: 11 }))).status).toBe(403);
    expect(tx.visit.update).not.toHaveBeenCalled();
});

it('refuses a signed-out caller', async () => {
    jest.mocked(getServerSession).mockResolvedValue(null);

    expect((await POST(req({ visitId: 11 }))).status).toBe(401);
});

it('answers 404 for a visit that is not removed, and writes nothing', async () => {
    tx.visit.findUnique.mockResolvedValue({ ...removed, deletedAt: null });

    expect((await POST(req({ visitId: 11 }))).status).toBe(404);
    expect(tx.visit.update).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(invalidateAttendanceCache).not.toHaveBeenCalled();
});

it('refuses while the person is in an archived household', async () => {
    tx.$queryRaw.mockResolvedValue([{ archivedAt: new Date('2026-11-03T00:00:00Z') }]);

    const res = await POST(req({ visitId: 11 }));

    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(ARCHIVED_HOUSEHOLD_REFUSAL);
    expect(tx.visit.update).not.toHaveBeenCalled();
    expect(invalidateAttendanceCache).not.toHaveBeenCalled();
});

it('answers 404 for an unknown visit', async () => {
    outerFindUnique.mockResolvedValue(null);

    expect((await POST(req({ visitId: 99 }))).status).toBe(404);
});

it('answers 400 without a visit id', async () => {
    expect((await POST(req({}))).status).toBe(400);
});

it('refuses a removed visit that was never closed', async () => {
    tx.visit.findUnique.mockResolvedValue({ ...removed, departedAt: null });

    expect((await POST(req({ visitId: 11 }))).status).toBe(409);
    expect(tx.visit.update).not.toHaveBeenCalled();
});

it('refuses while the person has an open visit over the same times', async () => {
    tx.visit.findMany.mockResolvedValue([{ id: 12, arrivedAt: new Date('2026-11-01T15:00:00Z'), departedAt: null }]);

    expect((await POST(req({ visitId: 11 }))).status).toBe(409);
    expect(tx.visit.update).not.toHaveBeenCalled();
});

it('flags a restore that overlaps a closed visit for the corrections review', async () => {
    tx.visit.findMany.mockResolvedValue([{ id: 13, arrivedAt: new Date('2026-11-01T15:00:00Z'), departedAt: new Date('2026-11-01T17:00:00Z') }]);

    expect((await POST(req({ visitId: 11 }))).status).toBe(200);
    expect(tx.auditLog.create.mock.calls[0][0].data.newData).toMatchObject({ overlapsVisitIds: [13], significance: { flagged: true } });
});
