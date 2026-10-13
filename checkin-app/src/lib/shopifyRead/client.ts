import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import type { PrismaClient, Prisma } from "@inventory/s-ingest-core/client";
import { config } from "@/lib/config";
import { logger } from "@/lib/logger";

/**
 * Read-only bridge to the s-read `shopify_read` Postgres — the mirror the
 * s-read-function keeps of Shopify orders/refunds/payouts/balance-transactions.
 * The reconciler (lib/finance/reconcile.ts) reads it to align Shopify order truth
 * with membership/program truth.
 *
 * Reads go through @inventory/s-ingest-core's Prisma client, so rows come back in
 * the camelCase model shapes the security layer classifies (security/generated/
 * shopify-read-classifications.ts). The mirror's own DDL owner (s-read) migrates
 * it; we only ever read.
 *
 * Note `shopify_read_<env>` lives on the SAME Aurora cluster as `checkin_<env>`
 * (isolated by database + role, not by cluster), so this pool is bound by the same
 * scale-to-zero invariant as lib/prisma.ts — see getPool below.
 *
 * Reads are SELECT-only by GRANT, not by convention: in a deployed env the app
 * connects with its OWN database-url credential, whose DML role is a member of the
 * mirror's SELECT-only NOLOGIN grant-holder (infra modules/s-read/init.sql) — there
 * is no separate mirror credential to hold or rotate. See config.shopifyReadDatabaseUrl()
 * for how the URL is derived (DATABASE_URL + SHOPIFY_READ_DB). Not wired →
 * isConfigured() is false and the reconciler no-ops, so an env without the mirror
 * runs no reconciliation rather than crashing.
 *
 * Timestamps: s-read's columns are `timestamp WITHOUT time zone` holding UTC, which
 * is how Prisma reads and writes every DateTime, so the reads need no zone handling.
 *
 * ponytail: no store_id filter — each env has its own `shopify_read_<env>` DB with
 * exactly one store, so filtering would only risk a myshopify-vs-storefront domain
 * mismatch. Add a store filter if a single mirror DB ever holds multiple stores.
 */

let pool: Pool | null = null;
let client: PrismaClient | null = null;

function getPool(url: string): Pool {
    if (!pool) {
        pool = new Pool({
            connectionString: url,
            max: 3,
            connectionTimeoutMillis: 10_000,
            // Scale-to-zero invariant (same rule as lib/prisma.ts, see PR #1030):
            // idle connections MUST be reaped and `min` MUST stay 0, or this pool
            // alone keeps the shared Aurora cluster from ever auto-pausing — it
            // pauses only after ~5 minutes with zero connections and zero queries.
            // Reaped fast (10s) rather than prisma.ts's 60s: that 60s buys warmth
            // across a USER's click-to-click gaps, and this pool has no user — it
            // serves one daily batch (api/cron/reconcile-shopify) and should let go
            // as soon as the run ends. No keepAlive: it exists to detect dead peers
            // on long-held connections, and nothing here holds one.
            idleTimeoutMillis: 10_000,
            min: 0,
            // Mirror reads run under checkin's OWN role (membership in the mirror's
            // NOLOGIN grant-holder — no separate credential), so name the session:
            // it's what tells these apart from app queries in pg_stat_activity.
            application_name: "checkin-shopify-read",
        });
        pool.on("error", (e) => logger.error("shopify_read pool error:", e));
    }
    return pool;
}

/**
 * The mirror client, or null when the mirror isn't wired. The generated client is
 * imported on first use, so loading this module (the reconciler, the routes, their
 * tests) never loads it.
 */
async function getClient(): Promise<PrismaClient | null> {
    const url = config.shopifyReadDatabaseUrl();
    if (!url) return null;
    if (!client) {
        const { PrismaClient } = await import("@inventory/s-ingest-core/client");
        client = new PrismaClient({ adapter: new PrismaPg(getPool(url)) });
    }
    return client;
}

