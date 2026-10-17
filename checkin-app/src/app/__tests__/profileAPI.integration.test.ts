/**
 * @jest-environment node
 */
/**
 * Integration Tests for Profile API
 * Tests GET and PATCH /api/profile for users viewing and updating their own info
 */

import { GET, PATCH } from '@/app/api/profile/route';
import prisma from '@/lib/prisma';
import { getServerSession } from 'next-auth/next';

// Mock NextAuth
jest.mock('next-auth/next', () => ({
    getServerSession: jest.fn()
}));
describe('Profile API Integration Tests', () => {
    let testUserId: number;
    let testHouseholdId: number;

    beforeAll(async () => {
        // Clean up any leaked state
        const existingUsers = await prisma.person.findMany({
            where: { email: { contains: 'profile-api-test' } },
            select: { id: true, householdId: true }
        });

        const existingUserIds = existingUsers.map(u => u.id);
        const existingHouseholdIds = existingUsers.map(u => u.householdId).filter((id): id is number => id !== null);

        await prisma.visit.deleteMany({
            where: { personId: { in: existingUserIds } }
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
        const user = await prisma.person.create({
            data: {
                email: 'user-profile-api-test@example.com',
                name: 'Profile Tester',
                dateOfBirth: new Date('1990-01-01'),
                household: { create: { name: "Test HH" } }
            }
        });
        testUserId = user.id;
        testHouseholdId = user.householdId;

        // Create visits for history testing
        await prisma.visit.createMany({
            data: [
                // Closed (departedAt set): a participant may have only one OPEN visit
                // (Visit_one_open_per_participant partial unique index); these are history.
                { personId: testUserId, arrivedAt: new Date(Date.now() - 3600000), departedAt: new Date(Date.now() - 3000000) },
                { personId: testUserId, arrivedAt: new Date(Date.now() - 7200000), departedAt: new Date(Date.now() - 6600000) }
            ]
        });
    });

    afterAll(async () => {
        await prisma.visit.deleteMany({
            where: { personId: testUserId }
        });

        await prisma.auditLog.deleteMany({
            where: { actorId: testUserId }
        });

        await prisma.person.deleteMany({
            where: { id: testUserId }
        });

        // RESTRICT: delete the household only after its participant is gone
        await prisma.household.deleteMany({
            where: { id: testHouseholdId }
        });
    });

    describe('GET /api/profile', () => {
        it('should return 401 Unauthorized without session', async () => {
             (getServerSession as jest.Mock).mockResolvedValue(null);

             const req = new Request('http://localhost:4000/api/profile', { method: 'GET' });
             const res = await GET(req as unknown as import("next/server").NextRequest);
             expect(res.status).toBe(401);
        });

        it('should return 404 Not Found for non-existent profile', async () => {
             (getServerSession as jest.Mock).mockResolvedValue({ user: { id: 999999 } });

             const req = new Request('http://localhost:4000/api/profile', { method: 'GET' });
             const res = await GET(req as unknown as import("next/server").NextRequest);
             expect(res.status).toBe(404);
        });

        it('should retrieve profile details and visit history', async () => {
             (getServerSession as jest.Mock).mockResolvedValue({ user: { id: testUserId } });

             const req = new Request('http://localhost:4000/api/profile', { method: 'GET' });
             const res = await GET(req as unknown as import("next/server").NextRequest);
             expect(res.status).toBe(200);

             const data = await res.json();
             expect(data.profile).toBeDefined();
             expect(data.profile.name).toBe('Profile Tester');

             expect(Array.isArray(data.profile.visits)).toBe(true);
             expect(data.profile.visits.length).toBe(2);
        });
    });

    describe('PATCH /api/profile', () => {
        it('should return 401 Unauthorized without session', async () => {
             (getServerSession as jest.Mock).mockResolvedValue(null);

             const req = new Request('http://localhost:4000/api/profile', {
                 method: 'PATCH',
                 body: JSON.stringify({ name: 'Hacker' })
             });
             const res = await PATCH(req as unknown as import("next/server").NextRequest);
             expect(res.status).toBe(401);
        });

        it('should successfully update partial profile fields', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({ user: { id: testUserId } });

            const req = new Request('http://localhost:4000/api/profile', {
                method: 'PATCH',
                body: JSON.stringify({
                    name: 'Updated Profile Tester'
                })
            });

            const res = await PATCH(req as unknown as import("next/server").NextRequest);
            expect(res.status).toBe(200);

            const data = await res.json();
            expect(data.profile.name).toBe('Updated Profile Tester');

            // Verify Audit Trail is populated
            const auditLogs = await prisma.auditLog.findMany({
                where: { actorId: testUserId, action: 'EDIT', tableName: 'Person', affectedEntityId: testUserId }
            });
            expect(auditLogs.length).toBeGreaterThan(0);
        });

        it('should reject a blank name and leave the stored name unchanged', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({ user: { id: testUserId } });

            const req = new Request('http://localhost:4000/api/profile', {
                method: 'PATCH',
                body: JSON.stringify({ name: '   ' })
            });

            const res = await PATCH(req as unknown as import("next/server").NextRequest);
            expect(res.status).toBe(400);

            const row = await prisma.person.findUnique({ where: { id: testUserId }, select: { name: true } });
            expect(row?.name).toBe('Updated Profile Tester');
        });

        it('sets isDeclaredAdult and clears DoB when over25 is checked with no dob', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({ user: { id: testUserId } });

            const req = new Request('http://localhost:4000/api/profile', {
                method: 'PATCH',
                body: JSON.stringify({ dob: null, over25: true })
            });
            const res = await PATCH(req as unknown as import("next/server").NextRequest);
            expect(res.status).toBe(200);

            const row = await prisma.person.findUnique({
                where: { id: testUserId },
                select: { dateOfBirth: true, isDeclaredAdult: true }
            });
            expect(row?.dateOfBirth).toBeNull();
            expect(row?.isDeclaredAdult).toBe(true);
        });

        it('leaves DoB and the adult flag untouched on a notification-only PATCH', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({ user: { id: testUserId } });

            // Seed a real DoB first so we can prove the guard preserves it.
            await prisma.person.update({
                where: { id: testUserId },
                data: { dateOfBirth: new Date('1990-01-01'), isDeclaredAdult: false }
            });

            const req = new Request('http://localhost:4000/api/profile', {
                method: 'PATCH',
                body: JSON.stringify({ notificationSettings: { foo: true } })
            });
            const res = await PATCH(req as unknown as import("next/server").NextRequest);
            expect(res.status).toBe(200);

            const row = await prisma.person.findUnique({
                where: { id: testUserId },
                select: { dateOfBirth: true, isDeclaredAdult: true }
            });
            expect(row?.dateOfBirth).toEqual(new Date('1990-01-01'));
            expect(row?.isDeclaredAdult).toBe(false);
        });
    });
});
