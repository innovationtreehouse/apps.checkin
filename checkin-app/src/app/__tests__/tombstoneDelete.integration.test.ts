import fs from 'fs';
import path from 'path';
import prisma from '@/lib/prisma';

/**
 * The #1456 2b-3 tombstone delete against a populated schema. Runs the
 * migration's own DO block (everything between its DELETE markers) and asserts
 * it deletes exactly the archived, unreferenced tombstones, keeps every other
 * one, and never raises.
 */

const MIGRATION_SQL = path.join(
    __dirname,
    '../../../prisma/migrations/20261101150000_delete_merged_tombstones/migration.sql',
);
const TAG = `tombstone-delete-${Date.now()}`;

function deleteBlock(): string {
    const block = fs.readFileSync(MIGRATION_SQL, 'utf8').split('-- >>> DELETE START')[1].split('-- >>> DELETE END')[0];
    return block.trim();
}

async function runDelete(): Promise<void> {
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(deleteBlock());
    });
}

describe('merged tombstone delete migration', () => {
    let householdId: number;
    let survivorId: number;
    const personIds: number[] = [];

    async function person(suffix: string, mergedIntoId: number | null = null): Promise<number> {
        const p = await prisma.person.create({ data: { name: `${TAG} ${suffix}`, householdId, mergedIntoId } });
        personIds.push(p.id);
        return p.id;
    }

    async function archive(fromId: number): Promise<void> {
        await prisma.personMerge.create({ data: { fromId, toId: survivorId, snapshot: { name: `${TAG} ${fromId}` } } });
    }

    async function exists(id: number): Promise<boolean> {
        return (await prisma.person.count({ where: { id } })) === 1;
    }

    beforeAll(async () => {
        householdId = (await prisma.household.create({ data: { name: `${TAG} household` } })).id;
        survivorId = await person('survivor');
    });

    afterAll(async () => {
        await prisma.rawBadgeLog.deleteMany({ where: { personId: { in: personIds } } });
        await prisma.personRole.deleteMany({ where: { personId: { in: personIds } } });
        await prisma.personMerge.deleteMany({ where: { OR: [{ fromId: { in: personIds } }, { toId: { in: personIds } }] } });
        await prisma.person.updateMany({ where: { id: { in: personIds } }, data: { mergedIntoId: null } });
        await prisma.person.deleteMany({ where: { id: { in: personIds } } });
        await prisma.household.delete({ where: { id: householdId } });
    });

    it('deletes only archived tombstones that nothing references, and repeats to clear a chain', async () => {
        const archived = await person('archived', survivorId);
        await archive(archived);

        const unarchived = await person('unarchived', survivorId);

        const badged = await person('badged', survivorId);
        await archive(badged);
        await prisma.rawBadgeLog.create({ data: { personId: badged, location: TAG } });

        // CASCADE would take the role with the row; a reference of any kind keeps it.
        const roleHolder = await person('role holder', survivorId);
        await archive(roleHolder);
        await prisma.personRole.create({ data: { personId: roleHolder, role: 'KEYHOLDER' } });

        // `inner` is referenced by `outer` until `outer` goes; id order puts it first.
        const inner = await person('chain inner', survivorId);
        const outer = await person('chain outer', inner);
        await archive(inner);
        await archive(outer);

        const live = await person('live');

        await runDelete();

        expect(await exists(archived)).toBe(false);
        expect(await exists(outer)).toBe(false);
        expect(await exists(inner)).toBe(false);
        expect(await exists(unarchived)).toBe(true);
        expect(await exists(badged)).toBe(true);
        expect(await exists(roleHolder)).toBe(true);
        expect(await exists(live)).toBe(true);
        expect(await exists(survivorId)).toBe(true);

        // The archive outlives the row: it is what the deleted id resolves through.
        expect(await prisma.personMerge.count({ where: { fromId: { in: [archived, inner, outer] } } })).toBe(3);
        // Nothing kept is unpointed from its survivor.
        expect((await prisma.person.findUniqueOrThrow({ where: { id: badged } })).mergedIntoId).toBe(survivorId);
    });

    it('is idempotent: a second run deletes nothing more', async () => {
        const before = await prisma.person.count({ where: { id: { in: personIds } } });
        await runDelete();
        expect(await prisma.person.count({ where: { id: { in: personIds } } })).toBe(before);
    });
});
