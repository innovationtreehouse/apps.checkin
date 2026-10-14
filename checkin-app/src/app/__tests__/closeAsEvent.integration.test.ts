/**
 * @jest-environment node
 */
/**
 * A close is one recorded event: the kiosk decides, the server records the
 * close with the keyholder's checkout and carries it out from that row. Each
 * case is one item of the check-in modeling brief (MC-*) or the intended
 * state machine (docs/rules/attendance-checkin.md, Opening and closing).
 */
import { POST } from '@/app/api/scan/route';
import prisma from '@/lib/prisma';
import { authenticateRequest } from '@/lib/auth';
import { executePendingCloses } from '@/lib/scan-service';
import { getFullAttendance, invalidateAttendanceCache } from '@/lib/getFullAttendance';
import type { Person, Visit } from '@/generated/prisma/client';

jest.mock('@/lib/auth', () => ({ authenticateRequest: jest.fn() }));
jest.mock('@/lib/notifications', () => ({
    sendCheckinNotifications: jest.fn().mockResolvedValue(undefined),
    sendNotification: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('@/lib/postEventEmails', () => ({ processPostEventEmails: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/lib/logger', () => ({
    logBackendError: jest.fn(),
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const TAG = 'close-as-event-test';
const HOUR = 3_600_000;

const scan = (body: Record<string, unknown>) => POST(new Request('http://localhost/api/scan', {
    method: 'POST',
    body: JSON.stringify(body),
}) as unknown as import('next/server').NextRequest);

describe('close as one recorded event (real DB)', () => {
    let k: Person;
    let k2: Person;
    let m: Person;
    let people: Person[];
    let closeIdFloor: number;

    beforeAll(async () => {
        const mk = (name: string, isKeyholder: boolean) => prisma.person.create({
            data: { name, email: `${name.toLowerCase()}-${TAG}@example.com`, isKeyholder, household: { create: { name: 'Test HH' } } },
        });
        k = await mk('Key', true);
        k2 = await mk('Key2', true);
        m = await mk('Member', false);
        people = [k, k2, m];
    });

    // The sweep is facility-wide: start every test from an empty building.
    beforeEach(async () => {
        (authenticateRequest as jest.Mock).mockResolvedValue({ type: 'kiosk' });
        await prisma.visit.updateMany({ where: { departedAt: null }, data: { departedAt: new Date(0) } });
        await prisma.facilityClose.updateMany({ where: { executedAt: null }, data: { executedAt: new Date(0) } });
        closeIdFloor = (await prisma.facilityClose.aggregate({ _max: { id: true } }))._max.id ?? 0;
    });

    afterEach(async () => {
        const ids = people.map(p => p.id);
        const closes = { id: { gt: closeIdFloor } };
        await prisma.auditLog.deleteMany({ where: { tableName: 'FacilityClose', affectedEntityId: { gt: closeIdFloor } } });
        await prisma.visit.updateMany({ where: { facilityClose: closes }, data: { facilityCloseId: null } });
        await prisma.facilityClose.deleteMany({ where: closes });
        await prisma.presenceEvent.deleteMany({ where: { personId: { in: ids } } });
        await prisma.visit.deleteMany({ where: { personId: { in: ids } } });
        await prisma.rawBadgeLog.deleteMany({ where: { personId: { in: ids } } });
        await prisma.person.update({ where: { id: k.id }, data: { isKeyholder: true } });
    });

    afterAll(async () => {
        await prisma.person.deleteMany({ where: { id: { in: people.map(p => p.id) } } });
        await prisma.household.deleteMany({ where: { id: { in: people.map(p => p.householdId) } } });
    });

    const at = (msAgo: number) => new Date(Date.now() - msAgo);
    const open = (p: Person, arrivedAt: Date, extra: Partial<Visit> = {}) =>
        prisma.visit.create({ data: { personId: p.id, arrivedAt, arrivedVia: 'SCANNER', ...extra } });
    const reload = (v: Visit) => prisma.visit.findUniqueOrThrow({ where: { id: v.id } });
    const closesSince = () => prisma.facilityClose.findMany({ where: { id: { gt: closeIdFloor } }, orderBy: { id: 'asc' } });
    const replay = (cid: string, scannedAt: Date, extra: Record<string, unknown>) =>
        scan({ participantId: k.id, clientEventId: `${TAG}-${cid}`, scannedAt: scannedAt.toISOString(), replay: true, intent: 'OUT', ...extra });

    it('alone: one live scan closes past others the server records; the keyholder departs as SCANNER', async () => {
        const kv = await open(k, at(2 * HOUR));
        const mv = await open(m, at(2 * HOUR));

        const res = await scan({ participantId: k.id, intent: 'OUT', close: 'alone' });
        expect(await res.json()).toMatchObject({ type: 'checkout', facilityClosed: true });

        expect((await reload(kv)).departedVia).toBe('SCANNER');
        expect((await reload(mv)).departedVia).toBe('FACILITY_CLOSE');
        const [close] = await closesSince();
        expect(close).toMatchObject({ via: 'KIOSK', closedById: k.id });
        expect(close.executedAt).not.toBeNull();
    });

    it('MC-A1: a stale "alone" replay closes at the scan time, unflagged, past others still recorded', async () => {
        const t = at(3 * HOUR);
        await open(k, at(5 * HOUR));
        const mv = await open(m, at(5 * HOUR));

        expect(await (await replay('a1', t, { close: 'alone' })).json()).toMatchObject({ facilityClosed: true });

        expect((await reload(mv)).departedAt?.getTime()).toBe(t.getTime());
        const log = await prisma.rawBadgeLog.findUniqueOrThrow({ where: { clientEventId: `${TAG}-a1` } });
        expect(log.reviewReason).toBeNull();
    });

    it('MC-A2: a queued confirm after the keyholder\'s own plain OUT closes with no visit of theirs', async () => {
        const kv = await open(k, at(5 * HOUR));
        const mv = await open(m, at(5 * HOUR));
        // Inside the replay freshness window, so the plain OUT applies as a checkout.
        const t1 = at(5 * 60_000);
        const t2 = new Date(t1.getTime() + 5000);
        await replay('a2-out', t1, {});
        expect((await reload(kv)).departedAt?.getTime()).toBe(t1.getTime());
        expect((await reload(mv)).departedAt).toBeNull();

        expect(await (await replay('a2-close', t2, { close: 'confirmed' })).json()).toMatchObject({ facilityClosed: true, visit: null });

        expect((await reload(mv)).departedAt?.getTime()).toBe(t2.getTime());
        expect(await prisma.rawBadgeLog.count({ where: { clientEventId: `${TAG}-a2-close`, reviewReason: { not: null } } })).toBe(0);
    });

    it('MC-A3: after the cron chunked a visit, every segment that began by the close is pulled back, a later one is not', async () => {
        const t = at(3 * HOUR);
        const boundary = new Date(t.getTime() + HOUR);
        const cronAt = at(10 * 60_000);
        await open(k, at(5 * HOUR), { departedAt: cronAt, departedVia: 'AUTO_CLOSE' });
        const seg1 = await open(m, at(5 * HOUR), { departedAt: boundary, departedVia: 'AUTO_CLOSE' });
        const seg2 = await open(m, boundary, { departedAt: cronAt, departedVia: 'AUTO_CLOSE' });

        expect(await (await replay('a3', t, { close: 'confirmed' })).json()).toMatchObject({ facilityClosed: true });

        expect((await reload(seg1)).departedAt?.getTime()).toBe(t.getTime());
        expect((await reload(seg2)).departedAt?.getTime()).toBe(cronAt.getTime());
    });

    it('MC-A4: a live confirm sent after a fast drain delivered the first OUT still closes', async () => {
        await open(k, at(HOUR));
        const mv = await open(m, at(HOUR));
        await replay('a4-out', at(20_000), {});

        expect(await (await scan({ participantId: k.id, intent: 'OUT', close: 'confirmed' })).json()).toMatchObject({ facilityClosed: true });
        expect((await reload(mv)).departedVia).toBe('FACILITY_CLOSE');
    });

    it('MC-B1: a close recorded but not carried out runs on the kiosk\'s deduped resend, exactly once', async () => {
        const t = at(HOUR);
        const mv = await open(m, at(2 * HOUR));
        // The scan transaction committed (badge log + close row), then the process died.
        await prisma.rawBadgeLog.create({ data: { personId: k.id, clientEventId: `${TAG}-b1`, timestamp: t } });
        await prisma.facilityClose.create({ data: { closedAt: t, closedById: k.id, via: 'KIOSK_OFFLINE', clientEventId: `${TAG}-b1`, executedAt: null } });
        expect((await reload(mv)).departedAt).toBeNull();

        expect(await (await replay('b1', t, { close: 'confirmed' })).json()).toMatchObject({ type: 'duplicate_ignored' });
        expect((await reload(mv)).departedAt?.getTime()).toBe(t.getTime());
        const [close] = await closesSince();
        expect(close.executedAt).not.toBeNull();
        const logs = await prisma.auditLog.count({ where: { tableName: 'FacilityClose', affectedEntityId: close.id } });

        await replay('b1', t, { close: 'confirmed' });
        expect(await prisma.auditLog.count({ where: { tableName: 'FacilityClose', affectedEntityId: close.id } })).toBe(logs);
    });

    it('two executors racing one recorded close sweep it once', async () => {
        await open(m, at(2 * HOUR));
        const close = await prisma.facilityClose.create({ data: { closedAt: at(HOUR), closedById: k.id, via: 'KIOSK', executedAt: null } });

        await Promise.all([executePendingCloses(), executePendingCloses()]);

        expect(await prisma.auditLog.count({ where: { tableName: 'FacilityClose', affectedEntityId: close.id } })).toBe(1);
    });

    it('MC-C1: a web dialog token minted on the keyholder\'s visit does not touch a kiosk close', async () => {
        await open(k, at(HOUR), { forceCloseToken: 'web-dialog', forceCloseWarnedAt: new Date(), forceCloseActorId: k2.id });
        const mv = await open(m, at(HOUR));

        expect(await (await scan({ participantId: k.id, intent: 'OUT', close: 'confirmed' })).json()).toMatchObject({ facilityClosed: true });
        expect((await reload(mv)).departedVia).toBe('FACILITY_CLOSE');
    });

    it('MC-C2: the keyholder\'s visit removed on the web before a queued close: it still closes, the removal stands', async () => {
        const kv = await open(k, at(5 * HOUR), { deletedAt: new Date() });
        const mv = await open(m, at(5 * HOUR));
        const t = at(3 * HOUR);

        expect(await (await replay('c2', t, { close: 'confirmed' })).json()).toMatchObject({ facilityClosed: true });

        expect((await reload(mv)).departedAt?.getTime()).toBe(t.getTime());
        const removed = await reload(kv);
        expect(removed.deletedAt).not.toBeNull();
        expect(removed.departedAt).toBeNull();
    });

    it('MC-C3: a web checkout of the keyholder after t, and a keyholder backdated before t, do not stop a queued close', async () => {
        const t = at(3 * HOUR);
        await open(k, at(5 * HOUR), { departedAt: at(HOUR), departedVia: 'TYPED' });
        const k2v = await open(k2, at(4 * HOUR));
        const mv = await open(m, at(5 * HOUR));

        expect(await (await replay('c3', t, { close: 'alone' })).json()).toMatchObject({ facilityClosed: true });

        expect((await reload(k2v)).departedAt?.getTime()).toBe(t.getTime());
        expect((await reload(mv)).departedAt?.getTime()).toBe(t.getTime());
    });

    it('MC-C3: a role revoked before the queued close arrives does not stop it; the close is flagged for review', async () => {
        await open(k, at(5 * HOUR));
        const mv = await open(m, at(5 * HOUR));
        await prisma.person.update({ where: { id: k.id }, data: { isKeyholder: false } });

        expect(await (await replay('c3r', at(3 * HOUR), { close: 'confirmed' })).json()).toMatchObject({ facilityClosed: true });

        expect((await reload(mv)).departedVia).toBe('FACILITY_CLOSE');
        const log = await prisma.rawBadgeLog.findUniqueOrThrow({ where: { clientEventId: `${TAG}-c3r` } });
        expect(log.reviewReason).toBe('close_not_keyholder');
    });

    it('a live close from someone whose keys were revoked is refused: they check out, nobody else does', async () => {
        const kv = await open(k, at(HOUR));
        const mv = await open(m, at(HOUR));
        await prisma.person.update({ where: { id: k.id }, data: { isKeyholder: false } });

        const res = await scan({ participantId: k.id, intent: 'OUT', close: 'alone', clientEventId: `${TAG}-revoked-live`, protocolVersion: 6 });
        expect(await res.json()).toMatchObject({ type: 'checkout', facilityClosed: false, closeRefused: true });

        expect((await reload(kv)).departedVia).toBe('SCANNER');
        expect((await reload(mv)).departedAt).toBeNull();
        expect(await closesSince()).toHaveLength(0);
    });

    it('closes apply in close-time order: an earlier close arriving late pulls a later close\'s departures back', async () => {
        const t1 = at(4 * HOUR);
        const t3 = at(2 * HOUR);
        const mv = await open(m, at(5 * HOUR));
        await prisma.facilityClose.create({ data: { closedAt: t3, closedById: k2.id, via: 'KIOSK', executedAt: null } });
        await executePendingCloses();
        expect((await reload(mv)).departedAt?.getTime()).toBe(t3.getTime());

        expect(await (await replay('order', t1, { close: 'confirmed' })).json()).toMatchObject({ facilityClosed: true });

        const v = await reload(mv);
        expect(v.departedAt?.getTime()).toBe(t1.getTime());
        expect(v.departedVia).toBe('FACILITY_CLOSE');
    });

    it('NoFalseOpen: a keyholder check-in from before a close, delivered after it ran, does not reopen the building; its queued OUT still applies', async () => {
        // Inside the replay freshness window, so both replays apply.
        const inAt = at(8 * 60_000);
        const t = at(6 * 60_000);
        const outAt = at(4 * 60_000);
        await prisma.facilityClose.create({ data: { closedAt: t, closedById: k.id, via: 'KIOSK', executedAt: null } });
        await executePendingCloses();

        await scan({ participantId: k2.id, clientEventId: `${TAG}-nfo-in`, scannedAt: inAt.toISOString(), replay: true, intent: 'IN' });
        invalidateAttendanceCache();
        const after = await getFullAttendance();
        expect(after.attendance.map(v => v.participant.id)).toContain(k2.id);
        expect(after.safety.facilityOpen).toBe(false);

        await scan({ participantId: k2.id, clientEventId: `${TAG}-nfo-out`, scannedAt: outAt.toISOString(), replay: true, intent: 'OUT' });
        const v = await prisma.visit.findFirstOrThrow({ where: { personId: k2.id } });
        expect(v.departedAt?.getTime()).toBe(outAt.getTime());
        expect(v.departedVia).toBe('SCANNER');
    });

    it('a keyholder arriving live just after the close ran reopens the building, inside the skew too', async () => {
        await prisma.facilityClose.create({ data: { closedAt: at(30_000), closedById: k.id, via: 'KIOSK', executedAt: null } });
        await executePendingCloses();
        await scan({ participantId: k2.id, intent: 'IN' });
        invalidateAttendanceCache();
        expect((await getFullAttendance()).safety.facilityOpen).toBe(true);
    });

    describe('a kiosk roster older than a check-in (rosterAsOf)', () => {
        it('live: one badge does not close; the keyholder leaves, is told who checked in, and a second badge closes', async () => {
            const kv = await open(k, at(2 * HOUR));
            const rosterAsOf = at(5 * 60_000);
            const mv = await open(m, at(2 * 60_000)); // a web check-in the stale kiosk roster missed

            const res = await scan({ participantId: k.id, intent: 'OUT', close: 'alone', rosterAsOf: rosterAsOf.toISOString() });
            const body = await res.json();
            expect(body).toMatchObject({ type: 'checkout', facilityClosed: false });
            expect(body.closePrompt).toContain('Member checked in at');
            expect(body.closePrompt).toContain('Badge again to close');
            expect((await reload(kv)).departedVia).toBe('SCANNER');
            expect((await reload(mv)).departedAt).toBeNull();
            expect(await closesSince()).toHaveLength(0);
            const leave = await prisma.auditLog.findFirstOrThrow({ where: { actorId: k.id, tableName: 'Visit', affectedEntityId: kv.id } });
            expect(leave.newData).toMatchObject({ type: 'last_keyholder_choice', choice: 'leave', via: 'KIOSK', othersInside: 1 });

            const second = await scan({ participantId: k.id, intent: 'OUT', close: 'confirmed', rosterAsOf: new Date().toISOString() });
            expect(await second.json()).toMatchObject({ facilityClosed: true });
            expect((await reload(mv)).departedVia).toBe('FACILITY_CLOSE');
        });

        it('live: a roster taken after every check-in closes on one badge', async () => {
            await open(k, at(2 * HOUR));
            const mv = await open(m, at(10 * 60_000));

            const res = await scan({ participantId: k.id, intent: 'OUT', close: 'alone', rosterAsOf: at(60_000).toISOString() });
            expect(await res.json()).toMatchObject({ facilityClosed: true });
            expect((await reload(mv)).departedVia).toBe('FACILITY_CLOSE');
        });

        it('replay: the late close applies as the keyholder meant, and is flagged naming who it may have swept out', async () => {
            const t = at(30 * 60_000);
            const rosterAsOf = at(60 * 60_000);
            await open(k, at(2 * HOUR));
            const mv = await open(m, at(45 * 60_000)); // after the roster, before the close

            const res = await replay('stale', t, { close: 'alone', rosterAsOf: rosterAsOf.toISOString() });
            expect(await res.json()).toMatchObject({ facilityClosed: true });
            expect((await reload(mv)).departedAt?.getTime()).toBe(t.getTime());

            const log = await prisma.rawBadgeLog.findUniqueOrThrow({ where: { clientEventId: `${TAG}-stale` } });
            expect(log.reviewReason).toBe('close_stale_roster');
            const [close] = await closesSince();
            const note = await prisma.auditLog.findFirstOrThrow({ where: { tableName: 'FacilityClose', affectedEntityId: close.id, newData: { path: ['type'], equals: 'close_stale_roster' } } });
            expect(note.newData).toMatchObject({ rosterAsOf: rosterAsOf.toISOString(), unseen: [{ visitId: mv.id, personId: m.id }] });
        });
    });

    it('a close never departs a visit that began after it', async () => {
        const t = at(3 * HOUR);
        const later = await open(m, at(HOUR));

        await replay('later', t, { close: 'alone' });

        expect((await reload(later)).departedAt).toBeNull();
    });
});
