/**
 * @jest-environment node
 */
/**
 * The nightly sweep vs a departure racing it. The departure holds the person
 * and facility locks, as every check-out path does; the sweep reads open visits
 * under the facility lock, so it waits, reads the visit as departed, and leaves
 * the racing departure in place instead of overwriting it with AUTO_CLOSE.
 *
 * jest.setup.js sets TEST_DB_POOL_MAX=2 so the racing departure and the sweep
 * run on separate connections, matching production.
 */
import { GET } from '@/app/api/cron/nightly/route';
import prisma from '@/lib/prisma';
import { lockFacility } from '@/lib/facilityLock';

jest.mock('@/lib/email', () => ({
    runPaced: (tasks: Array<() => Promise<unknown>>) => Promise.all(tasks.map((t) => t())),
    sendEmail: jest.fn().mockResolvedValue(true),
}));

const TAG = 'cron-nightly-lock';

function cronReq() {
    process.env.CRON_SECRET = 'test-secret';
    return new Request('http://localhost:4000/api/cron/nightly', {
        method: 'GET',
        headers: { authorization: 'Bearer test-secret' },
    });
}

describe('GET /api/cron/nightly lock', () => {
    let personId: number;
    let householdId: number;

    beforeAll(async () => {
        const p = await prisma.person.create({
            data: { name: 'Racer', email: `racer-${TAG}@example.com`, household: { create: { name: 'HH' } } },
        });
        personId = p.id;
        householdId = p.householdId;
    });

    afterAll(async () => {
        await prisma.visit.deleteMany({ where: { personId } });
        await prisma.person.delete({ where: { id: personId } });
        await prisma.household.delete({ where: { id: householdId } });
    });

    it('waits for a racing departure and does not overwrite it', async () => {
        const arrivedAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
        const departedAt = new Date(Date.now() - 60 * 60 * 1000);
        const visit = await prisma.visit.create({ data: { personId, arrivedAt } });

        let release!: () => void;
        const released = new Promise<void>((r) => { release = r; });
        let locked!: () => void;
        const lockTaken = new Promise<void>((r) => { locked = r; });

        const departure = prisma.$transaction(async (tx) => {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(${personId})`;
            await lockFacility(tx);
            await tx.visit.update({ where: { id: visit.id }, data: { departedAt, departedVia: 'TYPED' } });
            locked();
            await released;
        }, { timeout: 15_000 });

        await lockTaken;
        const sweep = GET(cronReq());
        // Give the sweep time to block on the facility lock.
        await new Promise((r) => setTimeout(r, 750));
        release();
        await departure;
        expect((await sweep).status).toBe(200);

        const row = await prisma.visit.findUnique({ where: { id: visit.id } });
        expect(row?.departedAt).toEqual(departedAt);
        expect(row?.departedVia).toBe('TYPED');
        expect(row?.facilityCloseId).toBeNull();
    });
});
