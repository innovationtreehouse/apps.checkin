import { NextResponse } from "next/server";
import { logIntegrationError } from "./logger";
import { rateLimit } from "./rate-limit";

export type WebhookVerifyResult =
    | { ok: true }
    | { ok: false; status: number; error: string };

/**
 * Verify an inbound webhook against the raw request body BEFORE it is parsed or
 * trusted — e.g. Shopify HMAC over the exact bytes, or a Zoho shared-secret
 * header. Returns the error status/body to send when verification fails (missing
 * signature → 401, unconfigured secret → 500, …).
 */
export type WebhookVerify = (req: Request, rawBody: string) => WebhookVerifyResult;

/**
 * Higher-order wrapper for inbound provider webhooks (Shopify, Zoho) — the
 * session-less, signature-authenticated sibling of {@link withAuth}/{@link withCron}.
 * Standardizes the guard these routes share:
 *
 *   1. per-IP rate limit (bucket `webhook-${provider}`) BEFORE any work, so a
 *      flood can't burn CPU on signature checks;
 *   2. provider `verify` against the raw body;
 *   3. JSON parse (malformed → 400);
 *   4. a top-level catch that writes one IntegrationErrorLog row
 *      (`source: ${provider}-webhook`) and returns 500 — so a handler throw can
 *      never escape unlogged.
 *
 * The handler receives the parsed body and owns its own 2xx envelope.
 *
 *   export const POST = withWebhook(
 *       { provider: "shopify", verify: (req, rawBody) => verifyShopifyHmac(req, rawBody, "Shopify webhook", onRejected) },
 *       async (req, order: ShopifyOrder) => { ... },
 *   );
 */
export function withWebhook<T = unknown>(
    opts: { provider: string; verify: WebhookVerify },
    handler: (req: Request, body: T) => Promise<NextResponse>,
) {
    return async (req: Request): Promise<NextResponse> => {
        // Guard BEFORE reading/verifying so a flood can't burn CPU on signature checks.
        const limited = rateLimit(req, { name: `webhook-${opts.provider}`, limit: 60, windowMs: 60_000 });
        if (limited) return limited;

        try {
            const rawBody = await req.text();

            const verdict = opts.verify(req, rawBody);
            if (!verdict.ok) {
                return NextResponse.json({ error: verdict.error }, { status: verdict.status });
            }

            let body: T;
            try {
                body = JSON.parse(rawBody) as T;
            } catch {
                return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
            }

            return await handler(req, body);
        } catch (error) {
            await logIntegrationError(`${opts.provider}-webhook`, error, {
                operation: `POST /api/webhooks/${opts.provider}`,
            });
            return NextResponse.json({ error: "Webhook Error" }, { status: 500 });
        }
    };
}
