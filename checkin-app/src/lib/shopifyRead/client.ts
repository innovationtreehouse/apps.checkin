import { Pool } from "pg";
import { config } from "@/lib/config";
import { logger } from "@/lib/logger";

/**
 * Read-only bridge to the s-read `shopify_read` Postgres — the mirror the
 * s-read-function keeps of Shopify orders/refunds/payouts/balance-transactions.
 * The reconciler (lib/finance/reconcile.ts) reads it to align Shopify order truth
 * with membership/program truth.
 *
 * Deliberately raw `pg` (parameterized SELECTs), NOT a second Prisma client: we
 * read a handful of columns from four tables, and a raw pool avoids wiring the
 * s-ingest-core generated client across the monorepo boundary (transpilePackages,
 * a second generate step, schema-version coupling). The mirror's own DDL owner
 * migrates it; we only ever read.
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
 * ponytail: no store_id filter — each env has its own `shopify_read_<env>` DB with
 * exactly one store, so filtering would only risk a myshopify-vs-storefront domain
 * mismatch. Add a store filter if a single mirror DB ever holds multiple stores.
 */

let pool: Pool | null = null;

function getPool(): Pool | null {
    const url = config.shopifyReadDatabaseUrl();
    if (!url) return null;
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

/**
 * AT TIME ZONE 'UTC' on the timestamps for the reason spelled out on latestSyncRun
 * below: the mirror's columns are naive `timestamp` holding UTC, and node-pg resolves
 * those against the node process's zone. The rule is the whole file's — EVERY
 * timestamp read from this mirror carries the cast.
 */
const ORDER_COLS = `shopify_gid AS "orderGid", legacy_id AS "legacyId", customer_email AS "customerEmail",
    financial_status AS "financialStatus", total_cents AS "totalCents", subtotal_cents AS "subtotalCents",
    total_refunded_cents AS "totalRefundedCents",
    discount_cents AS "discountCents", discount_codes AS "discountCodes",
    cancelled_at AT TIME ZONE 'UTC' AS "cancelledAt",
    updated_at AT TIME ZONE 'UTC' AS "updatedAt",
    note_attributes AS "noteAttributes"`;

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
    const p = getPool();
    if (!p) return [];
    const rows = await p.query<MirrorOrder>(
        // `$1 AT TIME ZONE 'UTC'` on the PARAM side, not the column: it turns the
        // JS Date into the naive-UTC value the column stores, so the comparison is
        // naive-vs-naive and stays sargable. Casting the column instead would work
        // but would rule out any future index on updated_at. Both sides must move
        // together — casting only one direction shifts the cursor by the offset.
        `SELECT ${ORDER_COLS} FROM shop_order
         WHERE test = false AND ($1::timestamptz IS NULL OR updated_at > ($1::timestamptz AT TIME ZONE 'UTC'))
         ORDER BY updated_at ASC NULLS FIRST
         LIMIT $2`,
        [since, limit],
    );
    return rows.rows;
}

/**
 * Look up specific REAL orders by their numeric legacy id (the id the app stored on
 * activation). `test = false`: a test order must never back a reversal or a payment row.
 */
