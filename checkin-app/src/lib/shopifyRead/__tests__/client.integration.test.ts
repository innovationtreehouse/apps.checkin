/**
 * @jest-environment node
 */
/**
 * The mirror client's raw-SQL match-audit reads run against a REAL `shopify_read`
 * mirror, built from s-ingest-core's own migrations so the column types, the
 * EventSource enum and the `::bigint` cast behave as in production.
 */
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { lineVariantStats, minRealOrderLegacyId } from "@/lib/shopifyRead/client";

const TAG = "mirror-client-sql-test";
const MIRROR_DB = `${new URL(process.env.DATABASE_URL!).pathname.slice(1)}_mirror_client_sql`;
const PRIOR_MIRROR_URL = process.env.SHOPIFY_READ_DATABASE_URL;
const MIGRATIONS = path.resolve(__dirname, "../../../../../packages/s-ingest-core/prisma/migrations");

let mirror: Client;
let nextLine = 1;

function urlFor(db: string): string {
    const url = new URL(process.env.DATABASE_URL!);
    url.pathname = `/${db}`;
    return url.toString();
}

async function withAdmin(sql: string): Promise<void> {
    const admin = new Client({ connectionString: process.env.DATABASE_URL });
    await admin.connect();
    try {
        await admin.query(sql);
    } finally {
        await admin.end();
    }
}

type Source = "BACKFILL" | "INCREMENTAL" | "HAND_LOADED" | "TEST_LOADED" | null;

async function mirrorOrder(legacyId: string, opts: { source?: Source; test?: boolean } = {}): Promise<string> {
    const gid = `gid://shopify/Order/${TAG}-${legacyId}`;
    await mirror.query(
        `INSERT INTO shop_order (shopify_gid, store_id, legacy_id, updated_at, test, source)
         VALUES ($1, 's', $2, now() AT TIME ZONE 'UTC', $3, $4::"EventSource")`,
        [gid, legacyId, opts.test ?? false, opts.source === undefined ? "INCREMENTAL" : opts.source],
    );
    return gid;
}

async function mirrorLine(orderGid: string, opts: { variantId?: string | null; removed?: boolean } = {}): Promise<void> {
    await mirror.query(
        `INSERT INTO shop_order_line (line_gid, order_gid, store_id, quantity, variant_legacy_id, removed)
         VALUES ($1, $2, 's', 1, $3, $4)`,
        [`${orderGid}/line-${nextLine++}`, orderGid, opts.variantId ?? null, opts.removed ?? false],
    );
}

beforeAll(async () => {
    await withAdmin(`DROP DATABASE IF EXISTS "${MIRROR_DB}" WITH (FORCE)`);
    await withAdmin(`CREATE DATABASE "${MIRROR_DB}"`);
    mirror = new Client({ connectionString: urlFor(MIRROR_DB) });
    await mirror.connect();
    for (const dir of fs.readdirSync(MIGRATIONS).filter((d) => /^\d+_/.test(d)).sort()) {
        await mirror.query(fs.readFileSync(path.join(MIGRATIONS, dir, "migration.sql"), "utf8"));
    }
    process.env.SHOPIFY_READ_DATABASE_URL = urlFor(MIRROR_DB);
}, 60_000);

afterEach(async () => {
    await mirror.query(`DELETE FROM shop_order_line`);
    await mirror.query(`DELETE FROM shop_order`);
});

afterAll(async () => {
    await mirror?.end();
    if (PRIOR_MIRROR_URL === undefined) delete process.env.SHOPIFY_READ_DATABASE_URL;
    else process.env.SHOPIFY_READ_DATABASE_URL = PRIOR_MIRROR_URL;
    await withAdmin(`DROP DATABASE IF EXISTS "${MIRROR_DB}" WITH (FORCE)`);
}, 60_000);

describe("minRealOrderLegacyId against a real mirror", () => {
    it("is null for an empty mirror", async () => {
        expect(await minRealOrderLegacyId()).toBeNull();
    });

    it("orders numerically and skips test, operator-loaded and non-numeric rows", async () => {
        await mirrorOrder("1000", { source: "BACKFILL" });
        await mirrorOrder("950", { source: null });
        await mirrorOrder("50", { test: true });
        await mirrorOrder("10", { source: "HAND_LOADED" });
        await mirrorOrder("20", { source: "TEST_LOADED" });
        await mirrorOrder("not-a-number");

        expect(await minRealOrderLegacyId()).toBe(BigInt(950));
    });

    it("is null when only test or operator-loaded orders exist", async () => {
        await mirrorOrder("50", { test: true });
        await mirrorOrder("10", { source: "HAND_LOADED" });

        expect(await minRealOrderLegacyId()).toBeNull();
    });
});

describe("lineVariantStats against a real mirror", () => {
    it("counts zero lines for an empty mirror", async () => {
        expect(await lineVariantStats()).toEqual({ lines: 0, withVariant: 0 });
    });

    it("counts only live lines of real, API-synced orders", async () => {
        const incremental = await mirrorOrder("1", { source: "INCREMENTAL" });
        await mirrorLine(incremental, { variantId: "v-1" });
        await mirrorLine(incremental, { variantId: null });
        await mirrorLine(incremental, { variantId: "v-2", removed: true });
        const backfill = await mirrorOrder("2", { source: "BACKFILL" });
        await mirrorLine(backfill, { variantId: "v-3" });
        const preColumn = await mirrorOrder("3", { source: null });
        await mirrorLine(preColumn, { variantId: null });

        const testOrder = await mirrorOrder("4", { test: true });
        await mirrorLine(testOrder, { variantId: "v-4" });
        const handLoaded = await mirrorOrder("5", { source: "HAND_LOADED" });
        await mirrorLine(handLoaded, { variantId: "v-5" });
        const testLoaded = await mirrorOrder("6", { source: "TEST_LOADED" });
        await mirrorLine(testLoaded, { variantId: "v-6" });

        expect(await lineVariantStats()).toEqual({ lines: 4, withVariant: 2 });
    });
});
