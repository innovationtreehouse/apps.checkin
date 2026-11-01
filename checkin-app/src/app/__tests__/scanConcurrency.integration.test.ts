/**
 * @jest-environment node
 */
/**
 * Concurrency tests for POST /api/scan.
 *
 * Steps 4–6 of the scan route (debounce read → record badge event → find open
 * visit → check-in/out) are a read-modify-write on a participant's visit state.
 * Without the per-participant advisory lock, two near-simultaneous scans for the
 * same participant can both pass the debounce read and both observe the same
 * visit state before either writes, producing:
 *   - two open visits for one participant (double check-in), or
 *   - a double check-out that 500s on Prisma P2025 when the second deletes the
 *     visit the first already removed.
 *
 * The route wraps steps 4–6 in a single $transaction that takes
 * `pg_advisory_xact_lock(participantId)` first, so same-participant scans
 * serialize. These tests fire two concurrent POSTs with Promise.all and assert
 * the committed state and the response pair.
 *
 * (Note: jest.setup.js gives this suite a connection pool of 2 — via
 * TEST_DB_POOL_MAX — instead of the default 1. With a pool of 1 the
 * $transaction wrapping serializes the two scans on its own and the assertions
 * pass even without the lock; with a pool of 2 the two transactions run on
 * separate connections, so the per-participant advisory lock is the *only*
 * thing that serializes them, exactly as in production (pool 10). Deleting the
 * `pg_advisory_xact_lock` line in route.ts makes this suite fail.)
 */
import { POST } from '@/app/api/scan/route';
import prisma from '@/lib/prisma';
import { authenticateRequest } from '@/lib/auth';

jest.mock('@/lib/auth', () => ({
    authenticateRequest: jest.fn(),
}));

// Keep notifications/post-event side effects out of the DB-facing assertions.
jest.mock('@/lib/notifications', () => ({
    sendCheckinNotifications: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/lib/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    logBackendError: jest.fn(),
}));

const EMAIL_TAG = 'scan-concurrency-test';

function scanRequest(participantId: number) {
    return new Request('http://localhost:4000/api/scan', {
        method: 'POST',
        body: JSON.stringify({ participantId }),
    }) as unknown as import('next/server').NextRequest;
}

async function openVisitCount(participantId: number) {
    return prisma.visit.count({ where: { personId: participantId, departedAt: null } });
}

describe('POST /api/scan concurrency (advisory lock)', () => {
    let keeperId: number;       // isKeyholder kept checked in so the facility stays open
    let checkinSubjectId: number;
    let checkoutSubjectId: number;

    beforeAll(async () => {
        // Kiosk auth for every scan in this suite.
        (authenticateRequest as jest.Mock).mockResolvedValue({ type: 'kiosk' });

        // Clean any leaked state from a prior run.
        const leaked = await prisma.person.findMany({
            where: { email: { contains: EMAIL_TAG } },
            select: { id: true, householdId: true },
        });
        const leakedIds = leaked.map(p => p.id);
        const leakedHouseholdIds = leaked.map(p => p.householdId);
        await prisma.visit.deleteMany({ where: { personId: { in: leakedIds } } });
        await prisma.rawBadgeLog.deleteMany({ where: { personId: { in: leakedIds } } });
        await prisma.person.deleteMany({ where: { id: { in: leakedIds } } });
        await prisma.household.deleteMany({ where: { id: { in: leakedHouseholdIds } } });

        const keeper = await prisma.person.create({
            data: { email: `keeper-${EMAIL_TAG}@example.com`, name: 'Keeper', isKeyholder: true, household: { create: { name: "Test HH" } } },
        });
        keeperId = keeper.id;
        // Keep the isKeyholder checked in so non-isKeyholder check-ins are allowed
        // and non-isKeyholder check-outs skip the last-isKeyholder force-close path.
        await prisma.visit.create({ data: { personId: keeperId, arrivedAt: new Date() } });

        const checkinSubject = await prisma.person.create({
            data: { email: `checkin-${EMAIL_TAG}@example.com`, name: 'Checkin Subject', household: { create: { name: "Test HH" } } },
        });
        checkinSubjectId = checkinSubject.id;

        const checkoutSubject = await prisma.person.create({
            data: { email: `checkout-${EMAIL_TAG}@example.com`, name: 'Checkout Subject', household: { create: { name: "Test HH" } } },
        });
        checkoutSubjectId = checkoutSubject.id;
    });

    afterAll(async () => {
        const ids = [keeperId, checkinSubjectId, checkoutSubjectId].filter(id => id !== undefined);
        const households = (await prisma.person.findMany({
            where: { id: { in: ids } },
            select: { householdId: true },
        })).map(p => p.householdId);
        await prisma.visit.deleteMany({ where: { personId: { in: ids } } });
        await prisma.rawBadgeLog.deleteMany({ where: { personId: { in: ids } } });
        await prisma.person.deleteMany({ where: { id: { in: ids } } });
        await prisma.household.deleteMany({ where: { id: { in: households } } });
    });

    it('two concurrent check-in scans → exactly one open visit, one checkin + one debounce', async () => {
        // Fresh state: no open visit, no recent badge event (so neither scan is
        // pre-debounced before the race even begins).
        await prisma.visit.deleteMany({ where: { personId: checkinSubjectId } });
        await prisma.rawBadgeLog.deleteMany({ where: { personId: checkinSubjectId } });
        expect(await openVisitCount(checkinSubjectId)).toBe(0);

        const [resA, resB] = await Promise.all([
            POST(scanRequest(checkinSubjectId)) as Promise<Response>,
            POST(scanRequest(checkinSubjectId)) as Promise<Response>,
        ]);

        // Neither request errors.
        expect(resA.status).toBe(200);
        expect(resB.status).toBe(200);

        const bodies = await Promise.all([resA.json(), resB.json()]);
        const types = bodies.map(b => b.type).sort();
        expect(types).toEqual(['checkin', 'ignored_debounce']);

        // The core invariant: the race did not open two visits.
        expect(await openVisitCount(checkinSubjectId)).toBe(1);
    });

    it('two concurrent check-out scans → exactly one successful checkout, no 500, zero open visits', async () => {
        // Fresh state: exactly one open visit, no recent badge event.
        await prisma.visit.deleteMany({ where: { personId: checkoutSubjectId } });
        await prisma.rawBadgeLog.deleteMany({ where: { personId: checkoutSubjectId } });
        await prisma.visit.create({ data: { personId: checkoutSubjectId, arrivedAt: new Date() } });
        expect(await openVisitCount(checkoutSubjectId)).toBe(1);

        const [resA, resB] = await Promise.all([
            POST(scanRequest(checkoutSubjectId)) as Promise<Response>,
            POST(scanRequest(checkoutSubjectId)) as Promise<Response>,
        ]);

        // No spurious 500 from a double-delete (Prisma P2025).
        expect(resA.status).toBe(200);
        expect(resB.status).toBe(200);

        const bodies = await Promise.all([resA.json(), resB.json()]);
        const types = bodies.map(b => b.type).sort();
        expect(types).toEqual(['checkout', 'ignored_debounce']);

        // The visit was closed exactly once.
        expect(await openVisitCount(checkoutSubjectId)).toBe(0);
    });
});
