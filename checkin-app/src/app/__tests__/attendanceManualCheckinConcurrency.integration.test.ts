/**
 * @jest-environment node
 */
/**
 * Concurrency test for POST /api/attendance (type: MANUAL_CHECKIN).
 *
 * The dashboard/household MANUAL_CHECKIN path reads "already checked in?" then
 * creates a visit. Unserialized, two concurrent MANUAL_CHECKINs for one participant
 * — or one racing /api/scan or /api/attendance/manual — both pass the guard and both
 * create an open visit. A later checkout closes only one; the other lingers open
 * forever, inflating the open-visit count and corrupting two-deep math.
 *
 * The route wraps the re-check + create in a $transaction that takes
 * `pg_advisory_xact_lock(participantId)` first. One request wins (200, creates the
 * visit); the loser re-checks under the lock, sees the open visit, and returns the
 * existing "already checked in" 400. Either way exactly one open visit survives.
 *
 * (jest.setup.js gives this suite a pool of 2 via TEST_DB_POOL_MAX so the two
 * transactions run on separate connections — the advisory lock is then the *only*
 * thing serializing them, as in production. Deleting the pg_advisory_xact_lock line
 * in route.ts, or the partial unique index, makes this suite fail.)
 */
import { POST } from '@/app/api/attendance/route';
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

const EMAIL_TAG = 'manual-checkin-concurrency-test';

function checkinRequest(participantId: number) {
    return new Request('http://localhost:4000/api/attendance', {
        method: 'POST',
        body: JSON.stringify({ type: 'MANUAL_CHECKIN', participantId }),
    }) as unknown as import('next/server').NextRequest;
}

async function openVisitCount(participantId: number) {
    return prisma.visit.count({ where: { personId: participantId, departedAt: null } });
}

describe('POST /api/attendance MANUAL_CHECKIN concurrency (advisory lock)', () => {
    let subjectId: number;
    let householdId: number;
    let anchorId: number;
    let anchorHouseholdId: number;

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
            data: { email: `subject-${EMAIL_TAG}@example.com`, name: 'Manual Checkin Concurrency Subject', household: { create: { name: "Test HH" } } },
        });
        subjectId = subject.id;
        householdId = subject.householdId;

        // A keyholder inside, so the facility-open guard passes: this suite
        // exercises the advisory lock, not the keyholder-first rule (covered
        // separately below).
        const anchor = await prisma.person.create({
            data: { email: `anchor-${EMAIL_TAG}@example.com`, name: 'Manual Checkin Concurrency Keyholder', isKeyholder: true, household: { create: { name: "Test HH" } } },
        });
        anchorId = anchor.id;
        anchorHouseholdId = anchor.householdId;
        await prisma.visit.create({ data: { personId: anchorId, arrivedAt: new Date(), arrivedVia: 'WEB' } });
    });

    afterAll(async () => {
        await prisma.visit.deleteMany({ where: { personId: { in: [subjectId, anchorId] } } });
        await prisma.auditLog.deleteMany({ where: { actorId: subjectId } });
        await prisma.person.deleteMany({ where: { id: { in: [subjectId, anchorId] } } });
        await prisma.household.deleteMany({ where: { id: { in: [householdId, anchorHouseholdId] } } });
    });

    it('two concurrent MANUAL_CHECKINs → exactly one open visit, no 500', async () => {
        // Fresh state: no open visit before the race.
        await prisma.visit.deleteMany({ where: { personId: subjectId } });
        expect(await openVisitCount(subjectId)).toBe(0);

        // Subject checks themselves in (isSelf → passes the permission guard).
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: subjectId } });

        const [resA, resB] = await Promise.all([
            POST(checkinRequest(subjectId)) as Promise<Response>,
            POST(checkinRequest(subjectId)) as Promise<Response>,
        ]);

        const statuses = [resA.status, resB.status].sort();
        // One winner creates the visit (200); the loser re-checks under the lock,
        // sees the open visit, and cleanly returns "already checked in" (400).
        // Neither path 500s.
        expect(statuses).toEqual([200, 400]);

        // The core invariant: the race did not open two visits.
        expect(await openVisitCount(subjectId)).toBe(1);
    });
});

const GUARD_TAG = 'manual-checkin-keyholder-guard-test';

// /attendance/current (MANUAL_CHECKIN) must not let a non-keyholder be the first into
// an empty building: it enforces the same facility-open guard as / (/api/scan →
// processCheckin).
describe('POST /api/attendance MANUAL_CHECKIN keyholder-first guard', () => {
    let nonKeyholderId: number;
    let keyholderId: number;
    let householdIds: number[];

    beforeAll(async () => {
        const leaked = await prisma.person.findMany({
            where: { email: { contains: GUARD_TAG } },
            select: { id: true, householdId: true },
        });
        const leakedIds = leaked.map(p => p.id);
        await prisma.visit.deleteMany({ where: { personId: { in: leakedIds } } });
        await prisma.person.deleteMany({ where: { id: { in: leakedIds } } });
        await prisma.household.deleteMany({ where: { id: { in: leaked.map(p => p.householdId) } } });

        const nk = await prisma.person.create({
            data: { email: `nk-${GUARD_TAG}@example.com`, name: 'Guard NonKeyholder', household: { create: { name: "Test HH" } } },
        });
        nonKeyholderId = nk.id;
        const kh = await prisma.person.create({
            data: { email: `kh-${GUARD_TAG}@example.com`, name: 'Guard Keyholder', isKeyholder: true, household: { create: { name: "Test HH" } } },
        });
        keyholderId = kh.id;
        householdIds = [nk.householdId, kh.householdId];
    });

    afterAll(async () => {
        await prisma.visit.deleteMany({ where: { personId: { in: [nonKeyholderId, keyholderId] } } });
        await prisma.person.deleteMany({ where: { id: { in: [nonKeyholderId, keyholderId] } } });
        await prisma.household.deleteMany({ where: { id: { in: householdIds } } });
    });

    it('non-keyholder into an empty building → 403, no visit', async () => {
        await prisma.visit.deleteMany({ where: { personId: { in: [nonKeyholderId, keyholderId] } } });
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: nonKeyholderId } });

        const res = await (POST(checkinRequest(nonKeyholderId)) as Promise<Response>);
        expect(res.status).toBe(403);
        expect(await openVisitCount(nonKeyholderId)).toBe(0);
    });

    it('a keyholder into an empty building → 403, no visit: only a badge at the door opens it', async () => {
        await prisma.visit.deleteMany({ where: { personId: { in: [nonKeyholderId, keyholderId] } } });
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: keyholderId, isKeyholder: true } });

        const res = await (POST(checkinRequest(keyholderId)) as Promise<Response>);
        expect(res.status).toBe(403);
        expect(await openVisitCount(keyholderId)).toBe(0);
    });

    it('non-keyholder with a keyholder present → 200', async () => {
        await prisma.visit.deleteMany({ where: { personId: { in: [nonKeyholderId, keyholderId] } } });
        await prisma.visit.create({ data: { personId: keyholderId, arrivedAt: new Date(), arrivedVia: 'WEB' } });
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: nonKeyholderId } });

        const res = await (POST(checkinRequest(nonKeyholderId)) as Promise<Response>);
        expect(res.status).toBe(200);
        expect(await openVisitCount(nonKeyholderId)).toBe(1);
    });
});
