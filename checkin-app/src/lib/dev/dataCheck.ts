import { config, ORG_DOMAIN } from "@/lib/config";

/**
 * The read-only dev data check (docs/in-design/DEV_RESET.md, "How it is proven gone"). It counts the
 * people and households on dev that are neither seeded personas nor org accounts, and every row that
 * links to them. The report holds table names and counts only, never a name, email or id.
 */

export interface DataCheckTx {
    $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
    $queryRawUnsafe(query: string, ...values: unknown[]): Promise<unknown>;
}

export interface DataCheckDb {
    $transaction<T>(fn: (tx: DataCheckTx) => Promise<T>): Promise<T>;
}

export interface PersonRow {
    id: number;
    email: string | null;
    householdId: number;
}

interface ForeignKeyRow {
    tbl: string;
    col: string;
    ref: string;
}

export interface DevDataReport {
    people: { total: number; seeded: number; orgAccounts: number; notSeeded: number };
    households: { total: number; notSeeded: number };
    /** Rows pointing straight at an unseeded person or household, per foreign-key column. */
    linkedRows: { table: string; column: string; rows: number }[];
    /** Distinct records (programs, events, ...) those rows point at in turn, per table. */
    linkedRecords: Record<string, number>;
}

const PERSON = '"Person"';
const HOUSEHOLD = '"Household"';

type EmailKind = "seeded" | "org" | "other" | "none";

function emailKind(email: string | null): EmailKind {
    if (!email) return "none";
    const domain = email.toLowerCase().split("@").pop();
    if (domain === "example.com") return "seeded";
    if (domain === ORG_DOMAIN) return "org";
    return "other";
}

/**
 * A household is seeded when someone in it has a seeded or org email and nobody in it has any other
 * email. A person without an email takes their household's standing.
 */
export function classifyPeople(people: PersonRow[], householdIds: number[]) {
    const members = new Map<number, EmailKind[]>();
    for (const p of people) members.set(p.householdId, [...(members.get(p.householdId) ?? []), emailKind(p.email)]);

    const households = new Set(
        householdIds.filter((id) => {
            const kinds = members.get(id) ?? [];
            const allowed = kinds.some((k) => k === "seeded" || k === "org");
            return !allowed || kinds.includes("other");
        }),
    );
    const flagged = new Set<number>();
    let orgAccounts = 0;
    for (const p of people) {
        const kind = emailKind(p.email);
        if (kind === "org") orgAccounts++;
        else if (kind === "other" || (kind === "none" && households.has(p.householdId))) flagged.add(p.id);
    }
    return { people: flagged, households, seededPeople: people.length - orgAccounts - flagged.size, orgAccounts };
}

const bare = (quoted: string) => quoted.replace(/^"|"$/g, "");

/** The database each environment's check may read: dev's own, or a local or integration-test one. */
export function isAllowedDatabase(env: string, name: string): boolean {
    if (env === "dev") return name === "checkin_dev";
    return name === "checkmein" || name.startsWith("checkin_test_");
}

export async function runDevDataCheck(db: DataCheckDb): Promise<DevDataReport> {
    const env = config.checkinEnv();
    if (env !== "dev" && env !== "local") {
        throw new Error(`dev-data-check runs only when CHECKIN_ENV is dev or local (got ${env})`);
    }

    return db.$transaction(async (tx) => {
        // The database refuses any write for the rest of this transaction.
        await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");

        const [{ name }] = (await tx.$queryRawUnsafe("SELECT current_database() AS name")) as { name: string }[];
        if (!isAllowedDatabase(env, name)) {
            throw new Error(`dev-data-check refuses to read a database that is not the ${env} database`);
        }

        const people = (await tx.$queryRawUnsafe(
            `SELECT id, email, "householdId" FROM ${PERSON}`,
        )) as PersonRow[];
        const householdRows = (await tx.$queryRawUnsafe(`SELECT id FROM ${HOUSEHOLD}`)) as { id: number }[];
        const result = classifyPeople(
            people,
            householdRows.map((h) => h.id),
        );

        const foreignKeys = (await tx.$queryRawUnsafe(`
            SELECT c.conrelid::regclass::text AS tbl, a.attname AS col, c.confrelid::regclass::text AS ref
            FROM pg_constraint c
            JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
            WHERE c.contype = 'f' AND cardinality(c.conkey) = 1
              AND c.connamespace = 'public'::regnamespace
        `)) as ForeignKeyRow[];

        const flaggedIds: Record<string, number[]> = {
            [PERSON]: [...result.people],
            [HOUSEHOLD]: [...result.households],
        };
        const linkedRows: DevDataReport["linkedRows"] = [];
        const linkedRecords = new Map<string, Set<string>>();

        for (const fk of foreignKeys) {
            const ids = flaggedIds[fk.ref];
            if (!ids || ids.length === 0) continue;
            const where = `"${fk.col}" = ANY($1::int[])`;
            const [{ n }] = (await tx.$queryRawUnsafe(
                `SELECT count(*)::int AS n FROM ${fk.tbl} WHERE ${where}`,
                ids,
            )) as { n: number }[];
            if (n === 0) continue;
            linkedRows.push({ table: bare(fk.tbl), column: fk.col, rows: n });

            for (const next of foreignKeys) {
                if (next.tbl !== fk.tbl || next.ref === PERSON || next.ref === HOUSEHOLD) continue;
                const reached = (await tx.$queryRawUnsafe(
                    `SELECT DISTINCT "${next.col}"::text AS id FROM ${fk.tbl} WHERE ${where} AND "${next.col}" IS NOT NULL`,
                    ids,
                )) as { id: string }[];
                const seen = linkedRecords.get(bare(next.ref)) ?? new Set<string>();
                for (const r of reached) seen.add(r.id);
                linkedRecords.set(bare(next.ref), seen);
            }
        }

        return {
            people: {
                total: people.length,
                seeded: result.seededPeople,
                orgAccounts: result.orgAccounts,
                notSeeded: result.people.size,
            },
            households: { total: householdRows.length, notSeeded: result.households.size },
            linkedRows,
            linkedRecords: Object.fromEntries([...linkedRecords].map(([table, ids]) => [table, ids.size])),
        };
    });
}
