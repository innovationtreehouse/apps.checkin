/**
 * @jest-environment node
 */
/**
 * POST /api/facility/visits/insert through the real handler(): staff record a
 * closed visit for someone else, with its IN/OUT presence events and audit row
 * in the same transaction.
 */
import type { NextRequest } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { POST } from '../route';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));
jest.mock('@/lib/attendanceTransitions', () => ({ findAssociatedEventAt: jest.fn().mockResolvedValue(null) }));
jest.mock('@/lib/household/archiveGuard', () => ({ lockLiveHouseholdsOf: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/lib/getFullAttendance', () => ({ invalidateAttendanceCache: jest.fn() }));

const tx = {
    $executeRaw: jest.fn(),
    visit: { findMany: jest.fn(), create: jest.fn() },
    presenceEvent: { create: jest.fn() },
    auditLog: { create: jest.fn() },
};
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        person: { findFirst: jest.fn().mockResolvedValue({ id: 2 }) },
        $transaction: (fn: (t: typeof tx) => unknown) => fn(tx),
    },
}));

const ARRIVED = new Date('2026-11-01T14:00:00Z');
const DEPARTED = new Date('2026-11-01T16:00:00Z');

const req = (body: unknown) =>
    new Request('http://localhost/api/facility/visits/insert', {
        method: 'POST',
        body: JSON.stringify(body),
    }) as unknown as NextRequest;

beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(getServerSession).mockResolvedValue({ user: { id: 5, isBoardMember: true } });
    tx.visit.findMany.mockResolvedValue([]);
    tx.visit.create.mockImplementation(async (args: { data: Record<string, unknown> }) => ({
        id: 31, deletedAt: null, deletedById: null, forceCloseWarnedAt: null, forceCloseToken: null, ...args.data,
    }));
    tx.presenceEvent.create.mockResolvedValue({});
    tx.auditLog.create.mockResolvedValue({});
});

it('writes an IN and an OUT presence event for the inserted visit', async () => {
    const res = await POST(req({ personId: 2, arrivedAt: ARRIVED.toISOString(), departedAt: DEPARTED.toISOString() }));

    expect(res.status).toBe(200);
    expect(tx.presenceEvent.create).toHaveBeenCalledTimes(2);
    expect(tx.presenceEvent.create).toHaveBeenNthCalledWith(1, {
        data: expect.objectContaining({ personId: 2, occurredAt: ARRIVED, direction: 'IN', source: 'TYPED', classification: 'PROJECTED', visitId: 31 }),
    });
    expect(tx.presenceEvent.create).toHaveBeenNthCalledWith(2, {
        data: expect.objectContaining({ personId: 2, occurredAt: DEPARTED, direction: 'OUT', source: 'TYPED', classification: 'PROJECTED', visitId: 31 }),
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ action: 'CREATE', affectedEntityId: 31, secondaryAffectedEntity: 2 }),
    });
});