export function isConfigured(): boolean {
    return !!config.shopifyReadDatabaseUrl();
}

/** A row of `shop_order` — only the columns the reconciler needs. */
export interface MirrorOrder {
    /** Shopify order GID, e.g. gid://shopify/Order/123. */
    orderGid: string;
    /** Numeric order id — joins to OrgMembershipProcess/ProgramParticipant.shopifyOrderId. */
    legacyId: string | null;
    customerEmail: string | null;
    /** Shopify displayFinancialStatus, verbatim (uppercase): PAID, REFUNDED, … */
    financialStatus: string | null;
    totalCents: number;
    subtotalCents: number;
    totalRefundedCents: number;
    /** Coupon amount Shopify took off the order (pre-existing column). Added back to
     * reconstruct the gross figure when amount-gating a couponed order. */
    discountCents: number;
    /**
     * Coupon codes applied at checkout, mirrored since #1048. Empty [] for orders
     * synced before that shipped (until a backfill re-pull) AND for genuinely
     * un-couponed orders — absence is not distinguishable, so treat non-empty as
     * "a coupon explains a sub-dues total", never empty as "definitely no coupon".
     */
    discountCodes: string[];
    cancelledAt: Date | null;
    updatedAt: Date | null;
    /**
     * The cart attributes we set on the checkout link (Membership_Process_ID,
     * CheckMeIn_Account_ID, Program_ID), mirrored since #1029. Null for orders
     * synced before that shipped — callers must handle absence.
     */
    noteAttributes: { key: string; value: string | null }[] | null;
}

const ORDER_SELECT = {
    shopifyGid: true,
    legacyId: true,
    customerEmail: true,
    financialStatus: true,
    totalCents: true,
    subtotalCents: true,
    totalRefundedCents: true,
    discountCents: true,
    discountCodes: true,
    cancelledAt: true,
    updatedAt: true,
    noteAttributes: true,
} as const;

type OrderRow = Prisma.ShopOrderGetPayload<{ select: typeof ORDER_SELECT }>;

function noteAttributesOf(v: Prisma.JsonValue | null): MirrorOrder["noteAttributes"] {
    if (!Array.isArray(v)) return null;
    return v.flatMap((a) =>
        a !== null && typeof a === "object" && !Array.isArray(a) && typeof a.key === "string"
            ? [{ key: a.key, value: typeof a.value === "string" ? a.value : null }]
            : [],
    );
}

function toMirrorOrder({ shopifyGid, noteAttributes, ...rest }: OrderRow): MirrorOrder {
    return { orderGid: shopifyGid, ...rest, noteAttributes: noteAttributesOf(noteAttributes) };
}

/** Read one cart attribute off a mirrored order. Null when absent (or pre-#1029). */
export function orderAttr(o: MirrorOrder, key: string): string | null {
    return o.noteAttributes?.find((a) => a.key === key)?.value ?? null;
}

/**
 * Orders whose mirror row changed after `since` (the reconciler's high-water mark),
 * excluding Shopify test orders. Oldest-first so the caller can advance the cursor
 * to the last row it processed. `since` null → from the beginning.
 */
export async function ordersChangedSince(since: Date | null, limit = 1000): Promise<MirrorOrder[]> {
    const db = await getClient();
    if (!db) return [];
    const rows = await db.shopOrder.findMany({
        where: { test: false, ...(since ? { updatedAt: { gt: since } } : {}) },
        orderBy: { updatedAt: { sort: "asc", nulls: "first" } },
        take: limit,
        select: ORDER_SELECT,
    });
    return rows.map(toMirrorOrder);
}

/**
 * Look up specific REAL orders by their numeric legacy id (the id the app stored on
 * activation). `test = false`: a test order must never back a reversal or a payment row.
 */
