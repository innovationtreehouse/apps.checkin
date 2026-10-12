/**
 * @jest-environment node
 */
/**
 * Root-vs-transaction client detection (db-client.ts) against a real Prisma
 * client: a transaction client is never mistaken for the root, so withTx joins
 * the caller's transaction and the scan route's facility sweep runs once, after
 * the per-person lock transaction commits.
 */
import { POST } from '@/app/api/scan/route';
import prisma from '@/lib/prisma';
import { authenticateRequest } from '@/lib/auth';
import { isRootClient, withTx } from '@/lib/db-client';
import { closeOnOfferConfirm } from '@/lib/scan-service';
import { processPostEventEmails } from '@/lib/postEventEmails';

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

jest.mock('@/lib/postEventEmails', () => ({
    processPostEventEmails: jest.fn().mockResolvedValue(undefined),
}));

const TAG = 'db-client-root-detection';

class Rollback extends Error {}

function scanReq(body: Record<string, unknown>) {
    return new Request('http://localhost/api/scan', {
        method: 'POST',
        body: JSON.stringify(body),
    }) as unknown as import('next/server').NextRequest;
}

/** Let the fire-and-forget email kick (dynamic import + call) settle. */
const settle = () => new Promise((r) => setTimeout(r, 100));

describe('db-client root detection', () => {
    let k1: number;
    let k2: number;
    let member: number;
    const ids = () => [k1, k2, member];
    const openVisits = () => prisma.visit.count({ where: { personId: { in: ids() }, departedAt: null } });
    const openVisitsFor = (personIds: number[]) =>
        prisma.visit.count({ where: { personId: { in: personIds }, departedAt: null } });

    beforeAll(async () => {
        (authenticateRequest as jest.Mock).mockResolvedValue({ type: 'kiosk' });
        const mk = (name: string, isKeyholder: boolean) => prisma.person.create({
            data: { name, email: `${name}-${TAG}@example.com`, isKeyholder, isDeclaredAdult: true, household: { create: { name } } },
        });
        k1 = (await mk('k1', true)).id;
        k2 = (await mk('k2', true)).id;
        member = (await mk('member', false)).id;
    });

    beforeEach(() => {
        (processPostEventEmails as jest.Mock).mockClear();
    });

    afterEach(async () => {
        await prisma.presenceEvent.deleteMany({ where: { personId: { in: ids() } } });
        await prisma.visit.deleteMany({ where: { personId: { in: ids() } } });
        await prisma.rawBadgeLog.deleteMany({ where: { personId: { in: ids() } } });
    });

    afterAll(async () => {
        const householdIds = (await prisma.person.findMany({ where: { id: { in: ids() } }, select: { householdId: true } }))
            .map((p) => p.householdId);
        await prisma.person.deleteMany({ where: { id: { in: ids() } } });
        await prisma.household.deleteMany({ where: { id: { in: householdIds } } });
        await prisma.$disconnect();
    });

    const arriveAll = (personIds: number[]) => prisma.visit.createMany({
        data: personIds.map((personId) => ({ personId, arrivedAt: new Date(Date.now() - 3600_000), arrivedVia: 'SCANNER' as const })),
    });

    it('isRootClient is true for the exported client and false inside a $transaction callback', async () => {
        expect(isRootClient(prisma)).toBe(true);
        await prisma.$transaction(async (tx) => {
            expect(isRootClient(tx)).toBe(false);
        });
    });

    it('withTx under a caller transaction rolls back with the caller', async () => {
        await expect(prisma.$transaction(async (tx) => {
            await withTx(tx, (inner) =>
                inner.visit.create({ data: { personId: member, arrivedAt: new Date(), arrivedVia: 'SCANNER' } }));
            throw new Rollback();
        })).rejects.toBeInstanceOf(Rollback);
        expect(await prisma.visit.count({ where: { personId: member } })).toBe(0);
    });

    it('withTx under a caller transaction: a caught inner failure undoes only the inner writes', async () => {
        await prisma.$transaction(async (tx) => {
            await tx.visit.create({ data: { personId: k2, arrivedAt: new Date(), arrivedVia: 'SCANNER' } });
            await expect(withTx(tx, async (inner) => {
                await inner.visit.create({ data: { personId: member, arrivedAt: new Date(), arrivedVia: 'SCANNER' } });
                throw new Rollback();
            })).rejects.toBeInstanceOf(Rollback);
            // The outer transaction is still usable after the caught failure.
            expect(await tx.visit.count({ where: { personId: k2 } })).toBe(1);
        });
        expect(await prisma.visit.count({ where: { personId: k2 } })).toBe(1);
        expect(await prisma.visit.count({ where: { personId: member } })).toBe(0);
    });

    it('a close confirmed under a caller transaction defers the facility sweep', async () => {
        await arriveAll([k2, member]);
        const kh = await prisma.person.findUniqueOrThrow({ where: { id: k1 } });
        await prisma.$transaction(async (tx) => {
            const res = await closeOnOfferConfirm(kh, 'kiosk', tx, null, `${TAG}-offline`, true);
            expect((await res!.json()).facilityClosed).toBe(true);
            expect(await tx.visit.count({ where: { personId: { in: [k2, member] }, departedAt: null } })).toBe(2);
        });
        await settle();
        expect(processPostEventEmails).not.toHaveBeenCalled();
    });

    it('a scan-route close by the last keyholder sweeps once and kicks post-event emails once', async () => {
        await arriveAll([k1]);
        const res = await (await POST(scanReq({ participantId: k1, intent: 'OUT' }))).json();
        expect(res.facilityClosed).toBe(true);
        await settle();
        expect(processPostEventEmails).toHaveBeenCalledTimes(1);
        expect(await openVisitsFor([k1])).toBe(0);
    });

    it('a scan-route close on the offered confirm sweeps everyone once and kicks post-event emails once', async () => {
        await arriveAll(ids());
        const offer = await (await POST(scanReq({ participantId: k1, intent: 'OUT' }))).json();
        expect(offer.forceCloseToken).toEqual(expect.any(String));
        await settle();
        expect(processPostEventEmails).not.toHaveBeenCalled();

        const closed = await (await POST(scanReq({ participantId: k1, intent: 'OUT', forceCloseToken: offer.forceCloseToken }))).json();
        expect(closed.facilityClosed).toBe(true);
        await settle();
        expect(processPostEventEmails).toHaveBeenCalledTimes(1);
        expect(await openVisits()).toBe(0);
    });
});
