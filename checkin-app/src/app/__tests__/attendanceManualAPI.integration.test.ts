/**
 * @jest-environment node
 */
/**
 * Integration Tests for Manual Attendance API
 * Tests POST /api/attendance/manual for recording closed past visits
 */

import { POST } from '@/app/api/attendance/manual/route';
import prisma from '@/lib/prisma';
import { getServerSession } from 'next-auth/next';

// Mock NextAuth
jest.mock('next-auth/next', () => ({
    getServerSession: jest.fn()
}));
describe('Manual Attendance API Integration Tests', () => {
    let testUserId: number;
    let testHouseholdId: number;

    beforeAll(async () => {
        // Clean up any leaked state
        const existingUsers = await prisma.person.findMany({
            where: { email: { contains: 'manual-attendance-test' } },
            select: { id: true }
        });
        
        const existingUserIds = existingUsers.map(u => u.id);
        
        await prisma.visit.deleteMany({
            where: { personId: { in: existingUserIds } }
        });
        
        await prisma.auditLog.deleteMany({
            where: { actorId: { in: existingUserIds } }
        });
        
        await prisma.person.deleteMany({
            where: { email: { contains: 'manual-attendance-test' } }
        });

        // Setup mock database records
        const user = await prisma.person.create({
            data: { email: 'user-manual-attendance-test@example.com', name: 'User Manual Attendance Test', household: { create: { name: "Test HH" } } }
        });
        testUserId = user.id;
        testHouseholdId = user.householdId;
    });

    afterAll(async () => {
        // Clean up
        await prisma.visit.deleteMany({
            where: { personId: testUserId }
        });
        await prisma.auditLog.deleteMany({
            where: { actorId: testUserId }
        });
        await prisma.person.deleteMany({
            where: { id: testUserId }
        });
        await prisma.household.deleteMany({
            where: { id: testHouseholdId }
        });
    });

    describe('POST /api/attendance/manual', () => {
        it('should return 401 Unauthorized without session', async () => {
            (getServerSession as jest.Mock).mockResolvedValue(null);

            const req = new Request('http://localhost:4000/api/attendance/manual', {
                method: 'POST',
                body: JSON.stringify({ arrivedAt: new Date().toISOString() })
            });

            const res = await POST(req as unknown as import("next/server").NextRequest);
            expect(res.status).toBe(401);
            const data = await res.json();
            expect(data.error).toBe('Unauthorized');
        });

        it('should return 400 Bad Request if arrival time is missing', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({
                user: { id: testUserId }
            });

            const req = new Request('http://localhost:4000/api/attendance/manual', {
                method: 'POST',
                body: JSON.stringify({ departedAt: new Date().toISOString() }) // No arrivedAt time
            });

            const res = await POST(req as unknown as import("next/server").NextRequest);
            expect(res.status).toBe(400);
            const data = await res.json();
            expect(data.error).toBe('Arrival time is required');
        });

        it('should return 400 Bad Request if arrival time is malformed', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({
                user: { id: testUserId }
            });

            const req = new Request('http://localhost:4000/api/attendance/manual', {
                method: 'POST',
                body: JSON.stringify({ arrivedAt: 'not-a-date', departedAt: new Date().toISOString() })
            });

            const res = await POST(req as unknown as import("next/server").NextRequest);
            expect(res.status).toBe(400);
            const data = await res.json();
            expect(data.error).toBe('Invalid arrival time');
        });

        it('should return 400 Bad Request if departure time is before arrival time', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({
                user: { id: testUserId }
            });

            const arrivedAt = new Date();
            const departedAt = new Date(arrivedAt.getTime() - 3600000); // 1 hour BEFORE arrival

            const req = new Request('http://localhost:4000/api/attendance/manual', {
                method: 'POST',
                body: JSON.stringify({ arrivedAt: arrivedAt.toISOString(), departedAt: departedAt.toISOString() })
            });

            const res = await POST(req as unknown as import("next/server").NextRequest);
            expect(res.status).toBe(400);
            const data = await res.json();
            expect(data.error).toBe('Departure time must be after arrival time');
        });

        it('should return 400 if departure time is in the future beyond the skew allowance', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({
                user: { id: testUserId }
            });

            const arrivedAt = new Date(Date.now() - 3600000);
            const departedAt = new Date(Date.now() + 60 * 60 * 1000);

            const req = new Request('http://localhost:4000/api/attendance/manual', {
                method: 'POST',
                body: JSON.stringify({ arrivedAt: arrivedAt.toISOString(), departedAt: departedAt.toISOString() })
            });

            const res = await POST(req as unknown as import("next/server").NextRequest);
            expect(res.status).toBe(400);
            const data = await res.json();
            expect(data.error).toBe('Departure time cannot be in the future.');
        });

        it('clamps a departure inside the skew allowance back to now', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({
                user: { id: testUserId }
            });

            const arrivedAt = new Date(Date.now() - 3600000);
            const departedAt = new Date(Date.now() + 2 * 60 * 1000);

            const req = new Request('http://localhost:4000/api/attendance/manual', {
                method: 'POST',
                body: JSON.stringify({ arrivedAt: arrivedAt.toISOString(), departedAt: departedAt.toISOString() })
            });

            const res = await POST(req as unknown as import("next/server").NextRequest);
            expect(res.status).toBe(201);
            const visit = await prisma.visit.findFirst({
                where: { personId: testUserId, arrivedAt },
                orderBy: { id: 'desc' }
            });
            expect(visit?.departedAt).not.toBeNull();
            expect(visit!.departedAt!.getTime()).toBeLessThanOrEqual(Date.now());
        });

        it('should successfully record a manual visit with both arrivedAt and departedAt defined', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({
                user: { id: testUserId }
            });

            const arrivedAt = new Date(Date.now() - 7200000); // 2 hours ago
            const departedAt = new Date(Date.now() - 3600000); // 1 hour ago

            const previousAuditLogs = await prisma.auditLog.count({
                where: { actorId: testUserId, action: 'CREATE', tableName: 'Visit' }
            });

            const req = new Request('http://localhost:4000/api/attendance/manual', {
                method: 'POST',
                body: JSON.stringify({ arrivedAt: arrivedAt.toISOString(), departedAt: departedAt.toISOString() })
            });

            const res = await POST(req as unknown as import("next/server").NextRequest);
            expect(res.status).toBe(201);
            const data = await res.json();
            
            expect(data.message).toBe('Manual visit recorded successfully.');
            expect(data.visit).toBeDefined();
            expect(data.visit.personId).toBe(testUserId);
            expect(new Date(data.visit.arrivedAt).toISOString()).toBe(arrivedAt.toISOString());
            expect(new Date(data.visit.departedAt).toISOString()).toBe(departedAt.toISOString());

            const currentAuditLogs = await prisma.auditLog.count({
                where: { actorId: testUserId, action: 'CREATE', tableName: 'Visit' }
            });
            expect(currentAuditLogs).toBe(previousAuditLogs + 1);
        });

        it('should return 400 and record nothing if departure is blank', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({
                user: { id: testUserId }
            });

            const before = await prisma.visit.count({ where: { personId: testUserId } });
            const req = new Request('http://localhost:4000/api/attendance/manual', {
                method: 'POST',
                body: JSON.stringify({ arrivedAt: new Date(Date.now() - 1800000).toISOString() })
            });

            const res = await POST(req as unknown as import("next/server").NextRequest);
            expect(res.status).toBe(400);
            const data = await res.json();
            expect(data.error).toMatch(/^Departure time is required/);
            expect(await prisma.visit.count({ where: { personId: testUserId } })).toBe(before);
        });
    });
});

