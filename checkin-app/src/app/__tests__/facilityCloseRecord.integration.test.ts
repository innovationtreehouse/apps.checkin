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
import { PATCH as manualPATCH, DELETE as manualDELETE } from '@/app/api/attendance/manual/[id]/route';
import { GET as nightlyGET } from '@/app/api/cron/nightly/route';
import { PATCH as staffPATCH } from '@/app/api/facility/visits/route';
import prisma from '@/lib/prisma';
import { authenticateRequest } from '@/lib/auth';
import { getServerSession } from 'next-auth/next';
import type { FacilityCloseVia, Person, Visit } from '@/generated/prisma/client';
import type { NextRequest } from 'next/server';
import { SCAN_PROTOCOL_VERSION } from '@/lib/scanProtocol';

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
                departedAt: v.departedAt!.toISOString(), departedVia: v.departedVia, via,
            });
            expect(rows[0].actorId).toBe(closedById ?? 0);
        }
        if (closersVisit) expect((await visitOf(closersVisit)).facilityCloseId).toBeNull();
        return close;
    }
    const fresh = [{ departedAt: null, departedVia: null }][0];

    describe('kiosk below scan protocol 6 (the checkout decides the close)', () => {
        it('the last keyholder\'s leave then confirming badge writes one KIOSK close', async () => {
            asKiosk();
            await open(keyholder);
            await open(member);
            await open(member2);

            const leave = await scanPOST(req('/api/scan', 'POST', { participantId: keyholder.id, intent: 'OUT' }));
            expect(leave.status).toBe(200);
            const { forceCloseToken } = await leave.json();
            expect(await prisma.facilityClose.count({ where: { id: { gt: closeIdFloor } } })).toBe(0);

            const res = await scanPOST(req('/api/scan', 'POST', { participantId: keyholder.id, intent: 'OUT', forceCloseToken }));
            expect(await res.json()).toMatchObject({ type: 'checkout', facilityClosed: true });
            expect((await visitOf(member)).departedVia).toBe('FACILITY_CLOSE');

            const close = await expectOneClose('KIOSK', keyholder.id, [
                { person: member, before: fresh },
                { person: member2, before: fresh },
            ], keyholder);
            expect(close.closerVisitId).toBe((await visitOf(keyholder)).id);
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

    describe('kiosk on scan protocol 6 (the kiosk sends the close)', () => {
        const v6 = (body: Record<string, unknown>) => req('/api/scan', 'POST', { protocolVersion: 6, ...body });

        it('a keyholder shown alone closes with one scan: one KIOSK close, past others the server records', async () => {
            asKiosk();
            const kv = await open(keyholder);
            await open(member);
            await open(member2);

            const res = await scanPOST(v6({ participantId: keyholder.id, intent: 'OUT', close: 'alone' }));
            expect(await res.json()).toMatchObject({ type: 'checkout', facilityClosed: true });
            expect((await visitOf(member)).departedVia).toBe('FACILITY_CLOSE');
            expect((await visitOf(keyholder)).departedVia).toBe('SCANNER');

            const close = await expectOneClose('KIOSK', keyholder.id, [
                { person: member, before: fresh },
                { person: member2, before: fresh },
            ], keyholder);
            expect(close.executedAt).not.toBeNull();
            expect(close.closerVisitId).toBe(kv.id);
        });

        it('a plain OUT with others recorded only leaves; the confirmed close then writes one KIOSK close', async () => {
            asKiosk();
            await open(keyholder);
            await open(member);

            const first = await scanPOST(v6({ participantId: keyholder.id, intent: 'OUT' }));
            const left = await first.json();
            expect(left).toMatchObject({ type: 'checkout', facilityClosed: false });
            expect(left).not.toHaveProperty('forceCloseToken');
            expect(await prisma.facilityClose.count({ where: { id: { gt: closeIdFloor } } })).toBe(0);

            const second = await scanPOST(v6({ participantId: keyholder.id, intent: 'OUT', close: 'confirmed' }));
            expect(await second.json()).toMatchObject({ facilityClosed: true });

            await expectOneClose('KIOSK', keyholder.id, [{ person: member, before: fresh }], keyholder);
        });

        it('a plain OUT closes nothing even when the server records nobody else', async () => {
            asKiosk();
            await open(keyholder);

            const res = await scanPOST(v6({ participantId: keyholder.id, intent: 'OUT' }));
            expect(await res.json()).toMatchObject({ type: 'checkout', facilityClosed: false });
            expect(await prisma.facilityClose.count({ where: { id: { gt: closeIdFloor } } })).toBe(0);
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

            const leave = await scanPOST(req('/api/scan', 'POST', { participantId: keyholder.id, intent: 'OUT' }));
            const { forceCloseToken } = await leave.json();

            const res = await scanPOST(req('/api/scan', 'POST', replayBody({ forceCloseToken, scannedAt: new Date().toISOString() })));
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

    describe('correcting a close', () => {
        const ago = (ms: number) => new Date(Date.now() - ms);
        const patch = (v: Visit, body: Record<string, unknown>) =>
            manualPATCH(req(`/api/attendance/manual/${v.id}`, 'PATCH', body), { params: Promise.resolve({ id: String(v.id) }) });
        const departedAt = async (v: Visit) => (await prisma.visit.findUniqueOrThrow({ where: { id: v.id } })).departedAt;
        const theClose = () => prisma.facilityClose.findFirstOrThrow({ where: { id: { gt: closeIdFloor } } });
        const moves = async (closeId: number) => prisma.auditLog.findMany({
            where: { tableName: 'FacilityClose', affectedEntityId: closeId, newData: { path: ['moved'], equals: true } },
        });

        /** A keyholder's kiosk close confirmed at `at`, delivered from the kiosk's queue. */
        async function closeAt(at: Date) {
            asKiosk();
            const res = await scanPOST(req('/api/scan', 'POST', {
                participantId: keyholder.id, clientEventId: `evt-correct-${TAG}`, scannedAt: at.toISOString(),
                replay: true, intent: 'OUT', close: 'confirmed', protocolVersion: 6,
            }));
            expect(await res.json()).toMatchObject({ facilityClosed: true });
            asSession(keyholder);
        }

        it('an open visit is neither corrected nor removed, and nothing closes', async () => {
            asSession(keyholder);
            const kv = await open(keyholder);
            const mv = await open(member);

            expect((await patch(kv, { departedAt: ago(60_000).toISOString() })).status).toBe(409);
            expect((await manualDELETE(req(`/api/attendance/manual/${kv.id}`, 'DELETE', {}), { params: Promise.resolve({ id: String(kv.id) }) })).status).toBe(409);

            expect(await prisma.visit.findUniqueOrThrow({ where: { id: kv.id } })).toMatchObject({ departedAt: null, deletedAt: null });
            expect(await departedAt(mv)).toBeNull();
            expect(await prisma.facilityClose.count({ where: { id: { gt: closeIdFloor } } })).toBe(0);
        });

        it('an earlier correction moves the departures the close set, except a later arrival and an owner-corrected one', async () => {
            asKiosk();
            const kv = await open(keyholder);
            const mv = await open(member);
            const bv = await open(board);
            const late = await open(member2, { arrivedAt: ago(30 * 60_000) });

            const res = await scanPOST(req('/api/scan', 'POST', { protocolVersion: 6, participantId: keyholder.id, intent: 'OUT', close: 'confirmed' }));
            expect(await res.json()).toMatchObject({ facilityClosed: true });
            const close = await theClose();
            expect(close.closerVisitId).toBe(kv.id);
            const original = close.closedAt;

            const ownCorrection = ago(45 * 60_000);
            asSession(board);
            expect((await patch(bv, { departedAt: ownCorrection.toISOString() })).status).toBe(200);

            const corrected = ago(HOUR);
            asSession(keyholder);
            expect((await patch(kv, { departedAt: corrected.toISOString() })).status).toBe(200);

            expect(await departedAt(kv)).toEqual(corrected);
            expect(await departedAt(mv)).toEqual(corrected);
            expect(await departedAt(bv)).toEqual(ownCorrection);
            expect(await departedAt(late)).toEqual(original);
            expect((await theClose()).closedAt).toEqual(corrected);

            const logged = await moves(close.id);
            expect(logged).toHaveLength(1);
            expect(logged[0]).toMatchObject({ actorId: keyholder.id, secondaryAffectedEntity: mv.id });
            expect(logged[0].oldData).toMatchObject({ visitId: mv.id, departedAt: original.toISOString(), departedVia: 'FACILITY_CLOSE' });
            expect(logged[0].newData).toMatchObject({ visitId: mv.id, departedAt: corrected.toISOString(), departedVia: 'FACILITY_CLOSE', via: 'WEB_CORRECTION' });
        });

        it('a later correction moves only the closer; a second earlier one moves the rest from where they are', async () => {
            const kv = await open(keyholder);
            const mv = await open(member);
            const at = ago(HOUR);
            await closeAt(at);
            const close = await theClose();

            const later = ago(30 * 60_000);
            expect((await patch(kv, { departedAt: later.toISOString() })).status).toBe(200);
            expect(await departedAt(kv)).toEqual(later);
            expect(await departedAt(mv)).toEqual(at);
            expect((await theClose()).closedAt).toEqual(at);
            expect(await moves(close.id)).toHaveLength(0);

            const earlier = ago(90 * 60_000);
            expect((await patch(kv, { departedAt: earlier.toISOString() })).status).toBe(200);
            expect(await departedAt(mv)).toEqual(earlier);
            expect((await moves(close.id))[0].oldData).toMatchObject({ departedAt: at.toISOString() });
        });

        it('the board correcting the closer\'s departure earlier moves the close, logged as the board on the closer\'s behalf', async () => {
            const kv = await open(keyholder);
            const mv = await open(member);
            await closeAt(ago(HOUR));
            const close = await theClose();

            asSession(board);
            const corrected = ago(90 * 60_000);
            const res = await staffPATCH(req('/api/facility/visits', 'PATCH', { visitId: kv.id, departedAt: corrected.toISOString() }));
            expect(res.status).toBe(200);

            expect(await departedAt(mv)).toEqual(corrected);
            expect((await theClose()).closedAt).toEqual(corrected);
            const [logged] = await moves(close.id);
            expect(logged).toMatchObject({ actorId: board.id, secondaryAffectedEntity: mv.id });
            expect(logged.newData).toMatchObject({ via: 'WEB_CORRECTION', moved: true, correctedForCloserId: keyholder.id });
        });

        it('a late offline confirm links the closer\'s leave however long after it the confirm came, so a correction moves the close', async () => {
            const leftAt = ago(40 * 60_000);
            const confirmedAt = ago(30 * 60_000);
            const kv = await open(keyholder, { departedAt: leftAt, departedVia: 'SCANNER' });
            const mv = await open(member);

            asKiosk();
            await scanPOST(req('/api/scan', 'POST', {
                participantId: keyholder.id, clientEventId: `evt-late-${TAG}`, scannedAt: confirmedAt.toISOString(),
                replay: true, intent: 'OUT', close: 'confirmed', protocolVersion: 6,
            }));
            const close = await theClose();
            expect(close).toMatchObject({ via: 'KIOSK_OFFLINE', closerVisitId: kv.id, closedAt: confirmedAt });

            asSession(keyholder);
            const corrected = ago(50 * 60_000);
            expect((await patch(kv, { departedAt: corrected.toISOString() })).status).toBe(200);
            expect(await departedAt(mv)).toEqual(corrected);
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
                data: { appliesToYear: 2026, name: `Program ${TAG}`, startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), leadMentorId: member.id },
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
                expect(row?.newData).toEqual({ visitId: seg.id, personId: member.id, departedAt: seg.departedAt!.toISOString(), departedVia: 'AUTO_CLOSE', via: 'NIGHTLY_SWEEP' });
            }
            await prisma.auditLog.deleteMany({ where: { tableName: 'SYSTEM_NOTIFY', timestamp: { gte: new Date(Date.now() - 60_000) } } });
        });

        describe('with nobody inside', () => {
            const closesSinceFloor = () => prisma.facilityClose.findMany({ where: { id: { gt: closeIdFloor } } });

            // Rows left by other suites would read as tonight's sweep or as a fence.
            beforeEach(async () => {
                process.env.CRON_SECRET = 'test-secret';
                await prisma.visit.updateMany({ where: { facilityCloseId: { not: null } }, data: { facilityCloseId: null } });
                await prisma.facilityClose.deleteMany();
            });

            it('still records the close, logging no departures', async () => {
                expect((await nightlyGET(cronReq())).status).toBe(200);
                const close = await expectOneClose('NIGHTLY_SWEEP', null, []);
                expect(close.executedAt).not.toBeNull();
            });

            it('fences a check-in scanned before it that arrives after it', async () => {
                expect((await nightlyGET(cronReq())).status).toBe(200);
                const [close] = await closesSinceFloor();

                asKiosk();
                const scannedAt = new Date(close.closedAt.getTime() - 60_000);
                const res = await scanPOST(req('/api/scan', 'POST', {
                    participantId: keyholder.id, clientEventId: `evt-${TAG}-fenced`, scannedAt: scannedAt.toISOString(),
                    replay: true, intent: 'IN', protocolVersion: SCAN_PROTOCOL_VERSION,
                }));
                expect((await res.json()).type).toBe('checkin');

                const visit = await visitOf(keyholder);
                expect(visit.arrivedAt).toEqual(scannedAt);
                expect(visit).toMatchObject({ departedAt: close.closedAt, departedVia: 'FACILITY_CLOSE', facilityCloseId: close.id });
                const log = await prisma.rawBadgeLog.findUnique({ where: { clientEventId: `evt-${TAG}-fenced` } });
                expect(log?.reviewReason).toBe('closed_before_delivery');
            });

            it('records no second close when the run is retried the same night', async () => {
                await nightlyGET(cronReq());
                expect((await nightlyGET(cronReq())).status).toBe(200);
                await expectOneClose('NIGHTLY_SWEEP', null, []);
            });

            it('gives a retry its own close when it does find someone inside', async () => {
                await nightlyGET(cronReq());
                await open(member);
                await nightlyGET(cronReq());

                const closes = await closesSinceFloor();
                expect(closes).toHaveLength(2);
                expect((await visitOf(member)).facilityCloseId).toBe(Math.max(...closes.map(c => c.id)));
                await prisma.auditLog.deleteMany({ where: { tableName: 'SYSTEM_NOTIFY', timestamp: { gte: new Date(Date.now() - 60_000) } } });
            });

            it('records its own close after a keyholder closed earlier that evening', async () => {
                await prisma.facilityClose.create({ data: { closedAt: new Date(Date.now() - 3 * HOUR), closedById: keyholder.id, via: 'KIOSK' } });
                await nightlyGET(cronReq());
                const closes = await closesSinceFloor();
                expect(closes.map(c => c.via).sort()).toEqual(['KIOSK', 'NIGHTLY_SWEEP']);
            });
        });
    });
});
