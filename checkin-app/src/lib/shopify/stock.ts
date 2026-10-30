// Program stock engine: the one writer of a program's Shopify stock, its lease and
// keyed-delta path, the unconfirmed-write settle, price sync and off-sale.

import { centsToDecimalString } from "@checkin/money";
import crypto from "crypto";
import prisma from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import type { TxClient } from "@/lib/db-client";
import { escapeHtml } from "@/lib/email-templates/base";
import { config } from "@/lib/config";
import { isSaleEnded, saleStockDelta } from "@/lib/programs/saleState";
import { programVariantIds } from "@/lib/programs/variants";
import { getAccessToken, reportShopifyFailure, shopifyFetch, SHOPIFY_API_VERSION, SHOPIFY_INVENTORY_API_VERSION } from "@/lib/shopify/client";
import { outboundCall } from "@/security/outbound";

/** A stock lease outlives its push's cap by this much, so it can't expire under a writer still inside its cap. */
const STOCK_LEASE_SLACK_MS = 30_000;
/** How often a writer re-tries a busy lease. */
const STOCK_LEASE_POLL_MS = 250;

/**
 * @internal Tests shrink these. A cap bounds one push, lease wait included: a user
 * request waits `requestCapMs`, a webhook or job `capMs`.
 */
export const programStockTiming = { capMs: 3 * 60_000, requestCapMs: 15_000, maxBackoffMs: 15_000 };

/** A program's stock bookkeeping for a variant it no longer sells: cleared when `shopifyVariantId` changes. */
export const STOCK_BOOKKEEPING_RESET = {
    shopifyStockCarry: 0,
    shopifyStockPendingWrite: null,
    shopifyStockUnconfirmed: 0,
    shopifyStockParked: null,
    shopifyStockPushNeededAt: null,
} satisfies Prisma.ProgramUpdateManyMutationInput;

/** Shopify keeps an idempotency key 24 h; a pending write older than this is not resent (it could apply twice) but parked as unconfirmed. */
const PENDING_WRITE_RESEND_LIMIT_MS = 23 * 60 * 60_000;


/** Codes that mean "not settled yet — resend the same request". */
const TRANSIENT_CODES = new Set(["THROTTLED", "INTERNAL_SERVER_ERROR", "TIMEOUT", "SERVICE_UNAVAILABLE", "IDEMPOTENCY_CONCURRENT_REQUEST"]);

/** Shopify gave no settled answer before the cap: the request may still land. */
class StockWriteUnsettledError extends Error {}

/** The exact write sent under one idempotency key, persisted so a resend reuses identical parameters. */
interface PendingStockWrite {
    key: string;
    reason: string;
    /** What the write changes Shopify's `available` by. */
    delta: number;
    /** How much of the carry the write takes; if it lands, any difference stays owed. */
    owedPart: number;
    inventoryItemId: string;
    locationId: string;
    sentAt: string;
}

interface GqlBody<T> {
    data?: T;
    errors?: { message?: string; extensions?: { code?: string } }[];
}
/** One GraphQL round trip. Throws only on a transport failure (network, our timeout). */
type Gql = (query: string, variables: Record<string, unknown>) => Promise<{ status: number; body: unknown }>;

type UserErrors = { userErrors: { code?: string; message: string }[] };
type ReadData = {
    locations: { nodes: { id: string; isActive: boolean }[] };
    productVariant: {
        inventoryItem: {
            id: string;
            inventoryLevels: { nodes: { location: { id: string }; quantities: { quantity: number }[] }[] };
        } | null;
    } | null;
};

const READ_STOCK = `
    query ProgramStockRead($variantId: ID!) {
        locations(first: 50) { nodes { id isActive } }
        productVariant(id: $variantId) {
            inventoryItem {
                id
                inventoryLevels(first: 50) { nodes { location { id } quantities(names: ["available"]) { quantity } } }
            }
        }
    }`;

const ACTIVATE_STOCK = `
    mutation ProgramStockActivate($inventoryItemId: ID!, $locationId: ID!, $idempotencyKey: String!) {
        inventoryActivate(inventoryItemId: $inventoryItemId, locationId: $locationId) @idempotent(key: $idempotencyKey) {
            inventoryLevel { id }
            userErrors { field message }
        }
    }`;

const ADJUST_STOCK = `
    mutation ProgramStockAdjust($input: InventoryAdjustQuantitiesInput!, $idempotencyKey: String!) {
        inventoryAdjustQuantities(input: $input) @idempotent(key: $idempotencyKey) {
            inventoryAdjustmentGroup { id }
            userErrors { code field message }
        }
    }`;

function shopifyGraphql(storeDomain: string, accessToken: string): Gql {
    return async (query, variables) => {
        const res = await shopifyFetch(`https://${storeDomain}/admin/api/${SHOPIFY_INVENTORY_API_VERSION}/graphql.json`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
            body: JSON.stringify({ query, variables }),
        }, "Shopify program stock");
        // An unreadable body (a 5xx gateway page, a 200 cut off mid-read) parses as {}; untilSettled treats it as unsettled.
        const body: unknown = await res.json().catch(() => ({}));
        return { status: res.status, body };
    };
}