export async function ordersByLegacyIds(legacyIds: string[]): Promise<MirrorOrder[]> {
    if (legacyIds.length === 0) return [];
    const db = await getClient();
    if (!db) return [];
    const rows = await db.shopOrder.findMany({
        where: { test: false, legacyId: { in: legacyIds } },
        select: ORDER_SELECT,
    });
    return rows.map(toMirrorOrder);
}

/**
 * Distinct variant legacy ids on one order's lines — the join key checkin owns
 * (BoardSettings/Program shopify*VariantId), mirrored onto shop_order_line since
 * #1048. This is the reconciler's replica of the webhook's membership/program-item
 * check ("lines whose variant is one of checkin's known ids"). Lines with a null
 * variant_legacy_id (custom/deleted product, or a row synced before #1048 and not
 * yet backfilled) are dropped, so an EMPTY result means "no attributable variant
 * ids" — the reconciler reads that as pre-backfill and falls back to its amount gate.
 */
export async function orderLineVariantIds(orderGid: string): Promise<string[]> {
    const db = await getClient();
    if (!db) return [];
    const rows = await db.shopOrderLine.findMany({
        where: { orderGid, variantLegacyId: { not: null } },
        distinct: ["variantLegacyId"],
        select: { variantLegacyId: true },
    });
    return rows.flatMap((r) => (r.variantLegacyId === null ? [] : [r.variantLegacyId]));
}

/** One order's attributable lines with their quantities — the program seat count.
 *  Lines an order edit removed are excluded; they were not paid for. */
export async function orderLines(orderGid: string): Promise<{ variantId: string; quantity: number }[]> {
    const db = await getClient();
    if (!db) return [];
    const rows = await db.shopOrderLine.findMany({
        where: { orderGid, variantLegacyId: { not: null }, removed: false },
        select: { variantLegacyId: true, quantity: true },
    });
    return rows.flatMap((r) => (r.variantLegacyId === null ? [] : [{ variantId: r.variantLegacyId, quantity: r.quantity }]));
}

/** The `sync_run` columns the board needs to judge how fresh the mirror is. */
export interface MirrorSyncRun {
    /**
     * RUNNING | COMPLETED | FAILED | ABANDONED. ABANDONED is s-read's stale-run
     * reaper relabelling a run whose process was killed (timeout/OOM) — so a dead
     * run never sits as RUNNING forever. Read verbatim; not narrowed to a union,
     * since the mirror's enum is s-read's to extend and an unknown value must
     * surface rather than break the read.
     */
    status: string;
    /** BACKFILL | INCREMENTAL | ADMIN. */
    kind: string;
    startedAt: Date;
    finishedAt: Date | null;
    /** s-read's per-object row counts. Shape is s-read's; passed through untouched. */
    counts: unknown;
    error: string | null;
}

/**
 * The most recent sync run, or null when the mirror has never run one (or is
 * unconfigured). Ordered by started_at — s-read stamps it on insert, so it is
 * non-null for every row, unlike finished_at.
 */
export async function latestSyncRun(): Promise<MirrorSyncRun | null> {
    const db = await getClient();
    if (!db) return null;
    return db.syncRun.findFirst({
        orderBy: { startedAt: "desc" },
        select: { status: true, kind: true, startedAt: true, finishedAt: true, counts: true, error: true },
    });
}

/**
 * Diagnostic probe: how many sync runs the mirror holds. One round trip whose
 * FAILURE is as informative as its success — the thrown pg error's `code`
 * discriminates every layer between here and the data (network, auth, database
 * missing, table missing, SELECT grant missing), which is why the diagnose route
 * calls this instead of six separate checks. It runs on the pool directly, not the
 * Prisma client, because Prisma rewraps those errors and drops the pg code. Errors
 * are deliberately NOT caught here: the caller owns the code→verdict mapping.
 */
export async function countSyncRuns(): Promise<number> {
    const url = config.shopifyReadDatabaseUrl();
    if (!url) throw new Error("shopify_read mirror is not configured");
    const rows = await getPool(url).query<{ runs: number }>(`SELECT count(*)::int AS runs FROM sync_run`);
    return rows.rows[0].runs;
}

