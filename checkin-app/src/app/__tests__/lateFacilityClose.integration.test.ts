/**
 * @jest-environment node
 */
/**
 * A facility close confirmed by the last keyholder at the kiosk applies whenever
 * it reaches the server, past the replay freshness window, and departs everyone
 * at the keyholder's scan time (docs/rules/attendance-checkin.md, kiosk
 * resilience). Unconfirmed stale replays still park.
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
jest.mock('@/lib/postEventEmails', () => ({ processPostEventEmails: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/lib/logger', () => ({
    logBackendError: jest.fn(),
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const TAG = 'late-close-test';
const HOUR = 3_600_000;

function scanReq(body: Record<string, unknown>) {
    return new Request('http://localhost/api/scan', {
        method: 'POST',
        body: JSON.stringify(body),
    }) as unknown as import('next/server').NextRequest;
}

describe('Late confirmed facility close (real DB)', () => {
    let keyholder: Person;
    let member: Person;
    let lateComer: Person;
    let opener: Person;
    let people: Person[];

    beforeAll(async () => {
        (authenticateRequest as jest.Mock).mockResolvedValue({ type: 'kiosk' });
        const mk = (name: string, isKeyholder: boolean) => prisma.person.create({
            data: { name, email: `${name.toLowerCase()}-${TAG}@example.com`, isKeyholder, household: { create: { name: 'Test HH' } } },
        });
        keyholder = await mk('Key', true);
        member = await mk('Member', false);
        lateComer = await mk('Late', false);
        opener = await mk('Opener', true);
        people = [keyholder, member, lateComer, opener];
    });

    // The sweep is facility-wide: start every test from an empty building.
    beforeEach(async () => {
        await prisma.visit.updateMany({ where: { departedAt: null }, data: { departedAt: new Date(0) } });
    });

    afterEach(async () => {
        const ids = people.map(p => p.id);
        await prisma.presenceEvent.deleteMany({ where: { personId: { in: ids } } });
        await prisma.visit.deleteMany({ where: { personId: { in: ids } } });
        await prisma.rawBadgeLog.deleteMany({ where: { personId: { in: ids } } });
    });

    afterAll(async () => {
        await prisma.person.deleteMany({ where: { id: { in: people.map(p => p.id) } } });
        await prisma.household.deleteMany({ where: { id: { in: people.map(p => p.householdId) } } });
    });

    /** Keyholder + member in since 5h ago; lateComer arrived 1h ago, after the close. */
    async function occupy(departed?: { at: Date; via: 'AUTO_CLOSE' }) {
        const at = new Date(Date.now() - 5 * HOUR);
        const done = departed ? { departedAt: departed.at, departedVia: departed.via } : {};
        await prisma.visit.create({ data: { personId: keyholder.id, arrivedAt: at, arrivedVia: 'SCANNER', forceCloseToken: 'tok-1', ...done } });
        await prisma.visit.create({ data: { personId: member.id, arrivedAt: at, arrivedVia: 'SCANNER', ...done } });
        await prisma.visit.create({ data: { personId: lateComer.id, arrivedAt: new Date(Date.now() - HOUR), arrivedVia: 'SCANNER', ...done } });
    }

    const visitOf = (p: Person) => prisma.visit.findFirstOrThrow({ where: { personId: p.id } });

    it.each([
        ['offline confirm', { forceCloseConfirmed: true }],
        ['echoed server token', { forceCloseToken: 'tok-1' }],
        ['offline confirm with intent', { forceCloseConfirmed: true, intent: 'OUT' }],
        ['offline confirm on a suspect clock', { forceCloseConfirmed: true, clockSuspect: true }],
    ])('a stale %s closes the facility at the keyholder\'s scan time', async (_label, extra) => {
        await occupy();
        const scannedAt = new Date(Date.now() - 3 * HOUR);
        const res = await POST(scanReq({ participantId: keyholder.id, clientEventId: `evt-${_label}`, scannedAt: scannedAt.toISOString(), replay: true, ...extra }));
        const body = await res.json();
        expect(body).toMatchObject({ type: 'checkout', facilityClosed: true });

        expect((await visitOf(keyholder)).departedAt?.getTime()).toBe(scannedAt.getTime());
        const m = await visitOf(member);
        expect(m.departedAt?.getTime()).toBe(scannedAt.getTime());
        expect(m.departedVia).toBe('FACILITY_CLOSE');
        // Arrived after the close with no keyholder since: departs when the close arrives.
        expect((await visitOf(lateComer)).departedAt?.getTime()).toBeGreaterThan(Date.now() - 60_000);
    });

    it('leaves a reopened building alone, and the opener does not block the late close', async () => {
        await occupy();
        await prisma.visit.create({ data: { personId: opener.id, arrivedAt: new Date(Date.now() - 2 * HOUR), arrivedVia: 'SCANNER' } });
        const scannedAt = new Date(Date.now() - 3 * HOUR);
        const res = await POST(scanReq({ participantId: keyholder.id, clientEventId: 'evt-reopened', scannedAt: scannedAt.toISOString(), replay: true, forceCloseToken: 'tok-1' }));
        expect(await res.json()).toMatchObject({ type: 'checkout', facilityClosed: true });

        expect((await visitOf(member)).departedAt?.getTime()).toBe(scannedAt.getTime());
        expect((await visitOf(opener)).departedAt).toBeNull();
        expect((await visitOf(lateComer)).departedAt).toBeNull();
    });

    it('parks a confirmed close whose scan time is ahead of server now (fast kiosk clock)', async () => {
        await occupy();
        const scannedAt = new Date(Date.now() + 3 * HOUR);
        const res = await POST(scanReq({ participantId: keyholder.id, clientEventId: 'evt-fast', scannedAt: scannedAt.toISOString(), replay: true, forceCloseConfirmed: true }));
        expect((await res.json()).type).toBe('parked');
        expect((await visitOf(keyholder)).departedAt).toBeNull();
        expect((await visitOf(member)).departedAt).toBeNull();
        const log = await prisma.rawBadgeLog.findUnique({ where: { clientEventId: 'evt-fast' } });
        expect(log?.reviewReason).toBe('clock_suspect');
    });

    it('an unconfirmed stale keyholder replay still parks', async () => {
        await occupy();
        const scannedAt = new Date(Date.now() - 3 * HOUR);
        const res = await POST(scanReq({ participantId: keyholder.id, clientEventId: 'evt-unconfirmed', scannedAt: scannedAt.toISOString(), replay: true }));
        expect((await res.json()).type).toBe('parked');
        expect((await visitOf(keyholder)).departedAt).toBeNull();
        expect((await visitOf(member)).departedAt).toBeNull();
        const log = await prisma.rawBadgeLog.findUnique({ where: { clientEventId: 'evt-unconfirmed' } });
        expect(log?.reviewReason).toBe('stale_replay');
    });

    it('pulls the nightly cron\'s AUTO_CLOSE departures back to the keyholder\'s scan time', async () => {
        const cronAt = new Date(Date.now() - 30 * 60_000);
        await occupy({ at: cronAt, via: 'AUTO_CLOSE' });
        const scannedAt = new Date(Date.now() - 3 * HOUR);
        const res = await POST(scanReq({ participantId: keyholder.id, clientEventId: 'evt-cron', scannedAt: scannedAt.toISOString(), replay: true, forceCloseConfirmed: true, intent: 'OUT' }));
        expect(await res.json()).toMatchObject({ type: 'checkout', facilityClosed: true });

        for (const p of [keyholder, member]) {
            const v = await visitOf(p);
            expect(v.departedAt?.getTime()).toBe(scannedAt.getTime());
            expect(v.departedVia).toBe('FACILITY_CLOSE');
        }
        const late = await visitOf(lateComer);
        expect(late.departedAt?.getTime()).toBe(cronAt.getTime());
        expect(late.departedVia).toBe('AUTO_CLOSE');
    });

    it('leaves a member-corrected departure alone', async () => {
        const cronAt = new Date(Date.now() - 30 * 60_000);
        await occupy({ at: cronAt, via: 'AUTO_CLOSE' });
        const typedAt = new Date(Date.now() - 2 * HOUR);
        await prisma.visit.updateMany({ where: { personId: member.id }, data: { departedAt: typedAt, departedVia: 'TYPED' } });
        const scannedAt = new Date(Date.now() - 3 * HOUR);
        await POST(scanReq({ participantId: keyholder.id, clientEventId: 'evt-typed', scannedAt: scannedAt.toISOString(), replay: true, forceCloseConfirmed: true }));

        expect((await visitOf(member)).departedAt?.getTime()).toBe(typedAt.getTime());
    });

    it('a wrong token against a cron-closed visit parks for review and changes nothing', async () => {
        const cronAt = new Date(Date.now() - 30 * 60_000);
        await occupy({ at: cronAt, via: 'AUTO_CLOSE' });
        const scannedAt = new Date(Date.now() - 3 * HOUR);
        const res = await POST(scanReq({ participantId: keyholder.id, clientEventId: 'evt-badtok', scannedAt: scannedAt.toISOString(), replay: true, forceCloseToken: 'nope' }));
        expect((await res.json()).type).toBe('parked');
        expect((await visitOf(member)).departedAt?.getTime()).toBe(cronAt.getTime());
        const log = await prisma.rawBadgeLog.findUnique({ where: { clientEventId: 'evt-badtok' } });
        expect(log?.reviewReason).toBe('force_close_review');
    });
});
