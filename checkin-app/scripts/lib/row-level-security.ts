/**
 * Prisma's schema DSL cannot express row-level security (e.g. Household's
 * archive filter), so `prisma migrate diff --from-empty` drops a table's
 * ENABLE/FORCE ROW LEVEL SECURITY and every policy on it. This module detects
 * that gap against a real (TRUTH) database and splices it back right after
 * the table's CREATE TABLE statement. Policy expressions come verbatim from
 * Postgres's own deparse (`pg_policies.qual` / `with_check`).
 */
import { groupByTable, insertAfterCreateTable, quoteIdent } from "./after-create-table";

export interface RlsTableRow {
    tablename: string;
    enabled: boolean;
    forced: boolean;
}

export interface PolicyRow {
    tablename: string;
    policyname: string;
    permissive: "PERMISSIVE" | "RESTRICTIVE";
    roles: string[];
    cmd: "ALL" | "SELECT" | "INSERT" | "UPDATE" | "DELETE";
    qual: string | null;
    withCheck: string | null;
}

export interface MissingRls {
    tables: RlsTableRow[];
    policies: PolicyRow[];
}

const renderRole = (role: string) => (role === "public" ? "PUBLIC" : quoteIdent(role));

export function renderPolicy(p: PolicyRow): string {
    return (
        `CREATE POLICY ${quoteIdent(p.policyname)} ON ${quoteIdent(p.tablename)} AS ${p.permissive} FOR ${p.cmd}` +
        ` TO ${p.roles.map(renderRole).join(", ")}` +
        (p.qual === null ? "" : ` USING (${p.qual})`) +
        (p.withCheck === null ? "" : ` WITH CHECK (${p.withCheck})`) +
        ";"
    );
}

export function renderRlsTable(t: RlsTableRow): string[] {
    const table = quoteIdent(t.tablename);
    return [
        ...(t.enabled ? [`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`] : []),
        ...(t.forced ? [`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`] : []),
    ];
}

function divergence(what: string, truth: string, candidate: string): Error {
    return new Error(
        `${what} exists in both databases but with different definitions — ` +
            `a real schema divergence, not something to auto-splice over.\n` +
            `  truth:     ${truth}\n` +
            `  candidate: ${candidate}`,
    );
}

/**
 * Diffs TRUTH's RLS table flags and policies against CANDIDATE's. Anything
 * present on both sides with a different definition throws.
 */
export function findMissingRls(
    truth: { tables: RlsTableRow[]; policies: PolicyRow[] },
    candidate: { tables: RlsTableRow[]; policies: PolicyRow[] },
): MissingRls {
    const candidateTables = new Map(candidate.tables.map((t) => [t.tablename, t]));
    const tables: RlsTableRow[] = [];
    for (const t of truth.tables) {
        const c = candidateTables.get(t.tablename);
        if (!c) tables.push(t);
        else if (c.enabled !== t.enabled || c.forced !== t.forced) {
            throw divergence(`Row-level security on "${t.tablename}"`, renderRlsTable(t).join(" "), renderRlsTable(c).join(" "));
        }
    }

    const policyKey = (p: PolicyRow) => `${p.tablename}.${p.policyname}`;
    const candidatePolicies = new Map(candidate.policies.map((p) => [policyKey(p), p]));
    const policies: PolicyRow[] = [];
    for (const p of truth.policies) {
        const c = candidatePolicies.get(policyKey(p));
        if (!c) policies.push(p);
        else if (renderPolicy(c) !== renderPolicy(p)) {
            throw divergence(`Policy "${p.policyname}" on "${p.tablename}"`, renderPolicy(p), renderPolicy(c));
        }
    }
    return { tables, policies };
}

/**
 * Inserts each table's missing ENABLE/FORCE statements, then its missing
 * policies, directly after the table's `CREATE TABLE`. Throws if the table
 * has no `CREATE TABLE` in the SQL.
 */
export function spliceRls(migrationSql: string, missing: MissingRls): string {
    const tables = new Map(missing.tables.map((t) => [t.tablename, t]));
    const policies = groupByTable(missing.policies);
    let sql = migrationSql;
    for (const tablename of new Set([...tables.keys(), ...policies.keys()])) {
        const t = tables.get(tablename);
        const statements = [...(t ? renderRlsTable(t) : []), ...(policies.get(tablename) ?? []).map(renderPolicy)];
        const block =
            `-- coalesce-migrations: row-level security restored — Prisma's DSL can't express it, so\n` +
            `-- prisma migrate diff --from-empty drops it. Rebuilt from the TRUTH DB's pg_class flags\n` +
            `-- and pg_policies for "${tablename}".\n` +
            statements.join("\n");
        sql = insertAfterCreateTable(sql, tablename, block, `row-level security for "${tablename}"`);
    }
    return sql;
}