// ── match-audit reads (lib/finance/matchAudit.ts) ────────────────────────────

/**
 * How much of the mirror's line data carries a variant id. Rows synced before
 * s-read's variant columns shipped are null until a BACKFILL run repopulates
 * them — the audit reports that state explicitly instead of concluding "no
 * membership orders exist" from a mirror that simply predates the column.
 */
export async function lineVariantStats(): Promise<{ lines: number; withVariant: number }> {
    const db = await getClient();
    if (!db) throw new Error("shopify_read mirror is not configured");
    // Joined to shop_order for the same `test = false` rule as ordersForVariants:
    // lines of test orders must not count as coverage, or a handful of test
    // orders synced post-backfill would mask a still-unbackfilled real mirror.
    const rows = await db.$queryRaw<{ lines: number; withVariant: number }[]>`
        SELECT count(*)::int AS "lines", count(l.variant_legacy_id)::int AS "withVariant"
        FROM shop_order_line l
        JOIN shop_order o ON o.shopify_gid = l.order_gid
        WHERE l.removed = false AND o.test = false`;
    return rows[0];
}

/** An order holding at least one line whose variant is one checkin knows about. */
export interface MirrorAuditOrder {
    legacyId: string | null;
    /** Shopify order name, e.g. "#1042" — what the board sees in Shopify admin. */
    name: string | null;
    customerEmail: string | null;
    financialStatus: string | null;
    totalCents: number;
    totalRefundedCents: number;
    cancelledAt: Date | null;
    /** Order-level coupon codes (shop_order.discount_codes text[] @default([]), #1048). */
    discountCodes: string[];
    /** Which of the requested variant ids this order's lines matched. */
    matchedVariantIds: string[];
}

/**
 * Every non-test order with a non-removed line whose variant_legacy_id is one of
 * `variantIds` — i.e. the orders that SHOULD reconcile to a membership or program.
 * Donations/t-shirts/etc. never match and are deliberately absent.
 */
export async function ordersForVariants(variantIds: string[]): Promise<MirrorAuditOrder[]> {
    if (variantIds.length === 0) return [];
    const db = await getClient();
    if (!db) return [];
    const lines = await db.shopOrderLine.findMany({
        where: { removed: false, variantLegacyId: { in: variantIds } },
        select: { orderGid: true, variantLegacyId: true },
    });
    const matched = new Map<string, Set<string>>();
    for (const l of lines) {
        if (l.variantLegacyId === null) continue;
        const set = matched.get(l.orderGid) ?? new Set<string>();
        set.add(l.variantLegacyId);
        matched.set(l.orderGid, set);
    }
    if (matched.size === 0) return [];
    const orders = await db.shopOrder.findMany({
        where: { test: false, shopifyGid: { in: [...matched.keys()] } },
        orderBy: { legacyId: { sort: "asc", nulls: "last" } },
        select: {
            shopifyGid: true,
            legacyId: true,
            name: true,
            customerEmail: true,
            financialStatus: true,
            totalCents: true,
            totalRefundedCents: true,
            discountCodes: true,
            cancelledAt: true,
        },
    });
    return orders.map(({ shopifyGid, ...o }) => ({ ...o, matchedVariantIds: [...(matched.get(shopifyGid) ?? [])].sort() }));
}

/**
 * Which of the given numeric order ids exist in the mirror as REAL orders.
 * `test = false` matches every other read here: a test-mode order must not
 * serve as the payment basis that turns an activation "ORDER_MATCHED".
 */
export async function orderLegacyIdsPresent(legacyIds: string[]): Promise<Set<string>> {
    if (legacyIds.length === 0) return new Set();
    const db = await getClient();
    if (!db) return new Set();
    const rows = await db.shopOrder.findMany({
        where: { test: false, legacyId: { in: legacyIds } },
        select: { legacyId: true },
    });
    return new Set(rows.flatMap((r) => (r.legacyId === null ? [] : [r.legacyId])));
}

