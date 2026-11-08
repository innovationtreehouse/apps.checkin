/**
 * @jest-environment node
 *
 * The target guard on a lead's attendance correction: a withdrawn person can be
 * corrected only for a session that started before they left.
 */

import prisma from '@/lib/prisma';
import { manualEditAttendance, type EventEditContext } from '@/lib/programs/events';

interface EnrollmentRow {
    status: string;
    endedAt: Date | null;
}

interface GuardWhere {
    OR: [{ status: { not: string } }, { endedAt: { gt: Date } }];
}

let enrollment: EnrollmentRow | null;

jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        programParticipant: { findFirst: jest.fn() },
        programVolunteer: { findFirst: jest.fn() },
        $transaction: jest.fn(),
    },
}));

jest.mock('@/lib/getFullAttendance', () => ({ invalidateAttendanceCache: jest.fn() }));

const SESSION_START = new Date('2026-06-10T18:00:00Z');
const ctx = {
    event: { id: 5, programId: 3, startAt: SESSION_START, endAt: new Date('2026-06-10T20:00:00Z') },
    actorId: 1,
    isSysAdminOrBoard: false,
    isLeadMentor: true,
    isCoreVolunteer: false,
} as unknown as EventEditContext;

const correct = () => manualEditAttendance(ctx, { participantId: 2, status: 'Absent' });

beforeEach(() => {
    jest.clearAllMocks();
    (prisma.programVolunteer.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.$transaction as jest.Mock).mockResolvedValue(null);
    // Applies the query's status and endedAt conditions to the one stored row.
    (prisma.programParticipant.findFirst as jest.Mock).mockImplementation(async ({ where }: { where: GuardWhere }) => {
        if (!enrollment) return null;
        const [enrolled, leftAfter] = where.OR;
        const matches = enrollment.status !== enrolled.status.not
            || (enrollment.endedAt !== null && enrollment.endedAt > leftAfter.endedAt.gt);
        return matches ? { personId: 2 } : null;
    });
});

it('corrects someone currently enrolled', async () => {
    enrollment = { status: 'ACTIVE', endedAt: null };
    expect((await correct()).ok).toBe(true);
});

it('corrects someone who withdrew after the session started', async () => {
    enrollment = { status: 'WITHDRAWN', endedAt: new Date('2026-06-20T00:00:00Z') };
    expect((await correct()).ok).toBe(true);
});

it('refuses someone who withdrew before the session started', async () => {
    enrollment = { status: 'WITHDRAWN', endedAt: new Date('2026-06-01T00:00:00Z') };
    expect(await correct()).toMatchObject({ ok: false, refusal: 'invalid' });
    expect(prisma.$transaction).not.toHaveBeenCalled();
});

it('refuses someone with no enrollment', async () => {
    enrollment = null;
    expect(await correct()).toMatchObject({ ok: false, refusal: 'invalid' });
});