/** CHECKIN_ENV=local stand-in: one location, stock per inventory item in memory, idempotency keys honoured. */
const mockStockByItem = new Map<string, number>();
const mockAppliedKeys = new Set<string>();
const MOCK_LOCATION_ID = "gid://shopify/Location/dev-mock";
const mockShopifyGraphql: Gql = async (query, variables) => {
    const reply = (data: unknown) => ({ status: 200, body: { data } });
    if (query.includes("ProgramStockRead")) {
        const itemId = `gid://shopify/InventoryItem/for-${String(variables.variantId)}`;
        const available = mockStockByItem.get(itemId);
        const levels = available === undefined ? [] : [{ location: { id: MOCK_LOCATION_ID }, quantities: [{ quantity: available }] }];
        return reply({
            locations: { nodes: [{ id: MOCK_LOCATION_ID, isActive: true }] },
            productVariant: { inventoryItem: { id: itemId, inventoryLevels: { nodes: levels } } },
        });
    }
    if (query.includes("ProgramStockActivate")) {
        mockStockByItem.set(String(variables.inventoryItemId), 0);
        return reply({ inventoryActivate: { userErrors: [] } });
    }
    const key = String(variables.idempotencyKey);
    const input = variables.input as { changes: { inventoryItemId: string; delta: number }[] };
    const { inventoryItemId, delta } = input.changes[0];
    if (!mockAppliedKeys.has(key)) {
        mockAppliedKeys.add(key);
        const before = mockStockByItem.get(inventoryItemId) ?? 0;
        mockStockByItem.set(inventoryItemId, before + delta);
        console.log(`[SHOPIFY] (mock) Adjusted available for ${inventoryItemId}: ${before} -> ${before + delta} (key ${key})`);
    }
    return reply({ inventoryAdjustQuantities: { userErrors: [] } });
};

/**
 * Send one request until Shopify gives a settled answer: resend the SAME variables
 * (so the same idempotency key) on a transport failure, 5xx, 429, a transient
 * GraphQL code or a reply with no readable body, with capped exponential backoff,
 * until `deadline`. A 401/403 after an attempt that may have reached Shopify does
 * not say whether that attempt landed, so it is resent too. Throws on a hard error
 * or when the deadline passes unsettled.
 */
async function untilSettled<T>(
    gql: Gql,
    query: string,
    variables: Record<string, unknown>,
    deadline: number,
    stillRunning: (data: T) => boolean = () => false,
): Promise<T> {
    let lastError = "no reply";
    let maybeSent = false;
    for (let attempt = 0; ; attempt++) {
        let reply: { status: number; body: GqlBody<T> } | null = null;
        try {
            const raw = await gql(query, variables);
            reply = { status: raw.status, body: (raw.body ?? {}) as GqlBody<T> };
        } catch (err) {
            lastError = err instanceof Error ? err.message : String(err);
        }
        if (reply) {
            const { status, body } = reply;
            const unreadable = status < 400 && body.data === undefined && !body.errors?.length;
            const transient = status >= 500 || status === 429 || unreadable
                || (maybeSent && (status === 401 || status === 403))
                || (body.errors ?? []).some((e) => TRANSIENT_CODES.has(e.extensions?.code ?? ""))
                || (body.data !== undefined && stillRunning(body.data));
            if (!transient) {
                if (status >= 400 || body.errors?.length || body.data === undefined) {
                    throw new Error(`Shopify GraphQL ${status}: ${JSON.stringify(body.errors ?? body)}`);
                }
                return body.data;
            }
            lastError = `HTTP ${status} ${JSON.stringify(body.errors ?? (unreadable ? "unreadable body" : "IDEMPOTENCY_CONCURRENT_REQUEST"))}`;
        }
        maybeSent = true;
        const wait = Math.min(1000 * 2 ** attempt, programStockTiming.maxBackoffMs);
        if (Date.now() + wait > deadline) {
            throw new StockWriteUnsettledError(`Shopify did not settle within ${programStockTiming.capMs}ms: ${lastError}`);
        }
        await new Promise((resolve) => setTimeout(resolve, wait));
    }
}

async function readStock(gql: Gql, variantId: string, deadline: number) {
    const data = await untilSettled<ReadData>(gql, READ_STOCK, { variantId: `gid://shopify/ProductVariant/${variantId}` }, deadline);
    const item = data.productVariant?.inventoryItem;
    if (!item) throw new Error(`Shopify variant ${variantId} not found or has no inventory item`);
    // Fails closed: an inactive or unknown-state location rejects inventory writes.
    const active = new Set(data.locations.nodes.filter((l) => l.isActive).map((l) => l.id));
    // The location already stocking the item, so a multi-location store keeps one pool.
    const level = item.inventoryLevels.nodes.find((n) => active.has(n.location.id));
    const locationId = level?.location.id ?? [...active][0];
    if (!locationId) throw new Error("no active Shopify location");
    // null = the item is not stocked at the location yet (a freshly created variant).
    return { inventoryItemId: item.id, locationId, available: level ? (level.quantities[0]?.quantity ?? 0) : null };
}

/**
 * Send one recorded delta with `inventoryAdjustQuantities` and its idempotency key.
 * Shopify dedupes this mutation by key (dev store, 2026-10-14): a resend of a write
 * that already landed returns its original result instead of applying it again, and
 * a resend of one that failed returns the original error. So the reply is always
 * definite: "applied", or a hard error (thrown), which means it did not apply.
 */
async function sendStockWrite(gql: Gql, write: PendingStockWrite, deadline: number): Promise<"applied"> {
    const codesOf = (d: { inventoryAdjustQuantities?: UserErrors }) => d.inventoryAdjustQuantities?.userErrors.map((e) => e.code ?? "") ?? [];
    // The write goes out as the Program.shopifyStockPendingWrite it is booked as.
    const data = await outboundCall(
        'shopify.inventory.adjust',
        { Program: { shopifyStockPendingWrite: JSON.stringify(write) } },
        (stripped) => {
            const sent = JSON.parse((stripped.Program as { shopifyStockPendingWrite: string }).shopifyStockPendingWrite) as PendingStockWrite;
            const variables = {
                input: {
                    name: "available",
                    reason: "correction",
                    changes: [{
                        inventoryItemId: sent.inventoryItemId,
                        locationId: sent.locationId,
                        delta: sent.delta,
                        // Deltas commute with store sales, so no compare: the key is the guard.
                        changeFromQuantity: null,
                    }],
                },
                idempotencyKey: sent.key,
            };
            return untilSettled<{ inventoryAdjustQuantities?: UserErrors }>(
                gql, ADJUST_STOCK, variables, deadline,
                (d) => codesOf(d).includes("IDEMPOTENCY_CONCURRENT_REQUEST"),
            );
        },
    );
    if (codesOf(data).length === 0) return "applied";
    throw new Error(`inventoryAdjustQuantities userErrors: ${JSON.stringify(data.inventoryAdjustQuantities?.userErrors)}`);
}

