import { NextResponse } from "next/server";
import crypto from "crypto";
import { logger } from "@/lib/logger";
import { withWebhook } from "@/lib/webhookAuth";
import { config } from "@/lib/config";
import { raiseReversalByOrderId, type PaymentExceptionKind, type RestockedLine } from "@/lib/finance/reconcile";
import { recordShopifyWebhookReceipt } from "@/lib/shopifyWebhookReceipt";

/**
 * Fast-path Shopify reversal webhooks — the low-latency complement to the daily
 * reconciler. Subscribed topics (register-shopify-webhook.ts):
 *   refunds/create        → REFUND
 *   orders/cancelled      → CANCELLED
 *   disputes/create       → CHARGEBACK (critical)
 *   disputes/update       → CHARGEBACK
 *
 * Each maps the affected Shopify order id to the membership process / program
 * enrollment it activated and raises a PaymentException (board decides — we never
 * auto-revert access, except removing a program enrollment whose seat the refund
 * restocked; see raiseReversalByOrderId). Whatever this drops, the daily reconciler still catches (within ~24h).
 * Same HMAC verify as the orders/paid route; the topic rides the x-shopify-topic
 * header.
 */

interface ReversalPayload {
    // orders/cancelled: the order object → id. refunds/create & disputes/*: order_id.
    id?: number | string;
    order_id?: number | string;
    // refunds/create only.
    refund_line_items?: { quantity?: number; restock_type?: string; line_item?: { variant_id?: number | string | null; quantity?: number } }[];
}

function restockedLines(payload: ReversalPayload): RestockedLine[] {
    return (payload.refund_line_items ?? [])
        .filter((l) => l.restock_type && l.restock_type !== "no_restock" && l.line_item?.variant_id != null)
        .map((l) => ({ variantId: String(l.line_item?.variant_id), quantity: l.quantity ?? 1, lineQuantity: l.line_item?.quantity ?? 1 }));
}

function verifyShopifyHmac(req: Request, rawBody: string): { ok: true } | { ok: false; status: number; error: string } {
    const secret = config.shopifyWebhookSecret();
    if (!secret) {
        logger.error("Shopify reversal webhook received but SHOPIFY_WEBHOOK_SECRET is not configured.");
        return { ok: false, status: 500, error: "Configuration Error" };
    }
    const headerSignature = req.headers.get("x-shopify-hmac-sha256");
    if (!headerSignature) return { ok: false, status: 401, error: "Missing signature" };

    const generated = crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
    const a = crypto.createHash("sha256").update(generated).digest();
    const b = crypto.createHash("sha256").update(headerSignature).digest();
    if (!crypto.timingSafeEqual(a, b)) {
        logger.error("Shopify reversal webhook signature mismatch.");
        return { ok: false, status: 401, error: "Invalid signature" };
    }
    return { ok: true };
}

const TOPIC_KIND: Record<string, PaymentExceptionKind> = {
    "refunds/create": "REFUND",
    "orders/cancelled": "CANCELLED",
    "disputes/create": "CHARGEBACK",
    "disputes/update": "CHARGEBACK",
};

export const POST = withWebhook({ provider: "shopify", verify: verifyShopifyHmac }, async (req, payload: ReversalPayload) => {
    const topic = req.headers.get("x-shopify-topic") ?? "";
    const kind = TOPIC_KIND[topic];
    // orders/cancelled sends the order (id); refunds/disputes send order_id.
    const orderId = topic === "orders/cancelled" ? payload.id : payload.order_id;

    let outcome: string;
    if (!kind) {
        outcome = `unhandled topic ${topic} — ignored`;
        logger.info(`[SHOPIFY REVERSAL] ${outcome}`);
    } else if (orderId == null) {
        outcome = `${topic}: no order id in payload — ignored`;
        logger.warn(`[SHOPIFY REVERSAL] ${outcome}`);
    } else {
        const matched = await raiseReversalByOrderId(String(orderId), kind, restockedLines(payload));
        outcome = matched
            ? `${topic}: raised ${kind} for order ${orderId}`
            : `${topic}: order ${orderId} not tied to any membership/enrollment — ignored`;
        logger.info(`[SHOPIFY REVERSAL] ${outcome}`);
    }

    await recordShopifyWebhookReceipt(req, payload, { hmacValid: true, outcome });
    return NextResponse.json({ success: true });
});
