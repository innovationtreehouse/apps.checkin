/**
 * @jest-environment node
 */
/**
 * Every facility close writes one FacilityClose record (who, when, which path)
 * and, for each departure it sets, stamps the visit with the close's id and
 * writes one AuditLog row with the departure before and after. The close's
 * outcome is the same as without the record.
 */
import { POST as scanPOST } from '@/app/api/scan/route';
import { DELETE as dashboardDELETE } from '@/app/api/attendance/route';
import { PATCH as manualPATCH, DELETE as manualDELETE } from '@/app/api/attendance/manual/[id]/route';
import { GET as nightlyGET } from '@/app/api/cron/nightly/route';
import prisma from '@/lib/prisma';
import { authenticateRequest } from '@/lib/auth';
import { getServerSession } from 'next-auth/next';
import type { FacilityCloseVia, Person, Visit } from '@/generated/prisma/client';
import type { NextRequest } from 'next/server';

jest.mock('@/lib/auth', () => ({
    ...jest.requireActual('@/lib/auth'),
    authenticateRequest: jest.fn(),
}));
jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));
jest.mock('@/lib/notifications', () => ({
    sendCheckinNotifications: jest.fn().mockResolvedValue(undefined),
    sendNotification: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('@/lib/email', () => ({
    runPaced: (tasks: Array<() => Promise<unknown>>) => Promise.all(tasks.map((t) => t())),
    sendEmail: jest.fn().mockResolvedValue(true),
}));
jest.mock('@/lib/postEventEmails', () => ({
    processPostEventEmails: jest.fn().mockResolvedValue({ processed: 0, sent: 0 }),
}));

const TAG = 'facility-close-record-test';
const HOUR = 3_600_000;

const req = (url: string, method: string, body?: unknown, headers?: Record<string, string>) =>
    new Request(`http://localhost${url}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }) as unknown as NextRequest;

describe('facility close record and departure log (real DB)', () => {
    let keyholder: Person;
    let keyholder2: Person;
    let member: Person;
    let member2: Person;
    let board: Person;
    let people: Person[];
    let closeIdFloor: number;
    const programIds: number[] = [];

    beforeAll(async () => {
        const mk = (name: string, flags: Partial<Pick<Person, 'isKeyholder' | 'isBoardMember'>>) => prisma.person.create({
            data: { name, email: `${name.toLowerCase()}-${TAG}@example.com`, ...flags, household: { create: { name: 'Test HH' } } },
        });
        keyholder = await mk('Key', { isKeyholder: true });
        keyholder2 = await mk('Key2', { isKeyholder: true });
        member = await mk('Member', {});
        member2 = await mk('Member2', {});
        board = await mk('Board', { isBoardMember: true });
        people = [keyholder, keyholder2, member, member2, board];
    });

    // The close is facility-wide: start every test from an empty building.
    beforeEach(async () => {
        await prisma.visit.updateMany({ where: { departedAt: null }, data: { departedAt: new Date(0) } });
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
        await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } });
        await prisma.event.deleteMany({ where: { programId: { in: programIds } } });
        await prisma.program.deleteMany({ where: { id: { in: programIds.splice(0) } } });
    });

    afterAll(async () => {
        await prisma.person.deleteMany({ where: { id: { in: people.map(p => p.id) } } });
        await prisma.household.deleteMany({ where: { id: { in: people.map(p => p.householdId) } } });
    });

    const arrivedAt = () => new Date(Date.now() - 2 * HOUR);
    const open = (p: Person, extra: Partial<Visit> = {}) =>
        prisma.visit.create({ data: { personId: p.id, arrivedAt: arrivedAt(), arrivedVia: 'SCANNER', ...extra } });
    const visitOf = (p: Person) => prisma.visit.findFirstOrThrow({ where: { personId: p.id }, orderBy: { id: 'desc' } });

    function asKiosk() {
        (authenticateRequest as jest.Mock).mockResolvedValue({ type: 'kiosk' });
    }
    function asSession(p: Person) {
        const user = { id: p.id, email: p.email, name: p.name, isKeyholder: p.isKeyholder, isBoardMember: p.isBoardMember, isSysadmin: false, householdId: p.householdId };
        (authenticateRequest as jest.Mock).mockResolvedValue({ type: 'session', user });
        (getServerSession as jest.Mock).mockResolvedValue({ user });
    }

    /**
     * Exactly one close since the test began, made by `closedById` via `via`;
     * every visit in `departed` carries it with one log row holding its before
     * and after; the closer's own visit does not.
     */
    async function expectOneClose(
        via: FacilityCloseVia,
        closedById: number | null,
        departed: { person: Person; before: { departedAt: Date | null; departedVia: string | null } }[],
        closersVisit?: Person,
    ) {
        const closes = await prisma.facilityClose.findMany({ where: { id: { gt: closeIdFloor } } });
        expect(closes).toHaveLength(1);
        const [close] = closes;
        expect(close).toMatchObject({ via, closedById });

        const logs = await prisma.auditLog.findMany({ where: { tableName: 'FacilityClose', affectedEntityId: close.id } });
        expect(logs).toHaveLength(departed.length);
        for (const { person, before } of departed) {
            const v = await visitOf(person);
            expect(v.facilityCloseId).toBe(close.id);
            expect(v.departedAt).not.toBeNull();
            const rows = logs.filter(l => l.secondaryAffectedEntity === v.id);
            expect(rows).toHaveLength(1);
            expect(rows[0].oldData).toEqual({
                visitId: v.id, personId: person.id,
                departedAt: before.departedAt?.toISOString() ?? null, departedVia: before.departedVia,
            });
            expect(rows[0].newData).toEqual({
                visitId: v.id, personId: person.id,
                departedAt: v.departedAt!.toISOString(), departedVia: v.departedVia,
            });
            expect(rows[0].actorId).toBe(closedById ?? 0);
        }
        if (closersVisit) expect((await visitOf(closersVisit)).facilityCloseId).toBeNull();
        return close;
    }
    const fresh = [{ departedAt: null, departedVia: null }][0];

    describe('kiosk', () => {
        it('a last-keyholder warning then confirming badge writes one KIOSK close', async () => {
            asKiosk();
            await open(keyholder);
            await open(member);
            await open(member2);

            const warn = await scanPOST(req('/api/scan', 'POST', { participantId: keyholder.id }));
            expect(warn.status).toBe(400);
            const { forceCloseToken } = await warn.json();
            expect(await prisma.facilityClose.count({ where: { id: { gt: closeIdFloor } } })).toBe(0);

            const res = await scanPOST(req('/api/scan', 'POST', { participantId: keyholder.id, forceCloseToken }));
            expect(await res.json()).toMatchObject({ type: 'checkout', facilityClosed: true });
            expect((await visitOf(member)).departedVia).toBe('FACILITY_CLOSE');

            await expectOneClose('KIOSK', keyholder.id, [
                { person: member, before: fresh },
                { person: member2, before: fresh },
            ], keyholder);
        });

        it('a close-offer second badge, with another keyholder recorded, writes one KIOSK close', async () => {
            asKiosk();
            await open(keyholder);
            await open(keyholder2);
            await open(member);

            const first = await scanPOST(req('/api/scan', 'POST', { participantId: keyholder.id, intent: 'OUT' }));
            const offer = await first.json();
            expect(offer).toMatchObject({ type: 'checkout', facilityClosed: false });
            expect(offer.forceCloseToken).toEqual(expect.any(String));

            const second = await scanPOST(req('/api/scan', 'POST', { participantId: keyholder.id, intent: 'OUT', forceCloseToken: offer.forceCloseToken }));
            expect(await second.json()).toMatchObject({ facilityClosed: true });

            await expectOneClose('KIOSK', keyholder.id, [
                { person: keyholder2, before: fresh },
                { person: member, before: fresh },
            ], keyholder);
        });

        it('an offline-confirmed replay writes one KIOSK_OFFLINE close at the scan time, logging the AUTO_CLOSE it pulls back', async () => {
            asKiosk();
            const cronAt = new Date(Date.now() - 10 * 60_000);
            const scannedAt = new Date(Date.now() - HOUR);
            await open(keyholder);
            await open(member, { departedAt: cronAt, departedVia: 'AUTO_CLOSE' });
            await open(member2);

            const res = await scanPOST(req('/api/scan', 'POST', {
                participantId: keyholder.id, clientEventId: `evt-${TAG}`, scannedAt: scannedAt.toISOString(), replay: true, forceCloseConfirmed: true,
            }));
            expect(await res.json()).toMatchObject({ type: 'checkout', facilityClosed: true });
            expect((await visitOf(member)).departedAt?.getTime()).toBe(scannedAt.getTime());

            const close = await expectOneClose('KIOSK_OFFLINE', keyholder.id, [
                { person: member, before: { departedAt: cronAt, departedVia: 'AUTO_CLOSE' } },
                { person: member2, before: fresh },
            ], keyholder);
            expect(close.closedAt.getTime()).toBe(scannedAt.getTime());
        });
    });

    describe('kiosk replay', () => {
        const replayBody = (extra: Record<string, unknown>) => ({
            participantId: keyholder.id, clientEventId: `evt-dup-${TAG}`, scannedAt: new Date(Date.now() - 60_000).toISOString(), replay: true, ...extra,
        });

        it('a replayed confirm echoing a server token records KIOSK_OFFLINE', async () => {
            asKiosk();
            await open(keyholder);
            await open(member);

            const warn = await scanPOST(req('/api/scan', 'POST', { participantId: keyholder.id }));
            const { forceCloseToken } = await warn.json();

            const res = await scanPOST(req('/api/scan', 'POST', replayBody({ forceCloseToken })));
            expect(await res.json()).toMatchObject({ type: 'checkout', facilityClosed: true });

            await expectOneClose('KIOSK_OFFLINE', keyholder.id, [{ person: member, before: fresh }], keyholder);
        });

        it('the same replayed close delivered twice writes no second close', async () => {
            asKiosk();
            await open(keyholder);
            await open(member);

            const first = await scanPOST(req('/api/scan', 'POST', replayBody({ forceCloseConfirmed: true })));
            expect(await first.json()).toMatchObject({ facilityClosed: true });
            const closes = await prisma.facilityClose.count({ where: { id: { gt: closeIdFloor } } });
            const logs = await prisma.auditLog.count({ where: { tableName: 'FacilityClose', affectedEntityId: { gt: closeIdFloor } } });

            const again = await scanPOST(req('/api/scan', 'POST', replayBody({ forceCloseConfirmed: true })));
            expect(await again.json()).toMatchObject({ type: 'duplicate_ignored' });
            expect(await prisma.facilityClose.count({ where: { id: { gt: closeIdFloor } } })).toBe(closes);
            expect(await prisma.auditLog.count({ where: { tableName: 'FacilityClose', affectedEntityId: { gt: closeIdFloor } } })).toBe(logs);

            await expectOneClose('KIOSK_OFFLINE', keyholder.id, [{ person: member, before: fresh }], keyholder);
        });
    });

    describe('web', () => {
        it('a session scan (home page toggle) writes one WEB_CHECKOUT close', async () => {
            asSession(keyholder);
            await open(keyholder);
            await open(member);

            const warn = await scanPOST(req('/api/scan', 'POST', { participantId: keyholder.id }));
            expect(warn.status).toBe(400);
            const { forceCloseToken } = await warn.json();

            const res = await scanPOST(req('/api/scan', 'POST', { participantId: keyholder.id, forceCloseToken }));
            expect(await res.json()).toMatchObject({ facilityClosed: true });

            await expectOneClose('WEB_CHECKOUT', keyholder.id, [{ person: member, before: fresh }], keyholder);
        });

        it('a board member\'s dashboard checkout of the last keyholder writes one WEB_DASHBOARD close', async () => {
            asSession(board);
            const kv = await open(keyholder);
            await open(member);
            await open(member2);

            const warn = await dashboardDELETE(req('/api/attendance', 'DELETE', { visitId: kv.id }));
            expect(warn.status).toBe(400);
            const { forceCloseToken } = await warn.json();

            const res = await dashboardDELETE(req('/api/attendance', 'DELETE', { visitId: kv.id, forceCloseToken }));
            expect(res.status).toBe(200);
            expect(await res.json()).toMatchObject({ success: true, facilityClosed: true });

            await expectOneClose('WEB_DASHBOARD', board.id, [
                { person: member, before: fresh },
                { person: member2, before: fresh },
            ], keyholder);
        });

        it('a correction closing the last keyholder\'s open visit writes one WEB_CORRECTION close', async () => {
            asSession(keyholder);
            const kv = await open(keyholder);
            await open(member);
            const departedAt = new Date(Date.now() - 60_000).toISOString();
            const ctx = { params: Promise.resolve({ id: String(kv.id) }) };

            const warn = await manualPATCH(req(`/api/attendance/manual/${kv.id}`, 'PATCH', { departedAt }), ctx);
            expect(warn.status).toBe(400);
            const { forceCloseToken } = await warn.json();

            const res = await manualPATCH(req(`/api/attendance/manual/${kv.id}`, 'PATCH', { departedAt, forceCloseToken }), ctx);
            expect(res.status).toBe(200);
            expect((await visitOf(member)).departedVia).toBe('FACILITY_CLOSE');

            await expectOneClose('WEB_CORRECTION', keyholder.id, [{ person: member, before: fresh }], keyholder);
        });

        it('a tombstone of the last keyholder\'s open visit writes one WEB_REMOVAL close', async () => {
            asSession(keyholder);
            const kv = await open(keyholder);
            await open(member);
            const ctx = { params: Promise.resolve({ id: String(kv.id) }) };

            const warn = await manualDELETE(req(`/api/attendance/manual/${kv.id}`, 'DELETE', {}), ctx);
            expect(warn.status).toBe(400);
            const { forceCloseToken } = await warn.json();

            const res = await manualDELETE(req(`/api/attendance/manual/${kv.id}`, 'DELETE', { forceCloseToken }), ctx);
            expect(res.status).toBe(200);
            expect((await prisma.visit.findUniqueOrThrow({ where: { id: kv.id } })).deletedAt).not.toBeNull();

            await expectOneClose('WEB_REMOVAL', keyholder.id, [{ person: member, before: fresh }], keyholder);
        });

        it('a keyholder alone checking out writes one close that departs nobody else', async () => {
            asSession(board);
            const kv = await open(keyholder);

            const res = await dashboardDELETE(req('/api/attendance', 'DELETE', { visitId: kv.id }));
            expect(await res.json()).toMatchObject({ success: true, facilityClosed: true });

            await expectOneClose('WEB_DASHBOARD', board.id, [], keyholder);
        });

        it('a checkout that does not close writes no close record', async () => {
            asSession(board);
            await open(keyholder);
            const mv = await open(member);

            const res = await dashboardDELETE(req('/api/attendance', 'DELETE', { visitId: mv.id }));
            expect(await res.json()).toMatchObject({ success: true, facilityClosed: false });
            expect(await prisma.facilityClose.count({ where: { id: { gt: closeIdFloor } } })).toBe(0);
        });
    });

    describe('overnight sweep', () => {
        const cronReq = () => req('/api/cron/nightly', 'GET', undefined, { authorization: 'Bearer test-secret' });

        it('writes one NIGHTLY_SWEEP close with no person, logging every departure it sets', async () => {
            process.env.CRON_SECRET = 'test-secret';
            await open(keyholder);
            await open(member);
            await open(member2);

            const res = await nightlyGET(cronReq());
            expect(res.status).toBe(200);
            expect((await visitOf(member)).departedVia).toBe('AUTO_CLOSE');

            await expectOneClose('NIGHTLY_SWEEP', null, [
                { person: keyholder, before: fresh },
                { person: member, before: fresh },
                { person: member2, before: fresh },
            ]);
            const log = await prisma.auditLog.findFirstOrThrow({ where: { tableName: 'FacilityClose', affectedEntityId: { gt: closeIdFloor } } });
            expect(log.actorSystem).toBe('cron:nightly');
            await prisma.auditLog.deleteMany({ where: { tableName: 'SYSTEM_NOTIFY', timestamp: { gte: new Date(Date.now() - 60_000) } } });
        });

        it('logs every segment of a visit the checkout splits across an event', async () => {
            process.env.CRON_SECRET = 'test-secret';
            const program = await prisma.program.create({
                data: { name: `Program ${TAG}`, startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), leadMentorId: member.id },
            });
            programIds.push(program.id);
            await prisma.event.create({
                data: { name: `Event ${TAG}`, programId: program.id, startAt: new Date(Date.now() - 90 * 60_000), endAt: new Date(Date.now() - 30 * 60_000) },
            });
            const original = await open(member);

            const res = await nightlyGET(cronReq());
            expect(res.status).toBe(200);

            const segments = await prisma.visit.findMany({ where: { personId: member.id }, orderBy: { arrivedAt: 'asc' } });
            expect(segments).toHaveLength(2);
            const [close] = await prisma.facilityClose.findMany({ where: { id: { gt: closeIdFloor } } });
            expect(close).toMatchObject({ via: 'NIGHTLY_SWEEP', closedById: null });
            const logs = await prisma.auditLog.findMany({ where: { tableName: 'FacilityClose', affectedEntityId: close.id } });
            expect(logs).toHaveLength(2);
            for (const seg of segments) {
                expect(seg.facilityCloseId).toBe(close.id);
                const row = logs.find(l => l.secondaryAffectedEntity === seg.id);
                expect(row?.oldData).toEqual({ visitId: original.id, personId: member.id, departedAt: null, departedVia: null });
                expect(row?.newData).toEqual({ visitId: seg.id, personId: member.id, departedAt: seg.departedAt!.toISOString(), departedVia: 'AUTO_CLOSE' });
            }
            await prisma.auditLog.deleteMany({ where: { tableName: 'SYSTEM_NOTIFY', timestamp: { gte: new Date(Date.now() - 60_000) } } });
        });

        it('writes no close when nobody is inside', async () => {
            process.env.CRON_SECRET = 'test-secret';
            const res = await nightlyGET(cronReq());
            expect(res.status).toBe(200);
            expect(await prisma.facilityClose.count({ where: { id: { gt: closeIdFloor } } })).toBe(0);
        });
    });
});