/** A write parked as unconfirmed: never re-sent, settled on its own by a person. */
interface ParkedStockWrite {
    key: string;
    delta: number;
    parkedAt: string;
}

function parkedWrites(column: string | null): ParkedStockWrite[] {
    return column ? (JSON.parse(column) as ParkedStockWrite[]) : [];
}

/** Now, or 1 ms after the latest parked write: `parkedAt` names the write on the board's settle screen. */
function uniqueParkedAt(earlier: ParkedStockWrite[]): string {
    const latest = Math.max(0, ...earlier.map((w) => Date.parse(w.parkedAt)));
    return new Date(Math.max(Date.now(), latest + 1)).toISOString();
}

function parkedColumn(writes: ParkedStockWrite[]): string | null {
    return writes.length > 0 ? JSON.stringify(writes) : null;
}

/** How much of a settled write the app still owes: what it wanted minus what landed. */
function stillOwed(write: PendingStockWrite, outcome: "applied" | "notApplied"): number {
    return outcome === "applied" ? write.owedPart - write.delta : write.owedPart;
}

/** An absolute stock target, counted on the transaction that holds the Program row lock. */
export type StockTarget = (db: TxClient) => Promise<number>;

/** Serializes a program's seat changes, each with its carry change, against the re-arm recount. */
async function lockProgramRow(tx: TxClient, programId: number): Promise<void> {
    await tx.$queryRaw`SELECT id FROM "Program" WHERE id = ${programId} FOR UPDATE`;
}

/** Take the program's stock lease if it is free or expired. One short statement; no transaction stays open. */
async function takeStockLease(programId: number, capMs: number): Promise<string | null> {
    const token = crypto.randomUUID();
    const now = new Date();
    const { count } = await prisma.program.updateMany({
        where: { id: programId, OR: [{ shopifyStockLeaseUntil: null }, { shopifyStockLeaseUntil: { lt: now } }] },
        data: { shopifyStockLeaseUntil: new Date(now.getTime() + capMs + STOCK_LEASE_SLACK_MS), shopifyStockLeaseToken: token },
    });
    return count === 1 ? token : null;
}

/** The lease expired under this writer and another took it; this writer stops before sending anything else. */
class StockLeaseLostError extends Error {}

/** Change the stock bookkeeping, only while `token` still holds the program's lease. */
async function bookStock(programId: number, token: string, data: Prisma.ProgramUpdateManyMutationInput): Promise<void> {
    const { count } = await prisma.program.updateMany({ where: { id: programId, shopifyStockLeaseToken: token }, data });
    if (count !== 1) throw new StockLeaseLostError(`lost the Shopify stock lease for program ${programId}`);
}

/**
 * Send a write already booked as pending and book how it settled. A write that may
 * still land (no settled answer before the cap) stays pending, for the next push to
 * resend under its key; a hard error settled it unapplied, so it goes back to owed.
 */
async function sendBooked(gql: Gql, programId: number, token: string, write: PendingStockWrite, deadline: number): Promise<void> {
    try {
        await sendStockWrite(gql, write, deadline);
    } catch (error) {
        if (!(error instanceof StockWriteUnsettledError)) {
            await bookStock(programId, token, { shopifyStockCarry: { increment: stillOwed(write, "notApplied") }, shopifyStockPendingWrite: null });
        }
        throw error;
    }
    await bookStock(programId, token, { shopifyStockCarry: { increment: stillOwed(write, "applied") - (await landedAfterSale(programId, write)) }, shopifyStockPendingWrite: null });
}

/**
 * The part of an applied write that put seats on sale after the sale ended (the
 * off-sale date passed while it was booked, in flight, or pending a resend). It is
 * booked back as owed with the settlement itself, so the drain takes it straight
 * back off sale.
 */
async function landedAfterSale(programId: number, write: PendingStockWrite): Promise<number> {
    if (write.delta <= 0) return 0;
    const sale = await prisma.program.findUnique({ where: { id: programId }, select: { startAt: true, offSaleAt: true, saleEndedAt: true } });
    if (!sale || !isSaleEnded(sale)) return 0;
    console.log(`[SHOPIFY] Program ${programId} sale ended while +${write.delta} (${write.key}) was in flight: taking it back off sale`);
    return write.delta;
}

interface DrainResult {
    error: unknown;
    expiredKey: string | null;
}

/**
 * Holding the lease: settle a write a failed push left pending, then land the
 * whole owed carry as one keyed delta, looping so deltas recorded meanwhile land
 * too. Each write is booked as pending (and its amount taken out of the carry)
 * BEFORE it is sent, and its outcome booked after, so a crash leaves it to be
 * resent under its key. Stock is never taken below 0: the shortfall stays as a
 * negative carry. Reports, never throws.
 */
