/**
 * @jest-environment node
 */
/**
 * Integration Tests for Event RSVP API
 * Tests PATCH /api/events/[id]/rsvp for updating participant's RSVP status
 */

import { PATCH } from '@/app/api/events/[id]/rsvp/route';
import prisma from '@/lib/prisma';
import { getServerSession } from 'next-auth/next';
// Mock NextAuth
jest.mock('next-auth/next', () => ({
    getServerSession: jest.fn(),
}));
describe('Event RSVP API Integration Tests', () => {
    let testUserId: number;
    let testUnenrolledUserId: number;
    let testProgramId: number;
    let testEventId: number;
    // Cross-tenant attacker: lead of a DIFFERENT program (not enrolled here).
    let foreignLeadId: number;
    let foreignProgramId: number;

    beforeAll(async () => {
        // Clean up any leaked state
        await prisma.rSVP.deleteMany({
            where: { person: { email: { contains: 'rsvp-test' } } }
        });
        await prisma.event.deleteMany({
            where: { name: 'RSVP Test Event' }
        });
        await prisma.programParticipant.deleteMany({
            where: { person: { email: { contains: 'rsvp-test' } } }
        });
        await prisma.program.deleteMany({
            where: { name: 'RSVP Test Program' }
        });
        await prisma.person.deleteMany({
            where: { email: { contains: 'rsvp-test' } }
        });

        // Setup mock database records
        const user = await prisma.person.create({
            data: { email: 'enrolled-user-rsvp-test@example.com', name: 'Enrolled RSVP Test', household: { create: { name: "Test HH" } } }
        });
        testUserId = user.id;

        const unenrolledUser = await prisma.person.create({
            data: { email: 'unenrolled-user-rsvp-test@example.com', name: 'Unenrolled RSVP Test', household: { create: { name: "Test HH" } } }
        });
        testUnenrolledUserId = unenrolledUser.id;

        const program = await prisma.program.create({
            data: {
                startAt: new Date('2026-01-01'),
                endAt: new Date('2026-12-31'),
                name: 'RSVP Test Program',
                leadMentorId: testUserId,
                maxParticipants: 10,
                minAge: 5,
                maxAge: 18,
            }
        });
        testProgramId = program.id;

        // Enroll the enrolled user
        await prisma.programParticipant.create({
            data: {
                programId: testProgramId,
                personId: testUserId
            }
        });

        // A lead of an UNRELATED program — the cross-tenant attacker. Privileged in
        // their own program but not enrolled/volunteering in testEvent's program.
        const foreignLead = await prisma.person.create({
            data: { email: 'foreignlead-rsvp-test@example.com', name: 'Foreign Lead RSVP Test', household: { create: { name: "Test HH" } } }
        });
        foreignLeadId = foreignLead.id;
        const foreignProgram = await prisma.program.create({
            data: { startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), name: 'RSVP Test Foreign Program', leadMentorId: foreignLeadId, maxParticipants: 10, minAge: 5, maxAge: 18 }
        });
        foreignProgramId = foreignProgram.id;

        const now = new Date();
        const start = new Date(now.getTime() + 1 * 60 * 60 * 1000); // 1 hour from now

        const event = await prisma.event.create({
            data: {
                name: 'RSVP Test Event',
                programId: testProgramId,
                startAt: start,
                endAt: new Date(start.getTime() + 2 * 60 * 60 * 1000)
            }
        });
        testEventId = event.id;
    });

    afterAll(async () => {
        // Clean up
        await prisma.rSVP.deleteMany({
            where: { personId: { in: [testUserId, testUnenrolledUserId, foreignLeadId] } }
        });
        await prisma.event.deleteMany({
            where: { id: testEventId }
        });
        await prisma.programParticipant.deleteMany({
            where: { programId: { in: [testProgramId, foreignProgramId] } }
        });
        await prisma.program.deleteMany({
            where: { id: { in: [testProgramId, foreignProgramId] } }
        });
        // RESTRICT: delete participants before their (auto-created) households.
        const allParticipantIds = [testUserId, testUnenrolledUserId, foreignLeadId];
        const householdIds = (await prisma.person.findMany({
            where: { id: { in: allParticipantIds } },
            select: { householdId: true }
        })).map(p => p.householdId);

        await prisma.person.deleteMany({
            where: { id: { in: allParticipantIds } }
        });
        await prisma.household.deleteMany({
            where: { id: { in: householdIds } }
        });
    });

    describe('PATCH /api/events/[id]/rsvp', () => {
        it('should return 401 Unauthorized without session', async () => {
             (getServerSession as jest.Mock).mockResolvedValue(null);

             const req = new Request(`http://localhost:4000/api/events/${testEventId}/rsvp`, {
                 method: 'PATCH',
                 body: JSON.stringify({ status: 'ATTENDING' })
             });

             const res = await PATCH(req as unknown as import("next/server").NextRequest, { params: Promise.resolve({ id: String(testEventId) }) });
             expect(res.status).toBe(401);
        });

        it('should return 400 Bad Request for invalid RSVP status', async () => {
             (getServerSession as jest.Mock).mockResolvedValue({
                 user: { id: testUserId }
             });

             const req = new Request(`http://localhost:4000/api/events/${testEventId}/rsvp`, {
                 method: 'PATCH',
                 body: JSON.stringify({ status: 'INVALID_STATUS' })
             });

             const res = await PATCH(req as unknown as import("next/server").NextRequest, { params: Promise.resolve({ id: String(testEventId) }) });
             expect(res.status).toBe(400);

             const data = await res.json();
             expect(data.error).toBe('Invalid RSVP status');
        });

        it('should return 404 Not Found for invalid event ID', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({
                user: { id: testUserId }
            });

            const req = new Request(`http://localhost:4000/api/events/9999999/rsvp`, {
                method: 'PATCH',
                body: JSON.stringify({ status: 'ATTENDING' })
            });

            const res = await PATCH(req as unknown as import("next/server").NextRequest, { params: Promise.resolve({ id: '9999999' }) });
            expect(res.status).toBe(404);
        });

        it('should return 403 Forbidden if user is not enrolled in the program for the event', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({
                user: { id: testUnenrolledUserId }
            });

            const req = new Request(`http://localhost:4000/api/events/${testEventId}/rsvp`, {
                method: 'PATCH',
                body: JSON.stringify({ status: 'ATTENDING' })
            });

            const res = await PATCH(req as unknown as import("next/server").NextRequest, { params: Promise.resolve({ id: String(testEventId) }) });
            expect(res.status).toBe(403);

            const data = await res.json();
            expect(data.error).toContain('Forbidden');
        });

        // IDOR boundary: the gate is the inline "are you enrolled/volunteering in
        // this event's program?" check (route.ts). A non-participant must be 403'd
        // AND no RSVP row must be written for them — a 403 that still upserted would
        // be the real bug. Re-query to pin it. Mirrors fd192fc.
        function rsvpFor(participantId: number) {
            return prisma.rSVP.findUnique({
                where: { eventId_personId: { eventId: testEventId, personId: participantId } }
            });
        }

        it('IDOR: a lead of a DIFFERENT program cannot RSVP (403, no RSVP written)', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({ user: { id: foreignLeadId } });

            const req = new Request(`http://localhost:4000/api/events/${testEventId}/rsvp`, {
                method: 'PATCH',
                body: JSON.stringify({ status: 'ATTENDING' })
            });
            const res = await PATCH(req as unknown as import("next/server").NextRequest, { params: Promise.resolve({ id: String(testEventId) }) });

            expect(res.status).toBe(403);
            expect(await rsvpFor(foreignLeadId)).toBeNull();
        });

        it('IDOR: a non-enrolled user cannot RSVP (403, no RSVP written)', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({ user: { id: testUnenrolledUserId } });

            const req = new Request(`http://localhost:4000/api/events/${testEventId}/rsvp`, {
                method: 'PATCH',
                body: JSON.stringify({ status: 'ATTENDING' })
            });
            const res = await PATCH(req as unknown as import("next/server").NextRequest, { params: Promise.resolve({ id: String(testEventId) }) });

            expect(res.status).toBe(403);
            expect(await rsvpFor(testUnenrolledUserId)).toBeNull();
        });

        it('should successfully create an RSVP for an enrolled participant', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({
                user: { id: testUserId }
            });

            const req = new Request(`http://localhost:4000/api/events/${testEventId}/rsvp`, {
                method: 'PATCH',
                body: JSON.stringify({ status: 'ATTENDING' })
            });

            const res = await PATCH(req as unknown as import("next/server").NextRequest, { params: Promise.resolve({ id: String(testEventId) }) });
            expect(res.status).toBe(200);

            const data = await res.json();
            expect(data.success).toBe(true);
            expect(data.rsvp.status).toBe('ATTENDING');

            const rsvpRecord = await prisma.rSVP.findUnique({
                where: {
                    eventId_personId: {
                        eventId: testEventId,
                        personId: testUserId
                    }
                }
            });
            expect(rsvpRecord).toBeDefined();
            expect(rsvpRecord?.status).toBe('ATTENDING');
        });

        it('should successfully update an existing RSVP', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({
                user: { id: testUserId }
            });

            // Make sure the record exists from the previous test or create it
            await prisma.rSVP.upsert({
                where: {
                    eventId_personId: {
                        eventId: testEventId,
                        personId: testUserId
                    }
                },
                update: { status: 'ATTENDING' },
                create: {
                    eventId: testEventId,
                    personId: testUserId,
                    status: 'ATTENDING'
                }
            });

            const req = new Request(`http://localhost:4000/api/events/${testEventId}/rsvp`, {
                method: 'PATCH',
                body: JSON.stringify({ status: 'NOT_ATTENDING' })
            });

            const res = await PATCH(req as unknown as import("next/server").NextRequest, { params: Promise.resolve({ id: String(testEventId) }) });
            expect(res.status).toBe(200);

            const data = await res.json();
            expect(data.success).toBe(true);
            expect(data.rsvp.status).toBe('NOT_ATTENDING');

            const rsvpRecord = await prisma.rSVP.findUnique({
                where: {
                    eventId_personId: {
                        eventId: testEventId,
                        personId: testUserId
                    }
                }
            });
            expect(rsvpRecord?.status).toBe('NOT_ATTENDING');
        });
    });
});
