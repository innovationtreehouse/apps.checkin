/**
 * @jest-environment node
 */
/**
 * Integration Tests for Admin Audit API
 * Tests GET /api/system-status/audit-log for viewing telemetry
 */

import { GET } from '@/app/api/system-status/audit-log/route';
import prisma from '@/lib/prisma';
import { getServerSession } from 'next-auth/next';

// Mock NextAuth
jest.mock('next-auth/next', () => ({
    getServerSession: jest.fn()
}));

const SYSTEM_TAG = 'cron:nightly';

describe('Admin Audit API Integration Tests', () => {
    let adminId: number;
    let commonId: number;
    let boardId: number;

    beforeAll(async () => {
        // Clean up any leaked state
        const existingUsers = await prisma.person.findMany({
            where: { email: { contains: 'audit-api-test' } },
            select: { id: true }
        });
        const existingUserIds = existingUsers.map(u => u.id);
        
        await prisma.auditLog.deleteMany({
            where: { actorId: { in: existingUserIds } }
        });
        
        await prisma.person.deleteMany({
            where: { id: { in: existingUserIds } }
        });

        // Create Admin
        const admin = await prisma.person.create({
            data: { email: 'admin-audit-api-test@example.com', name: 'Admin', isSysadmin: true, household: { create: { name: "Test HH" } } }
        });
        adminId = admin.id;

        // Create Common User
        const commonUser = await prisma.person.create({
            data: { email: 'common-audit-api-test@example.com', name: 'Common', household: { create: { name: "Test HH" } } }
        });
        commonId = commonUser.id;

        // Create a board member (no sysadmin flag) — they answer for what is logged here.
        const board = await prisma.person.create({
            data: { email: 'board-audit-api-test@example.com', name: 'Board', isBoardMember: true, household: { create: { name: "Test HH" } } }
        });
        boardId = board.id;

        // Produce a fake audit log row
        await prisma.auditLog.create({
            data: {
                actorId: adminId,
                action: 'CREATE',
                affectedEntityId: commonId,
                tableName: 'Person',
                newData: { email: 'common-audit-api-test@example.com' }
            }
        });

        // And one written by a named system actor, keyed on the same person as
        // the SECONDARY id — the slot an entity filter must also search.
        await prisma.auditLog.create({
            data: {
                actorId: 0,
                actorSystem: SYSTEM_TAG,
                action: 'EDIT',
                affectedEntityId: 0,
                secondaryAffectedEntity: commonId,
                tableName: 'SYSTEM_NOTIFY',
                newData: { message: 'audit-api-test system row' }
            }
        });
    });

    afterAll(async () => {
        const existingUserIds = [adminId, commonId, boardId].filter(id => id !== undefined);

        await prisma.auditLog.deleteMany({ where: { actorSystem: SYSTEM_TAG, secondaryAffectedEntity: commonId } });

        if (existingUserIds.length > 0) {
            await prisma.auditLog.deleteMany({
                where: { actorId: { in: existingUserIds } }
            });

            await prisma.person.deleteMany({
                where: { id: { in: existingUserIds } }
            });
        }
    });

    describe('GET /api/system-status/audit-log', () => {
        it('should return 401 Unauthorized without session', async () => {
             (getServerSession as jest.Mock).mockResolvedValue(null);

             const req = new Request('http://localhost:4000/api/system-status/audit-log', { method: 'GET' });
             const res = await GET(req as unknown as import("next/server").NextRequest);
             expect(res.status).toBe(401);
        });

        it('should return 403 Forbidden for a common user', async () => {
             (getServerSession as jest.Mock).mockResolvedValue({ user: { id: commonId, isSysadmin: false } });

             const req = new Request('http://localhost:4000/api/system-status/audit-log', { method: 'GET' });
             const res = await GET(req as unknown as import("next/server").NextRequest);
             expect(res.status).toBe(403);
        });

        it('should return 200 OK and logs for a isSysadmin', async () => {
             (getServerSession as jest.Mock).mockResolvedValue({ user: { id: adminId, isSysadmin: true } });

             const req = new Request('http://localhost:4000/api/system-status/audit-log', { method: 'GET' });
             const res = await GET(req as unknown as import("next/server").NextRequest);
             expect(res.status).toBe(200);
             
             const data = await res.json();
             expect(Array.isArray(data.logs)).toBe(true);
             expect(data.logs.length).toBeGreaterThanOrEqual(1);

             // Verify it contains our generated log
             const ourLog = data.logs.find((log: { id?: number; email?: string; name?: string; participantId?: number; level?: string; status?: string; role?: string; type?: string; [key: string]: unknown }) => log.actorId === adminId && log.action === 'CREATE');
             expect(ourLog).toBeDefined();

             // Server-side paging metadata + resolved actor name.
             expect(typeof data.total).toBe('number');
             expect(data.page).toBe(1);
             expect(data.pageSize).toBe(50);
             expect(Array.isArray(data.tables)).toBe(true);
             expect(ourLog.actorName).toBe('Admin');
        });

        it('should return 200 OK for a board member (non-sysadmin)', async () => {
             (getServerSession as jest.Mock).mockResolvedValue({ user: { id: boardId, isSysadmin: false, isBoardMember: true } });

             const req = new Request('http://localhost:4000/api/system-status/audit-log', { method: 'GET' });
             const res = await GET(req as unknown as import("next/server").NextRequest);
             expect(res.status).toBe(200);
             expect(Array.isArray((await res.json()).logs)).toBe(true);
        });

        it('should filter by a person actor and by a named system actor', async () => {
             (getServerSession as jest.Mock).mockResolvedValue({ user: { id: adminId, isSysadmin: true } });

             const byPerson = await (await GET(new Request(`http://localhost:4000/api/system-status/audit-log?actor=${adminId}`) as unknown as import("next/server").NextRequest)).json();
             expect(byPerson.logs.length).toBeGreaterThanOrEqual(1);
             for (const log of byPerson.logs) expect(log.actorId).toBe(adminId);

             const bySystem = await (await GET(new Request(`http://localhost:4000/api/system-status/audit-log?actor=${SYSTEM_TAG}`) as unknown as import("next/server").NextRequest)).json();
             expect(bySystem.logs.length).toBeGreaterThanOrEqual(1);
             for (const log of bySystem.logs) expect(log.actorSystem).toBe(SYSTEM_TAG);

             // Both actors are offered as filter options.
             expect(bySystem.systemActors).toContain(SYSTEM_TAG);
             expect(bySystem.actors.map((a: { id: number }) => a.id)).toContain(adminId);
        });

        it('should filter by entity id across both the primary and secondary slot', async () => {
             (getServerSession as jest.Mock).mockResolvedValue({ user: { id: adminId, isSysadmin: true } });

             const data = await (await GET(new Request(`http://localhost:4000/api/system-status/audit-log?entityId=${commonId}`) as unknown as import("next/server").NextRequest)).json();
             for (const log of data.logs) {
                 expect([log.affectedEntityId, log.secondaryAffectedEntity]).toContain(commonId);
             }
             // The person row (primary slot) and the system row (secondary slot) both match.
             expect(data.logs.some((l: { tableName: string }) => l.tableName === 'Person')).toBe(true);
             expect(data.logs.some((l: { actorSystem: string | null }) => l.actorSystem === SYSTEM_TAG)).toBe(true);
        });

        it('should filter by action and entity and page server-side', async () => {
             (getServerSession as jest.Mock).mockResolvedValue({ user: { id: adminId, isSysadmin: true } });

             const url = 'http://localhost:4000/api/system-status/audit-log?action=CREATE&table=Person&page=1';
             const req = new Request(url, { method: 'GET' });
             const res = await GET(req as unknown as import("next/server").NextRequest);
             expect(res.status).toBe(200);

             const data = await res.json();
             expect(data.logs.length).toBeLessThanOrEqual(50);
             // Every returned row must satisfy both filters.
             for (const log of data.logs) {
                 expect(log.action).toBe('CREATE');
                 expect(log.tableName).toBe('Person');
             }
        });
    });
});