async function drainStock(
    gql: Gql,
    programId: number,
    variantId: string,
    reason: string,
    token: string,
    deadline: number,
    target?: StockTarget,
): Promise<DrainResult> {
    const result: DrainResult = { error: null, expiredKey: null };
    try {
        for (;;) {
            // Nothing is in flight here: whatever was sent is booked, so stopping leaves it for the next push.
            if (Date.now() >= deadline) throw new StockWriteUnsettledError(`stock push for program ${programId} ran out of time`);
            const row = await prisma.program.findUnique({
                where: { id: programId },
                select: { shopifyStockCarry: true, shopifyStockPendingWrite: true, shopifyStockParked: true, startAt: true, offSaleAt: true, saleEndedAt: true },
            });
            if (!row) throw new Error(`program ${programId} not found`);

            if (row.shopifyStockPendingWrite) {
                const pending = JSON.parse(row.shopifyStockPendingWrite) as PendingStockWrite;
                if (Date.now() - Date.parse(pending.sentAt) >= PENDING_WRITE_RESEND_LIMIT_MS) {
                    // Shopify may have forgotten the key, so a resend could apply twice: a person settles it.
                    // Kept as its own entry: writes of opposite sign must not cancel before anyone settles them.
                    result.expiredKey = pending.key;
                    const earlier = parkedWrites(row.shopifyStockParked);
                    const parked = [...earlier, { key: pending.key, delta: pending.delta, parkedAt: uniqueParkedAt(earlier) }];
                    await bookStock(programId, token, {
                        shopifyStockCarry: { increment: pending.owedPart - pending.delta },
                        shopifyStockParked: parkedColumn(parked),
                        shopifyStockPendingWrite: null,
                    });
                } else {
                    // ponytail: the resend settles whether the +1 landed; if it did, it sits on sale until the -1 right after.
                    await sendBooked(gql, programId, token, pending, deadline);
                    console.log(`[SHOPIFY] Program ${programId} settled pending stock write ${pending.key}`);
                }
                continue;
            }

            if (target === undefined && row.shopifyStockCarry === 0) break;
            const stock = await readStock(gql, variantId, deadline);
            let available = stock.available;
            if (available === null) {
                await outboundCall('shopify.inventory.activate', { Program: { id: programId } }, (stripped) =>
                    untilSettled(gql, ACTIVATE_STOCK, {
                        inventoryItemId: stock.inventoryItemId,
                        locationId: stock.locationId,
                        idempotencyKey: `program-${(stripped.Program as { id: number }).id}-activate-${crypto.randomUUID()}`,
                    }, deadline));
                available = 0;
            }
            if (target !== undefined) {
                // An absolute target replaces whatever was owed before it, as the delta from what Shopify shows now.
                // Counted under the lease and under the Program row lock that every seat change takes with its
                // carry change (changeProgramStockWith), so each change is counted with its delta in the carry or
                // not at all. `available` already shows whether each parked write landed, so the target resolves
                // them: settling one later would count it twice.
                if (row.shopifyStockParked) {
                    console.log(`[SHOPIFY] Program ${programId} stock set from scratch (${reason}): cleared parked writes ${parkedWrites(row.shopifyStockParked).map((w) => w.key).join(", ")}`);
                }
                const quantity = target;
                const shown = available;
                await prisma.$transaction(async (tx) => {
                    await lockProgramRow(tx, programId);
                    const carry = (await quantity(tx)) - shown;
                    const { count } = await tx.program.updateMany({
                        where: { id: programId, shopifyStockLeaseToken: token },
                        data: { shopifyStockCarry: carry, shopifyStockParked: null, shopifyStockUnconfirmed: 0 },
                    });
                    if (count !== 1) throw new StockLeaseLostError(`lost the Shopify stock lease for program ${programId}`);
                });
                result.expiredKey = null;
                target = undefined;
                continue;
            }

            // After the sale has ended, owed stock may only come off sale, never go back on.
            const total = saleStockDelta(row, row.shopifyStockCarry);
            if (total !== row.shopifyStockCarry) {
                console.log(`[SHOPIFY] Program ${programId} sale has ended: dropping ${row.shopifyStockCarry - total} owed seat(s) instead of putting them back on sale`);
                await bookStock(programId, token, { shopifyStockCarry: { increment: total - row.shopifyStockCarry } });
            }
            if (total === 0) break;
            // Never below 0: held at 0, the shortfall stays owed as a negative carry.
            // ponytail: a store sale between this read and the adjust can still take it
            // to -1 (sold out either way); the drift check will see that gap.
            const delta = Math.max(total, -available);
            if (delta === 0) break;

            const write: PendingStockWrite = {
                key: `program-${programId}-${reason}-${crypto.randomUUID()}`,
                reason,
                delta,
                owedPart: total,
                inventoryItemId: stock.inventoryItemId,
                locationId: stock.locationId,
                sentAt: new Date().toISOString(),
            };
            await bookStock(programId, token, { shopifyStockCarry: { increment: -total }, shopifyStockPendingWrite: JSON.stringify(write) });
            await sendBooked(gql, programId, token, write, deadline);
            console.log(`[SHOPIFY] Program ${programId} stock ${available} -> ${available + delta} (${reason}, key ${write.key})`);
            // Held at 0: what's left is the over-capacity shortfall, nothing more to write.
            if (delta !== total) break;
        }
    } catch (error) {
        result.error = error;
    }
    return result;
}

/** The program-stock GraphQL client: the local mock, or the live store; null without credentials. */
async function stockGql(): Promise<Gql | null> {
    if (config.shopifyMockActive()) return mockShopifyGraphql;
    const storeDomain = config.shopifyStoreDomain();
    const accessToken = await getAccessToken();
    return storeDomain && accessToken ? shopifyGraphql(storeDomain, accessToken) : null;
}

async function alertStockPush(programId: number, variantId: string, reason: string, error: unknown): Promise<void> {
    await reportShopifyFailure(
        "adjustProgramInventory",
        error,
        { programId, shopifyVariantId: variantId, reason },
        `Shopify stock for program ${programId} needs a push (${escapeHtml(reason)}): a change could not be confirmed and is still owed. The daily Shopify reconcile retries it.`,
    );
}

/**
 * Land whatever the program owes Shopify, under its stock lease. Waits for a busy
 * lease by polling (no connection held) until the cap. Sets or clears
 * `shopifyStockPushNeededAt`, alerts the board, never throws. Returns false when
 * something is still owed or unconfirmed because of a failure.
 */
