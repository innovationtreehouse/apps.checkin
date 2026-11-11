/**
 * @jest-environment node
 */
/**
 * Scripted check-in scenarios for trace validation of the TLA+ model
 * (CheckinImpl_v3). Each drives the real scan and close code against
 * a real DB with the spec trace on, asserts the outcome, and leaves one NDJSON
 * trace per scenario in CHECKIN_TRACE_DIR (a temp dir when unset). The first
 * line of each is the scenario's topology: which person is which model name,
 * who holds a key, who starts inside.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { POST as scanPOST } from '@/app/api/scan/route';
import prisma from '@/lib/prisma';
import { startSpecTrace } from '@/lib/specTrace';
import type { Person } from '@/generated/prisma/client';

jest.mock('@/lib/verify-kiosk', () => ({
    getKioskPublicKeys: jest.fn(() => ['test-key']),
    verifyKioskSignature: jest.fn(() => ({ ok: true })),
}));
jest.mock('@/lib/notifications', () => ({
    sendCheckinNotifications: jest.fn().mockResolvedValue(undefined),
    sendNotification: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('@/lib/postEventEmails', () => ({ processPostEventEmails: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/lib/logger', () => ({
    logBackendError: jest.fn(),
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const TAG = 'spec-trace-test';
const HOUR = 3_600_000;
// No Person has this id: the server resolves it to nobody (scan protocol 7 parks it).
const UNKNOWN_ID = 2_147_400_000;
const traceDir = process.env.CHECKIN_TRACE_DIR || mkdtempSync(join(tmpdir(), 'checkin-traces-'));

type NextReq = import('next/server').NextRequest;
const iso = (ms: number) => new Date(ms).toISOString();

/** A signed kiosk scan, as client.py's post_scan builds it. */
const kiosk = async (body: Record<string, unknown>) => {
    const res = await scanPOST(new Request('http://localhost/api/scan', {
        method: 'POST',
        headers: { 'x-kiosk-signature': 'sig', 'x-kiosk-timestamp': '0', 'x-kiosk-nonce': 'n' },
        body: JSON.stringify({ protocolVersion: 7, ...body }),
    }) as unknown as NextReq);
    return { status: res.status, body: await res.json() };
};

