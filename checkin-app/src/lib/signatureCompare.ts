import crypto from "crypto";
import { config } from "@/lib/config";
import { logger } from "@/lib/logger";
import type { WebhookVerifyResult } from "@/lib/webhookAuth";

/**
 * Constant-time string equality. Both sides are hashed to a fixed length first,
 * so timingSafeEqual cannot throw on a length mismatch and no length leaks.
 *
 * Two empty strings are equal: a caller whose secret may be unset or empty
 * refuses that case itself before comparing.
 */
export function constantTimeEqual(a: string, b: string): boolean {
    return crypto.timingSafeEqual(
        crypto.createHash("sha256").update(a).digest(),
        crypto.createHash("sha256").update(b).digest(),
    );
}

export type ShopifyHmacRejection = "missing signature" | "signature mismatch";

/**
 * Verify the Shopify HMAC over the EXACT raw bytes. Config-not-set is a server
 * error (500); missing/wrong signature is unauthorized (401). Must run on the raw
 * body before it is parsed — re-serializing JSON would change the bytes.
 *
 * `source` names the endpoint in the config-error log; `onRejected` is how that
 * endpoint logs a refused delivery.
 */
export function verifyShopifyHmac(
    req: Request,
    rawBody: string,
    source: string,
    onRejected: (reason: ShopifyHmacRejection) => void,
): WebhookVerifyResult {
    const secret = config.shopifyWebhookSecret();
    if (!secret) {
        logger.error(`${source} received but SHOPIFY_WEBHOOK_SECRET is not configured.`);
        return { ok: false, status: 500, error: "Configuration Error" };
    }

    const headerSignature = req.headers.get("x-shopify-hmac-sha256");
    if (!headerSignature) {
        onRejected("missing signature");
        return { ok: false, status: 401, error: "Missing signature" };
    }

    const generatedSignature = crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
    if (!constantTimeEqual(generatedSignature, headerSignature)) {
        onRejected("signature mismatch");
        return { ok: false, status: 401, error: "Invalid signature" };
    }

    return { ok: true };
}
