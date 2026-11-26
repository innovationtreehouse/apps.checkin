/**
 * @jest-environment node
 *
 * Cancelling a session, alone or with the rest of its series: its visits are
 * detached and each detach, and each deleted event, is audited to the canceller.
 */

import prisma from '@/lib/prisma';
import { editEventTime, type EventEditContext } from '@/lib/programs/events';

const tx = {
    visit: { findMany: jest.fn(), updateMany: jest.fn() },
    rSVP: { deleteMany: jest.fn() },
    event: { deleteMany: jest.fn() },
    auditLog: { create: jest.fn(), createMany: jest.fn() },
};

jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        event: { findMany: jest.fn() },
        $transaction: jest.fn(),
    },
}));

jest.mock('@/lib/getFullAttendance', () => ({ invalidateAttendanceCache: jest.fn() }));

const ACTOR = 7;

const sessionAt = (id: number, start: string) => ({
    id,
    programId: 3,
    name: 'Robotics',
    startAt: new Date(start),
    endAt: new Date(new Date(start).getTime() + 2 * 3600_000),
    recurringGroupId: 'series-1',
});

const visitFor = (id: number, personId: number, eventId: number) => ({
    id,
    personId,
    associatedEventId: eventId,
    arrivedAt: new Date('2026-06-10T18:00:00Z'),
    departedAt: new Date('2026-06-10T20:00:00Z'),
    arrivedVia: 'SCANNER',
    departedVia: 'SCANNER',
});

const ctxFor = (event: ReturnType<typeof sessionAt>) => ({
    event,
    actorId: ACTOR,
    isSysAdminOrBoard: false,
    isLeadMentor: true,
    isCoreVolunteer: false,
}) as unknown as EventEditContext;

beforeEach(() => {
    jest.clearAllMocks();
    (prisma.$transaction as jest.Mock).mockImplementation((fn: (t: typeof tx) => Promise<unknown>) => fn(tx));
});

it('cancelling one session detaches its visits and audits each detach and the deletion', async () => {
    const session = sessionAt(5, '2026-06-10T18:00:00Z');
    tx.visit.findMany.mockResolvedValue([visitFor(11, 2, 5), visitFor(12, 4, 5)]);

    expect(await editEventTime(ctxFor(session), { action: 'cancel' })).toEqual({ ok: true, value: {} });

    expect(tx.visit.findMany).toHaveBeenCalledWith({ where: { associatedEventId: { in: [5] } } });
    expect(tx.visit.updateMany).toHaveBeenCalledWith({ where: { id: { in: [11, 12] } }, data: { associatedEventId: null } });
    expect(tx.rSVP.deleteMany).toHaveBeenCalledWith({ where: { eventId: { in: [5] } } });
    expect(tx.event.deleteMany).toHaveBeenCalledWith({ where: { id: { in: [5] } } });

    const visitRows = tx.auditLog.createMany.mock.calls[0][0].data;
    expect(visitRows).toEqual([
        expect.objectContaining({
            actorId: ACTOR, action: 'EDIT', tableName: 'Visit', affectedEntityId: 11, secondaryAffectedEntity: 2,
            oldData: expect.objectContaining({ associatedEventId: 5 }),
            newData: { associatedEventId: null, type: 'event_cancelled' },
        }),
        expect.objectContaining({ affectedEntityId: 12, secondaryAffectedEntity: 4, oldData: expect.objectContaining({ associatedEventId: 5 }) }),
    ]);

    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    expect(tx.auditLog.create).toHaveBeenCalledWith({
        data: {
            actorId: ACTOR, actorSystem: null, action: 'DELETE', tableName: 'Event', affectedEntityId: 5, secondaryAffectedEntity: 3,
            oldData: {
                programId: 3, name: 'Robotics',
                startAt: '2026-06-10T18:00:00.000Z', endAt: '2026-06-10T20:00:00.000Z',
                recurringGroupId: 'series-1',
            },
        },
    });
});

it('cancelling the rest of a series audits every detached visit against its own session', async () => {
    const first = sessionAt(5, '2026-06-10T18:00:00Z');
    const second = sessionAt(6, '2026-06-17T18:00:00Z');
    (prisma.event.findMany as jest.Mock).mockResolvedValue([first, second]);
    tx.visit.findMany.mockResolvedValue([visitFor(11, 2, 5), visitFor(21, 2, 6)]);

    expect(await editEventTime(ctxFor(first), { action: 'cancel', applyToFuture: true })).toEqual({ ok: true, value: { count: 2 } });

    expect(tx.visit.updateMany).toHaveBeenCalledWith({ where: { id: { in: [11, 21] } }, data: { associatedEventId: null } });
    expect(tx.event.deleteMany).toHaveBeenCalledWith({ where: { id: { in: [5, 6] } } });

    const visitRows = tx.auditLog.createMany.mock.calls[0][0].data;
    expect(visitRows.map((r: { affectedEntityId: number; oldData: { associatedEventId: number } }) =>
        [r.affectedEntityId, r.oldData.associatedEventId])).toEqual([[11, 5], [21, 6]]);

    const eventRows = tx.auditLog.create.mock.calls.map(([{ data }]) => data);
    expect(eventRows).toEqual([
        expect.objectContaining({ action: 'DELETE', tableName: 'Event', affectedEntityId: 5, oldData: expect.objectContaining({ startAt: '2026-06-10T18:00:00.000Z' }) }),
        expect.objectContaining({ action: 'DELETE', tableName: 'Event', affectedEntityId: 6, oldData: expect.objectContaining({ startAt: '2026-06-17T18:00:00.000Z' }) }),
    ]);
});

it('cancelling a session with no visits writes only the event row', async () => {
    tx.visit.findMany.mockResolvedValue([]);

    await editEventTime(ctxFor(sessionAt(5, '2026-06-10T18:00:00Z')), { action: 'cancel' });

    expect(tx.visit.updateMany).not.toHaveBeenCalled();
    expect(tx.auditLog.createMany).not.toHaveBeenCalled();
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
});
