/**
 * @jest-environment node
 */
/**
 * Cross-participant race: last-keyholder force-close vs a concurrent
 * non-keyholder check-in (#254).
 *
 * The person-level advisory lock does not serialize these two transactions;
 * the facility lock does. The check-in lands wholly before the sweep (and is
 * swept) or wholly after it (an open no-keyholder visit) — never a 403 or a
 * park at the kiosk, and the sweep never leaves the people it saw inside.
 *
 * A recorded close takes the person locks only of people it may depart, so an
 * unrelated person's in-flight transaction does not hold it up.
 *
 * jest.setup.js sets TEST_DB_POOL_MAX=2 so the two transactions run on separate
 * connections, matching production.
 */
import { POST } from '@/app/api/scan/route';
import { DELETE as dashboardDELETE } from '@/app/api/attendance/route';
import prisma from '@/lib/prisma';
import { authenticateRequest } from '@/lib/auth';
import { getServerSession } from 'next-auth/next';
import { executePendingCloses } from '@/lib/scan-service';
import { lockFacility } from '@/lib/facilityLock';

jest.mock('@/lib/auth', () => ({
    ...jest.requireActual('@/lib/auth'),
    authenticateRequest: jest.fn(),
}));
jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));

jest.mock('@/lib/notifications', () => ({
    sendCheckinNotifications: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/lib/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    logBackendError: jest.fn(),
}));

const TAG = 'facility-close-lock-254';

function scanReq(participantId: number, extra: Record<string, unknown> = {}) {
    return new Request('http://localhost:4000/api/scan', {
        method: 'POST',
        body: JSON.stringify({ participantId, ...extra }),
    }) as unknown as import('next/server').NextRequest;
}