describe('spec trace scenarios (real DB)', () => {
    let k1: Person;
    let k2: Person;
    let m1: Person;
    let people: Person[];
    let closeIdFloor: number;
    let seq = 0;
    const cid = (name: string) => `${TAG}-${name}-${Date.now()}-${seq++}`;

    beforeAll(async () => {
        mkdirSync(traceDir, { recursive: true });
        const mk = (name: string, isKeyholder: boolean) => prisma.person.create({
            data: { name, email: `${name.toLowerCase()}-${TAG}@example.com`, isKeyholder, household: { create: { name: 'Test HH' } } },
        });
        k1 = await mk('KeyOne', true);
        k2 = await mk('KeyTwo', true);
        m1 = await mk('Member', false);
        people = [k1, k2, m1];
        expect(await prisma.person.count({ where: { id: UNKNOWN_ID } })).toBe(0);
    });

    // The sweep is facility-wide: start every scenario from an empty building.
    beforeEach(async () => {
        await prisma.visit.updateMany({ where: { departedAt: null }, data: { departedAt: new Date(0) } });
        await prisma.facilityClose.updateMany({ where: { executedAt: null }, data: { executedAt: new Date(0) } });
        const dayAgo = new Date(Date.now() - 24 * HOUR);
        await prisma.facilityClose.updateMany({ where: { closedAt: { gt: dayAgo } }, data: { closedAt: dayAgo } });
        closeIdFloor = (await prisma.facilityClose.aggregate({ _max: { id: true } }))._max.id ?? 0;
    });

    afterEach(async () => {
        startSpecTrace(null);
        const ids = people.map(p => p.id);
        const closes = { id: { gt: closeIdFloor } };
        await prisma.auditLog.deleteMany({ where: { tableName: 'FacilityClose', affectedEntityId: { gt: closeIdFloor } } });
        await prisma.visit.updateMany({ where: { facilityClose: closes }, data: { facilityCloseId: null } });
        await prisma.facilityClose.deleteMany({ where: closes });
        await prisma.presenceEvent.deleteMany({ where: { personId: { in: ids } } });
        await prisma.visit.deleteMany({ where: { personId: { in: ids } } });
        await prisma.rawBadgeLog.deleteMany({ where: { OR: [{ personId: { in: ids } }, { clientEventId: { startsWith: TAG } }] } });
    });

    afterAll(async () => {
        await prisma.auditLog.deleteMany({ where: { tableName: 'Visit', secondaryAffectedEntity: { in: people.map(p => p.id) } } });
        await prisma.person.deleteMany({ where: { id: { in: people.map(p => p.id) } } });
        await prisma.household.deleteMany({ where: { id: { in: people.map(p => p.householdId) } } });
    });

    /** Seed who is inside, then start the scenario's trace with its topology line. */
    const begin = async (scenario: string, inside: Person[]) => {
        for (const p of inside) {
            await prisma.visit.create({ data: { personId: p.id, arrivedAt: new Date(Date.now() - HOUR), arrivedVia: 'SCANNER' } });
        }
        const file = join(traceDir, `${scenario}.ndjson`);
        writeFileSync(file, JSON.stringify({
            tag: 'config', ts: Date.now(),
            config: {
                scenario,
                persons: { [k1.id]: 'k1', [k2.id]: 'k2', [m1.id]: 'm1', [UNKNOWN_ID]: 'u1' },
                keyholders: ['k1', 'k2'],
                inside: inside.map(p => (p === k1 ? 'k1' : p === k2 ? 'k2' : 'm1')),
                unresolvable: ['u1'],
            },
        }) + '\n');
        startSpecTrace(file);
        return file;
    };
    const events = (file: string) => readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l))
        .filter(l => l.tag === 'trace').map(l => l.event.name as string);
    const closesSince = () => prisma.facilityClose.findMany({ where: { id: { gt: closeIdFloor } }, orderBy: { id: 'asc' } });
    const openOf = (p: Person) => prisma.visit.findFirst({ where: { personId: p.id, departedAt: null, deletedAt: null } });
    const lastVisit = (p: Person) => prisma.visit.findFirstOrThrow({ where: { personId: p.id }, orderBy: { id: 'desc' } });

    it('single keyholder close: the kiosk prompts, the second badge closes, the sweep departs the member', async () => {
        const file = await begin('single_keyholder_close', [k1, m1]);

        const out = await kiosk({ participantId: k1.id, clientEventId: cid('k1-out'), scannedAt: iso(Date.now()), intent: 'OUT' });
        expect(out.body).toMatchObject({ type: 'checkout' });
        const close = await kiosk({
            participantId: k1.id, clientEventId: cid('k1-close'), scannedAt: iso(Date.now()), intent: 'OUT',
            close: 'confirmed', rosterAsOf: iso(Date.now()),
        });
        expect(close.body).toMatchObject({ type: 'checkout', facilityClosed: true });

        expect(await openOf(m1)).toBeNull();
        expect((await lastVisit(m1)).departedVia).toBe('FACILITY_CLOSE');
        expect(await closesSince()).toEqual([expect.objectContaining({ via: 'KIOSK', closedById: k1.id })]);
        expect(events(file)).toEqual(expect.arrayContaining(['ScanRequest', 'VisitDepart', 'ScanCommit', 'CloseExecuted']));
    });

    it('two keyholders: the first leaves without closing, the second alone closes', async () => {
        const file = await begin('two_keyholders', [k1, k2]);

        expect((await kiosk({ participantId: k1.id, clientEventId: cid('k1-out'), scannedAt: iso(Date.now()), intent: 'OUT' })).body)
            .toMatchObject({ type: 'checkout' });
        expect(await closesSince()).toHaveLength(0);
        const close = await kiosk({
            participantId: k2.id, clientEventId: cid('k2-close'), scannedAt: iso(Date.now()), intent: 'OUT',
            close: 'alone', rosterAsOf: iso(Date.now()),
        });
        expect(close.body).toMatchObject({ facilityClosed: true });
        expect(await openOf(k1)).toBeNull();
        expect(await openOf(k2)).toBeNull();
        expect(events(file).filter(e => e === 'CloseExecuted')).toHaveLength(1);
    });

    it('held one-badge close with a lost reply: the resend closes as a late close and sweeps the unseen check-in', async () => {
        const rosterAsOf = Date.now() - 500;
        const file = await begin('held_close_lost_reply', [k1]);

        const checkin = await kiosk({ participantId: m1.id, clientEventId: cid('m1-in'), scannedAt: iso(Date.now()), intent: 'IN' });
        expect(checkin.body).toMatchObject({ type: 'checkin' });

        const id = cid('k1-alone');
        const scannedAt = iso(Date.now());
        const held = await kiosk({ participantId: k1.id, clientEventId: id, scannedAt, intent: 'OUT', close: 'alone', rosterAsOf: iso(rosterAsOf) });
        expect(held.body).toMatchObject({ type: 'checkout', facilityClosed: false });
        expect(await openOf(m1)).not.toBeNull();

        // The kiosk never saw that reply; its drain resends the row.
        const resent = await kiosk({ participantId: k1.id, clientEventId: id, scannedAt, replay: true, intent: 'OUT', close: 'alone', rosterAsOf: iso(rosterAsOf) });
        expect(resent.body).toMatchObject({ facilityClosed: true });
        expect(await openOf(m1)).toBeNull();
        expect(await closesSince()).toEqual([expect.objectContaining({ via: 'KIOSK_OFFLINE' })]);
        expect(events(file)).toContain('VisitOpen');
    });

    it('queued IN racing a live close: the member ends departed at the close either way', async () => {
        const file = await begin('queued_in_races_close', [k1]);
        // m1's live POST never reached the server; the row waits in the outbox.
        const inAt = Date.now() - 1500;
        const out = await kiosk({ participantId: k1.id, clientEventId: cid('k1-out'), scannedAt: iso(Date.now()), intent: 'OUT' });
        expect(out.body).toMatchObject({ type: 'checkout' });
        const rosterAsOf = Date.now();

        const [close, replayIn] = await Promise.all([
            kiosk({ participantId: k1.id, clientEventId: cid('k1-close'), scannedAt: iso(Date.now()), intent: 'OUT', close: 'confirmed', rosterAsOf: iso(rosterAsOf) }),
            kiosk({ participantId: m1.id, clientEventId: cid('m1-in'), scannedAt: iso(inAt), replay: true, intent: 'IN' }),
        ]);
        expect(close.body).toMatchObject({ facilityClosed: true });
        expect(replayIn.body).toMatchObject({ type: 'checkin' });
        expect(await openOf(m1)).toBeNull();
        expect((await lastVisit(m1)).departedVia).toBe('FACILITY_CLOSE');
        expect(events(file)).toContain('VisitOpen');
    });

    it('offline kiosk replay after a close: an IN scanned before a close is fenced at it', async () => {
        const file = await begin('offline_replay_after_close', [k1]);
        const inAt = Date.now() - 2000;

        const close = await kiosk({ participantId: k1.id, clientEventId: cid('k1-close'), scannedAt: iso(Date.now()), intent: 'OUT', close: 'confirmed', rosterAsOf: iso(Date.now()) });
        expect(close.body).toMatchObject({ type: 'checkout', facilityClosed: true });

        const replayIn = await kiosk({ participantId: m1.id, clientEventId: cid('m1-in'), scannedAt: iso(inAt), replay: true, intent: 'IN' });
        expect(replayIn.body).toMatchObject({ type: 'checkin' });
        const mv = await lastVisit(m1);
        expect(mv.departedVia).toBe('FACILITY_CLOSE');
        expect(await prisma.rawBadgeLog.findFirst({ where: { personId: m1.id } })).toMatchObject({ reviewReason: 'closed_before_delivery' });
        expect(events(file)).toEqual(expect.arrayContaining(['VisitDepart', 'CloseExecuted', 'VisitOpen']));
    });

    it('parked replay (protocol 7): an unresolvable badge is refused live and parked on replay', async () => {
        const file = await begin('parked_replay', [k1]);

        const live = await kiosk({ participantId: UNKNOWN_ID, clientEventId: cid('u-live'), scannedAt: iso(Date.now()), intent: 'IN' });
        expect(live.status).toBe(404);
        // The kiosk still shows the refused badge inside, so its next read is an OUT.
        const replayId = cid('u-replay');
        const parked = await kiosk({ participantId: UNKNOWN_ID, clientEventId: replayId, scannedAt: iso(Date.now()), replay: true, intent: 'OUT' });
        expect(parked.status).toBe(200);
        expect(parked.body).toMatchObject({ type: 'parked' });
        expect(await prisma.rawBadgeLog.findUnique({ where: { clientEventId: replayId } }))
            .toMatchObject({ personId: null, reviewReason: 'client_dead:unresolvable' });
        expect(events(file)).toEqual(['ScanRequest', 'ScanCommit', 'ScanRequest', 'ScanCommit']);
    });
});
