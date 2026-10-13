/**
 * @jest-environment node
 */
/**
 * Integration Tests for Manual Attendance API
 * Tests POST /api/attendance/manual for adding past manual check-ins
 */

import { POST } from '@/app/api/attendance/manual/route';
import prisma from '@/lib/prisma';
import { getServerSession } from 'next-auth/next';

// Mock NextAuth
jest.mock('next-auth/next', () => ({
    getServerSession: jest.fn()
}));
// The route fires check-in notifications without awaiting; stub them so no
// query outlives the suite's teardown.
jest.mock('@/lib/notifications', () => ({
    ...jest.requireActual('@/lib/notifications'),
    sendCheckinNotifications: jest.fn().mockResolvedValue(undefined),
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
                body: JSON.stringify({ arrivedAt: 'not-a-date' })
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

        it('should return 400 if departure is blank and arrival is a stale past day', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({
                user: { id: testUserId }
            });

            const arrivedAt = new Date(Date.now() - 2 * 24 * 3600000); // 2 days ago, no departure

            const req = new Request('http://localhost:4000/api/attendance/manual', {
                method: 'POST',
                body: JSON.stringify({ arrivedAt: arrivedAt.toISOString() })
            });

            const res = await POST(req as unknown as import("next/server").NextRequest);
            expect(res.status).toBe(400);
            const data = await res.json();
            expect(data.error).toBe('Departure time is required for past arrivals.');
        });

        it('should successfully record a manual visit with arrivedAt only', async () => {
            // Keyholder: an open backfill must clear the facility-open guard.
            (getServerSession as jest.Mock).mockResolvedValue({
                user: { id: testUserId, isKeyholder: true }
            });

            const arrivedAt = new Date(Date.now() - 1800000); // 30 minutes ago

            const req = new Request('http://localhost:4000/api/attendance/manual', {
                method: 'POST',
                body: JSON.stringify({ arrivedAt: arrivedAt.toISOString() })
            });

            const res = await POST(req as unknown as import("next/server").NextRequest);
            expect(res.status).toBe(201);
            const data = await res.json();
            
            expect(data.message).toBe('Manual visit recorded successfully.');
            expect(data.visit).toBeDefined();
            expect(new Date(data.visit.arrivedAt).toISOString()).toBe(arrivedAt.toISOString());
            expect(data.visit.departedAt).toBeNull();
        });

        it('dedups a SERIAL double-submit: second POST returns the same open visit, only one in DB', async () => {
            // Keyholder: an open backfill must clear the facility-open guard.
            (getServerSession as jest.Mock).mockResolvedValue({
                user: { id: testUserId, isKeyholder: true }
            });

            // Isolate: drop any open visit left by earlier tests so the count is unambiguous.
            await prisma.visit.deleteMany({ where: { personId: testUserId, departedAt: null } });

            const arrivedAt = new Date(Date.now() - 600000).toISOString(); // 10 min ago, open (no departure)
            const makeReq = () => new Request('http://localhost:4000/api/attendance/manual', {
                method: 'POST',
                body: JSON.stringify({ arrivedAt })
            }) as unknown as import("next/server").NextRequest;

            // Two submits, strictly one after the other (not the pool-2 concurrency harness):
            // the route's re-check-then-return path must dedup on its own.
            const res1 = await POST(makeReq());
            expect(res1.status).toBe(201);
            const first = (await res1.json()).visit;

            const res2 = await POST(makeReq());
            expect(res2.status).toBe(201);
            const second = (await res2.json()).visit;

            // The re-check returned the existing open visit instead of creating a new one.
            expect(second.id).toBe(first.id);

            const openVisits = await prisma.visit.findMany({
                where: { personId: testUserId, departedAt: null }
            });
            expect(openVisits.length).toBe(1);
            expect(openVisits[0].id).toBe(first.id);
        });
    });
});

// An OPEN manual backfill (no departure) claims the actor is in the building now,
// so it must obey the same keyholder-first rule as /api/scan and MANUAL_CHECKIN.
// A CLOSED backfill is historical and never gated.
describe('Manual Attendance API keyholder-first guard (open backfills)', () => {
    const TAG = 'manual-guard-test';
    let nkId: number;
    let khId: number;
    let householdIds: number[];

    function openReq(userId: number) {
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: userId, isKeyholder: false } });
        return new Request('http://localhost:4000/api/attendance/manual', {
            method: 'POST',
            body: JSON.stringify({ arrivedAt: new Date(Date.now() - 600000).toISOString() }), // 10 min ago, open
        }) as unknown as import('next/server').NextRequest;
    }

    beforeAll(async () => {
        const leaked = await prisma.person.findMany({ where: { email: { contains: TAG } }, select: { id: true, householdId: true } });
        const ids = leaked.map(p => p.id);
        await prisma.visit.deleteMany({ where: { personId: { in: ids } } });
        await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } });
        await prisma.person.deleteMany({ where: { id: { in: ids } } });
        await prisma.household.deleteMany({ where: { id: { in: leaked.map(p => p.householdId) } } });

        const nk = await prisma.person.create({ data: { email: `nk-${TAG}@example.com`, name: 'Guard NK', household: { create: { name: "Test HH" } } } });
        nkId = nk.id;
        const kh = await prisma.person.create({ data: { email: `kh-${TAG}@example.com`, name: 'Guard KH', isKeyholder: true, household: { create: { name: "Test HH" } } } });
        khId = kh.id;
        householdIds = [nk.householdId, kh.householdId];
    });

    afterAll(async () => {
        await prisma.visit.deleteMany({ where: { personId: { in: [nkId, khId] } } });
        await prisma.auditLog.deleteMany({ where: { actorId: { in: [nkId, khId] } } });
        await prisma.person.deleteMany({ where: { id: { in: [nkId, khId] } } });
        await prisma.household.deleteMany({ where: { id: { in: householdIds } } });
    });

    it('non-keyholder open backfill into an empty building → 403, no visit', async () => {
        await prisma.visit.deleteMany({ where: { personId: { in: [nkId, khId] } } });
        const res = await (POST(openReq(nkId)) as Promise<Response>);
        expect(res.status).toBe(403);
        expect(await prisma.visit.count({ where: { personId: nkId, departedAt: null } })).toBe(0);
    });

    it('non-keyholder open backfill with a keyholder present → 201', async () => {
        await prisma.visit.deleteMany({ where: { personId: { in: [nkId, khId] } } });
        await prisma.visit.create({ data: { personId: khId, arrivedAt: new Date(), arrivedVia: 'WEB' } });
        const res = await (POST(openReq(nkId)) as Promise<Response>);
        expect(res.status).toBe(201);
        expect(await prisma.visit.count({ where: { personId: nkId, departedAt: null } })).toBe(1);
    });

    it('non-keyholder CLOSED backfill into an empty building → 201 (historical, ungated)', async () => {
        await prisma.visit.deleteMany({ where: { personId: { in: [nkId, khId] } } });
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

// AT3 §3: a household lead records a visit FOR a household member — the only
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

    // The facility-open guard follows the SUBJECT: a lead cannot open the
    // building by backfilling an open visit for their non-keyholder child.
    it('403s an OPEN backfill for a member into an empty building', async () => {
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: leadId, isKeyholder: true } });
        await prisma.visit.deleteMany({ where: { personId: { in: [leadId, childId, outsiderId] } } });
        const res = await post({ arrivedAt: new Date(Date.now() - 600000).toISOString(), personId: childId });
        expect(res.status).toBe(403);
        expect(await prisma.visit.count({ where: { personId: childId, departedAt: null } })).toBe(0);
    });
});