// A closed entry is historical: it needs nobody in the building.
describe('Manual Attendance API closed entry into an empty building', () => {
    const TAG = 'manual-guard-test';
    let nkId: number;
    let householdId: number;

    beforeAll(async () => {
        const leaked = await prisma.person.findMany({ where: { email: { contains: TAG } }, select: { id: true, householdId: true } });
        const ids = leaked.map(p => p.id);
        await prisma.visit.deleteMany({ where: { personId: { in: ids } } });
        await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } });
        await prisma.person.deleteMany({ where: { id: { in: ids } } });
        await prisma.household.deleteMany({ where: { id: { in: leaked.map(p => p.householdId) } } });

        const nk = await prisma.person.create({ data: { email: `nk-${TAG}@example.com`, name: 'Guard NK', household: { create: { name: "Test HH" } } } });
        nkId = nk.id;
        householdId = nk.householdId;
    });

    afterAll(async () => {
        await prisma.visit.deleteMany({ where: { personId: nkId } });
        await prisma.auditLog.deleteMany({ where: { actorId: nkId } });
        await prisma.person.delete({ where: { id: nkId } });
        await prisma.household.delete({ where: { id: householdId } });
    });

    it('non-keyholder CLOSED entry → 201', async () => {
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: nkId, isKeyholder: false } });
        const arrivedAt = new Date(Date.now() - 7200000).toISOString(); // 2h ago
        const departedAt = new Date(Date.now() - 3600000).toISOString(); // 1h ago
        const req = new Request('http://localhost:4000/api/attendance/manual', {
            method: 'POST',
            body: JSON.stringify({ arrivedAt, departedAt }),
        }) as unknown as import('next/server').NextRequest;
        const res = await (POST(req) as Promise<Response>);
        expect(res.status).toBe(201);
    });
});