/**
 * Order GIDs that have a chargeback/dispute balance transaction, among the given
 * GIDs. Shopify Payments surfaces a dispute as a signed balance transaction whose
 * `type` names the dispute — this distinguishes a chargeback (CRITICAL) from an
 * ordinary refund. Case-insensitive match so 'dispute'/'chargeback'/'adjustment'
 * variants all match. Only disputes on real (`test = false`) orders count.
 */
export async function disputedOrderGids(orderGids: string[]): Promise<Set<string>> {
    if (orderGids.length === 0) return new Set();
    const db = await getClient();
    if (!db) return new Set();
    const txns = await db.shopBalanceTransaction.findMany({
        where: {
            orderGid: { in: orderGids },
            OR: [
                { type: { contains: "dispute", mode: "insensitive" } },
                { type: { contains: "chargeback", mode: "insensitive" } },
            ],
        },
        distinct: ["orderGid"],
        select: { orderGid: true },
    });
    const disputed = txns.flatMap((t) => (t.orderGid === null ? [] : [t.orderGid]));
    if (disputed.length === 0) return new Set();
    const real = await db.shopOrder.findMany({
        where: { test: false, shopifyGid: { in: disputed } },
        select: { shopifyGid: true },
    });
    return new Set(real.map((o) => o.shopifyGid));
}

/**
 * The smallest real (non-test) order legacy id in the mirror — the mirror's low-water mark.
 * An activation whose recorded order id sits BELOW this predates the mirror's coverage and is
 * unverifiable-by-design, not a gap. Null when the mirror holds no non-test orders (or is
 * unwired) → the caller then treats every not-in-mirror id as a real gap.
 * legacy_id is numeric-in-text; the ::bigint cast orders them numerically, ::text hands JS a
 * string to BigInt-parse without numeric coercion.
 * ponytail: assumes every legacy_id parses as bigint — true for Shopify order ids.
 */
export async function minRealOrderLegacyId(): Promise<bigint | null> {
    const db = await getClient();
    if (!db) return null;
    // `~ '^[0-9]+$'` guards the ::bigint cast: a single non-numeric legacy_id (a
    // hand-loaded/test row) would otherwise throw for the WHOLE aggregate and
    // 500 the audit. Shopify ids are always numeric, so this skips only junk.
    const rows = await db.$queryRaw<{ minLegacyId: string | null }[]>`
        SELECT min(legacy_id::bigint)::text AS "minLegacyId"
        FROM shop_order WHERE test = false AND legacy_id ~ '^[0-9]+$'`;
    const v = rows[0]?.minLegacyId;
    return v == null ? null : BigInt(v);
}

// ── income reads (the @inventory/income PayoutMirror port) ───────────────────
//
// Income reconciles payouts against QuickBooks, so it reads the hand-loaded
// history too: these reads skip only TEST_LOADED rows, unlike the reconciler's
// API-only reads above. Each row carries its raw `source`; the income library
// maps it. No customer column is selected: income never learns who bought.

export interface IncomeMirrorPayoutRow {
    payoutGid: string;
    issuedAt: Date;
    status: string;
    netCents: number;
    currency: string | null;
    source: string | null;
}

export interface IncomeMirrorTxnRow {
    txnGid: string;
    type: string;
    orderGid: string | null;
    orderName: string | null;
    amountCents: number;
    feeCents: number;
    netCents: number;
    source: string | null;
}

export interface IncomeMirrorLineRow {
    orderGid: string;
    variantId: string | null;
    title: string | null;
    sku: string | null;
    quantity: number;
    priceCents: number;
    discountCents: number;
}

export interface IncomeMirrorItemRow {
    variantId: string;
    title: string | null;
    sku: string | null;
}

