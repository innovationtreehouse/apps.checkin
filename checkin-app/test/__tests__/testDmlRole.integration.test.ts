import { Client } from 'pg'

describe('test DML role', () => {
    const client = new Client({ connectionString: process.env.DML_DATABASE_URL })

    beforeAll(() => client.connect())
    afterAll(() => client.end())

    it('is a role row security binds', async () => {
        const { rows } = await client.query<{
            rolname: string
            rolsuper: boolean
            rolbypassrls: boolean
            ownsHousehold: boolean
        }>(`
            SELECT rolname, rolsuper, rolbypassrls,
                   pg_has_role(current_user, c.relowner, 'USAGE') AS "ownsHousehold"
            FROM pg_roles, pg_class c
            WHERE rolname = current_user AND c.oid = '"Household"'::regclass`)

        expect(rows).toEqual([
            { rolname: 'checkin_test_dml', rolsuper: false, rolbypassrls: false, ownsHousehold: false },
        ])
    })

    it('holds the DML grants, and a new household starts unarchived', async () => {
        await client.query('BEGIN')
        try {
            const { rows } = await client.query<{ archivedAt: Date | null }>(
                `INSERT INTO "Household" (name) VALUES ('DML role probe') RETURNING "archivedAt"`,
            )
            expect(rows).toEqual([{ archivedAt: null }])
        } finally {
            await client.query('ROLLBACK')
        }
    })
})
