/**
 * @jest-environment node
 */
/**
 * Integration Tests for User Household Visits API
 * Tests GET /api/household/visits for users viewing recent check-ins of their household
 */

import { GET } from '@/app/api/household/visits/route';
import prisma from '@/lib/prisma';
import { getServerSession } from 'next-auth/next';

// Mock NextAuth
jest.mock('next-auth/next', () => ({
    getServerSession: jest.fn()
}));
describe('Household Visits API Integration Tests', () => {
    let testUserId: number;
    let testMemberId: number;
    let testOtherHouseUserId: number;
    let testNoHouseId: number;

    beforeAll(async () => {
        // Clean up any leaked state
        const existingUsers = await prisma.person.findMany({
            where: { email: { contains: 'house-visits-api-test' } },
            select: { id: true, householdId: true }
        });
        
        const existingUserIds = existingUsers.map(u => u.id);
        const existingHouseholdIds = existingUsers.map(u => u.householdId).filter(id => id !== null) as number[];
        
        await prisma.visit.deleteMany({
            where: { personId: { in: existingUserIds } }
        });

        await prisma.orgMembership.deleteMany({
            where: { householdId: { in: existingHouseholdIds } }
        });
        
        await prisma.auditLog.deleteMany({
            where: { actorId: { in: existingUserIds } }
        });

        // RESTRICT: delete participants before their households
        await prisma.person.deleteMany({
            where: { id: { in: existingUserIds } }
        });

        await prisma.household.deleteMany({
            where: { id: { in: existingHouseholdIds } }
        });

        // Setup mock database records
        const household = await prisma.household.create({
            data: { name: 'Visits Test Household' }
        });

        const leadUser = await prisma.person.create({
            data: { email: 'lead-house-visits-api-test@example.com', name: 'Lead User', householdId: household.id }
        });
        testUserId = leadUser.id;

        await prisma.person.update({ where: { id: leadUser.id }, data: { isHouseholdLead: true } });

        const memberUser = await prisma.person.create({
            data: { email: 'child-house-visits-api-test@example.com', name: 'Child User', householdId: household.id }
        });
        testMemberId = memberUser.id;

        const otherHousehold = await prisma.household.create({
            data: { name: 'Other Visits Test Household' }
        });

        const otherUser = await prisma.person.create({
            data: { email: 'other-house-visits-api-test@example.com', name: 'Other User', householdId: otherHousehold.id }
        });
        testOtherHouseUserId = otherUser.id;

        // Every participant belongs to a household; this user's own household simply has no visits.
        const noHouseUser = await prisma.person.create({
            data: { email: 'nohouse-visits-api-test@example.com', name: 'No House User', household: { create: { name: "Test HH" } } }
        });
        testNoHouseId = noHouseUser.id;

        const now = new Date();

        // Create visits for the test household
        await prisma.visit.createMany({
            data: [
                // Closed (departedAt set): leadUser appears twice, but a participant
                // may have only one OPEN visit (Visit_one_open_per_participant). This
                // window test filters by arrivedAt, so departure time is irrelevant.
                { personId: leadUser.id, arrivedAt: new Date(now.getTime() - 1000), departedAt: new Date(now.getTime() - 500) }, // Just now
                { personId: memberUser.id, arrivedAt: new Date(now.getTime() - 86400000), departedAt: new Date(now.getTime() - 86399000) }, // 1 day ago
                { personId: leadUser.id, arrivedAt: new Date(now.getTime() - 864000000), departedAt: new Date(now.getTime() - 863999000) }, // 10 days ago (outside 7 day window)
            ]
        });

        // Create visit for other household
        await prisma.visit.create({
            data: { personId: otherUser.id, arrivedAt: new Date(now.getTime() - 2000) }
        });
    });

    afterAll(async () => {
        const currentIds = [testUserId, testMemberId, testOtherHouseUserId, testNoHouseId].filter(id => id !== undefined);
        
        const existingUsers = await prisma.person.findMany({
            where: { id: { in: currentIds } },
            select: { householdId: true }
        });
        const validHouseholdIds = existingUsers.map(u => u.householdId).filter(id => id !== null) as number[];

        await prisma.visit.deleteMany({
            where: { personId: { in: currentIds } }
        });

        await prisma.orgMembership.deleteMany({
            where: { householdId: { in: validHouseholdIds } }
        });
        
        await prisma.auditLog.deleteMany({
            where: { actorId: { in: currentIds } }
        });

        // RESTRICT: delete participants before their households
        await prisma.person.deleteMany({
            where: { id: { in: currentIds } }
        });

        if (validHouseholdIds.length > 0) {
            await prisma.household.deleteMany({
                where: { id: { in: validHouseholdIds } }
            });
        }
    });

    describe('GET /api/household/visits', () => {
        it('should return 401 Unauthorized without session', async () => {
             (getServerSession as jest.Mock).mockResolvedValue(null);

             const req = new Request('http://localhost:4000/api/household/visits', { method: 'GET' });
             const res = await GET(req as unknown as import("next/server").NextRequest);
             expect(res.status).toBe(401);
        });

        it('should return empty visits array if the user\'s household has no visits', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({ user: { id: testNoHouseId } });

            const req = new Request('http://localhost:4000/api/household/visits', { method: 'GET' });
            const res = await GET(req as unknown as import("next/server").NextRequest);
            expect(res.status).toBe(200);

            const data = await res.json();
            expect(Array.isArray(data.visits)).toBe(true);
            expect(data.visits.length).toBe(0);
        });

        it('should return only the visits for the users in their own household within default 7 day window', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({ user: { id: testUserId } });

            const req = new Request('http://localhost:4000/api/household/visits', { method: 'GET' });
            const res = await GET(req as unknown as import("next/server").NextRequest);
            expect(res.status).toBe(200);

            const data = await res.json();
            expect(Array.isArray(data.visits)).toBe(true);
            
            // There are 3 visits total for the household, but 1 is 10 days old (outside default 7-day window)
            expect(data.visits.length).toBe(2);
            
            // Verify no cross-pollution from other household
            const hasOtherHouseholdVisits = data.visits.some((v: { id?: number; email?: string; name?: string; participantId?: number; level?: string; status?: string; role?: string; type?: string; [key: string]: unknown }) => v.personId === testOtherHouseUserId);
            expect(hasOtherHouseholdVisits).toBe(false);

            // Verify ordered correctly (descending)
            expect(data.visits[0].personId).toBe(testUserId); // Just now
            expect(data.visits[1].personId).toBe(testMemberId); // 1 day ago
        });

        it('should shift the visit window correctly when filter date is provided', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({ user: { id: testUserId } });

            // Look at exactly 9 days ago, window should be +/- 7 days from there (day -16 to day -2)
            const searchWindow = new Date(Date.now() - (9 * 86400000)).toISOString();
            
            const req = new Request(`http://localhost:4000/api/household/visits?date=${encodeURIComponent(searchWindow)}`, { method: 'GET' });
            const res = await GET(req as unknown as import("next/server").NextRequest);
            expect(res.status).toBe(200);

            const data = await res.json();
            expect(Array.isArray(data.visits)).toBe(true);
            
            // It should only capture the 10-days-ago visit, missing the 1-day-ago and just-now visits
            expect(data.visits.length).toBe(1);
            expect(data.visits[0].personId).toBe(testUserId);
            // Verify it was the 10-days-ago visit (can't easily verify the exact MS but logically it is the third visit record)
        });
    });
});
