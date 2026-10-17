/**
 * @jest-environment node
 */
/**
 * Integration Tests for Attendance API
 * Tests GET (fetch active visits), POST (manual check-in, two-deep notification), and DELETE (force checkout)
 */

import { GET, POST, DELETE } from '@/app/api/attendance/route';
import prisma from '@/lib/prisma';
import { getServerSession } from 'next-auth/next';
// Mock NextAuth
jest.mock('next-auth/next', () => ({
    getServerSession: jest.fn(),
}));
// The route fires check-in notifications without awaiting; stub them so no
// query outlives the suite's teardown.
jest.mock('@/lib/notifications', () => ({
    ...jest.requireActual('@/lib/notifications'),
    sendCheckinNotifications: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('@/lib/verify-kiosk', () => ({
    getKioskPublicKeys: jest.fn().mockReturnValue([Buffer.from('mock-key')]),
    verifyKioskSignature: jest.fn()
}));

describe('Attendance API Integration Tests', () => {
    let testAdminId: number;
    let testParticipantId: number;
    let testHouseholdMemberId: number;
    let testHouseholdId: number;
    let testAdminHouseholdId: number;
    let testKeyholderId: number;
    let testKeyholderHouseholdId: number;
    let activeVisitId: number;

    beforeAll(async () => {
        // Clean up any leaked state
        await prisma.visit.deleteMany({});
        await prisma.person.deleteMany({
            where: { email: { contains: 'attendance-test' } }
        });
        await prisma.household.deleteMany({
            where: { name: 'Attendance Test Household' }
        });

        // Setup mock database records
        const household = await prisma.household.create({
            data: { name: 'Attendance Test Household' }
        });
        testHouseholdId = household.id;

        const admin = await prisma.person.create({
            data: { email: 'admin-attendance-test@example.com', name: 'Admin Test', isSysadmin: true, household: { create: { name: "Test HH" } } }
        });
        testAdminId = admin.id;
        testAdminHouseholdId = admin.householdId;

        const participant = await prisma.person.create({
            data: { 
                email: 'participant-attendance-test@example.com', 
                name: 'Participant Test',
                householdId: testHouseholdId 
            }
        });
        testParticipantId = participant.id;

        // Make participant the household lead
        await prisma.person.update({
            where: { id: testParticipantId },
            data: { isHouseholdLead: true }
        });

        const householdMember = await prisma.person.create({
            data: { 
                email: 'member-attendance-test@example.com', 
                name: 'Household Member Test',
                householdId: testHouseholdId 
            }
        });
        testHouseholdMemberId = householdMember.id;

        // Keyholder present + checked in: the facility-open guard requires an
        // active keyholder before any non-keyholder MANUAL_CHECKIN succeeds.
        const keyholder = await prisma.person.create({
            data: { email: 'keyholder-attendance-test@example.com', name: 'Keyholder Test', isKeyholder: true, household: { create: { name: "Test HH" } } }
        });
        testKeyholderId = keyholder.id;
        testKeyholderHouseholdId = keyholder.householdId;
        await prisma.visit.create({
            data: { personId: testKeyholderId, arrivedAt: new Date() }
        });

        const visit = await prisma.visit.create({
            data: { personId: testParticipantId, arrivedAt: new Date() }
        });
        activeVisitId = visit.id;
    });

    afterAll(async () => {
        // Clean up
        await prisma.visit.deleteMany({});
        await prisma.person.deleteMany({
            where: { id: { in: [testAdminId, testParticipantId, testHouseholdMemberId, testKeyholderId] } }
        });
        await prisma.household.deleteMany({
            where: { id: { in: [testHouseholdId, testAdminHouseholdId, testKeyholderHouseholdId] } }
        });
    });

    describe('GET /api/attendance', () => {
        it('should return 401 Unauthorized without session or Kiosk header', async () => {
             (getServerSession as jest.Mock).mockResolvedValue(null);

             const req = new Request('http://localhost:4000/api/attendance', {
                 method: 'GET'
             });

             const res = await GET(req as unknown as import("next/server").NextRequest);
             expect(res.status).toBe(401);
        });

        it('should return active visits for an authenticated session', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({
                user: { id: testAdminId, isSysadmin: true }
            });

            const req = new Request('http://localhost:4000/api/attendance', {
                method: 'GET'
            });

            const res = await GET(req as unknown as import("next/server").NextRequest);
            expect(res.status).toBe(200);

            const data = await res.json();
            expect(data.attendance).toBeDefined();
            expect(Array.isArray(data.attendance)).toBe(true);
            
            // Should contain at least the visit we seeded
            const foundVisit = data.attendance.find((v: { id?: number; email?: string; name?: string; participantId?: number; level?: string; status?: string; role?: string; type?: string; [key: string]: unknown }) => v.id === activeVisitId);
            expect(foundVisit).toBeDefined();
            expect(foundVisit.participant.name).toBe('Participant Test');
        });
    });

    describe('DELETE /api/attendance', () => {
        it('should allow a household lead to check out a household member', async () => {
            // Setup a visit for the household member
            const memberVisit = await prisma.visit.create({
                data: { personId: testHouseholdMemberId, arrivedAt: new Date() }
            });

            (getServerSession as jest.Mock).mockResolvedValue({
                user: { 
                    id: testParticipantId, 
                    isSysadmin: false, 
                    householdId: testHouseholdId, 
                    householdLead: true 
                }
            });

            const req = new Request('http://localhost:4000/api/attendance', {
                method: 'DELETE',
                body: JSON.stringify({ visitId: memberVisit.id })
            });

            const res = await DELETE(req as unknown as import("next/server").NextRequest);
            expect(res.status).toBe(200);

            const data = await res.json();
            expect(data.success).toBe(true);
            expect(data.visit.departedAt).not.toBeNull();
        });

        it('should not allow a regular user to check out someone else', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({
                user: { id: testHouseholdMemberId, isSysadmin: false, householdId: testHouseholdId }
            });

            const req = new Request('http://localhost:4000/api/attendance', {
                method: 'DELETE',
                body: JSON.stringify({ visitId: activeVisitId }) // activeVisitId belongs to testParticipantId
            });

            const res = await DELETE(req as unknown as import("next/server").NextRequest);
            // 404, not 403: a visit id the caller may not touch must be
            // indistinguishable from one that does not exist.
            expect(res.status).toBe(404);

            const data = await res.json();
            expect(data.error).toBe('Visit not found');
        });
    });

    describe('POST /api/attendance', () => {
        it('should allow an admin to manually check in a user', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({
                user: { id: testAdminId, isSysadmin: true }
            });

            // Ensure testHouseholdMemberId is checked out before we check them in
            await prisma.visit.deleteMany({
                where: { personId: testHouseholdMemberId }
            });

            const req = new Request('http://localhost:4000/api/attendance', {
                method: 'POST',
                body: JSON.stringify({ type: 'MANUAL_CHECKIN', participantId: testHouseholdMemberId })
            });

            const res = await POST(req as unknown as import("next/server").NextRequest);
            expect(res.status).toBe(200);

            const data = await res.json();
            expect(data.success).toBe(true);
            expect(data.visit.personId).toBe(testHouseholdMemberId);
        });

        it('should return 400 when trying to check in an already checked in user', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({
                user: { id: testAdminId, isSysadmin: true }
            });

            const req = new Request('http://localhost:4000/api/attendance', {
                method: 'POST',
                body: JSON.stringify({ type: 'MANUAL_CHECKIN', participantId: testParticipantId }) // Already checked in
            });

            const res = await POST(req as unknown as import("next/server").NextRequest);
            expect(res.status).toBe(400);

            const data = await res.json();
            expect(data.error).toContain('already checked in');
        });
    });
});
