import { NextResponse } from "next/server";
import crypto from "crypto";
import prisma from "@/lib/prisma";
import { withAuth } from "@/lib/auth";
import { config, DEV_MOCK_MEMBERSHIP_VARIANT_ID } from "@/lib/config";
import { logger } from "@/lib/logger";
import { apiError } from "@/lib/api-response";

export const dynamic = "force-dynamic";

/**
 * POST /api/dev/shopify/orders-paid — dev-only stand-in for a real Shopify
 * orders/paid webhook (see docs/designs/SHOPIFY_DEV_STORE_WEBHOOK.md §6). Reached
 * from the dev tool's "Fire orders/paid" buttons. Rather than shortcut to
 * activate(), it synthesizes the order payload Shopify would send, signs it with
 * the mock webhook secret, and fires the REAL inbound webhook — so it exercises
 * the same HMAC-verify → match-by-cart-attribute → activate path prod runs
 * (mirrors the Zoho mock, docs/ops/contract-signing-mock.md).
 *
 * Two payload shapes, discriminated by body:
 *   { processId }                     → membership activation
 *   { programId, participantIds[] }   → program-enrollment activation
 *
 * ENV GATE: LOCAL ONLY. shopifyMockActive() is true iff CHECKIN_ENV=local, so this
 * route 404s on BOTH dev and prod — dev and prod pay through their real Shopify
 * store, which fires the real orders/paid webhook itself. Each path also fails
 * CLOSED when its target isn't actually awaiting payment (process not
 * PENDING_PAYMENT / participants not PENDING): the dev UI only ever lists
 * awaiting-payment rows, so the API refuses to fire a webhook for anything else.
 */
export const POST = withAuth({}, async (req, auth) => {
    if (!config.shopifyMockActive()) return apiError("Not available", 404); // local only; 404 on dev + prod
    if (auth.type !== "session") return apiError("Unauthorized", 401);

    if (!config.shopifyWebhookSecret()) return apiError("No webhook secret", 500);

    // .catch covers unparseable bodies; ?. covers parseable non-objects (`null`, `42`).
    const body = await req.json().catch(() => null);

    if (typeof body?.programId === "number") {
        return fireProgram(body.programId, body.participantIds);
    }
    if (typeof body?.processId === "number") {
        return fireMembership(body.processId);
    }
    return apiError("Missing or invalid processId / programId", 400);
});

// Sign the mock payload with the fixed dev secret and POST it at the REAL inbound
// webhook, same as Shopify would. Returns the webhook's HTTP status.
async function fireWebhook(payload: object): Promise<number> {
    const secret = config.shopifyWebhookSecret()!;
    const rawBody = JSON.stringify({ financial_status: "paid", ...payload });
    const signature = crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
    const res = await fetch(`${config.baseUrl()}/api/webhooks/shopify`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-shopify-topic": "orders/paid", "x-shopify-hmac-sha256": signature },
        body: rawBody,
    });
    return res.status;
}

async function fireMembership(processId: number): Promise<NextResponse> {
    if (!Number.isInteger(processId)) return apiError("Missing or invalid processId", 400);

    const existing = await prisma.orgMembershipProcess.findUnique({ where: { id: processId }, select: { status: true } });
    if (!existing || existing.status !== "PENDING_PAYMENT") {
        return apiError("Process not found or not awaiting payment", 404);
    }

    // A real paid order carries the membership variant id in its line_items; the
    // inbound handler matches it against BoardSettings to confirm the order is for
    // the membership product (#624/H2). The mock must echo a configured variant id
    // or the webhook lands as a no-membership-item anomaly, not an activation.
    const settings = await prisma.boardSettings.findUnique({ where: { id: 1 } });
    // Mock stands in for the manual BoardSettings variant a local seed never sets;
    // the inbound handler echoes the same fallback so the order matches (config).
    const variantId = settings?.orgMembershipVariantId ?? DEV_MOCK_MEMBERSHIP_VARIANT_ID;

    // Shape mirrors the subset the inbound handler reads: note_attributes (where
    // Shopify maps cart attributes) + line_items + an order id. Stable id so two
    // overlapping fires for the same process (both inside the pre-check window
    // above) collapse into one idempotent webhook retry on the handler side;
    // sequential re-fires are blocked by the PENDING_PAYMENT gate.
    const status = await fireWebhook({
        id: `dev-mock-order-${processId}`,
        note_attributes: [{ name: "Membership_Process_ID", value: String(processId) }],
        line_items: [{ variant_id: variantId }],
    });
    if (status >= 400) {
        logger.error(`Dev shopify orders-paid: webhook returned ${status} for process ${processId}`);
        return NextResponse.json({ error: "Webhook failed", status }, { status: 502 });
    }

    // Report the resulting status so the tool can show whether it activated, held
    // for background clearance, etc. (the webhook itself always 200s to Shopify).
    const proc = await prisma.orgMembershipProcess.findUnique({ where: { id: processId }, select: { status: true } });
    return NextResponse.json({ ok: true, status: proc?.status ?? null });
}

async function fireProgram(programId: number, rawParticipantIds: unknown): Promise<NextResponse> {
    const participantIds = Array.isArray(rawParticipantIds)
        ? rawParticipantIds.filter((n): n is number => typeof n === "number" && Number.isInteger(n))
        : [];
    if (!Number.isInteger(programId) || participantIds.length === 0) {
        return apiError("Missing or invalid programId / participantIds", 400);
    }

    // Fail closed like the membership path: only fire for participants actually
    // awaiting payment. The dev UI only lists PENDING rows, so anything else is a
    // stale/forged request, not a real checkout.
    const pending = await prisma.programParticipant.findMany({
        where: { programId, personId: { in: participantIds }, status: "PENDING" },
        select: { personId: true },
    });
    if (pending.length === 0) {
        return apiError("No matching participants awaiting payment", 404);
    }
    const pendingIds = pending.map((p) => p.personId);

    // Mirror the membership variant echo: the program branch of the inbound
    // handler fails CLOSED unless the paid order's line_items contain one of the
    // program's own Shopify variant id (webhooks/shopify/route.ts). Program has a
    // price (that's how the participant reached PENDING) but the variant may still
    // be unset.
    const program = await prisma.program.findUnique({
        where: { id: programId },
        select: { shopifyVariantId: true },
    });
    const variantId = program?.shopifyVariantId;
    if (!variantId) {
        return apiError("No Shopify variant configured on this program. Set one on the program in program-ops first, or the webhook leaves the participant PENDING.", 409);
    }

    // note_attributes carry the comma-joined account ids + program id exactly as
    // buildShopifyCheckoutUrl encodes them; the handler splits on ',' and activates
    // each PENDING participant. Stable order id → idempotent re-fire.
    const status = await fireWebhook({
        id: `dev-mock-order-prog-${programId}`,
        note_attributes: [
            { name: "CheckMeIn_Account_ID", value: pendingIds.join(",") },
            { name: "Program_ID", value: String(programId) },
        ],
        line_items: [{ variant_id: variantId, quantity: pendingIds.length }],
    });
    if (status >= 400) {
        logger.error(`Dev shopify orders-paid: webhook returned ${status} for program ${programId}`);
        return NextResponse.json({ error: "Webhook failed", status }, { status: 502 });
    }

    const activated = await prisma.programParticipant.findMany({
        where: { programId, personId: { in: pendingIds } },
        select: { personId: true, status: true },
    });
    return NextResponse.json({ ok: true, participants: activated });
}
