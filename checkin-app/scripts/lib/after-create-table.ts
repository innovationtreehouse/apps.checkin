export const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;

/**
 * Inserts `block` directly after the `CREATE TABLE "<table>" (...);`
 * statement in a `prisma migrate diff` script. Throws naming `what` if the
 * table has no CREATE TABLE there, since the block then has nowhere to go.
 */
export function insertAfterCreateTable(migrationSql: string, table: string, block: string, what: string): string {
    const start = migrationSql.indexOf(`CREATE TABLE ${quoteIdent(table)} (`);
    const end = start < 0 ? -1 : migrationSql.indexOf("\n);", start);
    if (end < 0) {
        throw new Error(`Cannot place ${what}: no CREATE TABLE ${quoteIdent(table)} statement in the candidate baseline.`);
    }
    const insertAt = end + "\n);".length;
    return migrationSql.slice(0, insertAt) + `\n\n${block}` + migrationSql.slice(insertAt);
}

export function groupByTable<T extends { tablename: string }>(rows: T[]): Map<string, T[]> {
    const groups = new Map<string, T[]>();
    for (const r of rows) groups.set(r.tablename, [...(groups.get(r.tablename) ?? []), r]);
    return groups;
}
