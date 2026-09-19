/**
 * @jest-environment node
 */
/**
 * Kiosk replay idempotency against the real DB (docs/rules/attendance-checkin.md,
 * kiosk resilience): a queued scan carries clientEventId + scannedAt + `replay:
 * true`, and
 * replay must dedup, toggle with the original scan time, and park instead of
 * toggling when stale or out-of-order. The live attempt carries the same
 * clientEventId (D4 try-first) but no flag, so none of those guards apply to it.
 */
import { POST } from '@/app/api/scan/route';
import prisma from '@/lib/prisma';
import { authenticateRequest } from '@/lib/auth';
import type { Person } from '@/generated/prisma/client';

jest.mock('@/lib/auth', () => ({ authenticateRequest: jest.fn() }));
jest.mock('@/lib/notifications', () => ({
    sendCheckinNotifications: jest.fn().mockResolvedValue(undefined),
    sendNotification: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('@/lib/logger', () => ({
    logBackendError: jest.fn(),
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const TAG = 'scan-replay-test';

function scanReq(body: Record<string, unknown>) {
    return new Request('http://localhost/api/scan', {
        method: 'POST',
        body: JSON.stringify(body),
    }) as unknown as import('next/server').NextRequest;
}

describe('Scan replay — clientEventId dedup and freshness window (real DB)', () => {
    let keyholder: Person;
    let member: Person;
    const householdIds: number[] = [];

    beforeAll(async () => {
        (authenticateRequest as jest.Mock).mockResolvedValue({ type: 'kiosk' });
        keyholder = await prisma.person.create({
            data: { name: 'Replay Key', email: `key-${TAG}@example.com`, isKeyholder: true, household: { create: { name: 'Test HH' } } },
        });
        householdIds.push(keyholder.householdId);
        member = await prisma.person.create({
            data: { name: 'Replay Member', email: `member-${TAG}@example.com`, household: { create: { name: 'Test HH' } } },
        });
        householdIds.push(member.householdId);

        // Keep the facility open for the whole suite: member check-ins require an
        // active keyholder, and this is testing replay, not facility-open gating.
        await prisma.visit.create({ data: { personId: keyholder.id, arrivedAt: new Date(0), arrivedVia: 'SCANNER' } });
    });

    afterEach(async () => {
        await prisma.visit.deleteMany({ where: { personId: member.id } });
        await prisma.rawBadgeLog.deleteMany({ where: { personId: member.id } });
    });

    afterAll(async () => {
        await prisma.visit.deleteMany({ where: { personId: { in: [keyholder.id, member.id] } } });
        await prisma.rawBadgeLog.deleteMany({ where: { personId: { in: [keyholder.id, member.id] } } });
        await prisma.person.deleteMany({ where: { id: { in: [keyholder.id, member.id] } } });
        await prisma.household.deleteMany({ where: { id: { in: householdIds } } });
    });

    it('redelivering the same clientEventId dedups instead of toggling a second time', async () => {
        // The real sequence: a live attempt whose ack was lost, then the drain's
        // redelivery of the same event.
        const scannedAt = new Date().toISOString();
        const first = await POST(scanReq({ participantId: member.id, clientEventId: 'evt-dedup', scannedAt }));
        expect((await first.json()).type).toBe('checkin');

        const retry = await POST(scanReq({ participantId: member.id, clientEventId: 'evt-dedup', scannedAt, replay: true }));
        expect(retry.status).toBe(200);
        expect((await retry.json()).type).toBe('duplicate_ignored');

        const visits = await prisma.visit.findMany({ where: { personId: member.id } });
        expect(visits).toHaveLength(1);
    });

    it('a fresh replay toggles using scannedAt as the recorded arrival time', async () => {
        const scannedAt = new Date(Date.now() - 60_000); // 1 min ago, within W
        const res = await POST(scanReq({ participantId: member.id, clientEventId: 'evt-fresh', scannedAt: scannedAt.toISOString(), replay: true }));
        expect((await res.json()).type).toBe('checkin');

        const visit = await prisma.visit.findFirst({ where: { personId: member.id } });
        expect(visit?.arrivedAt.getTime()).toBe(scannedAt.getTime());
    });

    it('a LIVE scan is never parked by the freshness window and arrives at server-now', async () => {
        const scannedAt = new Date(Date.now() - 20 * 60_000); // stale, but no replay flag
        const res = await POST(scanReq({ participantId: member.id, clientEventId: 'evt-live-stale', scannedAt: scannedAt.toISOString() }));
        expect((await res.json()).type).toBe('checkin');

        const visit = await prisma.visit.findFirst({ where: { personId: member.id } });
        expect(visit?.arrivedAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
    });

    it('a replay older than the freshness window parks instead of toggling', async () => {
        const scannedAt = new Date(Date.now() - 20 * 60_000); // 20 min ago > 10 min W
        const res = await POST(scanReq({ participantId: member.id, clientEventId: 'evt-stale', scannedAt: scannedAt.toISOString(), replay: true }));
        expect(res.status).toBe(200);
        expect((await res.json()).type).toBe('parked');

        expect(await prisma.visit.findFirst({ where: { personId: member.id } })).toBeNull();
        const log = await prisma.rawBadgeLog.findUnique({ where: { clientEventId: 'evt-stale' } });
        expect(log?.reviewReason).toBe('stale_replay');
    });

    it('a fresh replay whose scannedAt is older than a later departure parks (out-of-order guard)', async () => {
        // Live check-in/check-out first, well past the 3s debounce -- each
        // RawBadgeLog row is backdated after being written since the debounce
        // pre-read runs against real "now", not scannedAt (§2 D3). This
        // isolates the out-of-order guard without tripping the debounce.
        await POST(scanReq({ participantId: member.id }));
        await prisma.rawBadgeLog.updateMany({ where: { personId: member.id }, data: { timestamp: new Date(Date.now() - 5000) } });
        await POST(scanReq({ participantId: member.id }));
        await prisma.rawBadgeLog.updateMany({ where: { personId: member.id }, data: { timestamp: new Date(Date.now() - 5000) } });

        // A queued check-in from BEFORE that departure arrives late — state has
        // moved past it.
        const scannedAt = new Date(Date.now() - 4000);
        const res = await POST(scanReq({ participantId: member.id, clientEventId: 'evt-out-of-order', scannedAt: scannedAt.toISOString(), replay: true }));
        expect(res.status).toBe(200);
        expect((await res.json()).type).toBe('parked');

        const log = await prisma.rawBadgeLog.findUnique({ where: { clientEventId: 'evt-out-of-order' } });
        expect(log?.reviewReason).toBe('out_of_order');
    });

    // F7: a naive "most-recently-arrived visit" pick can miss a departedAt
    // that belongs to an OLDER-arrived visit -- e.g. a same-day resolution
    // (D7) writes a departedAt at resolution time on a visit that arrived
    // earlier than another visit's own arrival. The guard must compare the
    // true max across all of the participant's visit activity.
    it('parks on an older-arrived visit\'s newer departedAt, not just the latest-arrived visit (F7)', async () => {
        const now = Date.now();
        // Visit A: arrived earliest, but departed most recently (e.g. resolved late).
        await prisma.visit.create({
            data: { personId: member.id, arrivedAt: new Date(now - 10 * 60_000), departedAt: new Date(now - 60_000), arrivedVia: 'SCANNER' },
        });
        // Visit B: arrived more recently than A, but departed before A's departure.
        await prisma.visit.create({
            data: { personId: member.id, arrivedAt: new Date(now - 8 * 60_000), departedAt: new Date(now - 7 * 60_000), arrivedVia: 'SCANNER' },
        });

        // Replay dated between B's activity and A's departedAt -- state (via A)
        // has moved past it, even though B is the most-recently-arrived visit.
        const scannedAt = new Date(now - 3 * 60_000);
        const res = await POST(scanReq({ participantId: member.id, clientEventId: 'evt-f7-max-departed', scannedAt: scannedAt.toISOString(), replay: true }));
        expect(res.status).toBe(200);
        expect((await res.json()).type).toBe('parked');

        const log = await prisma.rawBadgeLog.findUnique({ where: { clientEventId: 'evt-f7-max-departed' } });
        expect(log?.reviewReason).toBe('out_of_order');
    });

    // The park is only half the story — a parked row nobody can see is
    // invariant 3 broken. This closes the loop end to end against the real DB:
    // park via the route, then run the EXACT query GET /api/system-status/
    // unsynced-scans runs and prove the row is in it, and that a dismiss takes
    // it back out. The route's own filter/admission are unit-tested; what only
    // Postgres can settle is that `reviewReason != null AND reviewedAt = null`
    // actually selects what /api/scan just wrote.
    it('a parked replay surfaces in the unsynced-scans list query until it is dismissed (D7)', async () => {
        const scannedAt = new Date(Date.now() - 40 * 60_000); // 40 min ago > 10 min W
        const res = await POST(scanReq({ participantId: member.id, clientEventId: 'evt-d7-surfaces', scannedAt: scannedAt.toISOString(), replay: true }));
        expect((await res.json()).type).toBe('parked');

        const queue = () => prisma.rawBadgeLog.findMany({
            where: { reviewReason: { not: null }, reviewedAt: null, personId: member.id },
            select: { id: true, timestamp: true, reviewReason: true, person: { select: { id: true, name: true } } },
            orderBy: { timestamp: 'desc' },
            take: 100,
        });

        const parked = await queue();
        expect(parked).toHaveLength(1);
        expect(parked[0].reviewReason).toBe('stale_replay');
        expect(parked[0].person.name).toBe('Replay Member');
        expect(parked[0].timestamp.getTime()).toBe(scannedAt.getTime());

        // The dismiss's guarded write, stamping both columns.
        const dismissed = await prisma.rawBadgeLog.updateMany({
            where: { id: parked[0].id, reviewReason: { not: null }, reviewedAt: null },
            data: { reviewedAt: new Date(), reviewedBy: keyholder.id },
        });
        expect(dismissed.count).toBe(1);

        expect(await queue()).toHaveLength(0);
        // reviewReason survives the dismissal — the row keeps saying why it parked.
        const after = await prisma.rawBadgeLog.findUnique({ where: { clientEventId: 'evt-d7-surfaces' } });
        expect(after?.reviewReason).toBe('stale_replay');
        expect(after?.reviewedBy).toBe(keyholder.id);
    });

    // #1347 PR-2 / Q10 — server-side DLQ ingest. A dead-lettered outbox row
    // parks with a client_dead:<status> reviewReason and must surface in the
    // unsynced-scans list PR-1 defines (reviewReason != null), without this
    // test depending on PR-1's own route/query code.
    it('a dead-lettered event parks with client_dead:<status> and surfaces in the unsynced-scans query shape', async () => {
        const scannedAt = new Date(Date.now() - 5 * 60_000);
        const res = await POST(scanReq({
            participantId: member.id, clientEventId: 'evt-dead-dlq', scannedAt: scannedAt.toISOString(), dead: true, deadStatus: 404,
        }));
        expect(res.status).toBe(200);
        expect((await res.json()).type).toBe('parked');

        expect(await prisma.visit.findFirst({ where: { personId: member.id } })).toBeNull();

        const log = await prisma.rawBadgeLog.findUnique({ where: { clientEventId: 'evt-dead-dlq' } });
        expect(log?.reviewReason).toBe('client_dead:404');
        expect(log?.timestamp.getTime()).toBe(scannedAt.getTime());

        // PR-1's planned unsynced-scans query shape.
        const unsynced = await prisma.rawBadgeLog.findMany({
            where: { personId: member.id, reviewReason: { not: null } },
        });
        expect(unsynced.map((r) => r.clientEventId)).toContain('evt-dead-dlq');
    });

    it('re-sending a dead-lettered event with the same clientEventId dedups instead of parking twice', async () => {
        const scannedAt = new Date(Date.now() - 2 * 60_000);
        const first = await POST(scanReq({
            participantId: member.id, clientEventId: 'evt-dead-retry', scannedAt: scannedAt.toISOString(), dead: true, deadStatus: 400,
        }));
        expect((await first.json()).type).toBe('parked');

        const retry = await POST(scanReq({
            participantId: member.id, clientEventId: 'evt-dead-retry', scannedAt: scannedAt.toISOString(), dead: true, deadStatus: 400,
        }));
        expect((await retry.json()).type).toBe('duplicate_ignored');

        const rows = await prisma.rawBadgeLog.findMany({ where: { clientEventId: 'evt-dead-retry' } });
        expect(rows).toHaveLength(1);
    });

    it('rejects dead:true and replay:true together', async () => {
        const res = await POST(scanReq({
            participantId: member.id, clientEventId: 'evt-dead-and-replay',
            scannedAt: new Date().toISOString(), dead: true, replay: true,
        }));
        expect(res.status).toBe(400);
        expect(await prisma.rawBadgeLog.findUnique({ where: { clientEventId: 'evt-dead-and-replay' } })).toBeNull();
    });

    it('accepts a declared protocolVersion this server speaks, absent included', async () => {
        for (const extra of [{}, { protocolVersion: 1 }, { protocolVersion: 2 }]) {
            const res = await POST(scanReq({ participantId: member.id, ...extra }));
            expect(res.status).toBe(200);
            // Toggle back so each iteration starts checked out.
            await prisma.visit.deleteMany({ where: { personId: member.id } });
        }
    });

    it('accepts a LIVE scan declaring a newer protocolVersion — a version race must not block the door', async () => {
        const res = await POST(scanReq({ participantId: member.id, protocolVersion: 3 }));
        expect(res.status).toBe(200);
        expect(await prisma.visit.findFirst({ where: { personId: member.id } })).not.toBeNull();
        await prisma.visit.deleteMany({ where: { personId: member.id } });
    });

    it('426-bounces a replay declaring a newer protocolVersion, writing nothing', async () => {
        const res = await POST(scanReq({
            participantId: member.id, clientEventId: 'evt-too-new-replay',
            scannedAt: new Date().toISOString(), replay: true, protocolVersion: 3,
        }));
        expect(res.status).toBe(426);
        expect((await res.json()).error).toMatch(/protocolVersion/);
        expect(await prisma.visit.findFirst({ where: { personId: member.id } })).toBeNull();
        expect(await prisma.rawBadgeLog.findUnique({ where: { clientEventId: 'evt-too-new-replay' } })).toBeNull();
    });

    it('426-bounces a dead-letter declaring a newer protocolVersion, writing nothing', async () => {
        const res = await POST(scanReq({
            participantId: member.id, clientEventId: 'evt-too-new-dead',
            scannedAt: new Date().toISOString(), dead: true, protocolVersion: 3,
        }));
        expect(res.status).toBe(426);
        expect(await prisma.rawBadgeLog.findUnique({ where: { clientEventId: 'evt-too-new-dead' } })).toBeNull();
    });

    it('rejects a malformed protocolVersion', async () => {
        for (const bad of ['2', 0, 1.5, null]) {
            const res = await POST(scanReq({ participantId: member.id, protocolVersion: bad }));
            expect(res.status).toBe(400);
        }
    });
});
