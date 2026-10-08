/**
 * @jest-environment node
 */
/**
 * Integration tests for POST /api/scan that exercise the REAL check-in /
 * check-out logic in scan-service.ts against a live database.
 *
 * The pre-existing scanRoute.test.ts mocks processCheckin/processCheckout away,
 * so the facility-open gate, visit creation, the check-in→check-out transition,
 * and the debounce all went untested. These tests close that gap. Authentication
 * is mocked to a kiosk identity so the focus stays on the scan state machine.
 */
import { POST } from '@/app/api/scan/route';
import prisma from '@/lib/prisma';
import { authenticateRequest } from '@/lib/auth';

jest.mock('@/lib/auth', () => ({
    authenticateRequest: jest.fn(),
}));

// Keep notification side effects out of the DB assertions.
jest.mock('@/lib/notifications', () => ({
    sendCheckinNotifications: jest.fn().mockResolvedValue(undefined),
    sendNotification: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/lib/logger', () => ({
    logBackendError: jest.fn(),
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const TAG = 'scan-checkin-test';

function scanReq(participantId: unknown) {
    return new Request('http://localhost/api/scan', {
        method: 'POST',
        body: JSON.stringify({ participantId }),
    }) as unknown as import('next/server').NextRequest;
}

describe('POST /api/scan — real check-in/out logic', () => {
    let keyholderId: number;
    let normalId: number;
    let keyholderHouseholdId: number;
    let normalHouseholdId: number;

    beforeAll(async () => {
        (authenticateRequest as jest.Mock).mockResolvedValue({ type: 'kiosk' });

        const isKeyholder = await prisma.person.create({
            data: {
                name: 'Keyholder Scan',
                email: `isKeyholder-${TAG}@example.com`,
                isKeyholder: true,
                household: { create: { name: "Test HH" } },
            },
        });
        keyholderId = isKeyholder.id;
        keyholderHouseholdId = isKeyholder.householdId;

        const normal = await prisma.person.create({
            data: {
                name: 'Normal Scan',
                email: `normal-${TAG}@example.com`,
                household: { create: { name: "Test HH" } },
            },
        });
        normalId = normal.id;
        normalHouseholdId = normal.householdId;
    });

    afterEach(async () => {
        // Reset facility state between cases so each test controls who is present.
        await prisma.visit.deleteMany({ where: { personId: { in: [keyholderId, normalId] } } });
        await prisma.rawBadgeLog.deleteMany({ where: { personId: { in: [keyholderId, normalId] } } });
    });

    afterAll(async () => {
        await prisma.visit.deleteMany({ where: { personId: { in: [keyholderId, normalId] } } });
        await prisma.rawBadgeLog.deleteMany({ where: { personId: { in: [keyholderId, normalId] } } });
        await prisma.person.deleteMany({ where: { id: { in: [keyholderId, normalId] } } });
        await prisma.household.deleteMany({ where: { id: { in: [keyholderHouseholdId, normalHouseholdId] } } });
    });

    it('checks in a non-keyholder kiosk scan with no keyholder present', async () => {
        const res = await POST(scanReq(normalId));
        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.type).toBe('checkin');

        const visits = await prisma.visit.count({ where: { personId: normalId, departedAt: null } });
        expect(visits).toBe(1);
        const badge = await prisma.rawBadgeLog.findFirst({
            where: { personId: normalId },
            orderBy: { timestamp: 'desc' },
        });
        expect(badge?.reviewReason).toBeNull();
        await prisma.visit.deleteMany({ where: { personId: normalId } });
    });

    it('lets a isKeyholder check in (opening the facility) and creates an open visit', async () => {
        const res = await POST(scanReq(keyholderId));
        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.type).toBe('checkin');

        const visit = await prisma.visit.findFirst({ where: { personId: keyholderId } });
        expect(visit).not.toBeNull();
        expect(visit?.departedAt).toBeNull();
    });

    it('orders check-in then check-out on a second scan: arrivedAt set first, departedAt after', async () => {
        // Seed an open isKeyholder visit so the facility is open for the normal user.
        await prisma.visit.create({ data: { personId: keyholderId, arrivedAt: new Date() } });

        // First scan → check-in.
        const checkinRes = await POST(scanReq(normalId));
        expect(checkinRes.status).toBe(200);
        expect((await checkinRes.json()).type).toBe('checkin');

        const openVisit = await prisma.visit.findFirst({
            where: { personId: normalId, departedAt: null },
        });
        expect(openVisit).not.toBeNull();
        expect(openVisit?.arrivedAt).toBeInstanceOf(Date);

        // Backdate the badge event so the second scan is past the 3s debounce window.
        await prisma.rawBadgeLog.updateMany({
            where: { personId: normalId },
            data: { timestamp: new Date(Date.now() - 5000) },
        });

        // Second scan → check-out.
        const checkoutRes = await POST(scanReq(normalId));
        expect(checkoutRes.status).toBe(200);
        expect((await checkoutRes.json()).type).toBe('checkout');

        const closedVisit = await prisma.visit.findFirst({
            where: { personId: normalId },
            orderBy: { arrivedAt: 'desc' },
        });
        expect(closedVisit?.departedAt).toBeInstanceOf(Date);
        // Ordering invariant: departure never precedes arrival.
        expect(closedVisit!.departedAt!.getTime()).toBeGreaterThanOrEqual(closedVisit!.arrivedAt.getTime());
    });

    it('silently debounces a repeated scan within 3 seconds (no second visit)', async () => {
        await prisma.visit.create({ data: { personId: keyholderId, arrivedAt: new Date() } });

        const first = await POST(scanReq(normalId));
        expect((await first.json()).type).toBe('checkin');

        const second = await POST(scanReq(normalId));
        expect(second.status).toBe(200);
        const json = await second.json();
        expect(json.type).toBe('ignored_debounce');

        // The debounced scan must NOT have flipped the open visit to checked-out.
        const open = await prisma.visit.count({ where: { personId: normalId, departedAt: null } });
        expect(open).toBe(1);
    });

    it('returns 404 for an unknown participant id', async () => {
        const res = await POST(scanReq(99999999));
        expect(res.status).toBe(404);
        const json = await res.json();
        expect(json.error).toMatch(/not found/i);
    });
});
