/**
 * @jest-environment node
 */
import fs from 'fs';
import path from 'path';
import type { Prisma } from '@/generated/prisma/client';
import prisma from '@/lib/prisma';

/**
 * The PersonMerge backfill against seeded tombstones. Runs the migration's OWN
 * SQL (extracted between its markers, not a reimplementation) and asserts:
 *   - a tombstone with a merge audit row takes its snapshot and mergedAt from the pre-image
 *   - a tombstone without one takes the row's values, never the sentinel email
 *   - a two-hop chain archives both tombstones against the live survivor
 *   - an existing archive row is untouched, and a second run changes nothing
 */

const MIGRATION_SQL = path.join(
    __dirname,
    '../../../prisma/migrations/20261031120000_person_merge_backfill/migration.sql',
);

/** Pull the statements between the BACKFILL markers — the exact SQL the deploy runs. */
function backfillStatements(): string[] {
    const raw = fs.readFileSync(MIGRATION_SQL, 'utf8');
    const afterStart = raw.split('-- >>> BACKFILL START')[1];
    const block = afterStart.slice(afterStart.indexOf('\n') + 1).split('-- >>> BACKFILL END')[0];
    return block
        .split('\n')
        .filter(line => !line.trim().startsWith('--'))
        .join('\n')
        .split(';')
        .map(s => s.trim())
        .filter(Boolean);
}

async function runBackfill(): Promise<number> {
    let inserted = 0;
    for (const stmt of backfillStatements()) {
        inserted += await prisma.$executeRawUnsafe(stmt);
    }
    return inserted;
}

const TAG = 'person-merge-backfill-test';
const AUDITED_MERGE_AT = new Date('2026-05-01T15:30:00.000Z');
const ARCHIVED_MERGE_AT = new Date('2026-09-01T12:00:00.000Z');

/** A person as the merge leaves it: merged into `intoId`, sentinel email. */
async function tombstone(name: string, intoId: number, householdId: number, data: Omit<Prisma.PersonUncheckedCreateInput, 'name' | 'householdId'> = {}): Promise<number> {
    const p = await prisma.person.create({ data: { name, householdId, mergedIntoId: intoId, ...data } });
    await prisma.person.update({ where: { id: p.id }, data: { email: `merged-${p.id}@deleted.invalid` } });
    return p.id;
}