export async function ordersByLegacyIds(legacyIds: string[]): Promise<MirrorOrder[]> {
    const p = getPool();
    if (!p || legacyIds.length === 0) return [];
    const rows = await p.query<MirrorOrder>(
        `SELECT ${ORDER_COLS} FROM shop_order WHERE test = false AND legacy_id = ANY($1::text[])`,
        [legacyIds],
    );
    return rows.rows;
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
    const p = getPool();
    if (!p) return [];
    const rows = await p.query<{ variantLegacyId: string }>(
        `SELECT DISTINCT variant_legacy_id AS "variantLegacyId" FROM shop_order_line
         WHERE order_gid = $1 AND variant_legacy_id IS NOT NULL`,
        [orderGid],
    );
    return rows.rows.map((r) => r.variantLegacyId);
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
 *
 * ⚠ AT TIME ZONE 'UTC' is load-bearing, not decoration. s-read's timestamps are
 * `timestamp WITHOUT time zone` holding UTC (Prisma's default mapping for DateTime),
 * and node-pg resolves a naive timestamp against the NODE PROCESS's zone — so a
 * container running anything but UTC reads every run at an offset and reports
 * nonsense freshness ("just now" for an hours-old sync, since a future instant makes
 * the difference negative). The cast pins the interpretation to UTC and hands the
 * driver a timestamptz, which is unambiguous everywhere. Deployed tasks happen to
 * run TZ=UTC today; this makes that a non-issue rather than a dependency.
 */
export async function latestSyncRun(): Promise<MirrorSyncRun | null> {
    const p = getPool();
    if (!p) return null;
    const rows = await p.query<MirrorSyncRun>(
        `SELECT status::text AS status, kind::text AS kind,
                started_at  AT TIME ZONE 'UTC' AS "startedAt",
                finished_at AT TIME ZONE 'UTC' AS "finishedAt",
                counts, error
         FROM sync_run
         ORDER BY started_at DESC
         LIMIT 1`,
    );
    return rows.rows[0] ?? null;
}

/**
 * Diagnostic probe: how many sync runs the mirror holds. One round trip whose
 * FAILURE is as informative as its success — the thrown pg error's `code`
 * discriminates every layer between here and the data (network, auth, database
 * missing, table missing, SELECT grant missing), which is why the diagnose route
 * calls this instead of six separate checks. Errors are deliberately NOT caught
 * here: the caller owns the code→verdict mapping.
 */
export async function countSyncRuns(): Promise<number> {
    const p = getPool();
    if (!p) throw new Error("shopify_read mirror is not configured");
    const rows = await p.query<{ runs: number }>(`SELECT count(*)::int AS runs FROM sync_run`);
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
    const p = getPool();
    if (!p) throw new Error("shopify_read mirror is not configured");
    const rows = await p.query<{ lines: number; withVariant: number }>(
        // Joined to shop_order for the same `test = false` rule as ordersForVariants:
        // lines of test orders must not count as coverage, or a handful of test
        // orders synced post-backfill would mask a still-unbackfilled real mirror.
        `SELECT count(*)::int AS "lines", count(l.variant_legacy_id)::int AS "withVariant"
         FROM shop_order_line l
         JOIN shop_order o ON o.shopify_gid = l.order_gid
         WHERE l.removed = false AND o.test = false`,
    );
    return rows.rows[0];
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
    const p = getPool();
    if (!p || variantIds.length === 0) return [];
    const rows = await p.query<MirrorAuditOrder>(
        `SELECT legacy_id AS "legacyId", name, customer_email AS "customerEmail",
                financial_status AS "financialStatus", total_cents AS "totalCents",
                total_refunded_cents AS "totalRefundedCents",
                discount_codes AS "discountCodes",
                cancelled_at AT TIME ZONE 'UTC' AS "cancelledAt",
                (SELECT array_agg(DISTINCT l.variant_legacy_id)
                   FROM shop_order_line l
                  WHERE l.order_gid = shop_order.shopify_gid AND l.removed = false
                    AND l.variant_legacy_id = ANY($1::text[])) AS "matchedVariantIds"
         FROM shop_order
         WHERE test = false
           AND EXISTS (SELECT 1 FROM shop_order_line l
                        WHERE l.order_gid = shop_order.shopify_gid AND l.removed = false
                          AND l.variant_legacy_id = ANY($1::text[]))
         ORDER BY legacy_id NULLS LAST`,
        [variantIds],
    );
    return rows.rows;
}

/**
 * Which of the given numeric order ids exist in the mirror as REAL orders.
 * `test = false` matches every other read here: a test-mode order must not
 * serve as the payment basis that turns an activation "ORDER_MATCHED".
 */
export async function orderLegacyIdsPresent(legacyIds: string[]): Promise<Set<string>> {
    const p = getPool();
    if (!p || legacyIds.length === 0) return new Set();
    const rows = await p.query<{ legacyId: string }>(
        `SELECT legacy_id AS "legacyId" FROM shop_order WHERE test = false AND legacy_id = ANY($1::text[])`,
        [legacyIds],
    );
    return new Set(rows.rows.map((r) => r.legacyId));
}

/**
 * Order GIDs that have a chargeback/dispute balance transaction, among the given
 * GIDs. Shopify Payments surfaces a dispute as a signed balance transaction whose
 * `type` names the dispute — this distinguishes a chargeback (CRITICAL) from an
 * ordinary refund. Case-insensitive LIKE so 'dispute'/'chargeback'/'adjustment'
 * variants all match. Only disputes on real (`test = false`) orders count.
 */
export async function disputedOrderGids(orderGids: string[]): Promise<Set<string>> {
    const p = getPool();
    if (!p || orderGids.length === 0) return new Set();
    const rows = await p.query<{ orderGid: string }>(
        `SELECT DISTINCT bt.order_gid AS "orderGid" FROM shop_balance_transaction bt
         JOIN shop_order o ON o.shopify_gid = bt.order_gid
         WHERE bt.order_gid = ANY($1::text[]) AND o.test = false
           AND (lower(bt.type) LIKE '%dispute%' OR lower(bt.type) LIKE '%chargeback%')`,
        [orderGids],
    );
    return new Set(rows.rows.map((r) => r.orderGid));
}

/**
 * The smallest real (non-test) order legacy id in the mirror — the mirror's low-water mark.
 * An activation whose recorded order id sits BELOW this predates the mirror's coverage and is
 * unverifiable-by-design, not a gap. Null when the mirror holds no non-test orders (or is
 * unwired) → the caller then treats every not-in-mirror id as a real gap.
 * legacy_id is numeric-in-text; the ::bigint cast orders them numerically, ::text hands JS a
 * string to BigInt-parse without node-pg's numeric coercion.
 * ponytail: assumes every legacy_id parses as bigint — true for Shopify order ids.
 */
export async function minRealOrderLegacyId(): Promise<bigint | null> {
    const p = getPool();
    if (!p) return null;
    const rows = await p.query<{ minLegacyId: string | null }>(
        // `~ '^\d+$'` guards the ::bigint cast: a single non-numeric legacy_id (a
        // hand-loaded/test row) would otherwise throw for the WHOLE aggregate and
        // 500 the audit. Shopify ids are always numeric, so this skips only junk.
        `SELECT min(legacy_id::bigint)::text AS "minLegacyId"
         FROM shop_order WHERE test = false AND legacy_id ~ '^\\d+$'`,
    );
    const v = rows.rows[0]?.minLegacyId;
    return v == null ? null : BigInt(v);
}
