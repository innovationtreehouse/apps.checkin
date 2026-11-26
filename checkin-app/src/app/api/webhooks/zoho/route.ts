import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { config } from "@/lib/config";
import { verifyZohoToken, parseZohoWebhook, ZOHO_WEBHOOK_HEADER } from "@/lib/membership/contract/zoho";
import { findProcessByEnvelope, markContractSigned, raiseDeniedClosedSignature } from "@/lib/membership/external";
import { withWebhook } from "@/lib/webhookAuth";
import { apiError } from "@/lib/api-response";

export const dynamic = "force-dynamic";

/**
 * Zoho has no native HMAC — verify the shared-secret header. Config-not-set is a
 * server error (500); a missing/wrong token is unauthorized (401). Runs against
 * headers only; the raw body is unused here.
 */
function verifyZoho(req: Request): { ok: true } | { ok: false; status: number; error: string } {
    if (!config.zohoWebhookSecret()) {
        logger.error("Zoho webhook received but ZOHO_WEBHOOK_SECRET is not configured.");
        return { ok: false, status: 500, error: "Configuration Error" };
    }
    if (!verifyZohoToken(req.headers.get(ZOHO_WEBHOOK_HEADER))) {
        return { ok: false, status: 401, error: "Invalid signature" };
    }
    return { ok: true };
}

/**
 * POST /api/webhooks/zoho — Zoho Sign contract completion callback.
 *
 * Verifies the shared-secret header, finds the membership process by its stored
 * Zoho request id, and (on a completed signing) records the contract as signed —
 * which may advance the application to payment. A signature for a DENIED household
 * records nothing and goes to the board. We never read contract content.
 */
export const POST = withWebhook({ provider: "zoho", verify: verifyZoho }, async (_req, body) => {
    const { requestId, completed } = parseZohoWebhook(body);
    if (!requestId) {
        logger.error("Zoho webhook missing request id.");
        return apiError("Missing request id", 400);
    }

    // Only act on completed signings; acknowledge other events so Zoho stops retrying.
    if (!completed) return NextResponse.json({ ok: true, ignored: "not completed" });

    const mp = await findProcessByEnvelope(requestId);
    if (!mp && await raiseDeniedClosedSignature(requestId)) return NextResponse.json({ ok: true, ignored: "denied household" });
    if (!mp) {
        logger.error(`Zoho webhook: no membership process for request ${requestId}.`);
        // Acknowledge to avoid endless retries for an unknown request.
        return NextResponse.json({ ok: true, ignored: "unknown request" });
    }

    await markContractSigned(mp.id);
    return NextResponse.json({ ok: true });
});
