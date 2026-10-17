/**
 * Pins the ROW SELECTION of the WEB retirement migration by executing the
 * committed migration.sql itself (not a copy) against seeded rows:
 * audited roster marks -> LEAD_MARKED, everything else on WEB -> TYPED,
 * LEAD_MARKED untouched, snapshot table captures every rewritten row.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import prisma from '@/lib/prisma';

const MIGRATION = join(
    __dirname,
    '../../../../prisma/migrations/20260825180000_visit_source_web_to_typed/migration.sql',
);

const TAG = 'webbackfill-mig';

async function wipe() {
    await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS "backfill"."_visit_source_web_backfill"');
    await prisma.auditLog.deleteMany({ where: { tableName: 'Visit', newData: { path: ['testTag'], equals: TAG } } });
    await prisma.visit.deleteMany({ where: { person: { household: { name: `hh-${TAG}` } } } });
    await prisma.person.deleteMany({ where: { household: { name: `hh-${TAG}` } } });
    await prisma.household.deleteMany({ where: { name: `hh-${TAG}` } });
}

beforeAll(wipe);
afterAll(async () => {
    await wipe();
    await prisma.$disconnect();
});

test('migration moves audited roster marks to LEAD_MARKED, the rest to TYPED, and snapshots both', async () => {
    const hh = await prisma.household.create({ data: { name: `hh-${TAG}` } });
    const person = await prisma.person.create({ data: { name: `Person ${TAG}`, householdId: hh.id } });
    const mk = (arrivedVia: 'WEB' | 'LEAD_MARKED', departedVia: 'WEB' | 'LEAD_MARKED') =>
        prisma.visit.create({
            data: {
                personId: person.id,
                arrivedAt: new Date('2026-07-15T15:00:00Z'),
                departedAt: new Date('2026-07-15T17:00:00Z'),
                arrivedVia,
                departedVia,
            },
        });

    const audited = await mk('WEB', 'WEB'); // pre-#1622 roster mark with an AT3 audit row
    const plainWeb = await mk('WEB', 'WEB'); // typed clock / dashboard row
    const leadMarked = await mk('LEAD_MARKED', 'LEAD_MARKED'); // must survive untouched

    await prisma.auditLog.create({
        data: {
            actorId: person.id,
            action: 'EDIT',
            tableName: 'Visit',
            affectedEntityId: audited.id,
            newData: { type: 'lead_attendance_correction', arrivedVia: 'WEB', testTag: TAG },
        },
    });

    // Execute the real committed SQL, statement by statement (the test runs
    // outside prisma's migrate flow, so BEGIN/COMMIT wrap is re-applied here).
    const sql = readFileSync(MIGRATION, 'utf8');
    const statements = sql
        .replace(/^--.*$/gm, '') // comment lines first — they may contain ';'
        .split(';')
        .map((s) => s.trim())
        .filter((s) => s && s !== 'BEGIN' && s !== 'COMMIT');
    await prisma.$transaction(async (tx) => {
        for (const stmt of statements) {
            await tx.$executeRawUnsafe(stmt);
        }
    });

    const after = new Map(
        (await prisma.visit.findMany({ where: { personId: person.id } })).map((v) => [v.id, v]),
    );
    expect(after.get(audited.id)).toMatchObject({ arrivedVia: 'LEAD_MARKED', departedVia: 'LEAD_MARKED' });
    expect(after.get(plainWeb.id)).toMatchObject({ arrivedVia: 'TYPED', departedVia: 'TYPED' });
    expect(after.get(leadMarked.id)).toMatchObject({ arrivedVia: 'LEAD_MARKED', departedVia: 'LEAD_MARKED' });

    const snapshot = await prisma.$queryRawUnsafe<{ id: number }[]>(
        'SELECT "id" FROM "backfill"."_visit_source_web_backfill" ORDER BY "id"',
    );
    expect(snapshot.map((r) => r.id)).toEqual([audited.id, plainWeb.id].sort((a, b) => a - b));
});