async function pushProgramStock(
    programId: number,
    variantId: string,
    reason: string,
    capMs: number,
    carryBefore: number,
    target?: StockTarget,
): Promise<boolean> {
    const deadline = Date.now() + capMs;
    try {
        const gql = await stockGql();
        if (!gql) {
            await prisma.program.update({ where: { id: programId }, data: { shopifyStockPushNeededAt: new Date() } });
            await alertStockPush(programId, variantId, reason, new Error("Shopify credentials missing or access token unavailable"));
            return false;
        }

        let token = await takeStockLease(programId, capMs);
        while (!token && Date.now() + STOCK_LEASE_POLL_MS < deadline) {
            await new Promise((resolve) => setTimeout(resolve, STOCK_LEASE_POLL_MS));
            token = await takeStockLease(programId, capMs);
        }
        if (!token) {
            // The holder re-reads the carry before it lets go, so it usually lands this delta too.
            await prisma.program.update({ where: { id: programId }, data: { shopifyStockPushNeededAt: new Date() } });
            console.warn(`[SHOPIFY] Program ${programId} stock lease stayed busy for ${capMs}ms; the delta stays owed.`);
            return false;
        }

        const result = await drainStock(gql, programId, variantId, reason, token, deadline, target);
        const row = await prisma.program.findUnique({
            where: { id: programId },
            select: { shopifyStockCarry: true, shopifyStockUnconfirmed: true, shopifyStockParked: true, shopifyStockPendingWrite: true, shopifyStockPushNeededAt: true },
        });
        const carryAfter = row?.shopifyStockCarry ?? 0;
        const needsPush = result.error !== null || carryAfter !== 0 || (row?.shopifyStockUnconfirmed ?? 0) !== 0 || !!row?.shopifyStockParked || !!row?.shopifyStockPendingWrite;
        await prisma.program.updateMany({
            where: { id: programId, shopifyStockLeaseToken: token },
            data: {
                shopifyStockLeaseUntil: null,
                shopifyStockLeaseToken: null,
                shopifyStockPushNeededAt: needsPush ? (row?.shopifyStockPushNeededAt ?? new Date()) : null,
            },
        });

        if (result.error) {
            console.error(`[Shopify Error] Failed to push stock for program ${programId}:`, result.error);
            await alertStockPush(programId, variantId, reason, result.error);
        } else if (carryAfter < Math.min(0, carryBefore)) {
            const over = -carryAfter;
            await reportShopifyFailure(
                "adjustProgramInventory",
                new Error(`program ${programId} is over capacity by ${over}; Shopify held at 0`),
                { programId, shopifyVariantId: variantId, reason, carry: carryAfter },
                `Program ${programId} is over capacity by ${over} seat(s), so its Shopify stock is held at 0. The next ${over} seat(s) given back will not go on sale.`,
            );
        }
        if (result.expiredKey) {
            // The board settles it on Revenue Ops > Shopify > Unconfirmed Shopify stock (settleUnconfirmedStock).
            await reportShopifyFailure(
                "adjustProgramInventory",
                new Error(`stock write ${result.expiredKey} for program ${programId} could not be confirmed`),
                { programId, shopifyVariantId: variantId, idempotencyKey: result.expiredKey, parked: row?.shopifyStockParked ?? null },
                `A Shopify stock write for program ${programId} (key ${escapeHtml(result.expiredKey)}) stayed unsettled for a day, so Shopify could not say whether it landed. It will not be re-sent. Check the program's stock in Shopify by hand, then settle it on Revenue Ops &gt; Shopify &gt; Unconfirmed Shopify stock.`,
            );
        }
        return result.error === null && result.expiredKey === null;
    } catch (error) {
        // The DB failed mid-push; the lease expires on its own and the carry keeps what was not booked.
        console.error(`[Shopify Error] Stock push for program ${programId} failed:`, error);
        await alertStockPush(programId, variantId, reason, error);
        return false;
    }
}

/** Options for {@link adjustProgramInventory}. */
export interface StockWriteOptions {
    /** A user request: the push, lease wait included, is capped at `programStockTiming.requestCapMs`. */
    inRequest?: boolean;
    /** A webhook: record the delta and push in the background, so the reply stays inside Shopify's 5 s timeout. */
    deferred?: boolean;
}

/**
 * The ONE writer of a program's public Shopify stock: every app-initiated change
 * (initial stock, cap edits, scholarship holds and releases, comps, activation,
 * reconciler heals) comes through here. The caller decides the delta; this only
 * decides how it is written.
 *
 * The delta is first added to `Program.shopifyStockCarry` (what the app owes
 * Shopify), then a push lands the whole carry under a per-program lease (one
 * writer per program; no DB transaction is held across a Shopify call). Each
 * write is one delta, `inventoryAdjustQuantities` (API 2026-04) with an
 * idempotency key and no compare: deltas commute with store sales. A timeout,
 * 5xx or IDEMPOTENCY_CONCURRENT_REQUEST resends the SAME request until Shopify
 * settles or the cap passes (15 s in a user request, 3 min otherwise). Shopify
 * dedupes this mutation by key (dev store, 2026-10-14), so a resend of a write
 * that already landed is not applied twice. A write left unsettled is resent
 * under its key by the next push; after a day (the key's lifetime) it is parked
 * as unconfirmed for the board instead.
 *
 * Stock never goes below 0: an over-capacity shortfall stays as a negative carry
 * that later positive deltas pay down before any seat goes back on sale.
 *
 * Never throws. Returns whether the change landed; {@link changeProgramStock}
 * also says whether it was recorded. Whatever doesn't land stays owed and flagged
 * (`shopifyStockPushNeededAt`); the board is emailed; the daily reconcile-shopify
 * job re-pushes it ({@link healProgramStock}).
 */
export async function adjustProgramInventory(
    program: { id: number; shopifyVariantId?: string | null },
    delta: number,
    reason: string,
    options: StockWriteOptions = {},
): Promise<boolean> {
    return (await changeProgramStock(program, delta, reason, options)).landed;
}

/** What became of a stock change: `recorded` = owed in the carry (it will land), `landed` = confirmed in Shopify. */
export interface StockChange {
    recorded: boolean;
    landed: boolean;
}

/**
 * {@link adjustProgramInventory}, telling "recorded but not yet confirmed" apart
 * from "not recorded at all". A caller that marks a seat as taken out of stock
 * (a comp, a scholarship hold) keys on `recorded`: once the delta is in the carry
 * it lands later (next push or the daily heal) even when this push failed.
 */