// A household lead records a visit FOR a household member — the only
// path by which a minor (who cannot self-serve) gets one entered at all. The
// scope is the lead's own household, resolved server-side.
describe('Manual Attendance API — household-lead insert for a member', () => {
    const TAG = 'manual-hhlead-test';
    let leadId: number;
    let childId: number;
    let outsiderId: number;
    let householdIds: number[];

    const post = (body: unknown) => POST(new Request('http://localhost:4000/api/attendance/manual', {
        method: 'POST', body: JSON.stringify(body),
    }) as unknown as import('next/server').NextRequest) as Promise<Response>;

    const closedTimes = () => ({
        arrivedAt: new Date(Date.now() - 7200000).toISOString(),
        departedAt: new Date(Date.now() - 3600000).toISOString(),
    });

    beforeAll(async () => {
        const leaked = await prisma.person.findMany({ where: { email: { contains: TAG } }, select: { id: true, householdId: true } });
        const ids = leaked.map(p => p.id);
        await prisma.visit.deleteMany({ where: { personId: { in: ids } } });
        await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } });
        await prisma.person.deleteMany({ where: { id: { in: ids } } });
        await prisma.household.deleteMany({ where: { id: { in: leaked.map(p => p.householdId).filter((h): h is number => h != null) } } });

        const lead = await prisma.person.create({
            data: { email: `lead-${TAG}@example.com`, name: 'HH Lead', isHouseholdLead: true, household: { create: { name: 'Lead HH' } } },
        });
        leadId = lead.id;
        const child = await prisma.person.create({
            data: { email: `child-${TAG}@example.com`, name: 'HH Child', householdId: lead.householdId },
        });
        childId = child.id;
        const outsider = await prisma.person.create({
            data: { email: `outsider-${TAG}@example.com`, name: 'Other HH', household: { create: { name: 'Other HH' } } },
        });
        outsiderId = outsider.id;
        householdIds = [lead.householdId!, outsider.householdId!];
    });

    afterAll(async () => {
        const ids = [leadId, childId, outsiderId];
        await prisma.visit.deleteMany({ where: { personId: { in: ids } } });
        await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } });
        await prisma.person.deleteMany({ where: { id: { in: ids } } });
        await prisma.household.deleteMany({ where: { id: { in: householdIds } } });
    });

    it('records a visit for a household member, audited to the lead as actor', async () => {
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: leadId } });
        const res = await post({ ...closedTimes(), personId: childId });
        expect(res.status).toBe(201);

        const { visit } = await res.json();
        expect(visit.personId).toBe(childId);
        const audit = await prisma.auditLog.findFirst({
            where: { actorId: leadId, tableName: 'Visit', affectedEntityId: visit.id },
        });
        expect(audit?.secondaryAffectedEntity).toBe(childId);
    });

    it('403s a lead reaching outside their own household', async () => {
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: leadId } });
        const res = await post({ ...closedTimes(), personId: outsiderId });
        expect(res.status).toBe(403);
        expect(await prisma.visit.count({ where: { personId: outsiderId } })).toBe(0);
    });

    it('403s a NON-lead naming a household peer — leadership, not membership, is the grant', async () => {
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: childId } });
        const res = await post({ ...closedTimes(), personId: leadId });
        expect(res.status).toBe(403);
        expect(await prisma.visit.count({ where: { personId: leadId } })).toBe(0);
    });
});
