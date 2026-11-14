/**
 * Runs the committed blank-email migration against seeded rows: every blank or
 * space-only Person.email becomes null and a real address is left alone.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import prisma from '@/lib/prisma';

const MIGRATION = join(
    __dirname,
    '../../../prisma/migrations/20261113120000_person_blank_email_to_null/migration.sql',
);
const TAG = 'blank-email-mig';
const REAL = `real-${TAG}@example.com`;

async function wipe() {
    await prisma.person.deleteMany({ where: { household: { name: `hh-${TAG}` } } });
    await prisma.household.deleteMany({ where: { name: `hh-${TAG}` } });
}

beforeAll(wipe);
afterAll(async () => {
    await wipe();
    await prisma.$disconnect();
});

test('migration nulls blank and space-only emails and keeps a real one', async () => {
    const hh = await prisma.household.create({ data: { name: `hh-${TAG}` } });
    const mk = (n: number) => prisma.person.create({ data: { name: `Person ${TAG} ${n}`, householdId: hh.id } });
    const blankIds = [(await mk(1)).id, (await mk(2)).id, (await mk(3)).id];
    const real = await prisma.person.create({ data: { name: `Person ${TAG} real`, householdId: hh.id, email: REAL } });

    // Raw writes: the client's email extension would store these blanks as null.
    const blanks = ['', ' ', '  '];
    for (const [i, id] of blankIds.entries()) {
        await prisma.$executeRaw`UPDATE "Person" SET email = ${blanks[i]} WHERE id = ${id}`;
    }

    await prisma.$executeRawUnsafe(readFileSync(MIGRATION, 'utf8'));

    const rows = await prisma.person.findMany({ where: { householdId: hh.id }, select: { id: true, email: true } });
    const email = new Map(rows.map((r) => [r.id, r.email]));
    for (const id of blankIds) expect(email.get(id)).toBeNull();
    expect(email.get(real.id)).toBe(REAL);
});