export async function changeProgramStock(
    program: { id: number; shopifyVariantId?: string | null },
    delta: number,
    reason: string,
    options: StockWriteOptions = {},
): Promise<StockChange> {
    const variantId = program.shopifyVariantId;
    if (!variantId || delta === 0) return { recorded: true, landed: true };
    if (config.shopifyMockActive()) console.log(`[SHOPIFY] (mock) Would adjust inventory by ${delta} for variant: ${variantId}`);

    let carryBefore: number;
    try {
        const { shopifyStockCarry } = await prisma.program.update({
            where: { id: program.id },
            data: { shopifyStockCarry: { increment: delta } },
            select: { shopifyStockCarry: true },
        });
        carryBefore = shopifyStockCarry - delta;
    } catch (error) {
        await alertStockPush(program.id, variantId, reason, error);
        return { recorded: false, landed: false };
    }

    if (options.deferred) {
        // ponytail: fire-and-forget on this server process. A restart drops the push;
        // the delta stays owed in the carry and the daily heal lands it.
        void pushProgramStock(program.id, variantId, reason, programStockTiming.capMs, carryBefore);
        return { recorded: true, landed: true };
    }
    const capMs = options.inRequest ? programStockTiming.requestCapMs : programStockTiming.capMs;
    return { recorded: true, landed: await pushProgramStock(program.id, variantId, reason, capMs, carryBefore) };
}

/** The stock delta could not be written to the carry, so the transaction (row change included) rolled back. The board has been alerted. */
export class StockNotRecordedError extends Error {}

/**
 * Change the rows that move a program's taken seats and record the stock delta
 * they cause in ONE transaction under the Program row lock, then push. The row
 * change and its carry change commit together, so the re-arm recount (which
 * takes the same lock) never counts a change whose delta is not yet owed, a
 * reader never sees the change without its delta, and a crash cannot keep one
 * without the other. `change` returns the delta; a failure rolls both back and
 * throws. A failed carry write alerts the board and throws {@link StockNotRecordedError}. Returns whether the push landed (a recorded
 * delta that did not land stays owed and flagged, as with {@link changeProgramStock}).
 */
export async function changeProgramStockWith<T>(
    program: { id: number; shopifyVariantId?: string | null },
    reason: string,
    change: (tx: TxClient) => Promise<{ result: T; delta: number }>,
    options: StockWriteOptions = {},
): Promise<{ result: T; landed: boolean }> {
    const variantId = program.shopifyVariantId;
    const { result, delta, carryBefore } = await prisma.$transaction(async (tx) => {
        await lockProgramRow(tx, program.id);
        const { result, delta } = await change(tx);
        if (!variantId || delta === 0) return { result, delta: 0, carryBefore: 0 };
        try {
            const { shopifyStockCarry } = await tx.program.update({
                where: { id: program.id },
                data: { shopifyStockCarry: { increment: delta } },
                select: { shopifyStockCarry: true },
            });
            return { result, delta, carryBefore: shopifyStockCarry - delta };
        } catch (error) {
            await alertStockPush(program.id, variantId, reason, error);
            throw new StockNotRecordedError(`stock change for program ${program.id} could not be recorded`, { cause: error });
        }
    });
    if (!variantId || delta === 0) return { result, landed: true };
    if (config.shopifyMockActive()) console.log(`[SHOPIFY] (mock) Would adjust inventory by ${delta} for variant: ${variantId}`);
    if (options.deferred) {
        // ponytail: fire-and-forget, as in changeProgramStock; the daily heal lands what a restart drops.
        void pushProgramStock(program.id, variantId, reason, programStockTiming.capMs, carryBefore);
        return { result, landed: true };
    }
    const capMs = options.inRequest ? programStockTiming.requestCapMs : programStockTiming.capMs;
    return { result, landed: await pushProgramStock(program.id, variantId, reason, capMs, carryBefore) };
}

/**
 * Push whatever a program already owes, in the background (no new delta). The
 * refund webhook calls it so a restocked seat is netted against an over-capacity
 * carry right away instead of selling until the daily heal.
 */
export async function nudgeProgramStock(program: { id: number; shopifyVariantId: string }): Promise<void> {
    // No new delta, so no over-capacity alert: a restock only pays down an existing shortfall.
    void pushProgramStock(program.id, program.shopifyVariantId, "restock", programStockTiming.capMs, Number.NEGATIVE_INFINITY);
}

/**
 * Re-push every program the stock writer left owing (flagged, a write that may
 * still land, or a carry). The daily reconcile-shopify job calls it. Never throws.
 */
export async function healProgramStock(): Promise<{ checked: number; settled: number }> {
    // ponytail: the periodic drift check (recommendation §4, waiting on the board's
    // store decision) will also read shopifyStockPushNeededAt; until then this is its only reader.
    const programs = await prisma.program.findMany({
        where: {
            shopifyVariantId: { not: null },
            OR: [
                { shopifyStockPushNeededAt: { not: null } },
                { shopifyStockPendingWrite: { not: null } },
                { shopifyStockCarry: { not: 0 } },
            ],
        },
        select: { id: true, shopifyVariantId: true, shopifyStockCarry: true },
    });
    let settled = 0;
    for (const program of programs) {
        if (!program.shopifyVariantId) continue;
        if (await pushProgramStock(program.id, program.shopifyVariantId, "heal", programStockTiming.capMs, program.shopifyStockCarry)) settled++;
    }
    return { checked: programs.length, settled };
}

/** One parked stock write, as the board's settle screen shows it. A program parked twice has two rows. */
export interface UnconfirmedStockRow {
    programId: number;
    programName: string;
    unconfirmed: number;
    carry: number;
    /** When the write was parked, unique per program: the settle names the write by it. Null for an amount the previous release parked. */
    unconfirmedSince: Date | null;
    /** Shopify's `available` now; null when it can't be read within a few seconds. */
    shopifyAvailable: number | null;
}

/** Bounds the board screen's Shopify read per program. */
const UNCONFIRMED_READ_CAP_MS = 5_000;

