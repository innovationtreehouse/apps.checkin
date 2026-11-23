import { Client } from "pg";
import libraries from "../../../libraries.json";
import { config } from "@/lib/config";
import { currentDatabase, isAllowedDatabase } from "@/lib/dev/dataCheck";

/**
 * The dashboard reset's clean-out (docs/in-design/DEV_RESET.md, "Clean-out"): every table in checkin, each
 * library database and the Shopify-read mirror is truncated, except `_prisma_migrations` and checkin's
 * `DevLedger`. Every connection must name a dev (or local) database before anything is truncated.
 */

export interface RawDb {
    $queryRawUnsafe(query: string, ...values: unknown[]): Promise<unknown>;
    $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

export interface ResetTarget {
    db: string;
    url: string | null;
}

/** A refusal to truncate a database outside the dev namespace. Nothing has been truncated when it is thrown. */
export class DevResetRefused extends Error {}

/** Each library database, by its libraries.json name, then the Shopify-read mirror. */
export function resetTargets(): ResetTarget[] {
    return [
        ...libraries.map(({ name }) => ({ db: name, url: process.env[`${name.toUpperCase()}_DATABASE_URL`] || null })),
        { db: "shopify_read", url: config.shopifyReadDatabaseUrl() },
    ];
}

function pgDb(client: Client): RawDb {
    return {
        $queryRawUnsafe: async (query, ...values) => (await client.query(query, values)).rows,
        $executeRawUnsafe: async (query, ...values) => (await client.query(query, values)).rowCount ?? 0,
    };
}

async function assertDevDatabase(db: RawDb, env: string, name: string, url: string | undefined): Promise<void> {
    if (!isAllowedDatabase(env, await currentDatabase(db), url, name)) {
        throw new DevResetRefused(`reset refuses the ${name} connection: it is not the ${env} database`);
    }
}

async function truncateAll(db: RawDb, keep: string[]): Promise<void> {
    const rows = (await db.$queryRawUnsafe(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND NOT (tablename = ANY($1::text[]))`,
        keep,
    )) as { tablename: string }[];
    if (rows.length === 0) return;
    await db.$executeRawUnsafe(`TRUNCATE TABLE ${rows.map((r) => `"${r.tablename}"`).join(", ")} CASCADE`);
}

/**
 * Truncates checkin, then each configured library database, then Shopify-read, and returns the targets it
 * skipped because no connection is configured. `reseed` runs once checkin is truncated, even if a later
 * truncate fails, so checkin is never left without its baseline.
 */
export async function truncateDevDatabases(
    checkin: RawDb,
    reseed: () => Promise<unknown>,
    targets: ResetTarget[] = resetTargets(),
    connect: (url: string) => Promise<RawDb & { end(): Promise<void> }> = async (url) => {
        const client = new Client({ connectionString: url, application_name: "checkin-dev-reset" });
        await client.connect();
        return { ...pgDb(client), end: () => client.end() };
    },
): Promise<{ skipped: string[] }> {
    const env = config.checkinEnv();
    if (env !== "dev" && env !== "local") throw new DevResetRefused(`reset runs only on dev or local (got ${env})`);

    const configured = targets.filter((t): t is ResetTarget & { url: string } => t.url !== null);
    const skipped = targets.filter((t) => t.url === null).map((t) => t.db);
    const open: (RawDb & { end(): Promise<void> })[] = [];
    try {
        for (const t of configured) open.push(await connect(t.url));

        await assertDevDatabase(checkin, env, "checkin", process.env.DATABASE_URL);
        for (const [i, t] of configured.entries()) await assertDevDatabase(open[i], env, t.db, t.url);

        await truncateAll(checkin, ["_prisma_migrations", "DevLedger"]);
        try {
            for (const db of open) await truncateAll(db, ["_prisma_migrations"]);
        } finally {
            await reseed();
        }
    } finally {
        await Promise.allSettled(open.map((db) => db.end()));
    }
    return { skipped };
}