describe('PersonMerge backfill', () => {
    let householdId: number;
    let keeperId: number;
    let auditedId: number;
    let unauditedId: number;
    let chainMidId: number;
    let chainTailId: number;
    let archivedId: number;
    let preexistingMergeIds: number[];
    const auditIds: number[] = [];
    let backfillStartedAt: Date;
    let firstRunInserted: number;

    beforeAll(async () => {
        const household = await prisma.household.create({ data: { name: 'Merge Backfill HH' } });
        householdId = household.id;
        const keeper = await prisma.person.create({
            data: { name: 'Backfill Keeper', email: `keeper-${TAG}@example.com`, householdId },
        });
        keeperId = keeper.id;

        // The merge zeroed this one's role mirrors; the pre-image holds what it had.
        auditedId = await tombstone('Audited Tomb', keeperId, householdId, {
            lastBackgroundCheck: new Date('2020-01-01'),
        });
        // A household-lead removal audit row can share action, table and
        // secondaryAffectedEntity with a merge; it must not be read as the pre-image.
        const decoy = await prisma.auditLog.create({
            data: {
                actorId: keeperId,
                action: 'DELETE',
                tableName: 'Person',
                affectedEntityId: keeperId,
                secondaryAffectedEntity: auditedId,
                oldData: { householdId: auditedId, personId: keeperId, isHouseholdLead: true },
                timestamp: new Date('2026-01-01T00:00:00.000Z'),
            },
        });
        const merge = await prisma.auditLog.create({
            data: {
                actorId: keeperId,
                action: 'DELETE',
                tableName: 'Person',
                affectedEntityId: keeperId,
                secondaryAffectedEntity: auditedId,
                oldData: {
                    id: auditedId,
                    email: `audited-${TAG}@example.com`,
                    name: 'Audited Before Merge',
                    dateOfBirth: '2001-02-03T00:00:00.000Z',
                    lastBackgroundCheck: '2025-03-01T00:00:00.000Z',
                    isSysadmin: false,
                    isBoardMember: true,
                    isKeyholder: true,
                    isBackgroundCheckReviewer: false,
                    keeper: { id: keeperId, name: 'Backfill Keeper' },
                },
                newData: { keepId: keeperId },
                timestamp: AUDITED_MERGE_AT,
            },
        });
        auditIds.push(decoy.id, merge.id);

        unauditedId = await tombstone('Unaudited Tomb', keeperId, householdId, {
            lastBackgroundCheck: new Date('2024-06-15'),
            isKeyholder: true,
        });

        chainMidId = await tombstone('Chain Mid', keeperId, householdId);
        chainTailId = await tombstone('Chain Tail', chainMidId, householdId);

        archivedId = await tombstone('Already Archived', keeperId, householdId);
        await prisma.personMerge.create({
            data: { fromId: archivedId, toId: keeperId, mergedAt: ARCHIVED_MERGE_AT, snapshot: { name: 'Archived Snapshot' } },
        });

        // The backfill archives every tombstone in the database, so teardown removes
        // every row it inserted, not only this suite's.
        preexistingMergeIds = (await prisma.personMerge.findMany({ select: { id: true } })).map(m => m.id);

        backfillStartedAt = new Date(Date.now() - 1000);
        firstRunInserted = await runBackfill();
    });

    afterAll(async () => {
        await prisma.personMerge.deleteMany({
            where: { OR: [{ id: { notIn: preexistingMergeIds } }, { fromId: archivedId }] },
        });
        await prisma.auditLog.deleteMany({ where: { id: { in: auditIds } } });
        await prisma.person.deleteMany({ where: { id: chainTailId } });
        await prisma.person.deleteMany({ where: { id: { in: [auditedId, unauditedId, chainMidId, archivedId] } } });
        await prisma.person.deleteMany({ where: { id: keeperId } });
        await prisma.household.deleteMany({ where: { id: householdId } });
    });

    it('takes an audited tombstone\'s snapshot and mergedAt from the merge pre-image', async () => {
        const row = await prisma.personMerge.findUniqueOrThrow({ where: { fromId: auditedId } });
        expect(row.toId).toBe(keeperId);
        expect(row.mergedAt).toEqual(AUDITED_MERGE_AT);
        expect(row.snapshot).toEqual({
            name: 'Audited Before Merge',
            email: `audited-${TAG}@example.com`,
            lastBackgroundCheck: '2025-03-01T00:00:00.000Z',
            isSysadmin: false,
            isBoardMember: true,
            isKeyholder: true,
            isBackgroundCheckReviewer: false,
        });
    });

    it('falls back to the row for an unaudited tombstone, with a null email', async () => {
        const row = await prisma.personMerge.findUniqueOrThrow({ where: { fromId: unauditedId } });
        expect(row.toId).toBe(keeperId);
        expect(row.mergedAt.getTime()).toBeGreaterThanOrEqual(backfillStartedAt.getTime());
        expect(row.snapshot).toEqual({
            name: 'Unaudited Tomb',
            email: null,
            lastBackgroundCheck: '2024-06-15T00:00:00.000Z',
            isSysadmin: false,
            isBoardMember: false,
            isKeyholder: true,
            isBackgroundCheckReviewer: false,
        });
    });

    it('points both links of a two-hop chain at the live survivor', async () => {
        const rows = await prisma.personMerge.findMany({ where: { fromId: { in: [chainMidId, chainTailId] } } });
        expect(rows).toHaveLength(2);
        expect(rows.every(r => r.toId === keeperId)).toBe(true);
    });

    it('leaves an existing archive row untouched', async () => {
        const row = await prisma.personMerge.findUniqueOrThrow({ where: { fromId: archivedId } });
        expect(row.mergedAt).toEqual(ARCHIVED_MERGE_AT);
        expect(row.snapshot).toEqual({ name: 'Archived Snapshot' });
    });

    it('changes nothing on a second run', async () => {
        const ours = [auditedId, unauditedId, chainMidId, chainTailId, archivedId];
        const before = await prisma.personMerge.findMany({ where: { fromId: { in: ours } }, orderBy: { fromId: 'asc' } });
        expect(firstRunInserted).toBeGreaterThanOrEqual(4);
        expect(await runBackfill()).toBe(0);
        const after = await prisma.personMerge.findMany({ where: { fromId: { in: ours } }, orderBy: { fromId: 'asc' } });
        expect(after).toEqual(before);
    });
});
