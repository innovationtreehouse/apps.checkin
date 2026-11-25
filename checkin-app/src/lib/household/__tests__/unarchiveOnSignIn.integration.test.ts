import { Client } from 'pg';
import type * as ArchiveAction from '../archiveAction';

const TAG = `unarchive-sign-in-${Date.now()}`;

// Seeding and cleanup connect as the superuser, which row security never binds.
const admin = new Client({ connectionString: process.env.DATABASE_URL });
process.env.DATABASE_URL = process.env.DML_DATABASE_URL;

let unarchiveOnSignIn: typeof ArchiveAction.unarchiveOnSignIn;

async function seedArchived(status: string | null): Promise<{ householdId: number; personId: number }> {
    const { rows: [household] } = await admin.query<{ id: number }>(
        `INSERT INTO "Household" (name, "archivedAt") VALUES ($1, now() - interval '400 days') RETURNING id`,
        [`household ${TAG}`],
    );
    if (status) await admin.query(`INSERT INTO "OrgMembership" ("householdId", status) VALUES ($1, $2)`, [household.id, status]);
    const { rows: [person] } = await admin.query<{ id: number }>(
        `INSERT INTO "Person" (name, "householdId") VALUES ($1, $2) RETURNING id`,
        [`member ${TAG}`, household.id],
    );
    return { householdId: household.id, personId: person.id };
}

const archivedAt = async (id: number) =>
    (await admin.query<{ archivedAt: Date | null }>(`SELECT "archivedAt" FROM "Household" WHERE id = $1`, [id])).rows[0].archivedAt;

const auditRows = async (id: number) =>
    (await admin.query(`SELECT "actorId", "actorSystem", "newData" FROM "AuditLog" WHERE "tableName" = 'Household' AND "affectedEntityId" = $1`, [id])).rows;

beforeAll(async () => {
    await admin.connect();
    ({ unarchiveOnSignIn } = await import('../archiveAction'));
});

afterAll(async () => {
    const households = `SELECT id FROM "Household" WHERE name LIKE $1`;
    await admin.query(`DELETE FROM "AuditLog" WHERE "tableName" = 'Household' AND "affectedEntityId" IN (${households})`, [`%${TAG}`]);
    await admin.query(`DELETE FROM "Person" WHERE name LIKE $1`, [`%${TAG}`]);
    await admin.query(`DELETE FROM "OrgMembership" WHERE "householdId" IN (${households})`, [`%${TAG}`]);
    await admin.query(`DELETE FROM "Household" WHERE name LIKE $1`, [`%${TAG}`]);
    await admin.end();
});

describe('unarchiveOnSignIn against row security', () => {
    it('unarchives a member\'s household and records sign-in as the reason', async () => {
        const { householdId, personId } = await seedArchived('REVOKED');

        await expect(unarchiveOnSignIn(householdId, personId)).resolves.toBe(true);

        expect(await archivedAt(householdId)).toBeNull();
        expect(await auditRows(householdId)).toEqual([
            { actorId: 0, actorSystem: 'system:sign-in', newData: { archivedAt: null, reason: 'sign_in', signedInBy: personId } },
        ]);
    });

    it('a second sign-in is a no-op', async () => {
        const { householdId, personId } = await seedArchived(null);
        await unarchiveOnSignIn(householdId, personId);

        await expect(unarchiveOnSignIn(householdId, personId)).resolves.toBe(false);

        expect(await auditRows(householdId)).toHaveLength(1);
    });

    it('leaves a denied household archived', async () => {
        const { householdId, personId } = await seedArchived('DENIED');

        await expect(unarchiveOnSignIn(householdId, personId)).resolves.toBe(false);

        expect(await archivedAt(householdId)).not.toBeNull();
        expect(await auditRows(householdId)).toEqual([]);
    });
});