/** Every parked (unconfirmed) stock write, oldest first per program. Never writes. */
export async function listUnconfirmedStock(): Promise<UnconfirmedStockRow[]> {
    const programs = await prisma.program.findMany({
        where: { OR: [{ shopifyStockParked: { not: null } }, { shopifyStockUnconfirmed: { not: 0 } }] },
        select: { id: true, name: true, shopifyVariantId: true, shopifyStockParked: true, shopifyStockUnconfirmed: true, shopifyStockCarry: true },
        orderBy: { id: "asc" },
    });
    if (programs.length === 0) return [];

    const gql = await stockGql().catch(() => null);
    const available = async (variantId: string | null): Promise<number | null> => {
        if (!gql || !variantId) return null;
        try {
            return (await readStock(gql, variantId, Date.now() + UNCONFIRMED_READ_CAP_MS)).available;
        } catch {
            return null;
        }
    };
    const perProgram = await Promise.all(programs.map(async (p) => {
        const shopifyAvailable = await available(p.shopifyVariantId);
        const row = (unconfirmed: number, unconfirmedSince: Date | null): UnconfirmedStockRow =>
            ({ programId: p.id, programName: p.name, unconfirmed, carry: p.shopifyStockCarry, unconfirmedSince, shopifyAvailable });
        return [
            ...(p.shopifyStockUnconfirmed !== 0 ? [row(p.shopifyStockUnconfirmed, null)] : []),
            ...parkedWrites(p.shopifyStockParked).map((w) => row(w.delta, new Date(w.parkedAt))),
        ];
    }));
    return perProgram.flat();
}

/** "landed": Shopify has the change, so it is dropped. "notLanded": it goes back into the owed carry. */
export type UnconfirmedStockChoice = "landed" | "notLanded";
export type SettleUnconfirmedOutcome = { carry: number } | { refused: "notFound" | "busy" | "stale" };

/** How long the settle step holds the program's stock lease (it makes no Shopify call). */
const SETTLE_LEASE_MS = 10_000;

/**
 * A board member settles one of a program's parked stock writes after checking
 * Shopify by hand. The write is named by the row the page showed: its `parkedAt`
 * and amount, or `parkedAt` null for the previous release's amount. Under the
 * program's stock lease, in one transaction: refuses as stale when that write is
 * no longer parked (settled from another tab, or a re-arm resolved it), else
 * removes it, adds it to the carry for "notLanded", and writes the AuditLog row.
 * "landed" makes no Shopify call; "notLanded" then nudges a push so the carry
 * lands as a keyed delta.
 */
export async function settleUnconfirmedStock(
    programId: number,
    expected: number,
    parkedAt: string | null,
    choice: UnconfirmedStockChoice,
    actorId: number,
): Promise<SettleUnconfirmedOutcome> {
    const token = await takeStockLease(programId, SETTLE_LEASE_MS);
    if (!token) {
        return { refused: (await prisma.program.count({ where: { id: programId } })) === 0 ? "notFound" : "busy" };
    }
    let settled: { carry: number; variantId: string | null } | null;
    try {
        settled = await prisma.$transaction(async (tx) => {
            const before = await tx.program.findUniqueOrThrow({
                where: { id: programId },
                select: { shopifyStockParked: true, shopifyStockUnconfirmed: true },
            });
            const parked = parkedWrites(before.shopifyStockParked);
            const legacy = parkedAt === null && before.shopifyStockUnconfirmed === expected;
            const index = parkedAt === null ? -1 : parked.findIndex((w) => w.parkedAt === parkedAt && w.delta === expected);
            if (index === -1 && !legacy) return null;
            const settledKey = legacy ? null : parked[index].key;
            const bookkeeping: Prisma.ProgramUpdateManyMutationInput = legacy
                ? { shopifyStockUnconfirmed: 0 }
                : { shopifyStockParked: parkedColumn(parked.filter((_, i) => i !== index)) };
            const { count } = await tx.program.updateMany({
                where: { id: programId, shopifyStockLeaseToken: token },
                data: choice === "landed" ? bookkeeping : { ...bookkeeping, shopifyStockCarry: { increment: expected } },
            });
            if (count !== 1) return null;
            const row = await tx.program.findUniqueOrThrow({
                where: { id: programId },
                select: { shopifyStockCarry: true, shopifyVariantId: true },
            });
            await tx.auditLog.create({
                data: {
                    actorId,
                    action: "EDIT",
                    tableName: "Program",
                    affectedEntityId: programId,
                    oldData: { shopifyStockUnconfirmed: before.shopifyStockUnconfirmed, shopifyStockParked: before.shopifyStockParked },
                    newData: { settledUnconfirmedStock: choice, amount: expected, key: settledKey, shopifyStockCarry: row.shopifyStockCarry },
                },
            });
            return { carry: row.shopifyStockCarry, variantId: row.shopifyVariantId };
        });
    } finally {
        await prisma.program.updateMany({
            where: { id: programId, shopifyStockLeaseToken: token },
            data: { shopifyStockLeaseUntil: null, shopifyStockLeaseToken: null },
        });
    }
    if (!settled) return { refused: "stale" };
    if (choice === "notLanded" && settled.variantId) {
        await nudgeProgramStock({ id: programId, shopifyVariantId: settled.variantId });
    }
    return { carry: settled.carry };
}

/**
 * Sets the program's base price on every Shopify variant it sells — the public
 * one and the hidden claimant one. Both carry the base (non-member) price; members
 * get their discount through {@link mintMemberDiscountCode}, so the member price
 * alone never reaches Shopify. Called from PATCH /api/programs/[id] when the
 * base price changes.
 *
 * A zero or null base is never pushed: a $0 public variant gives seats away in
 * the store. That case is reported to admins like any other failure.
 *
 * Never throws: on failure logs + emails admins via reportShopifyFailure and
 * returns false, so the caller can warn that Shopify's price is out of date.
 */
