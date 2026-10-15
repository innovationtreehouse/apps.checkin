/**
 * @jest-environment node
 */
/**
 * Causal-chain coverage for a keyholder's close: check-in → close request →
 * sweep → post-event emails, driven through the scan route.
 */
import { POST } from '@/app/api/scan/route';
import prisma from '@/lib/prisma';
import { authenticateRequest } from '@/lib/auth';
import { processPostEventEmails } from '@/lib/postEventEmails';
import { MAX_VISIT_MS } from '@/lib/visitTimes';
import type { Person } from '@/generated/prisma/client';

jest.mock('@/lib/auth', () => ({ authenticateRequest: jest.fn() }));
jest.mock('@/lib/notifications', () => ({
    sendCheckinNotifications: jest.fn().mockResolvedValue(undefined),
    sendNotification: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('@/lib/postEventEmails', () => ({
    processPostEventEmails: jest.fn().mockResolvedValue({ processed: 0 }),
}));
jest.mock('@/lib/logger', () => ({
    logBackendError: jest.fn(),
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const TAG = 'scan-causal-test';
const flush = () => new Promise(r => setImmediate(r));

function scanReq(participantId: number, extra: Record<string, unknown> = {}) {
    return new Request('http://localhost/api/scan', {
        method: 'POST',
        body: JSON.stringify({ participantId, ...extra }),
    }) as unknown as import('next/server').NextRequest;
}

describe('Scan causal chain — last isKeyholder closes facility', () => {
    let isKeyholder: Person;
    let normal: Person;
    const householdIds: number[] = [];

    beforeAll(async () => {
        (authenticateRequest as jest.Mock).mockResolvedValue({ type: 'kiosk' });
        isKeyholder = await prisma.person.create({
            data: { name: 'Causal Key', email: `key-${TAG}@example.com`, isKeyholder: true, household: { create: { name: "Test HH" } } },
        });
        householdIds.push(isKeyholder.householdId);
        normal = await prisma.person.create({
            data: { name: 'Causal Normal', email: `normal-${TAG}@example.com`, household: { create: { name: "Test HH" } } },
        });
        householdIds.push(normal.householdId);
    });

    beforeEach(() => {
        (authenticateRequest as jest.Mock).mockResolvedValue({ type: 'kiosk' });
        (processPostEventEmails as jest.Mock).mockClear();
    });

    afterEach(async () => {
        await prisma.visit.deleteMany({ where: { personId: { in: [isKeyholder.id, normal.id] } } });
        await prisma.rawBadgeLog.deleteMany({ where: { personId: { in: [isKeyholder.id, normal.id] } } });
    });

    afterAll(async () => {
        await prisma.person.deleteMany({ where: { id: { in: [isKeyholder.id, normal.id] } } });
        await prisma.household.deleteMany({ where: { id: { in: householdIds } } });
    });

    it('via the scan route: a lone isKeyholder checking out closes the facility and triggers post-event emails', async () => {
        // Check in.
        const inRes = await POST(scanReq(isKeyholder.id));
        expect((await inRes.json()).type).toBe('checkin');

        // Past the debounce window.
        await prisma.rawBadgeLog.updateMany({
            where: { personId: isKeyholder.id },
            data: { timestamp: new Date(Date.now() - 5000) },
        });

        // The kiosk showed nobody else: one scan closes.
        const outRes = await POST(scanReq(isKeyholder.id, { intent: 'OUT', close: 'alone' }));
        expect(outRes.status).toBe(200);
        const json = await outRes.json();
        expect(json.type).toBe('checkout');
        expect(json.facilityClosed).toBe(true);

        await flush(); // let the fire-and-forget dynamic import resolve
        expect(processPostEventEmails).toHaveBeenCalledWith({ forceImmediate: true });

        const open = await prisma.visit.count({ where: { personId: isKeyholder.id, departedAt: null } });
        expect(open).toBe(0);
    });

    it('a close request departs everyone the server records inside, then sends post-event emails', async () => {
        await prisma.visit.create({ data: { personId: isKeyholder.id, arrivedAt: new Date() } });
        await prisma.visit.create({ data: { personId: normal.id, arrivedAt: new Date() } });

        const res = await POST(scanReq(isKeyholder.id, { intent: 'OUT', close: 'alone' }));
        expect((await res.json()).facilityClosed).toBe(true);

        await flush();
        expect(processPostEventEmails).toHaveBeenCalledWith({ forceImmediate: true });
        const openAnyone = await prisma.visit.count({
            where: { personId: { in: [isKeyholder.id, normal.id] }, departedAt: null },
        });
        expect(openAnyone).toBe(0);
    });

    it('caps a >24h visit at arrival + MAX_VISIT_MS, stamps the rest at the close moment, and leaves a tombstone open', async () => {
        const stale = new Date(Date.now() - 30 * 60 * 60 * 1000);
        const beforeClose = Date.now();

        const kVisit = await prisma.visit.create({
            data: { personId: isKeyholder.id, arrivedAt: new Date() },
        });
        const staleVisit = await prisma.visit.create({ data: { personId: normal.id, arrivedAt: stale } });
        // Open AND tombstoned — the one-open-visit index only covers live rows.
        const tombstoned = await prisma.visit.create({
            data: { personId: normal.id, arrivedAt: stale, deletedAt: new Date() },
        });

        const res = await POST(scanReq(isKeyholder.id, { intent: 'OUT', close: 'confirmed' }));
        expect((await res.json()).facilityClosed).toBe(true);

        const capped = await prisma.visit.findUnique({ where: { id: staleVisit.id } });
        expect(capped?.departedAt).toEqual(new Date(stale.getTime() + MAX_VISIT_MS));
        expect(capped?.departedVia).toBe('FACILITY_CLOSE');

        // An in-range visit still takes the close moment itself.
        const sameDay = await prisma.visit.findUnique({ where: { id: kVisit.id } });
        expect(sameDay!.departedAt!.getTime()).toBeGreaterThanOrEqual(beforeClose);
        expect(sameDay!.departedAt!.getTime()).toBeLessThanOrEqual(Date.now());
        expect(sameDay?.departedVia).toBe('SCANNER');

        const untouched = await prisma.visit.findUnique({ where: { id: tombstoned.id } });
        expect(untouched?.departedAt).toBeNull();
    });

    it('a plain keyholder OUT with others inside checks out only the keyholder', async () => {
        await prisma.visit.create({ data: { personId: isKeyholder.id, arrivedAt: new Date() } });
        await prisma.visit.create({ data: { personId: normal.id, arrivedAt: new Date() } });

        const res = await POST(scanReq(isKeyholder.id, { intent: 'OUT', protocolVersion: 6 }));
        const json = await res.json();
        expect(json.type).toBe('checkout');
        expect(json.facilityClosed).toBe(false);

        expect(await prisma.visit.count({ where: { personId: normal.id, departedAt: null } })).toBe(1);
        expect(processPostEventEmails).not.toHaveBeenCalled();
    });

    it('the confirmed close lands inside the debounce window of the leaving scan', async () => {
        await prisma.visit.create({ data: { personId: isKeyholder.id, arrivedAt: new Date() } });
        await prisma.visit.create({ data: { personId: normal.id, arrivedAt: new Date() } });

        await POST(scanReq(isKeyholder.id, { intent: 'OUT' }));
        const closeRes = await POST(scanReq(isKeyholder.id, { intent: 'OUT', close: 'confirmed' }));
        expect((await closeRes.json()).facilityClosed).toBe(true);

        const open = await prisma.visit.count({
            where: { personId: { in: [isKeyholder.id, normal.id] }, departedAt: null },
        });
        expect(open).toBe(0);
    });
});
