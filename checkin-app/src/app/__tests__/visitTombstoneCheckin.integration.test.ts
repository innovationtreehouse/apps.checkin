/**
 * @jest-environment node
 */
/**
 * The tombstone migration's core claim, against a real Postgres.
 *
 * `Visit_one_open_per_participant` is a partial unique index. It is predicated
 * on `deletedAt IS NULL` so a tombstoned open visit no longer counts as "open":
 * without that predicate a member who self-deletes an open visit can never check
 * in again — every later arrival hits P2002 on an index row nothing will clear.
 * Mocking cannot show this; the index is a database object.
 */
import { POST } from '@/app/api/attendance/manual/route';
import { DELETE } from '@/app/api/attendance/manual/[id]/route';
import prisma from '@/lib/prisma';
import { getFullAttendance } from '@/lib/getFullAttendance';
import { getServerSession } from 'next-auth/next';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));
jest.mock('@/lib/email', () => ({
    runPaced: (tasks: Array<() => Promise<unknown>>) => Promise.all(tasks.map((t) => t())),
    sendEmail: jest.fn().mockResolvedValue(true),
}));

const EMAIL_TAG = 'visit-tombstone-checkin-test';

function openVisitRequest() {
    return new Request('http://localhost:4000/api/attendance/manual', {
        method: 'POST',
        body: JSON.stringify({ arrivedAt: new Date(Date.now() - 60000).toISOString() }),
    }) as unknown as import('next/server').NextRequest;
}

function deleteRequest() {
    return new Request('http://localhost:4000/api/attendance/manual/0', {
        method: 'DELETE',
    }) as unknown as import('next/server').NextRequest;
}

describe('tombstoned open visit does not block the next check-in', () => {
    let subjectId: number;
    let householdId: number;

    beforeAll(async () => {
        const leaked = await prisma.person.findMany({
            where: { email: { contains: EMAIL_TAG } },
            select: { id: true, householdId: true },
        });
        const leakedIds = leaked.map(p => p.id);
        await prisma.visit.deleteMany({ where: { personId: { in: leakedIds } } });
        await prisma.auditLog.deleteMany({ where: { actorId: { in: leakedIds } } });
        await prisma.person.deleteMany({ where: { id: { in: leakedIds } } });
        await prisma.household.deleteMany({ where: { id: { in: leaked.map(p => p.householdId) } } });

        // Keyholder: an open backfill must clear the facility-open guard.
        const subject = await prisma.person.create({
            data: {
                email: `subject-${EMAIL_TAG}@example.com`,
                name: 'Tombstone Checkin Subject',
                isKeyholder: true,
                household: { create: { name: 'Test HH' } },
            },
        });
        subjectId = subject.id;
        householdId = subject.householdId;
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: subjectId, isKeyholder: true } });
    });

    afterAll(async () => {
        await prisma.visit.deleteMany({ where: { personId: subjectId } });
        await prisma.auditLog.deleteMany({ where: { actorId: subjectId } });
        await prisma.person.deleteMany({ where: { id: subjectId } });
        await prisma.household.deleteMany({ where: { id: householdId } });
    });

    it('self-deleting an open visit frees the one-open-visit slot', async () => {
        await prisma.visit.deleteMany({ where: { personId: subjectId } });

        const first = await POST(openVisitRequest()) as Response;
        expect(first.status).toBe(201);
        const firstId = (await first.json()).visit.id as number;

        const deleted = await DELETE(deleteRequest(), { params: Promise.resolve({ id: String(firstId) }) } as never);
        expect(deleted.status).toBe(200);

        // Tombstone, not a row removal — and still open (no fabricated departure).
        const tombstoned = await prisma.visit.findUnique({ where: { id: firstId } });
        expect(tombstoned?.deletedAt).toBeInstanceOf(Date);
        expect(tombstoned?.departedAt).toBeNull();

        // The claim: the next check-in creates a NEW open visit rather than
        // hitting the partial unique index (a P2002 surfaces here as a 500).
        const second = await POST(openVisitRequest()) as Response;
        expect(second.status).toBe(201);
        const secondId = (await second.json()).visit.id as number;
        expect(secondId).not.toBe(firstId);

        // Exactly one LIVE open visit; the tombstone is invisible to the guard.
        expect(await prisma.visit.count({
            where: { personId: subjectId, departedAt: null, deletedAt: null },
        })).toBe(1);
    });

    it('a tombstoned open visit leaves the cached kiosk roster', async () => {
        await prisma.visit.deleteMany({ where: { personId: subjectId } });
        // A second keyholder stays present, so the delete doesn't close the
        // facility (whose close path refreshes the cache on its own).
        const other = await prisma.person.create({
            data: {
                email: `other-${EMAIL_TAG}@example.com`,
                name: 'Tombstone Other Keyholder',
                isKeyholder: true,
                householdId,
                visits: { create: { arrivedAt: new Date(Date.now() - 120000) } },
            },
        });

        try {
            const created = await POST(openVisitRequest()) as Response;
            expect(created.status).toBe(201);
            const visitId = (await created.json()).visit.id as number;

            // Warm the cache with the visit on the roster.
            const before = await getFullAttendance({ kiosk: true });
            expect(before.attendance.map(v => v.id)).toContain(visitId);

            const deleted = await DELETE(deleteRequest(), { params: Promise.resolve({ id: String(visitId) }) } as never);
            expect(deleted.status).toBe(200);

            const after = await getFullAttendance({ kiosk: true });
            expect(after.attendance.map(v => v.id)).not.toContain(visitId);
        } finally {
            await prisma.visit.deleteMany({ where: { personId: other.id } });
            await prisma.person.delete({ where: { id: other.id } });
        }
    });
});
