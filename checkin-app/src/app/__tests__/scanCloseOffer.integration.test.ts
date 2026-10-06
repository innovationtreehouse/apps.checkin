/**
 * @jest-environment node
 */
/**
 * A keyholder double-scans to close the building while another keyholder is
 * still recorded inside (a forgotten badge-out): the first badge checks them out
 * and offers the close, the second — inside the 3s debounce — closes everyone's
 * open visit. Live and offline-replayed (docs/rules/attendance-checkin.md).
 */
import { POST } from '@/app/api/scan/route';
import prisma from '@/lib/prisma';
import { authenticateRequest } from '@/lib/auth';

jest.mock('@/lib/auth', () => ({
    authenticateRequest: jest.fn(),
}));

jest.mock('@/lib/notifications', () => ({
    sendCheckinNotifications: jest.fn().mockResolvedValue(undefined),
    sendNotification: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/lib/logger', () => ({
    logBackendError: jest.fn(),
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const TAG = 'scan-close-offer-test';

function scanReq(body: Record<string, unknown>) {
    return new Request('http://localhost/api/scan', {
        method: 'POST',
        body: JSON.stringify(body),
    }) as unknown as import('next/server').NextRequest;
}

describe('keyholder double-scan closes with another keyholder recorded inside', () => {
    let k1: number;
    let k2: number;
    let member: number;
    const ids = () => [k1, k2, member];

    beforeAll(async () => {
        (authenticateRequest as jest.Mock).mockResolvedValue({ type: 'kiosk' });
        const mk = (name: string, isKeyholder: boolean) => prisma.person.create({
            data: { name, email: `${name}-${TAG}@example.com`, isKeyholder, isDeclaredAdult: true, household: { create: { name } } },
        });
        k1 = (await mk('k1', true)).id;
        k2 = (await mk('k2', true)).id;
        member = (await mk('member', false)).id;
    });

    beforeEach(async () => {
        await prisma.visit.createMany({
            data: ids().map(personId => ({ personId, arrivedAt: new Date(Date.now() - 3600_000), arrivedVia: 'SCANNER' as const })),
        });
    });

    afterEach(async () => {
        await prisma.presenceEvent.deleteMany({ where: { personId: { in: ids() } } });
        await prisma.visit.deleteMany({ where: { personId: { in: ids() } } });
        await prisma.rawBadgeLog.deleteMany({ where: { personId: { in: ids() } } });
    });

    afterAll(async () => {
        await prisma.person.deleteMany({ where: { id: { in: ids() } } });
        await prisma.$disconnect();
    });

    const openVisits = () => prisma.visit.count({ where: { personId: { in: ids() }, departedAt: null } });

    it('first badge checks out and offers the close; second badge closes the building', async () => {
        const first = await POST(scanReq({ participantId: k1, intent: 'OUT' }));
        const offer = await first.json();
        expect(offer.type).toBe('checkout');
        expect(offer.forceCloseToken).toEqual(expect.any(String));
        expect(await openVisits()).toBe(2);

        const second = await POST(scanReq({ participantId: k1, intent: 'OUT', forceCloseToken: offer.forceCloseToken }));
        const closed = await second.json();
        expect(closed.type).toBe('checkout');
        expect(closed.facilityClosed).toBe(true);
        expect(await openVisits()).toBe(0);
    });

    it('a single badge leaves the other keyholder and the room as they are', async () => {
        await POST(scanReq({ participantId: k1, intent: 'OUT' }));
        expect(await openVisits()).toBe(2);
    });

    it('closes on the offline replay: the OUT, then the kiosk-confirmed close', async () => {
        const t0 = Date.now() - 60_000;
        const replay = (n: number, extra: Record<string, unknown>) => scanReq({
            participantId: k1, intent: 'OUT', replay: true,
            clientEventId: `${TAG}-${n}`, scannedAt: new Date(t0 + n * 2000).toISOString(), ...extra,
        });

        expect((await (await POST(replay(1, {}))).json()).type).toBe('checkout');
        expect(await openVisits()).toBe(2);

        const closed = await (await POST(replay(2, { forceCloseConfirmed: true }))).json();
        expect(closed.facilityClosed).toBe(true);
        expect(await openVisits()).toBe(0);
    });
});
