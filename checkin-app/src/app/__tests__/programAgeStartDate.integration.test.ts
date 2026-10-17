/**
 * @jest-environment node
 */
/**
 * Integration Test: age eligibility on the AUTHENTICATED enroll route is judged
 * as of the program's START date, not enrollment time (commit 2fd96fe).
 *
 * The existing programAgeBounds test sets startAt = new Date(), which collapses
 * every boundary to "age today" and leaves the start-date logic unguarded. Here
 * the program begins ~8 months in the FUTURE and the participant's calendar age
 * crosses the minAge boundary in that window: 13 today, 14 by `startAt`.
 *
 * Correct (calculateAge(dob, startAt)) -> eligible -> 200.
 * Revert (calculateAge(dob), i.e. age-as-of-now) -> 13 < 14 -> 400. This test
 * fails if the route is reverted to enrollment-time age.
 */

import { POST as enrollParticipant } from '@/app/api/programs/[id]/participants/route';
import prisma from '@/lib/prisma';
import { getServerSession } from 'next-auth/next';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));
jest.mock('@/lib/notifications', () => ({ sendNotification: jest.fn() }));

// Date faked only (timers real) so Prisma's pg pool keeps working.
const FAKE_TIMER_OPTS: Parameters<typeof jest.useFakeTimers>[0] = {
    doNotFake: [
        'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
        'setImmediate', 'clearImmediate', 'nextTick', 'queueMicrotask',
        'requestAnimationFrame', 'cancelAnimationFrame', 'hrtime', 'performance',
    ],
    now: new Date('2026-01-01T12:00:00.000Z'),
};

describe('Program Age Start-Date Basis (authenticated route)', () => {
    let programId: number;
    let userId: number;
    let guardianId: number;

    beforeAll(async () => {
        await prisma.programParticipant.deleteMany({ where: { person: { email: { contains: 'age-startdate-test' } } } });
        await prisma.person.deleteMany({ where: { email: { contains: 'age-startdate-test' } } });
        await prisma.program.deleteMany({ where: { name: { contains: 'Age StartDate Test' } } });

        // minAge 14, begins 2026-09-01. Free (no prices) so enrollment is allowed.
        const program = await prisma.program.create({
            data: {
                name: 'Age StartDate Test Program',
                minAge: 14,
                startAt: new Date('2026-09-01T00:00:00.000Z'),
                endAt: new Date('2027-06-01T00:00:00.000Z'),
                phase: 'UPCOMING',
                enrollmentStatus: 'OPEN', offSaleAt: new Date('2999-01-01')
            }
        });
        programId = program.id;

        // Born 2012-04-01: age 13 as of 2026-01-01 (frozen now), turns 14 on
        // 2026-04-01 — BEFORE the 2026-09-01 start. Eligible as of startAt only.
        // The subject is 13 at enrollment time, so a household lead enrolls them —
        // only a known adult may self-enroll (docs/rules/programs.md). The
        // age-as-of-startAt rule under test is unaffected by who submits.
        const household = await prisma.household.create({ data: { name: "Test HH" } });
        const guardian = await prisma.person.create({
            data: {
                email: 'guardian-age-startdate-test@example.com',
                name: 'Guardian',
                dateOfBirth: new Date('1985-01-01T00:00:00.000Z'),
                isHouseholdLead: true,
                householdId: household.id,
            }
        });
        guardianId = guardian.id;
        const user = await prisma.person.create({
            data: { email: 'turns14-age-startdate-test@example.com', name: 'Turns 14 Before Start', dateOfBirth: new Date('2012-04-01T00:00:00.000Z'), householdId: household.id }
        });
        userId = user.id;
    });

    afterAll(async () => {
        await prisma.programParticipant.deleteMany({ where: { programId } });
        await prisma.program.deleteMany({ where: { id: programId } });
        await prisma.person.deleteMany({ where: { id: { in: [userId, guardianId] } } });
    });

    afterEach(async () => {
        await prisma.programParticipant.deleteMany({ where: { programId } });
    });

    it('admits a participant who is under minAge today but reaches it by the program start date', async () => {
        jest.useFakeTimers(FAKE_TIMER_OPTS);
        try {
            (getServerSession as jest.Mock).mockResolvedValue({
                user: { id: guardianId, isSysadmin: false, isBoardMember: false }
            });

            const req = new Request(`http://localhost:4000/api/programs/${programId}/participants`, {
                method: 'POST',
                body: JSON.stringify({ participantId: userId })
            });

            const res = await enrollParticipant(req as unknown as import("next/server").NextRequest, { params: Promise.resolve({ id: programId.toString() }) });
            // Age as of startAt (2026-09-01) = 14 -> eligible. Enrollment-time age (13) would 400.
            expect(res.status).toBe(200);
            const data = await res.json();
            expect(data.success).toBe(true);
        } finally {
            jest.useRealTimers();
        }
    });
});
