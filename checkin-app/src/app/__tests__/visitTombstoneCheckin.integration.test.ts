/**
 * @jest-environment node
 */
/**
 * The tombstone migration's core claim, against a real Postgres.
 *
 * `Visit_one_open_per_participant` is a partial unique index. It is predicated
 * on `deletedAt IS NULL` so a tombstoned open visit does not count as "open":
 * without that predicate its person could never check in again — every later
 * arrival hits P2002 on an index row nothing will clear.
 * Mocking cannot show this; the index is a database object.
 */
import { DELETE } from '@/app/api/attendance/manual/[id]/route';
import prisma from '@/lib/prisma';
import { getServerSession } from 'next-auth/next';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));

const EMAIL_TAG = 'visit-tombstone-checkin-test';

describe('a tombstoned open visit', () => {
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
        await prisma.person.delete({ where: { id: subjectId } });
        await prisma.household.delete({ where: { id: householdId } });
    });

    it('frees the one-open-visit slot', async () => {
        await prisma.visit.deleteMany({ where: { personId: subjectId } });
        await prisma.visit.create({ data: { personId: subjectId, arrivedAt: new Date(Date.now() - 60000), deletedAt: new Date() } });

        // The claim: a NEW open visit rather than a P2002 on the partial unique index.
        await prisma.visit.create({ data: { personId: subjectId, arrivedAt: new Date() } });

        expect(await prisma.visit.count({
            where: { personId: subjectId, departedAt: null, deletedAt: null },
        })).toBe(1);
    });

    it('is not how a member ends a live one: removing it is refused', async () => {
        await prisma.visit.deleteMany({ where: { personId: subjectId } });
        const open = await prisma.visit.create({ data: { personId: subjectId, arrivedAt: new Date(Date.now() - 60000) } });

        const res = await DELETE(new Request(`http://localhost:4000/api/attendance/manual/${open.id}`, {
            method: 'DELETE',
        }) as unknown as import('next/server').NextRequest, { params: Promise.resolve({ id: String(open.id) }) } as never);

        expect(res.status).toBe(409);
        expect((await prisma.visit.findUniqueOrThrow({ where: { id: open.id } })).deletedAt).toBeNull();
    });
});
