/**
 * Prisma's schema DSL cannot express a CHECK constraint (e.g.
 * `Person_name_not_blank`), so `prisma migrate diff --from-empty` drops every
 * one. This module detects that gap against a real (TRUTH) database and
 * splices each missing constraint back in verbatim, right after its table's
 * CREATE TABLE statement.
 */
import { groupByTable, insertAfterCreateTable, quoteIdent } from "./after-create-table";

export interface CheckConstraintRow {
    tablename: string;
    conname: string;
    /** `pg_get_constraintdef` output, e.g. `CHECK ((btrim(name) <> ''::text))`. */
    condef: string;
}

const key = (r: CheckConstraintRow) => `${r.tablename}.${r.conname}`;

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
 * constraint directly after its table's `CREATE TABLE` statement, in input
 * order. Throws if the table has no `CREATE TABLE` in the SQL.
 */
export function spliceCheckConstraints(migrationSql: string, missing: CheckConstraintRow[]): string {
    let sql = migrationSql;
    for (const [tablename, cons] of groupByTable(missing)) {
        const block = cons
            .map(
                (con) =>
                    `-- coalesce-migrations: CHECK constraint restored — Prisma's DSL can't express it, so\n` +
                    `-- prisma migrate diff --from-empty drops it. Spliced verbatim from the TRUTH DB's\n` +
                    `-- pg_get_constraintdef for "${con.conname}".\n` +
                    `ALTER TABLE ${quoteIdent(tablename)} ADD CONSTRAINT ${quoteIdent(con.conname)} ${con.condef};`,
            )
            .join("\n\n");
        sql = insertAfterCreateTable(sql, tablename, block, `CHECK constraint ${cons.map((c) => `"${c.conname}"`).join(", ")}`);
    }
    return sql;
}
