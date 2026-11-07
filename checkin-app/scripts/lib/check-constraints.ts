/**
 * Prisma's schema DSL cannot express a CHECK constraint (e.g.
 * `Person_name_not_blank`), so `prisma migrate diff --from-empty` drops every
 * one. This module detects that gap against a real (TRUTH) database and
 * splices each missing constraint back in verbatim, right after its table's
 * CREATE TABLE statement.
 */

export interface CheckConstraintRow {
    tablename: string;
    conname: string;
    /** `pg_get_constraintdef` output, e.g. `CHECK ((btrim(name) <> ''::text))`. */
    condef: string;
}

const key = (r: CheckConstraintRow) => `${r.tablename}.${r.conname}`;
const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;

/**
 * Diffs TRUTH's CHECK constraints against CANDIDATE's. A same-named
 * constraint with a different definition is a real schema divergence, so it
 * throws rather than returning it for splicing.
 */
export function findMissingCheckConstraints(truth: CheckConstraintRow[], candidate: CheckConstraintRow[]): CheckConstraintRow[] {
    const candidateByKey = new Map(candidate.map((r) => [key(r), r]));
    const missing: CheckConstraintRow[] = [];
    for (const t of truth) {
        const c = candidateByKey.get(key(t));
        if (!c) {
            missing.push(t);
        } else if (c.condef !== t.condef) {
            throw new Error(
                `CHECK constraint "${t.conname}" on "${t.tablename}" exists in both databases but with different definitions — ` +
                    `a real schema divergence, not something to auto-splice over.\n` +
                    `  truth:     ${t.condef}\n` +
                    `  candidate: ${c.condef}`,
            );
        }
    }
    return missing;
}

/**
 * Inserts `ALTER TABLE ... ADD CONSTRAINT ... <condef>;` for each missing
 * constraint directly after its table's `CREATE TABLE` statement. Throws if
 * the table has no `CREATE TABLE` in the SQL, since the constraint then has
 * nowhere to go.
 */
export function spliceCheckConstraints(migrationSql: string, missing: CheckConstraintRow[]): string {
    let sql = migrationSql;
    for (const con of missing) {
        const table = quoteIdent(con.tablename);
        const start = sql.indexOf(`CREATE TABLE ${table} (`);
        const end = start < 0 ? -1 : sql.indexOf("\n);", start);
        if (end < 0) {
            throw new Error(
                `Cannot place CHECK constraint "${con.conname}": no CREATE TABLE ${table} statement in the candidate baseline.`,
            );
        }
        const insertAt = end + "\n);".length;
        const block =
            `\n\n-- coalesce-migrations: CHECK constraint restored — Prisma's DSL can't express it, so\n` +
            `-- prisma migrate diff --from-empty drops it. Spliced verbatim from the TRUTH DB's\n` +
            `-- pg_get_constraintdef for "${con.conname}".\n` +
            `ALTER TABLE ${table} ADD CONSTRAINT ${quoteIdent(con.conname)} ${con.condef};`;
        sql = sql.slice(0, insertAt) + block + sql.slice(insertAt);
    }
    return sql;
}
