/**
 * @jest-environment node
 */
/**
 * Integration Tests for Attendance API
 * Tests GET (fetch active visits)
 */

import { GET } from '@/app/api/attendance/route';
import prisma from '@/lib/prisma';
import { getServerSession } from 'next-auth/next';
// Mock NextAuth
jest.mock('next-auth/next', () => ({
    getServerSession: jest.fn(),
}));
jest.mock('@/lib/verify-kiosk', () => ({
    getKioskPublicKeys: jest.fn().mockReturnValue([Buffer.from('mock-key')]),
    verifyKioskSignature: jest.fn()
}));

describe('Attendance API Integration Tests', () => {
    let testAdminId: number;
    let testParticipantId: number;
    let testHouseholdId: number;
    let testAdminHouseholdId: number;
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

        const visit = await prisma.visit.create({
            data: { personId: testParticipantId, arrivedAt: new Date() }
        });
        activeVisitId = visit.id;
    });

    afterAll(async () => {
        // Clean up
        await prisma.visit.deleteMany({});
        await prisma.person.deleteMany({
            where: { id: { in: [testAdminId, testParticipantId] } }
        });
        await prisma.household.deleteMany({
            where: { id: { in: [testHouseholdId, testAdminHouseholdId] } }
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
});