const NOT_TEST_LOADED = `source IS DISTINCT FROM 'TEST_LOADED'`;

const PAYOUT_COLS = `payout_gid AS "payoutGid", issued_at AT TIME ZONE 'UTC' AS "issuedAt",
    status, net_cents AS "netCents", currency, source::text AS source`;

/** Paid payouts issued on or after `from`, oldest first. */
export async function incomePaidPayoutsSince(from: Date): Promise<IncomeMirrorPayoutRow[]> {
    const p = getPool();
    if (!p) return [];
    const rows = await p.query<IncomeMirrorPayoutRow>(
        `SELECT ${PAYOUT_COLS} FROM shop_payout
         WHERE upper(status) = 'PAID' AND issued_at IS NOT NULL
           AND issued_at >= ($1::timestamptz AT TIME ZONE 'UTC') AND ${NOT_TEST_LOADED}
         ORDER BY issued_at ASC, payout_gid ASC`,
        [from],
    );
    return rows.rows;
}

/** One payout in any status, or null when absent, undated or test-loaded. */
export async function incomePayout(gid: string): Promise<IncomeMirrorPayoutRow | null> {
    const p = getPool();
    if (!p) return null;
    const rows = await p.query<IncomeMirrorPayoutRow>(
        `SELECT ${PAYOUT_COLS} FROM shop_payout
         WHERE payout_gid = $1 AND issued_at IS NOT NULL AND ${NOT_TEST_LOADED}`,
        [gid],
    );
    return rows.rows[0] ?? null;
}

/** A payout's balance transactions, with each one's order name. */
export async function incomePayoutTransactions(payoutGid: string): Promise<IncomeMirrorTxnRow[]> {
    const p = getPool();
    if (!p) return [];
    const rows = await p.query<IncomeMirrorTxnRow>(
        `SELECT bt.txn_gid AS "txnGid", bt.type, bt.order_gid AS "orderGid", o.name AS "orderName",
                bt.amount_cents AS "amountCents", bt.fee_cents AS "feeCents", bt.net_cents AS "netCents",
                bt.source::text AS source
         FROM shop_balance_transaction bt
         LEFT JOIN shop_order o ON o.shopify_gid = bt.order_gid
         WHERE bt.payout_gid = $1 AND bt.source IS DISTINCT FROM 'TEST_LOADED'
         ORDER BY bt.transaction_date ASC NULLS LAST, bt.txn_gid ASC`,
        [payoutGid],
    );
    return rows.rows;
}

/** The given orders' non-removed lines. */
export async function incomeOrderLines(orderGids: string[]): Promise<IncomeMirrorLineRow[]> {
    const p = getPool();
    if (!p || orderGids.length === 0) return [];
    const rows = await p.query<IncomeMirrorLineRow>(
        `SELECT order_gid AS "orderGid", variant_legacy_id AS "variantId", title, sku, quantity,
                price_cents AS "priceCents", discount_cents AS "discountCents"
         FROM shop_order_line
         WHERE order_gid = ANY($1::text[]) AND removed = false
         ORDER BY order_gid, line_gid`,
        [orderGids],
    );
    return rows.rows;
}

/** Every variant on a real order's line, with the title and SKU of its newest order. */
export async function incomeItemsSeen(): Promise<IncomeMirrorItemRow[]> {
    const p = getPool();
    if (!p) return [];
    const rows = await p.query<IncomeMirrorItemRow>(
        `SELECT DISTINCT ON (l.variant_legacy_id) l.variant_legacy_id AS "variantId", l.title, l.sku
         FROM shop_order_line l
         JOIN shop_order o ON o.shopify_gid = l.order_gid
         WHERE l.variant_legacy_id IS NOT NULL AND o.test = false AND o.${NOT_TEST_LOADED}
         ORDER BY l.variant_legacy_id, o.updated_at DESC NULLS LAST`,
    );
    return rows.rows;
}
