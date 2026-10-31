import { Client } from 'pg';
import type { withArchivedHouseholds as WithArchivedHouseholds } from '../archived';
import type PrismaSingleton from '@/lib/prisma';

const TAG = `household-archive-${Date.now()}`;

// Seeding and cleanup connect as the superuser, which row security never binds.
const admin = new Client({ connectionString: process.env.DATABASE_URL });
// The app singleton reads DATABASE_URL when it loads, so these suites read as
// the DML role through the same client production code uses.
process.env.DATABASE_URL = process.env.DML_DATABASE_URL;

let prisma: typeof PrismaSingleton;
let withArchivedHouseholds: typeof WithArchivedHouseholds;
let activeId: number;
let archivedId: number;

const ownIds = () => ({ id: { in: [activeId, archivedId] } });
const visibleIds = (rows: { id: number }[]) => rows.map((r) => r.id).sort((a, b) => a - b);

async function seedHousehold(name: string, archived: boolean): Promise<number> {
    const { rows } = await admin.query<{ id: number }>(
        `INSERT INTO "Household" (name, "archivedAt") VALUES ($1, $2) RETURNING id`,
        [`${name} ${TAG}`, archived ? new Date() : null],
    );
    return rows[0].id;
}

beforeAll(async () => {
    await admin.connect();
    prisma = (await import('@/lib/prisma')).default;
    withArchivedHouseholds = (await import('../archived')).withArchivedHouseholds;
    activeId = await seedHousehold('active', false);
    archivedId = await seedHousehold('archived', true);
    await admin.query(
        `INSERT INTO "Person" (name, "householdId") VALUES ($1, $2), ($3, $4)`,
        [`active member ${TAG}`, activeId, `archived member ${TAG}`, archivedId],
    );
});

afterAll(async () => {
    await admin.query(`DELETE FROM "Person" WHERE name LIKE $1`, [`%${TAG}`]);
    await admin.query(`DELETE FROM "Household" WHERE name LIKE $1`, [`%${TAG}`]);
    await admin.end();
});

describe('household archive enforcement contract', () => {
    it('reads as a role row security binds', async () => {
        const [role] = await prisma.$queryRaw<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
            SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
        expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
    });

    it('hides an archived household from a read with no opt-in', async () => {
        const rows = await prisma.household.findMany({ where: ownIds(), select: { id: true } });
        expect(visibleIds(rows)).toEqual([activeId]);
    });

    it('shows it inside withArchivedHouseholds', async () => {
        const rows = await withArchivedHouseholds((tx) =>
            tx.household.findMany({ where: ownIds(), select: { id: true } }),
        );
        expect(visibleIds(rows)).toEqual([activeId, archivedId]);
    });

    it('does not carry the opt-in onto the same pooled connection', async () => {
        const backend = async (db: Pick<typeof prisma, '$queryRaw'>) =>
            (await db.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0].pid;

        const optedInOn = await withArchivedHouseholds((tx) => backend(tx));

        expect(await backend(prisma)).toBe(optedInOn);
        const rows = await prisma.household.findMany({ where: ownIds(), select: { id: true } });
        expect(visibleIds(rows)).toEqual([activeId]);
    });

    it('keeps row security enabled and forced, with one SELECT policy', async () => {
        const [table] = await prisma.$queryRaw<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
            SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = '"Household"'::regclass`;
        expect(table).toEqual({ relrowsecurity: true, relforcerowsecurity: true });

        const policies = await prisma.$queryRaw<{ policyname: string }[]>`
            SELECT policyname FROM pg_policies
            WHERE schemaname = 'public' AND tablename = 'Household'
              AND permissive = 'PERMISSIVE' AND cmd IN ('SELECT', 'ALL')`;
        expect(policies).toEqual([{ policyname: 'household_hide_archived' }]);
    });
});

describe('household archive coverage beyond direct reads', () => {
    it('honours the policy in raw SQL', async () => {
        const rows = await prisma.$queryRaw<{ id: number }[]>`
            SELECT id FROM "Household" WHERE id IN (${activeId}, ${archivedId})`;
        expect(visibleIds(rows)).toEqual([activeId]);
    });

    it('excludes an archived household from a relation filter', async () => {
        const rows = await prisma.person.findMany({
            where: { name: { endsWith: TAG }, household: { name: { endsWith: TAG } } },
            select: { householdId: true },
        });
        expect(rows).toEqual([{ householdId: activeId }]);
    });

    it('lets ordinary writes through the per-command policies', async () => {
        const created = await prisma.household.create({ data: { name: `written ${TAG}` } });
        await prisma.household.update({ where: { id: created.id }, data: { name: `renamed ${TAG}` } });
        await prisma.household.delete({ where: { id: created.id } });
    });

    it('refuses to archive without the opt-in, and allows it with', async () => {
        const { id } = await prisma.household.create({ data: { name: `to archive ${TAG}` } });

        await expect(
            prisma.household.update({ where: { id }, data: { archivedAt: new Date() } }),
        ).rejects.toThrow();

        await withArchivedHouseholds((tx) =>
            tx.household.update({ where: { id }, data: { archivedAt: new Date() } }),
        );
        expect(await prisma.household.findUnique({ where: { id } })).toBeNull();

        await withArchivedHouseholds((tx) =>
            tx.household.update({ where: { id }, data: { archivedAt: null } }),
        );
        expect(await prisma.household.findUnique({ where: { id }, select: { id: true } })).toEqual({ id });
    });

    it('matches nothing when writing an archived row without the opt-in', async () => {
        await expect(
            prisma.household.update({ where: { id: archivedId }, data: { name: `hit ${TAG}` } }),
        ).rejects.toMatchObject({ code: 'P2025' });
    });
});
