/**
 * @jest-environment node
 */
/**
 * Integration Tests for Events API
 * Tests POST /api/events for single and recurring event generation
 */

import { POST } from '@/app/api/events/route';
import { normalizeAuditData } from '@/lib/auditPayload';
import prisma from '@/lib/prisma';
import { getServerSession } from 'next-auth/next';
import { formatInTimeZone } from 'date-fns-tz';

// Mock NextAuth
jest.mock('next-auth/next', () => ({
    getServerSession: jest.fn(),
}));
describe('Events API Integration Tests', () => {
    let testAdminId: number;
    let testUserId: number;
    let testLeadMentorId: number;
    let testProgramId: number;

    let prevAppSettings: { id: number; timezone: string; locale: string } | null = null;

    beforeAll(async () => {
        // This suite asserts America/Chicago wall-clock semantics; pin the
        // AppSettings singleton rather than trusting whatever a worker-mate
        // left behind (the localization suite once leaked America/New_York).
        prevAppSettings = await prisma.appSettings.findUnique({ where: { id: 1 } });
        await prisma.appSettings.upsert({
            where: { id: 1 },
            create: { id: 1, timezone: 'America/Chicago' },
            update: { timezone: 'America/Chicago' },
        });

        // Clean up any leaked state
        await prisma.event.deleteMany({
            where: { name: { contains: 'Test Event' } }
        });
        await prisma.program.deleteMany({
            where: { name: 'Events Test Program' }
        });
        await prisma.person.deleteMany({
            where: { email: { contains: 'events-api-test' } }
        });

        // Setup mock database records
        const admin = await prisma.person.create({
            data: { email: 'admin-events-api-test@example.com', name: 'Admin Events Test', isSysadmin: true, household: { create: { name: "Test HH" } } }
        });
        testAdminId = admin.id;

        const user = await prisma.person.create({
            data: { email: 'user-events-api-test@example.com', name: 'User Events Test', household: { create: { name: "Test HH" } } }
        });
        testUserId = user.id;

        const mentor = await prisma.person.create({
            data: { email: 'mentor-events-api-test@example.com', name: 'Mentor Events Test', household: { create: { name: "Test HH" } } }
        });
        testLeadMentorId = mentor.id;

        const program = await prisma.program.create({
            data: {
                startAt: new Date('2026-01-01'),
                endAt: new Date('2026-12-31'),
                name: 'Events Test Program',
                leadMentorId: testLeadMentorId,
                maxParticipants: 10,
                minAge: 5,
                maxAge: 18,
            }
        });
        testProgramId = program.id;
    });

    afterAll(async () => {
        // Same singleton discipline as the pin above: put back what we found.
        if (prevAppSettings) await prisma.appSettings.update({ where: { id: 1 }, data: { timezone: prevAppSettings.timezone, locale: prevAppSettings.locale } });
        else await prisma.appSettings.deleteMany({ where: { id: 1 } });

        // Clean up
        await prisma.event.deleteMany({
            where: { name: { contains: 'Test Event' } }
        });
        await prisma.program.deleteMany({
            where: { id: testProgramId }
        });
        // RESTRICT: delete participants before their (auto-created) households.
        const householdIds = (await prisma.person.findMany({
            where: { id: { in: [testAdminId, testUserId, testLeadMentorId] } },
            select: { householdId: true }
        })).map(p => p.householdId);

        await prisma.auditLog.deleteMany({
            where: { actorId: { in: [testAdminId, testUserId, testLeadMentorId] } }
        });
        await prisma.person.deleteMany({
            where: { id: { in: [testAdminId, testUserId, testLeadMentorId] } }
        });
        await prisma.household.deleteMany({
            where: { id: { in: householdIds } }
        });
    });

    describe('POST /api/events', () => {
        it('should return 401 Unauthorized without session', async () => {
             (getServerSession as jest.Mock).mockResolvedValue(null);

             const req = new Request('http://localhost:4000/api/events', {
                 method: 'POST',
                 body: JSON.stringify({ name: 'Test Event' })
             });

             const res = await POST(req as unknown as import("next/server").NextRequest);
             expect(res.status).toBe(401);
        });

        it('should return 403 Forbidden for non-admin users who are not lead mentors', async () => {
             (getServerSession as jest.Mock).mockResolvedValue({
                 user: { id: testUserId, isSysadmin: false, isBoardMember: false }
             });

             const req = new Request('http://localhost:4000/api/events', {
                 method: 'POST',
                 body: JSON.stringify({ name: 'Test Event', programId: testProgramId, startDate: '2025-01-01', startTime: '10:00', endTime: '12:00' })
             });

             const res = await POST(req as unknown as import("next/server").NextRequest);
             expect(res.status).toBe(403);
        });

        it('should return 400 Bad Request if required fields are missing', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({
                user: { id: testAdminId, isSysadmin: true, isBoardMember: false }
            });

            const req = new Request('http://localhost:4000/api/events', {
                method: 'POST',
                body: JSON.stringify({ name: 'Test Event Missing Dates' }) // Missing startDate, etc
            });

            const res = await POST(req as unknown as import("next/server").NextRequest);
            expect(res.status).toBe(400);
            
            const data = await res.json();
            expect(data.error).toBe('Missing required fields');
        });

        it('should return 400 if end time is not after start time', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({
                user: { id: testAdminId, isSysadmin: true, isBoardMember: false }
            });

            const req = new Request('http://localhost:4000/api/events', {
                method: 'POST',
                body: JSON.stringify({
                    name: 'Test Event Bad Times',
                    programId: testProgramId,
                    startDate: '2026-10-01',
                    startTime: '15:00',
                    endTime: '15:00' // end == start
                })
            });

            const res = await POST(req as unknown as import("next/server").NextRequest);
            expect(res.status).toBe(400);
            const data = await res.json();
            expect(data.error).toBe('Event end time must be after start time');

            // Nothing created.
            const events = await prisma.event.findMany({ where: { name: 'Test Event Bad Times' } });
            expect(events.length).toBe(0);
        });

        it('should successfully create a single event as admin', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({
                user: { id: testAdminId, isSysadmin: true, isBoardMember: false }
            });

            const req = new Request('http://localhost:4000/api/events', {
                method: 'POST',
                body: JSON.stringify({
                    name: 'Single Test Event',
                    description: 'A test event description',
                    programId: testProgramId,
                    startDate: '2026-10-01',
                    startTime: '13:00',
                    endTime: '15:00'
                })
            });

            const res = await POST(req as unknown as import("next/server").NextRequest);
            expect(res.status).toBe(200);

            const data = await res.json();
            expect(data.success).toBe(true);
            expect(data.count).toBe(1);

            const events = await prisma.event.findMany({ where: { name: 'Single Test Event' } });
            expect(events.length).toBe(1);
            expect(events[0].programId).toBe(testProgramId);
            expect(formatInTimeZone(events[0].startAt, 'America/Chicago', 'HH:mm:ss')).toBe('13:00:00');
            expect(formatInTimeZone(events[0].endAt, 'America/Chicago', 'HH:mm:ss')).toBe('15:00:00');

            // Exactly one AuditLog row for this create, by the creating admin.
            // Route logs a summary keyed to the program (affectedEntityId = programId), not per-event.
            const logs = await prisma.auditLog.findMany({ where: { actorId: testAdminId, tableName: 'Event' } });
            expect(logs.length).toBe(1);
            expect(logs[0].action).toBe('CREATE');
            expect(logs[0].affectedEntityId).toBe(testProgramId);
            // newData is a JSON-stringified summary: { count, sample }.
            expect(normalizeAuditData(logs[0].newData)).toMatchObject({ count: 1 });
        });

        it('should successfully create recurring events as a lead mentor', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({
                user: { id: testLeadMentorId, isSysadmin: false, isBoardMember: false }
            });

            // Recurrence: from Oct 1 to Oct 15, on Mon (1) and Wed (3).
            // Oct 1 2026 is a Thursday.
            // Expected dates: Oct 5(Mon), Oct 7(Wed), Oct 12(Mon), Oct 14(Wed) -> 4 events.
            const req = new Request('http://localhost:4000/api/events', {
                method: 'POST',
                body: JSON.stringify({
                    name: 'Recurring Test Event',
                    programId: testProgramId,
                    startDate: '2026-10-01',
                    startTime: '09:00',
                    endTime: '11:00',
                    recurrence: {
                        daysOfWeek: [1, 3], 
                        until: '2026-10-15'
                    }
                })
            });

            const res = await POST(req as unknown as import("next/server").NextRequest);
            expect(res.status).toBe(200);

            const data = await res.json();
            expect(data.success).toBe(true);
            expect(data.count).toBe(4);

            const events = await prisma.event.findMany({ where: { name: 'Recurring Test Event' } });
            expect(events.length).toBe(4);
        });

        it('should keep the same local wall-clock time across the DST fall-back boundary', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({
                user: { id: testLeadMentorId, isSysadmin: false, isBoardMember: false }
            });

            // US DST ends on the first Sunday of November — Nov 1 2026 (2am CDT -> 1am CST).
            // Weekly on Wednesday (3) from Oct 28 to Nov 11 2026 spans that boundary:
            //   Oct 28 (CDT, -05:00), Nov 4 (CST, -06:00), Nov 11 (CST, -06:00) -> 3 events.
            // Local time is fixed at 13:00 (a daytime hour, well clear of the 1-2am
            // repeated-hour ambiguity), so every occurrence must read 13:00:00 local
            // even though its UTC instant shifts by an hour when DST ends.
            const req = new Request('http://localhost:4000/api/events', {
                method: 'POST',
                body: JSON.stringify({
                    name: 'DST Boundary Test Event',
                    programId: testProgramId,
                    startDate: '2026-10-28',
                    startTime: '13:00',
                    endTime: '15:00',
                    recurrence: {
                        daysOfWeek: [3],
                        until: '2026-11-11'
                    }
                })
            });

            const res = await POST(req as unknown as import("next/server").NextRequest);
            expect(res.status).toBe(200);

            const data = await res.json();
            expect(data.success).toBe(true);
            expect(data.count).toBe(3);

            const events = await prisma.event.findMany({
                where: { name: 'DST Boundary Test Event' },
                orderBy: { startAt: 'asc' }
            });
            expect(events.length).toBe(3);

            // Every occurrence keeps the same 13:00 local wall-clock, before and after fall-back.
            for (const occ of events) {
                expect(formatInTimeZone(occ.startAt, 'America/Chicago', 'HH:mm:ss')).toBe('13:00:00');
                expect(formatInTimeZone(occ.endAt, 'America/Chicago', 'HH:mm:ss')).toBe('15:00:00');
            }

            // Prove the series actually crossed DST: the UTC offset differs before vs after.
            const offsets = events.map(occ => formatInTimeZone(occ.startAt, 'America/Chicago', 'xxx'));
            expect(offsets[0]).toBe('-05:00');  // Oct 28, CDT
            expect(offsets[1]).toBe('-06:00');  // Nov 4, CST
            expect(offsets[2]).toBe('-06:00');  // Nov 11, CST
        });
    });
});
