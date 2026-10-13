/**
 * @jest-environment node
 */
/**
 * A facility close confirmed by the last keyholder at the kiosk applies whenever
 * it reaches the server, past the replay freshness window, and departs everyone
 * at the keyholder's scan time (docs/rules/attendance-checkin.md, kiosk
 * resilience) — but never anyone who arrived after it. That includes a confirm
 * arriving after the keyholder's own badge already checked them out and offered
 * the close, and a keyholder's late OUT the kiosk showed with nobody else
 * inside. A close fences a late check-in scanned before it. Unconfirmed
 * intent-less stale replays still park.
 */
import { POST } from '@/app/api/scan/route';
import prisma from '@/lib/prisma';
import { authenticateRequest } from '@/lib/auth';
import { LATE_CLOSE_SKEW_MS } from '@/lib/scan-service';
import { SCAN_PROTOCOL_VERSION } from '@/lib/scanProtocol';
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
        await prisma.facilityClose.updateMany({ where: { closedAt: { gt: new Date(Date.now() - 2 * 86_400_000) } }, data: { closedAt: new Date(0) } });
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

    /** Keyholder + member in since 5h ago; lateComer arrived 1h ago, after the close (3h ago). */
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
        // Badged in after lock-up: a late close never ends a visit that began after it.
        expect((await visitOf(lateComer)).departedAt).toBeNull();
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

    it('departs an arrival inside the clock-skew allowance, never before it arrived', async () => {
        await occupy();
        const scannedAt = new Date(Date.now() - 3 * HOUR);
        const skewed = new Date(scannedAt.getTime() + LATE_CLOSE_SKEW_MS - 1000);
        await prisma.visit.update({ where: { id: (await visitOf(lateComer)).id }, data: { arrivedAt: skewed } });
        const res = await POST(scanReq({ participantId: keyholder.id, clientEventId: 'evt-skew', scannedAt: scannedAt.toISOString(), replay: true, forceCloseConfirmed: true }));
        expect(await res.json()).toMatchObject({ type: 'checkout', facilityClosed: true });

        const late = await visitOf(lateComer);
        expect(late.departedAt?.getTime()).toBe(skewed.getTime());
        expect(late.departedVia).toBe('FACILITY_CLOSE');
    });

    it('closes at server now when the confirmed close is stamped ahead of it (fast kiosk clock)', async () => {
        await occupy();
        const before = Date.now();
        const res = await POST(scanReq({ participantId: keyholder.id, clientEventId: 'evt-fast', scannedAt: new Date(before + 3 * HOUR).toISOString(), replay: true, forceCloseConfirmed: true, protocolVersion: SCAN_PROTOCOL_VERSION }));
        expect(await res.json()).toMatchObject({ type: 'checkout', facilityClosed: true });
        const departed = (await visitOf(member)).departedAt!.getTime();
        expect(departed).toBeGreaterThanOrEqual(before);
        expect(departed).toBeLessThanOrEqual(Date.now());
        // Applied, never silently: the doubtful clock goes to review.
        expect((await prisma.rawBadgeLog.findUnique({ where: { clientEventId: 'evt-fast' } }))?.reviewReason).toBe('clock_suspect');
    });

    // The last keyholder leaving closes the building,
    // however late that scan arrives, and is not held or flagged for review.
    it.each([
        ['open visit', undefined],
        ['cron-closed visit', 'cron'],
    ])('a late shownEmpty OUT from an %s closes at the scan time, unflagged, past others still recorded', async (_label, cron) => {
        const cronAt = new Date(Date.now() - 30 * 60_000);
        await occupy(cron ? { at: cronAt, via: 'AUTO_CLOSE' } : undefined);
        // A keyholder who forgot to badge out; the kiosk did not show them.
        await prisma.visit.create({ data: { personId: opener.id, arrivedAt: new Date(Date.now() - 4 * HOUR), arrivedVia: 'SCANNER', ...(cron ? { departedAt: cronAt, departedVia: 'AUTO_CLOSE' as const } : {}) } });
        const scannedAt = new Date(Date.now() - 3 * HOUR);
        const id = `evt-last-${_label}`;
        const res = await POST(scanReq({ participantId: keyholder.id, clientEventId: id, scannedAt: scannedAt.toISOString(), replay: true, intent: 'OUT', shownEmpty: true }));
        expect(await res.json()).toMatchObject({ type: 'checkout', facilityClosed: true });

        for (const p of [keyholder, member, opener]) {
            expect((await visitOf(p)).departedAt?.getTime()).toBe(scannedAt.getTime());
        }
        expect((await visitOf(member)).departedVia).toBe('FACILITY_CLOSE');
        expect((await prisma.rawBadgeLog.findUnique({ where: { clientEventId: id } }))?.reviewReason).toBeNull();
    });

    it('a late keyholder OUT shown with others and no second scan leaves without closing, flagged', async () => {
        await occupy();
        const scannedAt = new Date(Date.now() - 3 * HOUR);
        const res = await POST(scanReq({ participantId: keyholder.id, clientEventId: 'evt-not-empty', scannedAt: scannedAt.toISOString(), replay: true, intent: 'OUT', shownEmpty: false, protocolVersion: SCAN_PROTOCOL_VERSION }));
        expect(await res.json()).toMatchObject({ type: 'checkout', facilityClosed: false });
        expect((await visitOf(keyholder)).departedAt?.getTime()).toBe(scannedAt.getTime());
        expect((await visitOf(member)).departedAt).toBeNull();
        expect((await prisma.rawBadgeLog.findUnique({ where: { clientEventId: 'evt-not-empty' } }))?.reviewReason).toBe('force_close_review');
    });

    describe('a close fences a late check-in scanned before it', () => {
        const closeAt = () => new Date(Date.now() - 2 * HOUR);
        const closeRow = (at: Date) => prisma.facilityClose.create({ data: { closedAt: at, closedById: keyholder.id, via: 'KIOSK' } });
        const inReplay = (id: string, at: Date, intent: 'IN' | 'OUT' = 'IN') =>
            POST(scanReq({ participantId: lateComer.id, clientEventId: id, scannedAt: at.toISOString(), replay: true, intent, protocolVersion: SCAN_PROTOCOL_VERSION }));
        const reasonOf = async (id: string) => (await prisma.rawBadgeLog.findUnique({ where: { clientEventId: id } }))?.reviewReason;

        afterEach(async () => {
            await prisma.visit.deleteMany({ where: { personId: lateComer.id } });
            await prisma.facilityClose.deleteMany({ where: { closedById: keyholder.id } });
        });

        it('an IN scanned before a close departs at that close, flagged', async () => {
            const at = closeAt();
            const close = await closeRow(at);
            const scannedAt = new Date(at.getTime() - HOUR);
            expect((await (await inReplay('evt-fence-before', scannedAt)).json()).type).toBe('checkin');

            const v = await visitOf(lateComer);
            expect(v.arrivedAt.getTime()).toBe(scannedAt.getTime());
            expect(v.departedAt?.getTime()).toBe(at.getTime());
            expect(v.departedVia).toBe('FACILITY_CLOSE');
            expect(v.facilityCloseId).toBe(close.id);
            expect(await reasonOf('evt-fence-before')).toBe('closed_before_delivery');
        });

        it('an IN scanned after a close opens a visit as usual', async () => {
            const at = closeAt();
            await closeRow(at);
            const scannedAt = new Date(at.getTime() + HOUR);
            expect((await (await inReplay('evt-fence-after', scannedAt)).json()).type).toBe('checkin');

            const v = await visitOf(lateComer);
            expect(v.arrivedAt.getTime()).toBe(scannedAt.getTime());
            expect(v.departedAt).toBeNull();
            expect(await reasonOf('evt-fence-after')).toBe('stale_replay');
        });

        it('the same person\'s queued OUT before the close pulls the fenced departure back to it', async () => {
            const at = closeAt();
            await closeRow(at);
            await inReplay('evt-fence-in', new Date(at.getTime() - HOUR));
            const outAt = new Date(at.getTime() - 30 * 60_000);
            expect((await (await inReplay('evt-fence-out', outAt, 'OUT')).json()).type).toBe('checkout');

            const v = await visitOf(lateComer);
            expect(v.departedAt?.getTime()).toBe(outAt.getTime());
            expect(v.departedVia).toBe('SCANNER');
            expect(v.facilityCloseId).toBeNull();
            expect(await reasonOf('evt-fence-out')).toBe('out_of_order');
        });
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

    describe('after the keyholder\'s own badge checked them out and offered the close', () => {
        const leaveAt = () => new Date(Date.now() - 3 * HOUR);

        /** The leave at `leftAt` departed the keyholder by scan, the offer's token on the visit. */
        async function leftByBadge(leftAt: Date) {
            await occupy();
            await prisma.visit.updateMany({ where: { personId: keyholder.id }, data: { departedAt: leftAt, departedVia: 'SCANNER' } });
        }

        it.each([
            ['offer token', { forceCloseToken: 'tok-1' }],
            ['offline confirm', { forceCloseConfirmed: true }],
        ])('a stale confirm with the %s closes at the confirm\'s scan time', async (label, extra) => {
            const leftAt = leaveAt();
            await leftByBadge(leftAt);
            const scannedAt = new Date(leftAt.getTime() + 5_000);
            const res = await POST(scanReq({ participantId: keyholder.id, clientEventId: `evt-left-${label}`, scannedAt: scannedAt.toISOString(), replay: true, intent: 'OUT', ...extra }));
            expect(await res.json()).toMatchObject({ type: 'checkout', facilityClosed: true });

            const k = await visitOf(keyholder);
            expect(k.departedAt?.getTime()).toBe(leftAt.getTime());
            expect(k.departedVia).toBe('SCANNER');
            expect(k.forceCloseToken).toBeNull();
            const m = await visitOf(member);
            expect(m.departedAt?.getTime()).toBe(scannedAt.getTime());
            expect(m.departedVia).toBe('FACILITY_CLOSE');
            expect((await visitOf(lateComer)).departedAt).toBeNull();
        });

        it('a wrong token parks for review and changes nothing', async () => {
            const leftAt = leaveAt();
            await leftByBadge(leftAt);
            const scannedAt = new Date(leftAt.getTime() + 5_000);
            const res = await POST(scanReq({ participantId: keyholder.id, clientEventId: 'evt-left-badtok', scannedAt: scannedAt.toISOString(), replay: true, intent: 'OUT', forceCloseToken: 'nope' }));
            expect((await res.json()).type).toBe('parked');
            expect((await visitOf(member)).departedAt).toBeNull();
            const log = await prisma.rawBadgeLog.findUnique({ where: { clientEventId: 'evt-left-badtok' } });
            expect(log?.reviewReason).toBe('force_close_review');
        });

        it('closes against the latest departure, not the latest arrival', async () => {
            const leftAt = leaveAt();
            await leftByBadge(leftAt);
            const current = await visitOf(keyholder);
            // Backdated: the current visit arrived before an older one that left earlier.
            await prisma.visit.update({ where: { id: current.id }, data: { arrivedAt: new Date(Date.now() - 7 * HOUR) } });
            const older = await prisma.visit.create({ data: {
                personId: keyholder.id, arrivedAt: new Date(Date.now() - 6 * HOUR), arrivedVia: 'SCANNER',
                departedAt: new Date(Date.now() - 4 * HOUR), departedVia: 'SCANNER', forceCloseToken: 'tok-old',
            } });
            const scannedAt = new Date(leftAt.getTime() + 5_000);
            const res = await POST(scanReq({ participantId: keyholder.id, clientEventId: 'evt-left-backdated', scannedAt: scannedAt.toISOString(), replay: true, intent: 'OUT', forceCloseToken: 'tok-1' }));
            expect(await res.json()).toMatchObject({ type: 'checkout', facilityClosed: true });

            expect((await prisma.visit.findUniqueOrThrow({ where: { id: current.id } })).forceCloseToken).toBeNull();
            expect((await prisma.visit.findUniqueOrThrow({ where: { id: older.id } })).forceCloseToken).toBe('tok-old');
            expect((await visitOf(member)).departedAt?.getTime()).toBe(scannedAt.getTime());
        });

        it('a badge departure after the confirm\'s scan time is not the one that offered it', async () => {
            const leftAt = leaveAt();
            await leftByBadge(leftAt);
            const scannedAt = new Date(leftAt.getTime() - 60_000);
            const res = await POST(scanReq({ participantId: keyholder.id, clientEventId: 'evt-left-before', scannedAt: scannedAt.toISOString(), replay: true, intent: 'OUT', forceCloseToken: 'tok-1' }));
            expect((await res.json()).type).toBe('parked');
            expect((await visitOf(member)).departedAt).toBeNull();
        });
    });
});