export async function syncProgramPrice(
    program: { id: number; name: string; shopifyVariantId?: string | null; claimantShopifyVariantId?: string | null },
    basePriceCents: number | null,
): Promise<boolean> {
    const variantIds = programVariantIds(program);
    if (variantIds.length === 0) return true;

    const context = { programId: program.id, variantIds, basePriceCents };
    const emailIntro = `The Shopify price for program <strong>${escapeHtml(program.name)}</strong> is out of date. Set it by hand in Shopify on every variant listed below.`;

    if (!basePriceCents || basePriceCents <= 0) {
        await reportShopifyFailure(
            "syncProgramPrice",
            new Error(`Base price is ${basePriceCents == null ? "unset" : "$0"}; Shopify variants ${variantIds.join(", ")} keep their old price`),
            context,
            emailIntro,
        );
        return false;
    }
    const price = centsToDecimalString(basePriceCents);

    // See createShopifySingleVariantProgram for why this branch exists (CHECKIN_ENV=local mock).
    if (config.shopifyMockActive()) {
        console.log(`[SHOPIFY] (mock) Would set price ${price} on variants: ${variantIds.join(", ")}`);
        return true;
    }

    const storeDomain = config.shopifyStoreDomain();
    const accessToken = await getAccessToken();
    if (!storeDomain || !accessToken) {
        await reportShopifyFailure(
            "syncProgramPrice",
            new Error("Shopify credentials missing or access token unavailable"),
            context,
            emailIntro,
        );
        return false;
    }

    try {
        // ponytail: REST product endpoints are legacy; switch to GraphQL productVariantsBulkUpdate with the capacity redesign's GraphQL move (≥2026-04).
        const bag = {
            Program: {
                shopifyVariantId: program.shopifyVariantId,
                claimantShopifyVariantId: program.claimantShopifyVariantId,
                nonOrgMemberPriceCents: basePriceCents,
            },
        };
        await outboundCall('shopify.product.update', bag, async (stripped) => {
            const sent = stripped.Program as { shopifyVariantId?: string | null; claimantShopifyVariantId?: string | null; nonOrgMemberPriceCents: number };
            const sentPrice = centsToDecimalString(sent.nonOrgMemberPriceCents);
            for (const variantId of programVariantIds(sent)) {
                const res = await shopifyFetch(`https://${storeDomain}/admin/api/${SHOPIFY_API_VERSION}/variants/${variantId}.json`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
                    body: JSON.stringify({ variant: { id: Number(variantId), price: sentPrice } }),
                }, "Shopify update variant price");
                if (!res.ok) {
                    throw new Error(`Shopify price update failed for variant ${variantId}: ${res.status} ${await res.text()}`);
                }
            }
        });
        console.log(`[SHOPIFY] Set price ${price} on variants ${variantIds.join(", ")}`);
        return true;
    } catch (error) {
        console.error("[Shopify Error] Failed to update program price:", error);
        await reportShopifyFailure("syncProgramPrice", error, context, emailIntro);
        return false;
    }
}

/**
 * Sets a program's Shopify stock to an absolute quantity, for when relative
 * adjustments were skipped (a sale that ended and is re-armed). Same lease and
 * keyed-delta path as {@link adjustProgramInventory}: under the lease the carry
 * becomes `quantity() − available`, replacing deltas owed before it, since
 * `quantity` counts from the app's own seats. `quantity` runs under the lease and
 * may be negative: an over-capacity program holds Shopify at 0 and keeps the
 * shortfall owed, so seats given back later pay it down before any goes on sale.
 * Never throws.
 */
export async function setProgramInventory(
    program: { id: number; shopifyVariantId?: string | null },
    quantity: StockTarget,
    reason: string,
): Promise<boolean> {
    if (!program.shopifyVariantId) return true;
    return pushProgramStock(program.id, program.shopifyVariantId, reason, programStockTiming.requestCapMs, Number.NEGATIVE_INFINITY, quantity);
}

/**
 * Takes a program's store product off sale by setting its status to draft, so
 * neither the store page nor an old cart link can buy it. Idempotent. A program
 * without a product has nothing to take down and succeeds.
 *
 * Called by the sale sweep (lib/programs/saleSweep.ts) on the off-sale date for
 * programs that have a reserved-seat product. Nothing re-lists it automatically.
 *
 * Never throws: logs + emails the admin via reportShopifyFailure and returns
 * false, so the sweep retries on its next run.
 */
export async function setProgramProductOffSale(
    program: { shopifyProductId?: string | null },
): Promise<boolean> {
    const productId = program.shopifyProductId;
    if (!productId) return true;

    if (config.shopifyMockActive()) {
        console.log(`[SHOPIFY] (mock) Would set product ${productId} to draft`);
        return true;
    }

    const storeDomain = config.shopifyStoreDomain();
    const accessToken = await getAccessToken();
    if (!storeDomain || !accessToken) {
        await reportShopifyFailure(
            "setProgramProductOffSale",
            new Error("Shopify credentials missing or access token unavailable"),
            { shopifyProductId: productId },
            `Failed to take a program's Shopify product off sale after its off-sale date. It will be retried on the next daily run.`,
        );
        return false;
    }

    try {
        const res = await outboundCall('shopify.product.update', { Program: { shopifyProductId: productId } }, (stripped) => {
            const sentId = (stripped.Program as { shopifyProductId: string }).shopifyProductId;
            return shopifyFetch(`https://${storeDomain}/admin/api/${SHOPIFY_API_VERSION}/products/${sentId}.json`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Shopify-Access-Token': accessToken,
                },
                body: JSON.stringify({ product: { id: Number(sentId), status: 'draft' } }),
            }, "Shopify product off sale");
        });
        if (!res.ok) {
            throw new Error(`Shopify product off-sale failed for ${productId}: ${res.status} ${await res.text()}`);
        }
        console.log(`[SHOPIFY] Product ${productId} set to draft (off sale)`);
        return true;
    } catch (error) {
        console.error("[Shopify Error] Failed to take program product off sale:", error);
        await reportShopifyFailure(
            "setProgramProductOffSale",
            error,
            { shopifyProductId: productId },
            `Failed to take a program's Shopify product off sale after its off-sale date. It will be retried on the next daily run.`,
        );
        return false;
    }
}
