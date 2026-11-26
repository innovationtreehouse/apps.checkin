/**
 * @jest-environment node
 *
 * Cancelling a session that has started and has attendance is for the Board or a
 * sysadmin only; the program's leader still cancels unattended or future sessions.
 */

import prisma from '@/lib/prisma';
import { editEventTime, type EventEditContext } from '@/lib/programs/events';

jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        visit: { findFirst: jest.fn(), updateMany: jest.fn() },
        event: { findMany: jest.fn(), delete: jest.fn(), deleteMany: jest.fn() },
        rSVP: { deleteMany: jest.fn() },
        $transaction: jest.fn(),
    },
}));

jest.mock('@/lib/getFullAttendance', () => ({ invalidateAttendanceCache: jest.fn() }));
jest.mock('@/lib/appSettings', () => ({ resolveDisplayTimezone: jest.fn().mockResolvedValue('UTC') }));

const DAY = 24 * 60 * 60 * 1000;
const PAST = { id: 5, name: 'Robotics', startAt: new Date(Date.now() - 7 * DAY), endAt: new Date(Date.now() - 7 * DAY + 2 * 3600_000), recurringGroupId: 'g1' };
const FUTURE = { id: 6, name: 'Robotics', startAt: new Date(Date.now() + 7 * DAY), endAt: new Date(Date.now() + 7 * DAY + 2 * 3600_000), recurringGroupId: 'g1' };

type Role = 'lead' | 'board' | 'sysadmin';

const ctxFor = (event: typeof PAST, role: Role) => ({
    event,
    actorId: 1,
    isSysAdminOrBoard: role !== 'lead',
    isLeadMentor: role === 'lead',
    isCoreVolunteer: false,
}) as unknown as EventEditContext;

/** Events with a live visit linked to them. */
let attended: number[];

const cancel = (event: typeof PAST, role: Role, applyToFuture = false) =>
    editEventTime(ctxFor(event, role), { action: 'cancel', applyToFuture });

beforeEach(() => {
    jest.clearAllMocks();
    attended = [];
    (prisma.$transaction as jest.Mock).mockResolvedValue([]);
    (prisma.visit.findFirst as jest.Mock).mockImplementation(async ({ where }: { where: { associatedEventId: { in: number[] } } }) => {
        const id = where.associatedEventId.in.find(i => attended.includes(i));
        return id === undefined ? null : { associatedEventId: id };
    });
    (prisma.event.findMany as jest.Mock).mockResolvedValue([PAST, FUTURE]);
});

it('refuses the lead mentor a past session with attendance', async () => {
    attended = [PAST.id];
    expect(await cancel(PAST, 'lead')).toEqual({
        ok: false,
        refusal: 'forbidden',
        message: 'This session has attendance; only the Board or a sysadmin can cancel it.',
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
});

it('refuses the lead mentor a whole series when one of its sessions has attendance', async () => {
    attended = [PAST.id];
    const result = await cancel(PAST, 'lead', true);
    expect(result).toMatchObject({ ok: false, refusal: 'forbidden' });
    expect(!result.ok && result.message).toMatch(/session has attendance; only the Board or a sysadmin can cancel it\. Nothing in the series was cancelled\./);
    expect(prisma.$transaction).not.toHaveBeenCalled();
});

it.each<Role>(['board', 'sysadmin'])('lets the %s cancel a past session with attendance', async role => {
    attended = [PAST.id];
    expect(await cancel(PAST, role)).toEqual({ ok: true, value: {} });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.visit.findFirst).not.toHaveBeenCalled();
});

it('lets the lead mentor cancel a past session with no attendance', async () => {
    expect(await cancel(PAST, 'lead')).toEqual({ ok: true, value: {} });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
});

it('lets the lead mentor cancel a future session without looking for attendance', async () => {
    attended = [FUTURE.id];
    expect(await cancel(FUTURE, 'lead')).toEqual({ ok: true, value: {} });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.visit.findFirst).not.toHaveBeenCalled();
});
