/**
 * @jest-environment node
 */
/**
 * Concurrency regression tests for the visit-write paths that do a
 * read-then-write on Visit: PATCH /api/events/[id] (manualEditAttendance),
 * DELETE /api/facility/visits, and POST /api/my-programs/conflicts/resolve.
 *
 * With nothing serializing them a concurrent writer could invalidate the
 * pre-check before the write landed: two Present marks on different events both
 * saw "no open visit" and both created one (P2002 on
 * Visit_one_open_per_participant → 500), two deletes both saw the row live and
 * both tombstoned it, and two conflict resolutions each saw the other half of
 * the overlap still live and tombstoned both, erasing the session entirely.
 * Each now runs inside a $transaction that takes
 * `pg_advisory_xact_lock(<the visit's personId>)` and re-checks under the lock,
 * matching /api/scan and /api/attendance/manual.
 *
 * (jest.setup.js gives this suite a pool of 2 via TEST_DB_POOL_MAX so the two
 * transactions run on separate connections — the advisory lock is then the only
 * thing serializing them, as in production. Deleting a pg_advisory_xact_lock
 * line from either route makes this suite fail.)
 */
import { PATCH as EVENT_PATCH } from '@/app/api/events/[id]/route';
import { DELETE as VISIT_DELETE } from '@/app/api/facility/visits/route';
import { POST as CONFLICT_RESOLVE } from '@/app/api/my-programs/conflicts/resolve/route';
import prisma from '@/lib/prisma';
import { getServerSession } from 'next-auth/next';
import { Client } from 'pg';

jest.mock('next-auth/next', () => ({
    getServerSession: jest.fn(),
}));

const TAG = 'visit-write-lock-concurrency-test';
const HOUR = 60 * 60 * 1000;

function eventPatch(eventId: number, body: Record<string, unknown>) {
    const req = new Request('http://localhost:4000/api/events/x', {
        method: 'PATCH',
        body: JSON.stringify(body),
    });
    return EVENT_PATCH(req as unknown as import('next/server').NextRequest, {
        params: Promise.resolve({ id: String(eventId) }),
    }) as Promise<Response>;
}

function visitDelete(visitId: number) {
    const req = new Request('http://localhost:4000/api/facility/visits', {
        method: 'DELETE',
        body: JSON.stringify({ visitId }),
    });
    return VISIT_DELETE(req as unknown as import('next/server').NextRequest) as Promise<Response>;
}

/**
 * Block until someone is WAITING on the advisory lock for `key` in this
 * database — pg_locks is cluster-wide, so filter both, or a sibling jest
 * worker's lock answers for ours.
 */
async function waitForBlockedAdvisoryLock(client: Client, key: number) {
    for (let i = 0; i < 200; i++) {
        const { rows } = await client.query(
            `SELECT 1 FROM pg_locks l JOIN pg_database d ON d.oid = l.database
             WHERE l.locktype = 'advisory' AND NOT l.granted
               AND l.objid = $1 AND d.datname = current_database() LIMIT 1`,
            [key],
        );
        if (rows.length) return;
        await new Promise(r => setTimeout(r, 25));
    }
    throw new Error(`no waiter appeared on advisory lock ${key}`);
}

function resolveConflict(visitId: number) {
    const req = new Request('http://localhost:4000/api/my-programs/conflicts/resolve', {
        method: 'POST',
        body: JSON.stringify({ visitId }),
    });
    return CONFLICT_RESOLVE(req as unknown as import('next/server').NextRequest) as Promise<Response>;
}