describe('POST /api/scan facility-close lock (#254)', () => {
    let keyholderId: number;
    let otherId: number;
    let racerId: number;
    let householdIds: number[] = [];

    beforeAll(async () => {
        (authenticateRequest as jest.Mock).mockResolvedValue({ type: 'kiosk' });

        const kh = await prisma.person.create({
            data: { name: 'KH', email: `kh-${TAG}@example.com`, isKeyholder: true, household: { create: { name: 'HH' } } },
        });
        const other = await prisma.person.create({
            data: { name: 'Other', email: `other-${TAG}@example.com`, household: { create: { name: 'HH' } } },
        });
        const racer = await prisma.person.create({
            data: { name: 'Racer', email: `racer-${TAG}@example.com`, household: { create: { name: 'HH' } } },
        });
        keyholderId = kh.id;
        otherId = other.id;
        racerId = racer.id;
        householdIds = [kh.householdId, other.householdId, racer.householdId];
    });

    afterEach(async () => {
        const ids = [keyholderId, otherId, racerId];
        await prisma.visit.deleteMany({ where: { personId: { in: ids } } });
        await prisma.rawBadgeLog.deleteMany({ where: { personId: { in: ids } } });
    });

    afterAll(async () => {
        const ids = [keyholderId, otherId, racerId];
        await prisma.visit.deleteMany({ where: { personId: { in: ids } } });
        await prisma.rawBadgeLog.deleteMany({ where: { personId: { in: ids } } });
        await prisma.person.deleteMany({ where: { id: { in: ids } } });
        await prisma.household.deleteMany({ where: { id: { in: householdIds } } });
    });

    it('concurrent keyholder close and non-keyholder check-in: sweep is complete, racer checks in', async () => {
        await prisma.visit.create({ data: { personId: keyholderId, arrivedAt: new Date() } });
        await prisma.visit.create({ data: { personId: otherId, arrivedAt: new Date() } });

        const [closeRes, checkinRes] = await Promise.all([
            POST(scanReq(keyholderId, { intent: 'OUT', close: 'confirmed' })),
            POST(scanReq(racerId)),
        ]);

        expect(closeRes.status).toBe(200);
        expect(checkinRes.status).toBe(200);

        const open = await prisma.visit.count({
            where: { personId: { in: [keyholderId, otherId] }, departedAt: null, deletedAt: null },
        });
        expect(open).toBe(0);

        expect((await checkinRes.json()).type).toBe('checkin');
        expect(await prisma.visit.count({ where: { personId: racerId } })).toBe(1);
    });

    it('a dashboard close that loses the race to the kiosk departs nothing and records no close', async () => {
        const kh = await prisma.person.findUniqueOrThrow({ where: { id: keyholderId } });
        const user = { id: kh.id, email: kh.email, name: kh.name, isKeyholder: true, isBoardMember: false, isSysadmin: false, householdId: kh.householdId };
        (authenticateRequest as jest.Mock).mockResolvedValue({ type: 'session', user });
        (getServerSession as jest.Mock).mockResolvedValue({ user });
        // The guard is facility-wide: start from an empty building.
        await prisma.visit.updateMany({ where: { departedAt: null }, data: { departedAt: new Date(0) } });
        const kv = await prisma.visit.create({ data: { personId: keyholderId, arrivedAt: new Date(Date.now() - 3_600_000) } });
        await prisma.visit.create({ data: { personId: otherId, arrivedAt: new Date(Date.now() - 3_600_000) } });
        const del = (body: Record<string, unknown>) => dashboardDELETE(new Request('http://localhost:4000/api/attendance', {
            method: 'DELETE', body: JSON.stringify({ visitId: kv.id, ...body }),
        }) as unknown as import('next/server').NextRequest);
        const { forceCloseToken } = await (await del({})).json();
        const closesBefore = await prisma.facilityClose.count();

        // The kiosk's checkout holds the keyholder's person lock; the dashboard
        // close starts while it does, and the kiosk departs the visit first.
        let dashboard!: Promise<Response>;
        await prisma.$transaction(async (tx) => {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(${keyholderId})`;
            dashboard = del({ forceCloseToken, closeChoice: 'close' });
            for (let i = 0; i < 100; i++) {
                const [{ waiting }] = await tx.$queryRaw<{ waiting: number }[]>`
                    SELECT count(*)::int AS waiting FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`;
                if (waiting > 0) break;
                await new Promise(r => setTimeout(r, 20));
            }
            await tx.visit.update({ where: { id: kv.id }, data: { departedAt: new Date(), departedVia: 'SCANNER' } });
        }, { timeout: 10_000 });
        await dashboard;

        expect((await prisma.visit.findUniqueOrThrow({ where: { id: kv.id } })).departedVia).toBe('SCANNER');
        expect(await prisma.facilityClose.count()).toBe(closesBefore);
        expect(await prisma.visit.count({ where: { personId: otherId, departedAt: null } })).toBe(1);
    });

    it('a close does not wait on the person lock of someone whose machine-ended visit ended before it', async () => {
        const HOUR = 3_600_000;
        const at = (msAgo: number) => new Date(Date.now() - msAgo);
        await prisma.visit.create({ data: { personId: racerId, arrivedAt: at(30 * HOUR), departedAt: at(28 * HOUR), departedVia: 'AUTO_CLOSE' } });
        const inside = await prisma.visit.create({ data: { personId: otherId, arrivedAt: at(2 * HOUR) } });
        const close = await prisma.facilityClose.create({ data: { closedAt: at(HOUR), closedById: keyholderId, via: 'KIOSK', executedAt: null } });
        // The racer's person lock is held by an unrelated in-flight transaction for the whole close.
        let release!: () => void;
        let held!: () => void;
        const lockHeld = new Promise<void>(r => { held = r; });
        const holder = prisma.$transaction(async (tx) => {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(${racerId})`;
            held();
            await new Promise<void>(r => { release = r; });
        }, { timeout: 30_000 });
        await lockHeld;

        try {
            await executePendingCloses();
            expect((await prisma.facilityClose.findUniqueOrThrow({ where: { id: close.id } })).executedAt).not.toBeNull();
            expect((await prisma.visit.findUniqueOrThrow({ where: { id: inside.id } })).departedVia).toBe('FACILITY_CLOSE');
        } finally {
            release();
            await holder;
            await prisma.visit.updateMany({ where: { facilityCloseId: close.id }, data: { facilityCloseId: null } });
            await prisma.auditLog.deleteMany({ where: { tableName: 'FacilityClose', affectedEntityId: close.id } });
            await prisma.facilityClose.delete({ where: { id: close.id } });
        }
    });

    it('a replayed IN waiting on the facility lock is fenced by a close committed meanwhile', async () => {
        (authenticateRequest as jest.Mock).mockResolvedValue({ type: 'kiosk' });
        const inAt = new Date(Date.now() - 5 * 60_000);
        const cid = `${TAG}-race-in`;
        let closeId = 0;
        // A close's executor holds the facility lock while the replay reaches it.
        let replayed!: Promise<Response>;
        await prisma.$transaction(async (tx) => {
            await lockFacility(tx);
            replayed = POST(scanReq(racerId, { clientEventId: cid, scannedAt: inAt.toISOString(), replay: true, intent: 'IN', protocolVersion: 7 }));
            for (let i = 0; i < 100; i++) {
                const [{ waiting }] = await tx.$queryRaw<{ waiting: number }[]>`
                    SELECT count(*)::int AS waiting FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`;
                if (waiting > 0) break;
                await new Promise(r => setTimeout(r, 20));
            }
            closeId = (await tx.facilityClose.create({
                data: { closedAt: new Date(Date.now() - 60_000), closedById: keyholderId, via: 'KIOSK', executedAt: new Date() },
            })).id;
        }, { timeout: 10_000 });

        try {
            expect(await (await replayed).json()).toMatchObject({ type: 'checkin' });
            const v = await prisma.visit.findFirstOrThrow({ where: { personId: racerId } });
            expect(v.departedVia).toBe('FACILITY_CLOSE');
            expect((await prisma.rawBadgeLog.findUniqueOrThrow({ where: { clientEventId: cid } })).reviewReason).toBe('closed_before_delivery');
        } finally {
            await prisma.visit.deleteMany({ where: { facilityCloseId: closeId } });
            await prisma.presenceEvent.deleteMany({ where: { clientEventId: cid } });
            await prisma.facilityClose.delete({ where: { id: closeId } });
        }
    });
});
