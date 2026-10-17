/**
 * @jest-environment node
 */
/**
 * Integration tests for the Broken Households tab.
 *  - GET /api/admin/broken-households lists households whose live members include no
 *    lead, and excludes both households that already have a lead and households with
 *    no live member to promote.
 *  - POST /api/household/lead lets a BOARD MEMBER assign a lead to a household they
 *    are not a member of, which un-breaks it.
 */

import { GET } from '@/app/api/admin/broken-households/route';
import { POST } from '@/app/api/household/lead/route';
import prisma from '@/lib/prisma';
import { getServerSession } from 'next-auth/next';

jest.mock('next-auth/next', () => ({
    getServerSession: jest.fn(),
}));

describe('Broken Households API Integration Tests', () => {
    let boardId: number;
    let brokenHouseholdId: number;
    let emptyHouseholdId: number;
    let ledHouseholdId: number;
    let brokenAdultId: number;

    const cleanup = async () => {
        await prisma.person.deleteMany({
            where: { email: { contains: 'broken-api-test' } }
        });
        await prisma.household.deleteMany({
            where: { name: { contains: 'Broken API Test' } }
        });
    };

    beforeAll(async () => {
        await cleanup();

        // Acting board member (not a member of any test household below).
        const board = await prisma.person.create({
            data: { email: 'board-broken-api-test@example.com', name: 'Board Broken Test', isBoardMember: true, household: { create: { name: "Test HH" } } }
        });
        boardId = board.id;

        // 1. Leadless household with an adult + a youth -> broken.
        const broken = await prisma.household.create({ data: { name: 'Broken API Test HH Broken' } });
        brokenHouseholdId = broken.id;
        const adult = await prisma.person.create({
            data: { email: 'adult-broken-api-test@example.com', name: 'Broken Adult', householdId: brokenHouseholdId, dateOfBirth: new Date('1990-01-01') }
        });
        brokenAdultId = adult.id;
        await prisma.person.create({
            data: { email: 'youth-broken-api-test@example.com', name: 'Broken Youth', householdId: brokenHouseholdId, dateOfBirth: new Date('2015-01-01') }
        });

        // 2. Leadless household with no members -> nobody to promote, so NOT listed.
        const empty = await prisma.household.create({ data: { name: 'Broken API Test HH Empty' } });
        emptyHouseholdId = empty.id;

        // 3. Household that already has a lead -> NOT broken.
        const led = await prisma.household.create({ data: { name: 'Broken API Test HH Led' } });
        ledHouseholdId = led.id;
        const leadMember = await prisma.person.create({
            data: { email: 'lead-broken-api-test@example.com', name: 'Existing Lead', householdId: ledHouseholdId, dateOfBirth: new Date('1985-01-01') }
        });
        await prisma.person.update({ where: { id: leadMember.id }, data: { isHouseholdLead: true } });
    });

    afterAll(cleanup);

    it('GET lists leadless households and excludes led and empty ones', async () => {
        (getServerSession as jest.Mock).mockResolvedValue({
            user: { id: boardId, isSysadmin: false, isBoardMember: true }
        });

        const req = new Request('http://localhost:4000/api/admin/broken-households', { method: 'GET' });
        const res = await GET(req as unknown as import('next/server').NextRequest);
        expect(res.status).toBe(200);

        const data = await res.json();
        const ids = data.households.map((h: { id: number }) => h.id);
        expect(ids).toContain(brokenHouseholdId);
        expect(ids).not.toContain(emptyHouseholdId);
        expect(ids).not.toContain(ledHouseholdId);

        const broken = data.households.find((h: { id: number }) => h.id === brokenHouseholdId);
        expect(broken.members).toHaveLength(2);
    });

    it('POST lets a board member assign a lead to a household they are not in, un-breaking it', async () => {
        (getServerSession as jest.Mock).mockResolvedValue({
            user: { id: boardId, isSysadmin: false, isBoardMember: true }
        });

        const req = new Request('http://localhost:4000/api/household/lead', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ participantId: brokenAdultId }),
        });
        const res = await POST(req as unknown as import('next/server').NextRequest);
        expect(res.status).toBe(200);

        const lead = await prisma.person.findFirst({
            where: { id: brokenAdultId, householdId: brokenHouseholdId, isHouseholdLead: true },
            select: { id: true }
        });
        expect(lead).not.toBeNull();

        // No longer broken.
        const getRes = await GET(
            new Request('http://localhost:4000/api/admin/broken-households', { method: 'GET' }) as unknown as import('next/server').NextRequest
        );
        const ids = (await getRes.json()).households.map((h: { id: number }) => h.id);
        expect(ids).not.toContain(brokenHouseholdId);
    });
});