describe('visit-write advisory locks', () => {
    let adminId: number;
    let subjectId: number;
    let householdIds: number[];

    beforeAll(async () => {
        const leaked = await prisma.person.findMany({
            where: { email: { contains: TAG } },
            select: { id: true, householdId: true },
        });
        const leakedIds = leaked.map(p => p.id);
        await prisma.visit.deleteMany({ where: { personId: { in: leakedIds } } });
        await prisma.auditLog.deleteMany({ where: { actorId: { in: leakedIds } } });
        await prisma.event.deleteMany({ where: { name: { contains: TAG } } });
        await prisma.person.deleteMany({ where: { id: { in: leakedIds } } });
        await prisma.household.deleteMany({ where: { id: { in: leaked.map(p => p.householdId) } } });

        const admin = await prisma.person.create({
            data: { name: 'Lock Admin', email: `admin-${TAG}@example.com`, isSysadmin: true, household: { create: { name: 'Test HH' } } },
        });
        adminId = admin.id;
        const subject = await prisma.person.create({
            data: { name: 'Lock Subject', email: `subject-${TAG}@example.com`, household: { create: { name: 'Test HH' } } },
        });
        subjectId = subject.id;
        householdIds = [admin.householdId, subject.householdId];
    });

    beforeEach(() => {
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: adminId, isSysadmin: true } });
    });

    afterAll(async () => {
        await prisma.visit.deleteMany({ where: { personId: { in: [adminId, subjectId] } } });
        await prisma.auditLog.deleteMany({ where: { actorId: { in: [adminId, subjectId] } } });
        await prisma.event.deleteMany({ where: { name: { contains: TAG } } });
        await prisma.person.deleteMany({ where: { id: { in: [adminId, subjectId] } } });
        await prisma.household.deleteMany({ where: { id: { in: householdIds } } });
    });

    function makeEvent(label: string) {
        const start = new Date(Date.now() - 2 * HOUR);
        return prisma.event.create({
            data: { name: `${TAG} ${label}`, startAt: start, endAt: new Date(start.getTime() + HOUR), description: 'x' },
        });
    }

    it('two concurrent Present marks on different events → one links the open visit, the other is refused', async () => {
        await prisma.visit.deleteMany({ where: { personId: subjectId } });
        const [eventA, eventB] = await Promise.all([makeEvent('race-a'), makeEvent('race-b')]);
        await prisma.visit.create({ data: { personId: subjectId, arrivedAt: new Date(Date.now() - 2 * HOUR), arrivedVia: 'SCANNER' } });

        const markPresent = (eventId: number) => eventPatch(eventId, {
            action: 'manualEditAttendance',
            participantId: subjectId,
            status: 'Present',
            arrivedAt: new Date(Date.now() - 90 * 60 * 1000).toISOString(),
            departedAt: new Date(Date.now() - 60 * 1000).toISOString(),
        });

        const [resA, resB] = await Promise.all([markPresent(eventA.id), markPresent(eventB.id)]);

        expect([resA.status, resB.status].sort()).toEqual([200, 400]);
        expect(await prisma.visit.count({ where: { personId: subjectId, deletedAt: null } })).toBe(1);
        expect(await prisma.visit.count({ where: { personId: subjectId, departedAt: null, deletedAt: null } })).toBe(1);
    });

    it('two concurrent facility deletes of one visit → 200 + 404, tombstoned once', async () => {
        await prisma.visit.deleteMany({ where: { personId: subjectId } });
        const visit = await prisma.visit.create({
            data: {
                personId: subjectId,
                arrivedAt: new Date(Date.now() - 2 * HOUR),
                departedAt: new Date(Date.now() - HOUR),
            },
        });

        const [resA, resB] = await Promise.all([visitDelete(visit.id), visitDelete(visit.id)]);

        expect([resA.status, resB.status].sort()).toEqual([200, 404]);

        // Delete is a tombstone: the row survives, deleted exactly once, and the
        // loser never overwrote deletedById.
        const after = await prisma.visit.findUniqueOrThrow({ where: { id: visit.id } });
        expect(after.deletedAt).not.toBeNull();
        expect(after.deletedById).toBe(adminId);
        expect(await prisma.visit.count({ where: { personId: subjectId, deletedAt: null } })).toBe(0);
    });

    it('two concurrent conflict resolutions on both halves of one overlap → one survives', async () => {
        await prisma.visit.deleteMany({ where: { personId: subjectId } });
        const [visitA, visitB] = await Promise.all([
            prisma.visit.create({
                data: { personId: subjectId, arrivedAt: new Date(Date.now() - 3 * HOUR), departedAt: new Date(Date.now() - HOUR) },
            }),
            prisma.visit.create({
                data: { personId: subjectId, arrivedAt: new Date(Date.now() - 2 * HOUR), departedAt: new Date(Date.now() - HOUR) },
            }),
        ]);

        const [resA, resB] = await Promise.all([resolveConflict(visitA.id), resolveConflict(visitB.id)]);

        // Winner tombstones its half (200); the loser re-checks under the lock,
        // finds its visit no longer overlaps anything live, and refuses (409).
        expect([resA.status, resB.status].sort()).toEqual([200, 409]);

        // The whole point: the participant keeps one visit for the session.
        expect(await prisma.visit.count({ where: { personId: subjectId, deletedAt: null } })).toBe(1);
    });

    it('audits the delete off the in-lock re-read, not the stale pre-lock row', async () => {
        await prisma.visit.deleteMany({ where: { personId: subjectId } });
        await prisma.auditLog.deleteMany({ where: { actorId: adminId } });

        // The visit to resolve is still OPEN (no departure yet), overlapping a
        // closed sibling so the in-lock overlap guard accepts it. Only one open
        // visit per participant is allowed, hence the sibling is the closed one.
        const arrivedAt = new Date(Date.now() - 3 * HOUR);
        const open = await prisma.visit.create({
            data: { personId: subjectId, arrivedAt, departedAt: null, arrivedVia: 'SCANNER' },
        });
        await prisma.visit.create({
            data: { personId: subjectId, arrivedAt: new Date(Date.now() - 2 * HOUR), departedAt: new Date(Date.now() - HOUR) },
        });

        // Hold the participant's advisory lock on connections outside prisma's
        // pool, so the route's pre-lock read lands first and its in-lock re-read
        // is forced to wait behind the departure we land in between.
        const holder = new Client({ connectionString: process.env.DATABASE_URL });
        const watcher = new Client({ connectionString: process.env.DATABASE_URL });
        await holder.connect();
        await watcher.connect();
        let pending: Promise<Response> | undefined;
        try {
            await holder.query('BEGIN');
            await holder.query('SELECT pg_advisory_xact_lock($1)', [subjectId]);

            pending = resolveConflict(open.id);

            // No sleep: an ungranted advisory lock on this key IS the signal
            // that the route is parked, and it only gets there after its
            // pre-lock read.
            await waitForBlockedAdvisoryLock(watcher, subjectId);

            // The departure the lock exists to order against. 3h, SCANNER.
            await prisma.visit.update({
                where: { id: open.id },
                data: { departedAt: new Date(arrivedAt.getTime() + 3 * HOUR), departedVia: 'SCANNER' },
            });
            await holder.query('COMMIT'); // releases the lock; the route proceeds

            expect((await pending).status).toBe(200);
        } finally {
            await holder.query('ROLLBACK').catch(() => { });
            await pending?.catch(() => { });
            await holder.end();
            await watcher.end();
        }

        const audit = await prisma.auditLog.findFirst({
            where: { tableName: 'Visit', affectedEntityId: open.id, action: 'DELETE' },
            orderBy: { id: 'desc' },
        });
        // 180 min x SCANNER weight 3 x proxy 2 (admin != subject) = 1080, and it
        // must agree with the oldData snapshot beside it. Scoring the pre-lock
        // row instead sees departedAt: null -> duration 0 -> score 0, an audit
        // row claiming nothing was lost while its own oldData shows a 3h visit.
        expect((audit?.oldData as { departedAt: string | null })?.departedAt).not.toBeNull();
        expect((audit?.newData as { significance?: { score: number; flagged: boolean } })?.significance)
            .toEqual({ score: 1080, flagged: true });
    });
});
