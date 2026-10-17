import prisma from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { systemActor } from "@/lib/auditActor";

/**
 * Delivery log for the inbound Shopify webhook, surfaced on the "Shopify
 * Webhook" settings tab so a board member can verify the store's webhook
 * wiring end-to-end: press "Send test notification" in the Shopify admin,
 * then see the receipt inside checkin. Settlement is driven ONLY by the
 * orders/paid webhook, so a store with no webhook registered silently never
 * settles; this log is the in-app evidence. Only signature-verified deliveries
 * are recorded — a rejected one writes nothing (see logRejectedShopifyWebhook).
 *
 * Stored as AuditLog rows (actorId 0 = system, the convention the audit-log
 * viewer already renders as "System") rather than a new table: the repo allows
 * at most one schema migration per release and a concurrent PR already carries
 * it, and AuditLog's Json newData column fits an append-only event log fine.
 * tableName is the query key.
 */
export const SHOPIFY_WEBHOOK_RECEIPT_TABLE = "ShopifyWebhookReceipt";

/** Shape of one receipt, stored in AuditLog.newData. */
export interface ShopifyWebhookReceipt {
    /** X-Shopify-Topic header (e.g. "orders/paid"); null if absent. */
    topic: string | null;
    /** X-Shopify-Shop-Domain header — which store sent it; null if absent. */
    shopDomain: string | null;
    /** Whether HMAC verification passed. false = secret mismatch / missing signature. */
    hmacValid: boolean;
    /** True for Shopify's "Send test notification" sample and test-mode orders. */
    test: boolean;
    /** Shopify order id as a string; null when the payload has none / is unparseable. */
    orderId: string | null;
    /** One short line: what the webhook route did with the delivery. */
    outcome: string;
    /** ISO timestamp of receipt. */
    receivedAt: string;
}

// Shopify's admin "Send test notification" button sends a fixed sample order
// with this well-known id (the same across stores). Kept as a string: the
// value exceeds Number.MAX_SAFE_INTEGER, so JSON.parse rounds it — the number
// comparison below matches the rounded double, the string comparison matches
// stores/clients that send the id as a string.
const SHOPIFY_SAMPLE_ORDER_ID = "820982911946154508";

const REJECT_LOG_INTERVAL_MS = 60_000;
let lastRejectLogAt = 0;
let rejectsSinceLastLog = 0;

/**
 * Log a delivery that failed signature checks, at most once a minute per
 * instance, with a count of the rejections since the last line. Writes nothing
 * to the database: an unauthenticated caller must not be able to add rows.
 */
export function logRejectedShopifyWebhook(reason: string, now = Date.now()): void {
    rejectsSinceLastLog++;
    if (now - lastRejectLogAt < REJECT_LOG_INTERVAL_MS) return;
    logger.warn(`Shopify webhook rejected (${reason}); ${rejectsSinceLastLog} rejected in the last interval.`);
    lastRejectLogAt = now;
    rejectsSinceLastLog = 0;
}

/**
 * Detect Shopify's "Send test notification" sample (and test-mode orders).
 * The payload is untrusted input of unknown shape, so read it defensively:
 * test orders carry `"test": true`; the admin sample additionally uses the
 * fixed sample order id (checked both as string and as the JSON.parse-rounded
 * number, see SHOPIFY_SAMPLE_ORDER_ID).
 */
export function isShopifyTestNotification(order: unknown): boolean {
    if (typeof order !== "object" || order === null) return false;
    const o = order as { test?: unknown; id?: unknown };
    if (o.test === true) return true;
    if (o.id === undefined || o.id === null) return false;
    return String(o.id) === SHOPIFY_SAMPLE_ORDER_ID || Number(o.id) === Number(SHOPIFY_SAMPLE_ORDER_ID);
}

/**
 * Append one delivery receipt. NEVER throws: a failed insert must not break
 * settlement (a non-2xx would make Shopify retry the whole order), so the
 * write is fully swallowed — logged and moved past.
 */
export async function recordShopifyWebhookReceipt(
    req: Request,
    order: unknown,
    opts: { hmacValid: boolean; outcome: string },
): Promise<void> {
    try {
        const o = (typeof order === "object" && order !== null ? order : {}) as { id?: unknown };
        const receipt: ShopifyWebhookReceipt = {
            topic: req.headers.get("x-shopify-topic"),
            shopDomain: req.headers.get("x-shopify-shop-domain"),
            hmacValid: opts.hmacValid,
            test: isShopifyTestNotification(order),
            orderId: o.id === undefined || o.id === null ? null : String(o.id),
            outcome: opts.outcome,
            receivedAt: new Date().toISOString(),
        };
        await prisma.auditLog.create({
            data: {
                ...systemActor("webhook:shopify-receipt"),
                action: "CREATE",
                tableName: SHOPIFY_WEBHOOK_RECEIPT_TABLE,
                affectedEntityId: 0, // no entity row backs a receipt; newData IS the record
                newData: { ...receipt },
            },
        });
    } catch (error) {
        logger.error("Failed to record Shopify webhook receipt (delivery log only — settlement unaffected):", error);
    }
}
