import fs from 'fs';
import path from 'path';
import prisma from '@/lib/prisma';

/**
 * Runs the migration's own fill, extracted between its markers, against a table
 * put back into its pre-migration shape.
 */
const MIGRATION_SQL = path.join(
    __dirname,
    '../../../prisma/migrations/20261030120000_program_applies_to_year_required/migration.sql',
);
const TAG = `year-fill-${Date.now()}`;

function fillStatements(): string[] {
    const block = fs.readFileSync(MIGRATION_SQL, 'utf8').split('-- >>> FILL START')[1].split('-- >>> FILL END')[0];
    return block.match(/DO \$\$[\s\S]*?\$\$;|[^;]+;/g)!.map((s) => s.trim()).filter(Boolean);
}

async function runFill(): Promise<void> {
    await prisma.$transaction(async (tx) => {
        for (const stmt of fillStatements()) await tx.$executeRawUnsafe(stmt);
    });
}

async function addProgram(suffix: string, startAt: string, endAt: string, year: number | null = null): Promise<number> {
    const program = await prisma.program.create({
        data: { name: `${TAG} ${suffix}`, startAt: new Date(startAt), endAt: new Date(endAt), appliesToYear: year ?? 0 },
    });
    if (year == null) {
        await prisma.$executeRaw`UPDATE "Program" SET "appliesToYear" = NULL WHERE "id" = ${program.id}`;
    }
    return program.id;
}

async function yearOf(id: number): Promise<number | null> {
    const rows = await prisma.$queryRaw<{ appliesToYear: number | null }[]>`SELECT "appliesToYear" FROM "Program" WHERE "id" = ${id}`;
    return rows[0].appliesToYear;
}

describe('program membership year fill', () => {
    beforeAll(async () => {
        await prisma.$executeRawUnsafe('ALTER TABLE "Program" ALTER COLUMN "appliesToYear" DROP NOT NULL');
    });

    afterAll(async () => {
        await prisma.program.deleteMany({ where: { name: { startsWith: TAG } } });
        await prisma.$executeRawUnsafe('ALTER TABLE "Program" ALTER COLUMN "appliesToYear" SET NOT NULL');
    });

    it('refuses to run, changing nothing, while a yearless program starts in 2027-2028 or later', async () => {
        const late = await addProgram('late', '2027-09-01', '2027-12-01');
        const ordinary = await addProgram('ordinary', '2026-01-01', '2026-03-01');

        await expect(runFill()).rejects.toThrow('program year fill');

        expect(await yearOf(late)).toBeNull();
        expect(await yearOf(ordinary)).toBeNull();
        await prisma.program.delete({ where: { id: late } });
        await prisma.program.delete({ where: { id: ordinary } });
    });

    it('fills by the end-date rule, leaves a stated year alone, then requires the column', async () => {
        const endsJuly31 = await addProgram('july31', '2026-06-01', '2026-07-31');
        const endsAug1 = await addProgram('aug1', '2026-06-01', '2026-08-01');
        const crossing = await addProgram('crossing', '2026-06-01', '2026-10-01');
        const lastDayBeforeGuard = await addProgram('guard-edge', '2027-08-31', '2027-10-01');
        const stated = await addProgram('stated', '2026-06-01', '2026-10-01', 2025);
        const statedLate = await addProgram('stated-late', '2028-01-01', '2028-03-01', 2027);

        await runFill();

        expect(await yearOf(endsJuly31)).toBe(2025);
        expect(await yearOf(endsAug1)).toBe(2026);
        expect(await yearOf(crossing)).toBe(2026);
        expect(await yearOf(lastDayBeforeGuard)).toBe(2026);
        expect(await yearOf(stated)).toBe(2025);
        expect(await yearOf(statedLate)).toBe(2027);
        await expect(
            prisma.$executeRaw`UPDATE "Program" SET "appliesToYear" = NULL WHERE "id" = ${endsJuly31}`,
        ).rejects.toThrow();
    });
});
