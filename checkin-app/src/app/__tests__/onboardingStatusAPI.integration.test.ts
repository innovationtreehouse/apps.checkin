/**
 * @jest-environment node
 */
/**
 * Integration Tests for Onboarding Status API
 * Tests GET /api/profile/onboarding-status — in particular that youth
 * are never asked for a phone number
 */

import { GET } from '@/app/api/profile/onboarding-status/route';
import prisma from '@/lib/prisma';
import { getServerSession } from 'next-auth/next';

// Mock NextAuth
jest.mock('next-auth/next', () => ({
    getServerSession: jest.fn()
}));

describe('Onboarding Status API Integration Tests', () => {
    let adultId: number;
    let youthId: number;
    let noDobId: number;
    const householdIds: number[] = [];

    const youthDob = () => {
        const d = new Date();
        d.setFullYear(d.getFullYear() - 12);
        return d;
    };

    beforeAll(async () => {
        // Clean up any leaked state
        const existingUsers = await prisma.person.findMany({
            where: { email: { contains: 'onboarding-status-test' } },
            select: { id: true, householdId: true }
        });
        const existingUserIds = existingUsers.map(u => u.id);
        const existingHouseholdIds = existingUsers.map(u => u.householdId).filter((id): id is number => id !== null);

        // RESTRICT: delete participants before their households
        await prisma.person.deleteMany({ where: { id: { in: existingUserIds } } });
        await prisma.household.deleteMany({ where: { id: { in: existingHouseholdIds } } });

        const adult = await prisma.person.create({
            data: {
                email: 'adult-onboarding-status-test@example.com',
                name: 'Adult No Phone',
                dateOfBirth: new Date('1990-01-01'),
                household: { create: { name: "Test HH" } }
            }
        });
        adultId = adult.id;
        householdIds.push(adult.householdId);

        const youth = await prisma.person.create({
            data: {
                email: 'youth-onboarding-status-test@example.com',
                name: 'Youth No Phone',
                dateOfBirth: youthDob(),
                household: { create: { name: "Test HH" } }
            }
        });
        youthId = youth.id;
        householdIds.push(youth.householdId);

        const noDob = await prisma.person.create({
            data: {
                email: 'nodob-onboarding-status-test@example.com',
                name: 'No DOB No Phone',
                household: { create: { name: "Test HH" } }
            }
        });
        noDobId = noDob.id;
        householdIds.push(noDob.householdId);
    });

    afterAll(async () => {
        // RESTRICT: delete participants before their households
        await prisma.person.deleteMany({
            where: { id: { in: [adultId, youthId, noDobId] } }
        });
        await prisma.household.deleteMany({
            where: { id: { in: householdIds } }
        });
    });

    const callRoute = async (userId: number | null) => {
        (getServerSession as jest.Mock).mockResolvedValue(userId === null ? null : { user: { id: userId } });
        const req = new Request('http://localhost:4000/api/profile/onboarding-status', { method: 'GET' });
        return GET(req as unknown as import("next/server").NextRequest);
    };

    describe('GET /api/profile/onboarding-status', () => {
        it('should return 401 Unauthorized without session', async () => {
            const res = await callRoute(null);
            expect(res.status).toBe(401);
        });

        it('should require a phone for an adult without one', async () => {
            const res = await callRoute(adultId);
            expect(res.status).toBe(200);

            const data = await res.json();
            expect(data.needsPhone).toBe(true);
        });

        it('should NOT require a phone for a youth', async () => {
            const res = await callRoute(youthId);
            expect(res.status).toBe(200);

            const data = await res.json();
            expect(data.needsPhone).toBe(false);
        });

        it('should require a phone when DOB is unknown', async () => {
            const res = await callRoute(noDobId);
            expect(res.status).toBe(200);

            const data = await res.json();
            expect(data.needsPhone).toBe(true);
        });

        it('should not require a phone once one is set', async () => {
            await prisma.person.update({
                where: { id: adultId },
                data: { phone: '555-123-4567' }
            });

            const res = await callRoute(adultId);
            const data = await res.json();
            expect(data.needsPhone).toBe(false);
            expect(data.phone).toBe('555-123-4567');
        });
    });
});
