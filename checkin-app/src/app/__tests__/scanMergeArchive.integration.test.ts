/**
 * @jest-environment node
 */
/**
 * POST /api/scan against a badge whose Person row does not exist.
 *
 * With the merged-away Person row gone, `person.findUnique` returns null and the 404
 * would reject the badge at the door — the failure the merge redirect exists to
 * prevent. So the archive lookup lives in the not-found branch. Every case here
 * deletes the Person row by hand to reach that state.
 *
 * The delete works only because the RESTRICT relations are repointed — RawBadgeLog
 * above all, which otherwise pins every tombstone that has scanned. The first test
 * scans the loser BEFORE deleting it, so the fixture fails with P2003 if that
 * repointing regresses.
 *
 * Real lib/attendance scan services, real DB; only auth and notifications are stubbed.
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

const TAG = 'scan-merge-archive-test';

function scanReq(participantId: number) {
    return new Request('http://localhost/api/scan', {
        method: 'POST',
        body: JSON.stringify({ participantId }),
    }) as unknown as import('next/server').NextRequest;
}

describe('POST /api/scan — badge whose Person row was deleted', () => {
    let survivorId: number;
    let householdId: number;
    let extraPersonIds: number[];

    beforeEach(async () => {
        (authenticateRequest as jest.Mock).mockResolvedValue({ type: 'kiosk' });
        extraPersonIds = [];

        // A keyholder, so their own scan opens the facility for the rest.
        const survivor = await prisma.person.create({
            data: {
                name: 'Archive Survivor',
                email: `survivor-${TAG}@example.com`,
                isKeyholder: true,
                household: { create: { name: 'Archive Test HH' } },
            },
        });
        survivorId = survivor.id;
        householdId = survivor.householdId;

        // Facility open, so a scan reaches the check-in path rather than the gate.
        await prisma.visit.create({ data: { personId: survivorId, arrivedAt: new Date() } });
    });

    afterEach(async () => {
        const ids = [survivorId, ...extraPersonIds];
        await prisma.personMerge.deleteMany({ where: { OR: [{ toId: { in: ids } }, { fromId: { in: ids } }] } });
        await prisma.visit.deleteMany({ where: { personId: { in: ids } } });
        await prisma.rawBadgeLog.deleteMany({ where: { personId: { in: ids } } });
        await prisma.person.deleteMany({ where: { id: { in: ids } } });
        await prisma.household.deleteMany({ where: { id: householdId } });
    });

    /** A merged-away person whose Person row is then deleted, as 2b-3 will do. */
    async function archivedPerson(name: string, opts: { scanFirst?: boolean } = {}) {
        const loser = await prisma.person.create({
            data: { name, email: `${name}-${TAG}@example.com`, householdId },
        });
        if (opts.scanFirst) {
            // A badge log on the loser blocks the delete unless repointed.
            await prisma.rawBadgeLog.create({ data: { personId: loser.id, location: 'Main Entrance' } });
            // Repointed exactly as the merge does, and backdated past the 3s debounce
            // so the scan under test is not swallowed as a double-read.
            await prisma.rawBadgeLog.updateMany({
                where: { personId: loser.id },
                data: { personId: survivorId, timestamp: new Date(Date.now() - 10_000) },
            });
        }
        await prisma.personMerge.create({
            data: { fromId: loser.id, toId: survivorId, snapshot: { name, email: null, lastBackgroundCheck: null } },
        });
        await prisma.person.delete({ where: { id: loser.id } });
        return loser.id;
    }

    it('resolves a deleted id through the archive and checks the survivor in', async () => {
        const goneId = await archivedPerson('Gone One', { scanFirst: true });

        const res = await POST(scanReq(goneId));
        expect(res.status).toBe(200);
        expect((await res.json()).type).toBe('checkout'); // survivor was already in

        // The scan was recorded against the SURVIVOR, not the id on the badge.
        const logged = await prisma.rawBadgeLog.findFirst({
            where: { personId: survivorId }, orderBy: { timestamp: 'desc' },
        });
        expect(logged).not.toBeNull();
        expect(await prisma.rawBadgeLog.count({ where: { personId: goneId } })).toBe(0);
    });

    // The two arms have to compose, because the tombstone and the archive coexist
    // for the whole of 2b. Note what the schema rules out: toId is a RESTRICT FK,
    // and the merge repoints it, so an archive row pointing at a DELETED person
    // cannot occur — archive-to-archive chains are unreachable, and this
    // archive-then-tombstone shape is the only multi-hop one the DB permits.
    it('resolves archive -> tombstone -> live survivor in one walk', async () => {
        const tombstone = await prisma.person.create({
            data: { name: 'Middle Tombstone', email: `middle-${TAG}@example.com`, householdId, mergedIntoId: survivorId },
        });
        extraPersonIds.push(tombstone.id);

        const loser = await prisma.person.create({
            data: { name: 'Two Hop', email: `twohop-${TAG}@example.com`, householdId },
        });
        extraPersonIds.push(loser.id);
        await prisma.personMerge.create({
            data: { fromId: loser.id, toId: tombstone.id, snapshot: { name: 'Two Hop', email: null, lastBackgroundCheck: null } },
        });
        await prisma.person.delete({ where: { id: loser.id } });

        const res = await POST(scanReq(loser.id));
        expect(res.status).toBe(200);

        // Landed on the live survivor, not the tombstone in the middle.
        expect(await prisma.rawBadgeLog.count({ where: { personId: survivorId } })).toBe(1);
        expect(await prisma.rawBadgeLog.count({ where: { personId: tombstone.id } })).toBe(0);
    });

    it('still 404s an id that is in neither Person nor the archive', async () => {
        const res = await POST(scanReq(2_000_000_000));
        expect(res.status).toBe(404);
        expect((await res.json()).error).toContain('not found');
    });
});
