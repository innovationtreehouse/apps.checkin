/**
 * @jest-environment node
 */
/**
 * Concurrency regression test for POST /api/attendance/manual.
 *
 * Creating an open visit (arrivedAt, no departure) is a read-modify-write on a
 * participant's visit state, same as /api/scan. Before the per-participant
 * advisory lock (route.ts ~line 40), two near-simultaneous manual check-ins for
 * one participant could both pass the open-visit re-check and both create a
 * visit, leaving two open visits — checkout closes only one, the other lingers
 * and corrupts attendance/isKeyholder counts.
 *
 * The fix wraps the open-visit check + create in a $transaction that takes
 * `pg_advisory_xact_lock(participantId)` first, then returns the existing open
 * visit if one is found (loser no-ops, status 201, same visit id). This test
 * fires two concurrent create-open-visit POSTs and asserts exactly one open
 * visit survives and both responses reference the same visit.
 *
 * (Note: jest.setup.js gives this suite a connection pool of 2 — via
 * TEST_DB_POOL_MAX — instead of the default 1. With a pool of 1 the
 * $transaction wrapping serializes the two requests on its own and the
 * assertions pass even without the lock; with a pool of 2 the two transactions
 * run on separate connections, so the advisory lock is the *only* thing that
 * serializes them, exactly as in production. Deleting the
 * `pg_advisory_xact_lock` line in route.ts makes this suite fail.)
 */
import { POST } from '@/app/api/attendance/manual/route';
import prisma from '@/lib/prisma';
import { getServerSession } from 'next-auth/next';

jest.mock('next-auth/next', () => ({
    getServerSession: jest.fn(),
}));
// The route fires check-in notifications without awaiting; stub them so no
// query outlives the suite's teardown.
jest.mock('@/lib/notifications', () => ({
    ...jest.requireActual('@/lib/notifications'),
    sendCheckinNotifications: jest.fn().mockResolvedValue(undefined),
}));

const EMAIL_TAG = 'manual-attendance-concurrency-test';

function manualRequest(arrivedAt: string) {
    return new Request('http://localhost:4000/api/attendance/manual', {
        method: 'POST',
        body: JSON.stringify({ arrivedAt }),
    }) as unknown as import('next/server').NextRequest;
}

async function openVisitCount(participantId: number) {
    return prisma.visit.count({ where: { personId: participantId, departedAt: null } });
}

describe('POST /api/attendance/manual concurrency (advisory lock)', () => {
    let subjectId: number;
    let householdId: number;

    beforeAll(async () => {
        // Clean any leaked state from a prior run.
        const leaked = await prisma.person.findMany({
            where: { email: { contains: EMAIL_TAG } },
            select: { id: true, householdId: true },
        });
        const leakedIds = leaked.map(p => p.id);
        const leakedHouseholdIds = leaked.map(p => p.householdId);
        await prisma.visit.deleteMany({ where: { personId: { in: leakedIds } } });
        await prisma.auditLog.deleteMany({ where: { actorId: { in: leakedIds } } });
        await prisma.person.deleteMany({ where: { id: { in: leakedIds } } });
        await prisma.household.deleteMany({ where: { id: { in: leakedHouseholdIds } } });

        const subject = await prisma.person.create({
            data: { email: `subject-${EMAIL_TAG}@example.com`, name: 'Manual Concurrency Subject', household: { create: { name: "Test HH" } } },
        });
        subjectId = subject.id;
        householdId = subject.householdId;
    });

    afterAll(async () => {
        await prisma.visit.deleteMany({ where: { personId: subjectId } });
        await prisma.auditLog.deleteMany({ where: { actorId: subjectId } });
        await prisma.person.deleteMany({ where: { id: subjectId } });
        await prisma.household.deleteMany({ where: { id: householdId } });
    });

    it('two concurrent manual check-ins → exactly one open visit, both responses share it', async () => {
        // Fresh state: no open visit before the race.
        await prisma.visit.deleteMany({ where: { personId: subjectId } });
        expect(await openVisitCount(subjectId)).toBe(0);

        // Keyholder: an open backfill must clear the facility-open guard; this
        // suite exercises the advisory lock, not the keyholder-first rule.
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: subjectId, isKeyholder: true } });

        const arrivedAt = new Date(Date.now() - 1800000).toISOString(); // 30 min ago

        const [resA, resB] = await Promise.all([
            POST(manualRequest(arrivedAt)) as Promise<Response>,
            POST(manualRequest(arrivedAt)) as Promise<Response>,
        ]);

        // Neither request errors (loser no-ops by returning the existing visit).
        expect(resA.status).toBe(201);
        expect(resB.status).toBe(201);

        const [bodyA, bodyB] = await Promise.all([resA.json(), resB.json()]);
        expect(bodyA.visit).toBeDefined();
        expect(bodyB.visit).toBeDefined();
        // Both responses reference the same open visit — the loser returned the
        // winner's row instead of creating a second one.
        expect(bodyA.visit.id).toBe(bodyB.visit.id);

        // The core invariant: the race did not open two visits.
        expect(await openVisitCount(subjectId)).toBe(1);
    });
});
