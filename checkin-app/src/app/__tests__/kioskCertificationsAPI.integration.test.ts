/**
 * @jest-environment node
 */
/**
 * Integration Tests for Kiosk Certifications API
 * Tests GET /api/kioskdisplay/certifications to secure participant tool statuses for active shop users
 */

import { GET } from '@/app/api/kioskdisplay/certifications/route';
import prisma from '@/lib/prisma';
import { getServerSession } from 'next-auth/next';
import { getKioskPublicKeys, verifyKioskSignature } from '@/lib/verify-kiosk';
import { NextRequest } from 'next/server';

// Mock NextAuth
jest.mock('next-auth/next', () => ({
    getServerSession: jest.fn(),
}));
// Mock Kiosk Verification
jest.mock('@/lib/verify-kiosk', () => ({
    getKioskPublicKeys: jest.fn(),
    verifyKioskSignature: jest.fn()
}));

describe('Kiosk Certifications API Integration Tests', () => {
    let testUserId: number;
    let testHouseholdId: number;
    let toolId: number;

    beforeAll(async () => {
        // Clean up any leaked state
        const existingUsers = await prisma.person.findMany({
            where: { email: { contains: 'certifications-api-test' } },
            select: { id: true, householdId: true }
        });

        const existingUserIds = existingUsers.map(u => u.id);
        const existingHouseholdIds = existingUsers.map(u => u.householdId).filter((id): id is number => id !== null);

        await prisma.visit.deleteMany({
            where: { personId: { in: existingUserIds } }
        });

        await prisma.toolStatus.deleteMany({
            where: { personId: { in: existingUserIds } }
        });

        await prisma.tool.deleteMany({
            where: { name: 'Test CNC Router' }
        });

        // RESTRICT: delete participants before their households
        await prisma.person.deleteMany({
            where: { email: { contains: 'certifications-api-test' } }
        });

        await prisma.household.deleteMany({
            where: { id: { in: existingHouseholdIds } }
        });

        // Setup mock database records
        const user = await prisma.person.create({
            data: { email: 'user-certifications-api-test@example.com', name: 'User Kiosk Test', household: { create: { name: "Test HH" } } }
        });
        testUserId = user.id;
        testHouseholdId = user.householdId;

        const tool = await prisma.tool.create({
            data: { name: 'Test CNC Router' }
        });
        toolId = tool.id;

        await prisma.toolStatus.create({
            data: { 
                personId: testUserId,
                toolId: toolId,
                level: 'CERTIFIED'
            }
        });

        await prisma.visit.create({
            data: { personId: testUserId, arrivedAt: new Date() }
        });
    });

    beforeEach(() => {
        jest.clearAllMocks();
    });

    afterAll(async () => {
        // Clean up
        await prisma.visit.deleteMany({
            where: { personId: testUserId }
        });
        await prisma.toolStatus.deleteMany({
            where: { personId: testUserId }
        });
        await prisma.person.deleteMany({
            where: { id: testUserId }
        });
        // RESTRICT: delete the household only after its participant is gone
        await prisma.household.deleteMany({
            where: { id: testHouseholdId }
        });
        await prisma.tool.deleteMany({
            where: { id: toolId }
        });
    });

    describe('GET /api/kioskdisplay/certifications', () => {
        it('should return 401 Unauthorized without session or Kiosk header', async () => {
             (getServerSession as jest.Mock).mockResolvedValue(null);
             (getKioskPublicKeys as jest.Mock).mockReturnValue(['mock-pub-key']);

             const req = new Request('http://localhost:4000/api/kioskdisplay/certifications', { method: 'GET' });
             const res = await GET(req as unknown as NextRequest);
             expect(res.status).toBe(401);
        });

        it('should reject invalid Kiosk signatures', async () => {
             (getServerSession as jest.Mock).mockResolvedValue(null);
             (getKioskPublicKeys as jest.Mock).mockReturnValue(['mock-pub-key']);
             (verifyKioskSignature as jest.Mock).mockReturnValue({ ok: false, status: 401, error: 'Invalid Signature' });

             const req = new Request('http://localhost:4000/api/kioskdisplay/certifications', { 
                 method: 'GET',
                 headers: new Headers({
                     'x-kiosk-signature': 'bad-sig',
                     'x-kiosk-timestamp': '123456789'
                 })
             });

             const res = await GET(req as unknown as NextRequest);
             expect(res.status).toBe(401);
             const data = await res.json();
             // A bad kiosk signature falls through to the session check (here: no session),
             // so withAuth fails closed with the generic 401. The verifier's own error string
             // is intentionally not surfaced to the caller.
             expect(data.error).toBe('Unauthorized');
        });

        it('should return active visits and tools if Kiosk signature is valid', async () => {
             (getServerSession as jest.Mock).mockResolvedValue(null);
             (getKioskPublicKeys as jest.Mock).mockReturnValue(['mock-pub-key']);
             (verifyKioskSignature as jest.Mock).mockReturnValue({ ok: true });

             const req = new Request('http://localhost:4000/api/kioskdisplay/certifications', { 
                 method: 'GET',
                 headers: new Headers({
                     'x-kiosk-signature': 'good-sig',
                     'x-kiosk-timestamp': '123456789'
                 })
             });

             const res = await GET(req as unknown as NextRequest);
             expect(res.status).toBe(200);

             const data = await res.json();
             expect(Array.isArray(data.participants)).toBe(true);
             expect(Array.isArray(data.tools)).toBe(true);
             
             const visitMatches = data.participants.filter((v: {id: number}) => v.id === testUserId);
             expect(visitMatches.length).toBe(1);
             expect(visitMatches[0].toolStatuses.some((t: {toolId: number, level: string}) => t.toolId === toolId && t.level === 'CERTIFIED')).toBe(true);
             // Returns the kiosk label — first name, never the last name or raw email.
             expect(visitMatches[0].name).toMatch(/^User\b/);
             expect(visitMatches[0].name).not.toContain('Test');
             expect('email' in visitMatches[0]).toBe(false);
             
             const toolMatches = data.tools.filter((t: {id: number}) => t.id === toolId);
             expect(toolMatches.length).toBe(1);
             expect(toolMatches[0].name).toBe('Test CNC Router');
        });

        it('should return active visits and tools for authenticated web users', async () => {
            // This endpoint is privileged (isSysadmin/isBoardMember/isKeyholder or kiosk); a plain
            // member session gets 403. Grant a role flag so the session passes the gate.
            (getServerSession as jest.Mock).mockResolvedValue({ user: { id: testUserId, isKeyholder: true } });
            (getKioskPublicKeys as jest.Mock).mockReturnValue(['mock-pub-key']);

            const req = new Request('http://localhost:4000/api/kioskdisplay/certifications', { method: 'GET' });
            const res = await GET(req as unknown as NextRequest);
            expect(res.status).toBe(200);

            const data = await res.json();
            expect(data.participants.length).toBeGreaterThanOrEqual(1);
            expect(data.tools.length).toBeGreaterThanOrEqual(1);
        });
    });
});
