/**
 * @jest-environment node
 */
/**
 * The reconcile cursor against a REAL `shopify_read` mirror: every order the mirror
 * writes reaches the forward pass, whatever its Shopify `updated_at`, however many
 * orders share its stamp, and however late its write commits. The forward passes are
 * stubbed to record what they see; the mirror is a throwaway database built from
 * s-ingest-core's own migrations.
 */
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";
import prisma from "@/lib/prisma";
import { snapshotBoardSettings } from "@/test-helpers/boardSettings";
import { runReconcile } from "@/lib/finance/reconcile";
import type { MirrorOrder } from "@/lib/shopifyRead/client";

const mockSeen: string[] = [];
jest.mock("@/lib/finance/reconcile/membership", () => ({
    reconcileForwardMembership: async (o: MirrorOrder) => { mockSeen.push(o.orderGid); },
}));
jest.mock("@/lib/finance/reconcile/program", () => ({ reconcileForwardProgram: async () => {} }));
jest.mock("@/lib/finance/reconcile/reversals", () => ({ reconcileReversals: async () => 0 }));

const TAG = "reconcile-cursor-test";
// Named after this suite and the worker DB, so no other suite or worker shares it.
const MIRROR_DB = `${new URL(process.env.DATABASE_URL!).pathname.slice(1)}_reconcile_cursor`;
const PRIOR_MIRROR_URL = process.env.SHOPIFY_READ_DATABASE_URL;
const MIGRATIONS = path.resolve(__dirname, "../../../../../packages/s-ingest-core/prisma/migrations");

let mirror: Client;
let restoreBoardSettings: () => Promise<void> = async () => {};
/** The mirror's clock at the start of each test, as UTC text; every write is stamped relative to it. */
let base = "";

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

const gid = (name: string) => `gid://shopify/Order/${TAG}-${name}`;

/**
 * Write one order as the mirror's sync does: Shopify's `updated_at` and the mirror's
 * own `last_synced_at`, each given in minutes before the test's base time.
 */
async function write(name: string, at: { updated: number; synced: number; source?: "BACKFILL" | "HAND_LOADED" }): Promise<void> {
    await mirror.query(
        `INSERT INTO shop_order (shopify_gid, store_id, legacy_id, financial_status, updated_at, last_synced_at, source)
         VALUES ($1, 's', $2, 'PAID',
                 $6::timestamp - make_interval(mins => $3::int),
                 $6::timestamp - make_interval(mins => $4::int),
                 $5::"EventSource")
         ON CONFLICT (store_id, shopify_gid) DO UPDATE
            SET updated_at = EXCLUDED.updated_at, last_synced_at = EXCLUDED.last_synced_at, source = EXCLUDED.source`,
        [gid(name), `${TAG}-${name}`, at.updated, at.synced, at.source ?? "BACKFILL", base],
    );
}

/** One reconcile pass; returns the orders its forward pass saw. */
async function pass(): Promise<string[]> {
    mockSeen.length = 0;
    const r = await runReconcile();
    expect(r.leaseHeld).toBeUndefined();
    return [...mockSeen];
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
    restoreBoardSettings = await snapshotBoardSettings();
}, 60_000);

beforeEach(async () => {
    await mirror.query("TRUNCATE shop_order CASCADE");
    const { rows } = await mirror.query<{ base: string }>(`SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.MS') AS base`);
    base = rows[0].base;
    const fresh = { shopifyReconcileCursorAt: null, shopifyReconcileCursorGid: null, shopifyReconcileLeaseUntil: null, shopifyReconcileLeaseToken: null };
    await prisma.boardSettings.upsert({ where: { id: 1 }, create: { id: 1, ...fresh }, update: fresh });
});

afterAll(async () => {
    await restoreBoardSettings();
    await mirror?.end();
    if (PRIOR_MIRROR_URL === undefined) delete process.env.SHOPIFY_READ_DATABASE_URL;
    else process.env.SHOPIFY_READ_DATABASE_URL = PRIOR_MIRROR_URL;
    await withAdmin(`DROP DATABASE IF EXISTS "${MIRROR_DB}" WITH (FORCE)`);
}, 60_000);

describe("the reconcile cursor misses no order the mirror writes", () => {
    it("reads an order a parallel export load writes with an old updated_at", async () => {
        await write("live", { updated: 30, synced: 30 });
        expect(await pass()).toEqual([gid("live")]);

        await write("exported", { updated: 3 * 24 * 60, synced: 20 });
        expect(await pass()).toEqual([gid("exported")]);
    });

    it("reads an order changed in the same instant as the cursor", async () => {
        await write("first", { updated: 30, synced: 30 });
        expect(await pass()).toEqual([gid("first")]);

        await write("same-instant", { updated: 30, synced: 20 });
        expect(await pass()).toEqual([gid("same-instant")]);
    });

    it("reads every order when a 1,000-row batch ends among orders sharing one stamp", async () => {
        await mirror.query(
            `INSERT INTO shop_order (shopify_gid, store_id, legacy_id, financial_status, updated_at, last_synced_at, source)
             SELECT $1 || lpad(n::text, 4, '0'), 's', $2 || n, 'PAID', t, t, 'BACKFILL'
               FROM generate_series(1, 1001) AS n, (SELECT $3::timestamp - interval '1 hour' AS t) AS stamp`,
            [gid("bulk-"), `${TAG}-bulk-`, base],
        );
        const first = await pass();
        const second = await pass();

        expect(first).toHaveLength(1000);
        expect(new Set([...first, ...second]).size).toBe(1001);
    });

    it("reads an order a reset re-backfills after a moved cutover", async () => {
        await write("pre-cutover", { updated: 3 * 24 * 60, synced: 3 * 24 * 60, source: "HAND_LOADED" });
        await write("live", { updated: 30, synced: 30 });
        expect(await pass()).toEqual([gid("live")]);

        await write("pre-cutover", { updated: 3 * 24 * 60, synced: 20, source: "BACKFILL" });
        expect(await pass()).toEqual([gid("pre-cutover")]);
    });

    it("reads a store row that lands after the cursor passed its updated_at", async () => {
        await write("newer", { updated: 30, synced: 30 });
        expect(await pass()).toEqual([gid("newer")]);

        await write("late-store-row", { updated: 60, synced: 20 });
        expect(await pass()).toEqual([gid("late-store-row")]);
    });

    it("reconciles a just-synced order at once and still reads a write that commits after it", async () => {
        await write("just-synced", { updated: 1, synced: 1 });
        expect(await pass()).toContain(gid("just-synced"));

        await write("late-commit", { updated: 2, synced: 2 });
        expect(await pass()).toContain(gid("late-commit"));
    });
});
