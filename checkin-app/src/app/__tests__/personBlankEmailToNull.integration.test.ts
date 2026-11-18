/**
 * Runs the committed blank-email migrations against seeded rows: every blank or
 * all-whitespace Person.email becomes null and a real address is left alone.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import prisma from '@/lib/prisma';

const migrationPath = (name: string) => join(__dirname, '../../../prisma/migrations', name, 'migration.sql');
const SPACE_MIGRATION = migrationPath('20261113120000_person_blank_email_to_null');
const WHITESPACE_MIGRATION = migrationPath('20261114130000_person_whitespace_email_to_null');
const TAG = 'blank-email-mig';
const REAL = `real-${TAG}@example.com`;

async function wipe() {
    await prisma.person.deleteMany({ where: { household: { name: `hh-${TAG}` } } });
    await prisma.household.deleteMany({ where: { name: `hh-${TAG}` } });
}

beforeAll(wipe);
afterEach(wipe);
afterAll(() => prisma.$disconnect());

// Runs the file's statements in one transaction, dropping its own BEGIN/COMMIT; returns rows changed.
async function runMigration(path: string): Promise<number> {
    const statements = readFileSync(path, 'utf8')
        .replace(/^--.*$/gm, '')
        .split(';')
        .map((s) => s.trim())
        .filter((s) => s && s !== 'BEGIN' && s !== 'COMMIT');
    return prisma.$transaction(async (tx) => {
        let changed = 0;
        for (const stmt of statements) changed += await tx.$executeRawUnsafe(stmt);
        return changed;
    });
}

// Seeds one person per blank plus one with a real address; blanks are raw writes
// because the client's email extension would store them as null.
async function seed(blanks: string[]) {
    const hh = await prisma.household.create({ data: { name: `hh-${TAG}` } });
    const blankIds: number[] = [];
    for (const [i, blank] of blanks.entries()) {
        const { id } = await prisma.person.create({ data: { name: `Person ${TAG} ${i}`, householdId: hh.id } });
        await prisma.$executeRaw`UPDATE "Person" SET email = ${blank} WHERE id = ${id}`;
        blankIds.push(id);
    }
    const real = await prisma.person.create({ data: { name: `Person ${TAG} real`, householdId: hh.id, email: REAL } });
    const emails = async () => {
        const rows = await prisma.person.findMany({ where: { householdId: hh.id }, select: { id: true, email: true } });
        return new Map(rows.map((r) => [r.id, r.email]));
    };
    return { blankIds, realId: real.id, emails };
}

test('space migration nulls blank and space-only emails and keeps a real one', async () => {
    const { blankIds, realId, emails } = await seed(['', ' ', '  ']);

    await runMigration(SPACE_MIGRATION);

    const email = await emails();
    for (const id of blankIds) expect(email.get(id)).toBeNull();
    expect(email.get(realId)).toBe(REAL);
});

test('whitespace migration nulls tab, newline and mixed-whitespace emails, keeps a real one, and reruns as a no-op', async () => {
    const { blankIds, realId, emails } = await seed(['\t', '\n', '\r\n', ' \t\r\n ', '']);

    expect(await runMigration(WHITESPACE_MIGRATION)).toBe(blankIds.length);

    const email = await emails();
    for (const id of blankIds) expect(email.get(id)).toBeNull();
    expect(email.get(realId)).toBe(REAL);
    expect(await runMigration(WHITESPACE_MIGRATION)).toBe(0);
});
