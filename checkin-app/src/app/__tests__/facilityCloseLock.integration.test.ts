/**
 * @jest-environment node
 */
/**
 * Cross-participant race: last-keyholder force-close vs a concurrent
 * non-keyholder check-in (#254).
 *
 * The person-level advisory lock does not serialize these two transactions;
 * the facility lock does. The check-in lands wholly before the sweep (and is
 * swept) or wholly after it (an open no-keyholder visit) — never a 403 or a
 * park at the kiosk, and the sweep never leaves the people it saw inside.
 *
 * jest.setup.js sets TEST_DB_POOL_MAX=2 so the two POSTs run on separate
 * connections, matching production.
 */
import { POST } from '@/app/api/scan/route';
import prisma from '@/lib/prisma';
import { authenticateRequest } from '@/lib/auth';

jest.mock('@/lib/auth', () => ({
    authenticateRequest: jest.fn(),
}));

jest.mock('@/lib/notifications', () => ({
    sendCheckinNotifications: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/lib/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    logBackendError: jest.fn(),
}));

const TAG = 'facility-close-lock-254';

function scanReq(participantId: number, extra: Record<string, unknown> = {}) {
    return new Request('http://localhost:4000/api/scan', {
        method: 'POST',
        body: JSON.stringify({ participantId, ...extra }),
    }) as unknown as import('next/server').NextRequest;
}

describe('POST /api/scan facility-close lock (#254)', () => {
    let keyholderId: number;
    let otherId: number;
    let racerId: number;
    let householdIds: number[] = [];

    beforeAll(async () => {
        (authenticateRequest as jest.Mock).mockResolvedValue({ type: 'kiosk' });

        const kh = await prisma.person.create({
            data: { name: 'KH', email: `kh-${TAG}@example.com`, isKeyholder: true, household: { create: { name: 'HH' } } },
        });
        const other = await prisma.person.create({
            data: { name: 'Other', email: `other-${TAG}@example.com`, household: { create: { name: 'HH' } } },
        });
        const racer = await prisma.person.create({
            data: { name: 'Racer', email: `racer-${TAG}@example.com`, household: { create: { name: 'HH' } } },
        });
        keyholderId = kh.id;
        otherId = other.id;
        racerId = racer.id;
        householdIds = [kh.householdId, other.householdId, racer.householdId];
    });

    afterEach(async () => {
        const ids = [keyholderId, otherId, racerId];
        await prisma.visit.deleteMany({ where: { personId: { in: ids } } });
        await prisma.rawBadgeLog.deleteMany({ where: { personId: { in: ids } } });
    });

    afterAll(async () => {
        const ids = [keyholderId, otherId, racerId];
        await prisma.visit.deleteMany({ where: { personId: { in: ids } } });
        await prisma.rawBadgeLog.deleteMany({ where: { personId: { in: ids } } });
        await prisma.person.deleteMany({ where: { id: { in: ids } } });
        await prisma.household.deleteMany({ where: { id: { in: householdIds } } });
    });

    it('concurrent last-keyholder confirm and non-keyholder check-in: sweep is complete, racer checks in', async () => {
        await prisma.visit.create({ data: { personId: keyholderId, arrivedAt: new Date() } });
        await prisma.visit.create({ data: { personId: otherId, arrivedAt: new Date() } });

        const warn = await POST(scanReq(keyholderId));
        expect(warn.status).toBe(400);
        const warnBody = await warn.json();
        expect(warnBody.type).toBe('warning');
        expect(warnBody.forceCloseToken).toEqual(expect.any(String));

        const [closeRes, checkinRes] = await Promise.all([
            POST(scanReq(keyholderId, { forceCloseToken: warnBody.forceCloseToken })),
            POST(scanReq(racerId)),
        ]);

        expect(closeRes.status).toBe(200);
        expect(checkinRes.status).toBe(200);

        const open = await prisma.visit.count({
            where: { personId: { in: [keyholderId, otherId] }, departedAt: null, deletedAt: null },
        });
        expect(open).toBe(0);

        expect((await checkinRes.json()).type).toBe('checkin');
        expect(await prisma.visit.count({ where: { personId: racerId } })).toBe(1);
    });
});
