/**
 * @jest-environment node
 */
/**
 * A visit change and its audit row commit together (docs/rules/attendance-checkin.md).
 * A trigger makes Postgres refuse this suite's audit rows, whichever client writes
 * them, so each route's visit change must roll back with the refused row.
 */
import { POST as manualPost } from '@/app/api/attendance/manual/route';
import { PATCH as manualPatch, DELETE as manualDelete } from '@/app/api/attendance/manual/[id]/route';
import { PATCH as staffPatch, DELETE as staffDelete } from '@/app/api/facility/visits/route';
import { POST as staffInsert } from '@/app/api/facility/visits/insert/route';
import { POST as recordScan } from '@/app/api/system-status/unsynced-scans/[id]/route';
import { emailBoardMembers } from '@/lib/emailRecipients';
import prisma from '@/lib/prisma';
import { getServerSession } from 'next-auth/next';
import type { NextRequest } from 'next/server';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));
jest.mock('@/lib/emailRecipients', () => ({
    ...jest.requireActual('@/lib/emailRecipients'),
    emailBoardMembers: jest.fn(),
}));

const TAG = 'visit-audit-atomic-test';
const HOUR = 3600000;

const req = (method: string, path: string, body: unknown) =>
    new Request(`http://localhost:4000${path}`, { method, body: JSON.stringify(body) }) as unknown as NextRequest;
const ctx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });

describe('visit writes roll back when their audit row is refused', () => {
    let actorId: number;
    let householdId: number;
    const arrivedAt = new Date(Date.now() - 3 * HOUR);
    const departedAt = new Date(Date.now() - 2 * HOUR);
    const movedArrival = new Date(Date.now() - 4 * HOUR).toISOString();

    const closedVisit = () => prisma.visit.create({
        data: { personId: actorId, arrivedAt, departedAt, arrivedVia: 'SCANNER', departedVia: 'SCANNER' },
    });

    async function expectNoNewVisit() {
        expect(await prisma.visit.count({ where: { personId: actorId } })).toBe(0);
        expect(await prisma.presenceEvent.count({ where: { personId: actorId } })).toBe(0);
    }

    async function expectUntouched(visitId: number) {
        const row = await prisma.visit.findUnique({ where: { id: visitId } });
        expect(row).toMatchObject({ arrivedAt, departedAt, arrivedVia: 'SCANNER', departedVia: 'SCANNER', deletedAt: null });
    }

    beforeAll(async () => {
        const actor = await prisma.person.create({
            data: {
                email: `actor-${TAG}@example.com`,
                name: 'Audit Atomic Actor',
                isSysadmin: true,
                isBoardMember: true,
                isKeyholder: true,
                household: { create: { name: 'Test HH' } },
            },
        });
        actorId = actor.id;
        householdId = actor.householdId;
        (getServerSession as jest.Mock).mockResolvedValue({
            user: { id: actorId, name: actor.name, isSysadmin: true, isBoardMember: true, isKeyholder: true },
        });

        await prisma.$executeRawUnsafe(`
            CREATE OR REPLACE FUNCTION visit_audit_atomic_refuse() RETURNS trigger AS $$
            BEGIN RAISE EXCEPTION 'audit write refused'; END
            $$ LANGUAGE plpgsql`);
        await prisma.$executeRawUnsafe(`
            CREATE TRIGGER visit_audit_atomic_refuse BEFORE INSERT ON "AuditLog"
            FOR EACH ROW WHEN (NEW."actorId" = ${actorId})
            EXECUTE FUNCTION visit_audit_atomic_refuse()`);
    });

    beforeEach(() => {
        // The routes log the refused write; that error is this suite's premise.
        jest.spyOn(console, 'error').mockImplementation(() => {});
        (emailBoardMembers as jest.Mock).mockClear();
    });

    afterEach(async () => {
        jest.restoreAllMocks();
        await prisma.presenceEvent.deleteMany({ where: { personId: actorId } });
        await prisma.rawBadgeLog.deleteMany({ where: { personId: actorId } });
        await prisma.visit.deleteMany({ where: { personId: actorId } });
    });

    afterAll(async () => {
        await prisma.$executeRawUnsafe('DROP TRIGGER visit_audit_atomic_refuse ON "AuditLog"');
        await prisma.$executeRawUnsafe('DROP FUNCTION visit_audit_atomic_refuse()');
        await prisma.person.delete({ where: { id: actorId } });
        await prisma.household.delete({ where: { id: householdId } });
    });

    it('POST /api/attendance/manual records no visit', async () => {
        const res = await manualPost(req('POST', '/api/attendance/manual', { arrivedAt, departedAt }));
        expect(res.status).toBe(500);
        await expectNoNewVisit();
    });

    it('PATCH /api/attendance/manual/[id] keeps the old times and flags no one', async () => {
        const visit = await closedVisit();
        const res = await manualPatch(req('PATCH', `/api/attendance/manual/${visit.id}`, { arrivedAt: movedArrival }), ctx(visit.id));
        expect(res.status).toBe(500);
        await expectUntouched(visit.id);
        expect(emailBoardMembers).not.toHaveBeenCalled();
    });

    it('DELETE /api/attendance/manual/[id] leaves the visit live and flags no one', async () => {
        const visit = await closedVisit();
        const res = await manualDelete(req('DELETE', `/api/attendance/manual/${visit.id}`, {}), ctx(visit.id));
        expect(res.status).toBe(500);
        await expectUntouched(visit.id);
        expect(emailBoardMembers).not.toHaveBeenCalled();
    });

    it('PATCH /api/facility/visits keeps the old times', async () => {
        const visit = await closedVisit();
        const res = await staffPatch(req('PATCH', '/api/facility/visits', { visitId: visit.id, arrivedAt: movedArrival }));
        expect(res.status).toBe(500);
        await expectUntouched(visit.id);
    });

    it('DELETE /api/facility/visits leaves the visit live', async () => {
        const visit = await closedVisit();
        const res = await staffDelete(req('DELETE', '/api/facility/visits', { visitId: visit.id }));
        expect(res.status).toBe(500);
        await expectUntouched(visit.id);
    });

    it('POST /api/facility/visits/insert records no visit', async () => {
        const res = await staffInsert(req('POST', '/api/facility/visits/insert', { personId: actorId, arrivedAt, departedAt }));
        expect(res.status).toBe(500);
        await expectNoNewVisit();
    });

    it('POST /api/system-status/unsynced-scans/[id] records no visit and leaves the scan parked', async () => {
        const scan = await prisma.rawBadgeLog.create({
            data: { personId: actorId, timestamp: arrivedAt, reviewReason: 'stale_replay' },
        });
        const res = await recordScan(
            req('POST', `/api/system-status/unsynced-scans/${scan.id}`, { action: 'record', departedAt }),
            ctx(scan.id),
        );
        expect(res.status).toBe(500);
        await expectNoNewVisit();
        const row = await prisma.rawBadgeLog.findUnique({ where: { id: scan.id } });
        expect(row?.reviewedAt).toBeNull();
    });
});
