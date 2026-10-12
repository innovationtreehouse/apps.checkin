/**
 * @jest-environment node
 */
/**
 * Causal-chain coverage for the last-isKeyholder checkout: check-in → facility
 * close → post-event emails, plus the "others are still here" leave branch.
 * Previously post-event emails were only tested in isolation with a hand-seeded
 * visit; the trigger from an actual checkout was never exercised.
 */
import { POST } from '@/app/api/scan/route';
import { processCheckout } from '@/lib/scan-service';
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

function scanReq(participantId: number, forceCloseToken?: string, intent?: 'IN' | 'OUT', extra: Record<string, unknown> = {}) {
    return new Request('http://localhost/api/scan', {
        method: 'POST',
        body: JSON.stringify({ participantId, ...(forceCloseToken ? { forceCloseToken } : {}), ...(intent ? { intent } : {}), ...extra }),
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

        // Check out → last isKeyholder, nobody else present → facility closes.
        const outRes = await POST(scanReq(isKeyholder.id));
        expect(outRes.status).toBe(200);
        const json = await outRes.json();
        expect(json.type).toBe('checkout');
        expect(json.facilityClosed).toBe(true);

        await flush(); // let the fire-and-forget dynamic import resolve
        expect(processPostEventEmails).toHaveBeenCalledWith({ forceImmediate: true });

        const open = await prisma.visit.count({ where: { personId: isKeyholder.id, departedAt: null } });
        expect(open).toBe(0);
    });

    it('force-closes (departing everyone) when the scan echoes the confirm token, then sends post-event emails', async () => {
        const kVisit = await prisma.visit.create({
            data: {
                personId: isKeyholder.id, arrivedAt: new Date(),
                forceCloseWarnedAt: new Date(Date.now() - 5000), forceCloseToken: 'confirm-me',
            },
        });
        await prisma.visit.create({ data: { personId: normal.id, arrivedAt: new Date() } });

        const res = await processCheckout(isKeyholder, kVisit.id, 'kiosk', undefined, 'confirm-me');
        const json = await res.json();
        expect(json.facilityClosed).toBe(true);

        await flush();
        expect(processPostEventEmails).toHaveBeenCalledWith({ forceImmediate: true });

        // Everyone is departedAt, including the other attendee.
        const openAnyone = await prisma.visit.count({
            where: { personId: { in: [isKeyholder.id, normal.id] }, departedAt: null },
        });
        expect(openAnyone).toBe(0);
    });

    it('caps a >24h visit at arrival + MAX_VISIT_MS, stamps the rest at the close moment, and leaves a tombstone open', async () => {
        const stale = new Date(Date.now() - 30 * 60 * 60 * 1000);
        const beforeClose = Date.now();

        const kVisit = await prisma.visit.create({
            data: { personId: isKeyholder.id, arrivedAt: new Date(), forceCloseToken: 'confirm-me' },
        });
        const staleVisit = await prisma.visit.create({ data: { personId: normal.id, arrivedAt: stale } });
        // Open AND tombstoned — the one-open-visit index only covers live rows.
        const tombstoned = await prisma.visit.create({
            data: { personId: normal.id, arrivedAt: stale, deletedAt: new Date() },
        });

        const res = await processCheckout(isKeyholder, kVisit.id, 'kiosk', undefined, 'confirm-me');
        expect((await res.json()).facilityClosed).toBe(true);

        const capped = await prisma.visit.findUnique({ where: { id: staleVisit.id } });
        expect(capped?.departedAt).toEqual(new Date(stale.getTime() + MAX_VISIT_MS));
        expect(capped?.departedVia).toBe('FACILITY_CLOSE');

        // An in-range visit still takes the close moment itself.
        const sameDay = await prisma.visit.findUnique({ where: { id: kVisit.id } });
        expect(sameDay!.departedAt!.getTime()).toBeGreaterThanOrEqual(beforeClose);
        expect(sameDay!.departedAt!.getTime()).toBeLessThanOrEqual(Date.now());
        expect(sameDay?.departedVia).toBe('FACILITY_CLOSE');

        const untouched = await prisma.visit.findUnique({ where: { id: tombstoned.id } });
        expect(untouched?.departedAt).toBeNull();
    });

    it('checks the keyholder out and offers the close when others are present and no offer has been shown', async () => {
        const kVisit = await prisma.visit.create({ data: { personId: isKeyholder.id, arrivedAt: new Date() } });
        await prisma.visit.create({ data: { personId: normal.id, arrivedAt: new Date() } });
        // An ordinary double-tap: two badge events 5s apart, no offer behind them.
        await prisma.rawBadgeLog.create({ data: { personId: isKeyholder.id, timestamp: new Date(Date.now() - 5000) } });
        await prisma.rawBadgeLog.create({ data: { personId: isKeyholder.id, timestamp: new Date() } });

        const res = await processCheckout(isKeyholder, kVisit.id, 'kiosk');
        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.type).toBe('checkout');
        expect(json.facilityClosed).toBe(false);
        expect(json.closePrompt).toContain('No other keyholder is checked in');

        // Only the keyholder left: the other visit stays open and no emails fired.
        expect(await prisma.visit.count({ where: { personId: isKeyholder.id, departedAt: null } })).toBe(0);
        expect(await prisma.visit.count({ where: { personId: normal.id, departedAt: null } })).toBe(1);
        expect(processPostEventEmails).not.toHaveBeenCalled();

        // The offer's token rides the departed visit; only a scan echoing it may confirm.
        const stamped = await prisma.visit.findUnique({ where: { id: kVisit.id } });
        expect(stamped?.departedVia).toBe('SCANNER');
        expect(stamped?.forceCloseToken).toEqual(json.forceCloseToken);

        // The leave is audited, the handover not named.
        const audit = await prisma.auditLog.findFirst({ where: { tableName: 'Visit', affectedEntityId: kVisit.id }, orderBy: { id: 'desc' } });
        expect(audit?.newData).toEqual({ type: 'last_keyholder_choice', choice: 'leave', via: 'KIOSK', handoverToId: null, othersInside: 1 });
        await prisma.auditLog.deleteMany({ where: { tableName: 'Visit', affectedEntityId: kVisit.id } });
    });

    it('confirms through the route inside the debounce window — the token is the confirm, not the gap', async () => {
        await prisma.visit.create({ data: { personId: isKeyholder.id, arrivedAt: new Date() } });
        await prisma.visit.create({ data: { personId: normal.id, arrivedAt: new Date() } });

        const offerRes = await POST(scanReq(isKeyholder.id, undefined, 'OUT'));
        expect(offerRes.status).toBe(200);
        const offer = await offerRes.json();

        // Badge again immediately: inside the 3s debounce, which would swallow an
        // untokened scan. The confirm carries the token, so it lands.
        const closeRes = await POST(scanReq(isKeyholder.id, offer.forceCloseToken, 'OUT'));
        expect((await closeRes.json()).facilityClosed).toBe(true);

        const open = await prisma.visit.count({
            where: { personId: { in: [isKeyholder.id, normal.id] }, departedAt: null },
        });
        expect(open).toBe(0);
    });

    it('closes on one live badge the kiosk showed with nobody else inside, departing who the server still records', async () => {
        await prisma.visit.create({ data: { personId: isKeyholder.id, arrivedAt: new Date() } });
        await prisma.visit.create({ data: { personId: normal.id, arrivedAt: new Date() } });

        const res = await POST(scanReq(isKeyholder.id, undefined, 'OUT', { shownEmpty: true }));
        expect(await res.json()).toMatchObject({ type: 'checkout', facilityClosed: true });

        const open = await prisma.visit.count({
            where: { personId: { in: [isKeyholder.id, normal.id] }, departedAt: null },
        });
        expect(open).toBe(0);
    });

    it('leaves and offers the close on one live badge the kiosk showed with others, though the server records nobody', async () => {
        const kVisit = await prisma.visit.create({ data: { personId: isKeyholder.id, arrivedAt: new Date() } });

        const res = await POST(scanReq(isKeyholder.id, undefined, 'OUT', { shownEmpty: false }));
        const body = await res.json();
        expect(body).toMatchObject({ type: 'checkout', facilityClosed: false });
        expect(body.forceCloseToken).toEqual(expect.any(String));
        expect(processPostEventEmails).not.toHaveBeenCalled();
        await prisma.auditLog.deleteMany({ where: { tableName: 'Visit', affectedEntityId: kVisit.id } });
    });
});
