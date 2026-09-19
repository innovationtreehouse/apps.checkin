/**
 * @jest-environment node
 */
/**
 * Integration Tests for Admin Visits API
 * Tests GET and PATCH /api/facility/visits for viewing and editing check-in records
 */

import { GET, PATCH, DELETE } from '@/app/api/facility/visits/route';
import { POST } from '@/app/api/facility/visits/insert/route';
import prisma from '@/lib/prisma';
import { getServerSession } from 'next-auth/next';

// Mock NextAuth
jest.mock('next-auth/next', () => ({
    getServerSession: jest.fn()
}));

describe('Admin Visits API Integration Tests', () => {
    let testAdminId: number;
    let testUserId: number;
    let testVisitId: number;

    beforeAll(async () => {
        // Clean up any leaked state
        const existingUsers = await prisma.person.findMany({
            where: { email: { contains: 'visits-api-test' } },
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
            where: { email: { contains: 'visits-api-test' } }
        });

        // Setup mock database records
        const admin = await prisma.person.create({
            data: { email: 'admin-visits-api-test@example.com', name: 'Admin Visits Test', isSysadmin: true, household: { create: { name: "Test HH" } } }
        });
        testAdminId = admin.id;
        const checkAdmin = await prisma.person.findUnique({ where: { id: testAdminId } });
        console.log("Check Admin:", checkAdmin);

        const user = await prisma.person.create({
            data: { email: 'user-visits-api-test@example.com', name: 'User Visits Test', household: { create: { name: "Test HH" } } }
        });
        testUserId = user.id;

        const visit = await prisma.visit.create({
            data: {
                personId: testUserId,
                arrivedAt: new Date(Date.now() - 3600000), // 1 hour ago
            }
        });
        testVisitId = visit.id;
    });

    afterAll(async () => {
        // Clean up
        await prisma.visit.deleteMany({
            where: { personId: { in: [testAdminId, testUserId] } }
        });
        await prisma.auditLog.deleteMany({
            where: { actorId: { in: [testAdminId, testUserId] } }
        });
        await prisma.person.deleteMany({
            where: { id: { in: [testAdminId, testUserId] } }
        });
    });

    describe('GET /api/facility/visits', () => {
        it('should return 401 Unauthorized without session', async () => {
            (getServerSession as jest.Mock).mockResolvedValue(null);

            const req = new Request('http://localhost:4000/api/facility/visits', {
                method: 'GET'
            });

            const res = await GET(req as unknown as import("next/server").NextRequest);
            expect(res.status).toBe(401);
        });

        it('should return 403 Forbidden for non-admin users', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({
                user: { id: testUserId }
            });

            const req = new Request('http://localhost:4000/api/facility/visits', {
                method: 'GET'
            });

            const res = await GET(req as unknown as import("next/server").NextRequest);
            expect(res.status).toBe(403);
        });

        it('should return the latest visits for a isSysadmin', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({
                user: { id: testAdminId, isSysadmin: true }
            });

            const req = new Request('http://localhost:4000/api/facility/visits', {
                method: 'GET'
            });

            const res = await GET(req as unknown as import("next/server").NextRequest);
            expect(res.status).toBe(200);
            const data = await res.json();
            expect(Array.isArray(data.visits)).toBe(true);
            expect(data.visits.length).toBeGreaterThanOrEqual(1);

            const visitMatches = data.visits.filter((v: { id?: number; email?: string; name?: string; participantId?: number; level?: string; status?: string; role?: string; type?: string; [key: string]: unknown }) => v.personId === testUserId);
            expect(visitMatches.length).toBe(1);
            expect(visitMatches[0].person).toBeDefined();
        });
    });

    describe('PATCH /api/facility/visits', () => {
        it('should return 401 Unauthorized without session', async () => {
            (getServerSession as jest.Mock).mockResolvedValue(null);

            const req = new Request('http://localhost:4000/api/facility/visits', {
                method: 'PATCH',
                body: JSON.stringify({ visitId: testVisitId, departedAt: new Date().toISOString() })
            });

            const res = await PATCH(req as unknown as import("next/server").NextRequest);
            expect(res.status).toBe(401);
        });

        it('should return 403 Forbidden for non-admin users', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({
                user: { id: testUserId }
            });

            const req = new Request('http://localhost:4000/api/facility/visits', {
                method: 'PATCH',
                body: JSON.stringify({ visitId: testVisitId, departedAt: new Date().toISOString() })
            });

            const res = await PATCH(req as unknown as import("next/server").NextRequest);
            expect(res.status).toBe(403);
        });

        it('should return 400 Bad Request if visitId is missing', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({
                user: { id: testAdminId, isSysadmin: true }
            });

            const req = new Request('http://localhost:4000/api/facility/visits', {
                method: 'PATCH',
                body: JSON.stringify({ departedAt: new Date().toISOString() })
            });

            const res = await PATCH(req as unknown as import("next/server").NextRequest);
            expect(res.status).toBe(400);
            const data = await res.json();
            expect(data.error).toBe('visitId is required.');
        });

        it('should return 400 for an invalid provided date', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({
                user: { id: testAdminId, isSysadmin: true }
            });

            const req = new Request('http://localhost:4000/api/facility/visits', {
                method: 'PATCH',
                body: JSON.stringify({ visitId: testVisitId, departedAt: 'not-a-date' })
            });

            const res = await PATCH(req as unknown as import("next/server").NextRequest);
            expect(res.status).toBe(400);
            const data = await res.json();
            expect(data.error).toBe('Invalid departure time');
        });

        it('should return 400 for a future provided date', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({
                user: { id: testAdminId, isSysadmin: true }
            });

            const future = new Date(Date.now() + 3600000).toISOString();
            const req = new Request('http://localhost:4000/api/facility/visits', {
                method: 'PATCH',
                body: JSON.stringify({ visitId: testVisitId, departedAt: future })
            });

            const res = await PATCH(req as unknown as import("next/server").NextRequest);
            expect(res.status).toBe(400);
            const data = await res.json();
            expect(data.error).toBe('Departure time cannot be in the future.');
        });

        it('should return 400 when editing an open visit without supplying a departure', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({
                user: { id: testAdminId, isSysadmin: true }
            });

            // testVisitId is still open here (departedAt null); editing only arrival must not leave it open.
            const req = new Request('http://localhost:4000/api/facility/visits', {
                method: 'PATCH',
                body: JSON.stringify({ visitId: testVisitId, arrivedAt: new Date(Date.now() - 7200000).toISOString() })
            });

            const res = await PATCH(req as unknown as import("next/server").NextRequest);
            expect(res.status).toBe(400);
            const data = await res.json();
            expect(data.error).toBe('Departure time is required to close this visit.');
        });

        it('should return 400 when departure is not after arrival', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({
                user: { id: testAdminId, isSysadmin: true }
            });

            // Existing arrival is ~1h ago; a departure 2h ago is before it (also covers zero-length).
            const req = new Request('http://localhost:4000/api/facility/visits', {
                method: 'PATCH',
                body: JSON.stringify({ visitId: testVisitId, departedAt: new Date(Date.now() - 7200000).toISOString() })
            });

            const res = await PATCH(req as unknown as import("next/server").NextRequest);
            expect(res.status).toBe(400);
            const data = await res.json();
            expect(data.error).toBe('Departure time must be after arrival time');
        });

        it('should return 404 for a non-existent visit', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({
                user: { id: testAdminId, isSysadmin: true }
            });

            const req = new Request('http://localhost:4000/api/facility/visits', {
                method: 'PATCH',
                body: JSON.stringify({ visitId: 999999999, departedAt: new Date().toISOString() })
            });

            const res = await PATCH(req as unknown as import("next/server").NextRequest);
            expect(res.status).toBe(404);
            const data = await res.json();
            expect(data.error).toBe('Visit not found.');
        });

        it('should update the visit and log to audit block when an admin requests it', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({
                user: { id: testAdminId, isSysadmin: true }
            });

            const previousAuditLogs = await prisma.auditLog.count({
                where: { actorId: testAdminId, action: 'EDIT', tableName: 'Visit' }
            });

            const now = new Date();
            const req = new Request('http://localhost:4000/api/facility/visits', {
                method: 'PATCH',
                body: JSON.stringify({ visitId: testVisitId, departedAt: now.toISOString() })
            });

            const res = await PATCH(req as unknown as import("next/server").NextRequest);
            expect(res.status).toBe(200);
            const data = await res.json();
            expect(new Date(data.visit.departedAt).toISOString()).toBe(now.toISOString());
            expect(data.visit.departedVia).toBe('TYPED');

            const updatedVisit = await prisma.visit.findUnique({ where: { id: testVisitId } });
            expect(updatedVisit?.departedAt?.toISOString()).toBe(now.toISOString());

            const currentAuditLogs = await prisma.auditLog.count({
                where: { actorId: testAdminId, action: 'EDIT', tableName: 'Visit' }
            });
            expect(currentAuditLogs).toBe(previousAuditLogs + 1);

            // Only departedAt moved (from null, closing the visit) — no weighted
            // shift on either field, so significance is the zero floor.
            const auditLog = await prisma.auditLog.findFirst({
                where: { actorId: testAdminId, action: 'EDIT', tableName: 'Visit', affectedEntityId: testVisitId },
                orderBy: { id: 'desc' },
            });
            expect((auditLog?.newData as { significance?: { score: number; flagged: boolean } })?.significance)
                .toEqual({ score: 0, flagged: false });
        });

        // Correcting a time replaces where it came from: a corrected badge
        // arrival becomes a typed clock (arrivedVia TYPED). This edit's own
        // significance still weighs the pre-edit SCANNER measurement, but the
        // stored value is now a self-report, so a SECOND correction weighs TYPED.
        it('restamps arrivedVia to TYPED when the board corrects a scanned arrival', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({
                user: { id: testAdminId, isSysadmin: true }
            });

            const scanned = await prisma.visit.create({
                data: {
                    personId: testUserId,
                    arrivedAt: new Date(Date.now() - 4 * 3600000),
                    departedAt: new Date(Date.now() - 2 * 3600000),
                    arrivedVia: 'SCANNER',
                    departedVia: 'SCANNER',
                }
            });

            const corrected = new Date(Date.now() - 3 * 3600000).toISOString();
            const req = new Request('http://localhost:4000/api/facility/visits', {
                method: 'PATCH',
                body: JSON.stringify({ visitId: scanned.id, arrivedAt: corrected })
            });

            const res = await PATCH(req as unknown as import("next/server").NextRequest);
            expect(res.status).toBe(200);

            const stored = await prisma.visit.findUnique({ where: { id: scanned.id } });
            expect(stored?.arrivedAt.toISOString()).toBe(corrected);
            expect(stored?.arrivedVia).toBe('TYPED');    // re-timed → now a typed clock
            expect(stored?.departedVia).toBe('SCANNER'); // not sent — untouched
        });
    });

    describe('DELETE /api/facility/visits', () => {
        it('should return 401 Unauthorized without session', async () => {
            (getServerSession as jest.Mock).mockResolvedValue(null);

            const req = new Request('http://localhost:4000/api/facility/visits', {
                method: 'DELETE',
                body: JSON.stringify({ visitId: testVisitId })
            });

            const res = await DELETE(req as unknown as import("next/server").NextRequest);
            expect(res.status).toBe(401);
        });

        it('should return 403 Forbidden for non-admin users', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({
                user: { id: testUserId }
            });

            const req = new Request('http://localhost:4000/api/facility/visits', {
                method: 'DELETE',
                body: JSON.stringify({ visitId: testVisitId })
            });

            const res = await DELETE(req as unknown as import("next/server").NextRequest);
            expect(res.status).toBe(403);
        });

        it('should return 400 Bad Request if visitId is missing', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({
                user: { id: testAdminId, isSysadmin: true }
            });

            const req = new Request('http://localhost:4000/api/facility/visits', {
                method: 'DELETE',
                body: JSON.stringify({})
            });

            const res = await DELETE(req as unknown as import("next/server").NextRequest);
            expect(res.status).toBe(400);
            const data = await res.json();
            expect(data.error).toBe('visitId is required.');
        });

        it('should return 404 for a non-existent visit', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({
                user: { id: testAdminId, isSysadmin: true }
            });

            const req = new Request('http://localhost:4000/api/facility/visits', {
                method: 'DELETE',
                body: JSON.stringify({ visitId: 999999999 })
            });

            const res = await DELETE(req as unknown as import("next/server").NextRequest);
            expect(res.status).toBe(404);
            const data = await res.json();
            expect(data.error).toBe('Visit not found.');
        });

        it('should tombstone the visit and log to audit with oldData when an admin requests it', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({
                user: { id: testAdminId, isSysadmin: true }
            });

            // Own throwaway visit so the shared testVisitId stays available for other runs.
            const doomed = await prisma.visit.create({
                data: { personId: testUserId, arrivedAt: new Date(Date.now() - 3600000) }
            });

            const req = new Request('http://localhost:4000/api/facility/visits', {
                method: 'DELETE',
                body: JSON.stringify({ visitId: doomed.id })
            });

            const res = await DELETE(req as unknown as import("next/server").NextRequest);
            expect(res.status).toBe(200);
            const data = await res.json();
            expect(data.success).toBe(true);

            // Staff deletes tombstone like member self-deletes: the row survives,
            // stamped with who erased it.
            const tombstoned = await prisma.visit.findUnique({ where: { id: doomed.id } });
            expect(tombstoned?.deletedAt).toBeInstanceOf(Date);
            expect(tombstoned?.deletedById).toBe(testAdminId);

            const auditLog = await prisma.auditLog.findFirst({
                where: { actorId: testAdminId, action: 'DELETE', tableName: 'Visit', affectedEntityId: doomed.id }
            });
            expect(auditLog).not.toBeNull();
            expect((auditLog?.oldData as { id?: number })?.id).toBe(doomed.id);

            // Resolved (#1630): the visit is still open, so its score is elapsed
            // time-on-site (~1h, no arrivedVia so weight 1) rather than the old
            // hardcoded 0 — deleting a live check-in no longer scores lowest.
            // The admin (testAdminId) isn't the visit's own person (testUserId),
            // so this delete is byProxy too — the route doubles the weight
            // (significance.ts PROXY_MULTIPLIER), giving ~120, not ~60.
            const significance = (auditLog?.newData as { significance?: { score: number; flagged: boolean } })?.significance;
            expect(significance?.flagged).toBe(true);
            expect(significance?.score).toBeGreaterThanOrEqual(120);
            expect(significance?.score).toBeLessThan(130);
        });
    });

    // AT3 §3: the walk-in path. Neither the kiosk (live only) nor the event
    // roster mark (program-scoped, event window) can record a past visit for
    // someone who was simply never badged in.
    describe('POST /api/facility/visits — staff insert for others', () => {
        const post = (body: unknown) => POST(new Request('http://localhost:4000/api/facility/visits/insert', {
            method: 'POST', body: JSON.stringify(body),
        }) as unknown as import("next/server").NextRequest);

        const arrived = new Date(Date.now() - 3 * 3600000);
        const departed = new Date(Date.now() - 2 * 3600000);

        it('403s a non-admin — the role gate is the whole boundary here', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({ user: { id: testUserId } });
            const res = await post({ personId: testUserId, arrivedAt: arrived.toISOString(), departedAt: departed.toISOString() });
            expect(res.status).toBe(403);
        });

        it('creates a closed TYPED visit for another person and audits actor + subject', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({ user: { id: testAdminId, isSysadmin: true } });
            const res = await post({ personId: testUserId, arrivedAt: arrived.toISOString(), departedAt: departed.toISOString() });

            expect(res.status).toBe(200);
            const { visit } = await res.json();
            const stored = await prisma.visit.findUnique({ where: { id: visit.id } });
            expect(stored).toMatchObject({ personId: testUserId, arrivedVia: 'TYPED', departedVia: 'TYPED' });
            expect(stored?.departedAt).toBeInstanceOf(Date);

            const audit = await prisma.auditLog.findFirst({
                where: { actorId: testAdminId, action: 'CREATE', tableName: 'Visit', affectedEntityId: visit.id },
            });
            expect(audit).not.toBeNull();
            // actor ≠ subject is what marks this as acting-for-another (design §6.6).
            expect(audit?.secondaryAffectedEntity).toBe(testUserId);
        });

        it('refuses an open visit — live presence belongs to the kiosk', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({ user: { id: testAdminId, isSysadmin: true } });
            const res = await post({ personId: testUserId, arrivedAt: arrived.toISOString() });
            expect(res.status).toBe(400);
        });

        it('rejects a future time, an inverted range, and a >24h span', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({ user: { id: testAdminId, isSysadmin: true } });
            const future = new Date(Date.now() + 3600000).toISOString();
            expect((await post({ personId: testUserId, arrivedAt: future, departedAt: future })).status).toBe(400);
            expect((await post({ personId: testUserId, arrivedAt: departed.toISOString(), departedAt: arrived.toISOString() })).status).toBe(400);
            expect((await post({
                personId: testUserId,
                arrivedAt: new Date(Date.now() - 30 * 3600000).toISOString(),
                departedAt: departed.toISOString(),
            })).status).toBe(400);
        });

        it('400s a missing or malformed body rather than 500ing', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({ user: { id: testAdminId, isSysadmin: true } });
            const bodyless = POST(new Request('http://localhost:4000/api/facility/visits/insert', {
                method: 'POST',
            }) as unknown as import("next/server").NextRequest);
            expect((await bodyless).status).toBe(400);

            const malformed = POST(new Request('http://localhost:4000/api/facility/visits/insert', {
                method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops',
            }) as unknown as import("next/server").NextRequest);
            expect((await malformed).status).toBe(400);
        });

        it('404s an unknown person instead of creating an orphan visit', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({ user: { id: testAdminId, isSysadmin: true } });
            const res = await post({ personId: 999999999, arrivedAt: arrived.toISOString(), departedAt: departed.toISOString() });
            expect(res.status).toBe(404);
        });
    });
});
