/**
 * @jest-environment node
 */
/**
 * Integration Tests for Profile Visits API
 * Tests GET /api/profile/visits for users viewing their own recent check-ins
 */

import { GET } from '@/app/api/profile/visits/route';
import prisma from '@/lib/prisma';
import { getServerSession } from 'next-auth/next';

// Mock NextAuth
jest.mock('next-auth/next', () => ({
    getServerSession: jest.fn()
}));
describe('Profile Visits API Integration Tests', () => {
    let testUserId: number;
    let testHouseholdId: number;

    beforeAll(async () => {
        // Clean up any leaked state
        const existingUsers = await prisma.person.findMany({
            where: { email: { contains: 'profile-visits-api-test' } },
            select: { id: true, householdId: true }
        });

        const existingUserIds = existingUsers.map(u => u.id);
        const existingHouseholdIds = existingUsers.map(u => u.householdId).filter((id): id is number => id !== null);

        await prisma.visit.deleteMany({
            where: { personId: { in: existingUserIds } }
        });

        // RESTRICT: delete participants before their households
        await prisma.person.deleteMany({
            where: { id: { in: existingUserIds } }
        });

        await prisma.household.deleteMany({
            where: { id: { in: existingHouseholdIds } }
        });

        // Setup mock database records
        const user = await prisma.person.create({
            data: { email: 'user-profile-visits-test@example.com', name: 'Profile Visits Tester', household: { create: { name: "Test HH" } } }
        });
        testUserId = user.id;
        testHouseholdId = user.householdId;

        const now = new Date();

        // Create visits for the test user
        await prisma.visit.createMany({
            data: [
                // Closed (departedAt set): a participant may have only one OPEN visit
                // (Visit_one_open_per_participant partial unique index), and this
                // window test filters by arrivedAt, so departure time is irrelevant.
                { personId: testUserId, arrivedAt: new Date(now.getTime() - 1000), departedAt: new Date(now.getTime() - 500) }, // Just now
                { personId: testUserId, arrivedAt: new Date(now.getTime() - 86400000), departedAt: new Date(now.getTime() - 86399000) }, // 1 day ago
                { personId: testUserId, arrivedAt: new Date(now.getTime() - 864000000), departedAt: new Date(now.getTime() - 863999000) }, // 10 days ago (outside 7 day window)
            ]
        });
    });

    afterAll(async () => {
        await prisma.visit.deleteMany({
            where: { personId: testUserId }
        });

        await prisma.person.deleteMany({
            where: { id: testUserId }
        });

        // RESTRICT: delete the household only after its participant is gone
        await prisma.household.deleteMany({
            where: { id: testHouseholdId }
        });
    });

    describe('GET /api/profile/visits', () => {
        it('should return 401 Unauthorized without session', async () => {
             (getServerSession as jest.Mock).mockResolvedValue(null);

             const req = new Request('http://localhost:4000/api/profile/visits', { method: 'GET' });
             const res = await GET(req as unknown as import("next/server").NextRequest);
             expect(res.status).toBe(401);
        });

        // An id-less session (emptied jwt token) would read `personId: undefined` as
        // every person's visits on this 'authenticated' handler route.
        it('should return 401 for a session whose user has no id', async () => {
             (getServerSession as jest.Mock).mockResolvedValue({ user: { name: undefined, email: undefined } });

             const req = new Request('http://localhost:4000/api/profile/visits', { method: 'GET' });
             const res = await GET(req as unknown as import("next/server").NextRequest);
             expect(res.status).toBe(401);
        });

        it('should return visits for the user within default 7 day window', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({ user: { id: testUserId } });

            const req = new Request('http://localhost:4000/api/profile/visits', { method: 'GET' });
            const res = await GET(req as unknown as import("next/server").NextRequest);
            expect(res.status).toBe(200);

            const data = await res.json();
            expect(Array.isArray(data.visits)).toBe(true);
            
            // There are 3 visits total for the user, but 1 is 10 days old (outside default 7-day window)
            expect(data.visits.length).toBe(2);
        });

        it('should shift the visit window correctly when filter date is provided', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({ user: { id: testUserId } });

            // Look at exactly 9 days ago, window should be +/- 7 days from there (day -16 to day -2)
            const searchWindow = new Date(Date.now() - (9 * 86400000)).toISOString();
            
            const req = new Request(`http://localhost:4000/api/profile/visits?date=${encodeURIComponent(searchWindow)}`, { method: 'GET' });
            const res = await GET(req as unknown as import("next/server").NextRequest);
            expect(res.status).toBe(200);

            const data = await res.json();
            expect(Array.isArray(data.visits)).toBe(true);
            
            // It should only capture the 10-days-ago visit, missing the 1-day-ago and just-now visits
            expect(data.visits.length).toBe(1);
        });
    });
});
