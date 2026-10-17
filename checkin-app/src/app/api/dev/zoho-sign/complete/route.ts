import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import { config } from "@/lib/config";
import { logger } from "@/lib/logger";
import { ZOHO_WEBHOOK_HEADER } from "@/lib/membership/contract/zoho";
import { signingMockActive } from "@/lib/membership/contract/signingTarget";
import { apiError } from "@/lib/api-response";

export const dynamic = "force-dynamic";

/**
 * POST /api/dev/zoho-sign/complete — dev-only completion trigger for the Zoho Sign
 * mock (see docs/ops/contract-signing-mock.md). Reached from the dev
 * interstitial's "Complete signing" button. Rather than shortcut to markContractSigned,
 * it synthesizes a Zoho completion payload and fires the REAL inbound webhook, so the
 * mock exercises the same verify → parse → match → advance path prod does. The shared
 * secret stays server-side (config supplies a dev default in mock mode).
 *
 * 404s whenever the mock isn't active — always in prod.
 */
export const POST = withAuth({}, async (req, auth) => {
    // Honors the dev settings radio too (signingMockActive) — available exactly
    // when signing requests are routed to the debug interstitial.
    if (!(await signingMockActive())) return apiError("Not available", 404);
    if (auth.type !== "session") return apiError("Unauthorized", 401);

    const { rid } = await req.json().catch(() => ({ rid: undefined }));
    if (!rid || typeof rid !== "string") return apiError("Missing rid", 400);

    const secret = config.zohoWebhookSecret();
    if (!secret) return apiError("No webhook secret", 500);

    const res = await fetch(`${config.baseUrl()}/api/webhooks/zoho`, {
        method: "POST",
        headers: { "Content-Type": "application/json", [ZOHO_WEBHOOK_HEADER]: secret },
        body: JSON.stringify({ requests: { request_id: rid, request_status: "completed" } }),
    });
    if (!res.ok) {
        logger.error(`Dev zoho-sign complete: webhook returned ${res.status} for ${rid}`);
        return NextResponse.json({ error: "Webhook failed", status: res.status }, { status: 502 });
    }
    return NextResponse.json({ ok: true });
});
