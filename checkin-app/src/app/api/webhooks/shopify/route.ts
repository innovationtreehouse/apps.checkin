import { NextResponse } from "next/server";
import crypto from "crypto";
import prisma from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { activateByProcessId } from "@/lib/membership/payment";
import { withWebhook } from "@/lib/webhookAuth";
import { config } from "@/lib/config";
import { activateProgramEnrollment } from "@/lib/programs/activateEnrollment";
import { unentitledMemberCodeUse } from "@/lib/programs/memberDiscountCode";
import { isPaid, membershipVariantIdSet, orderEntitlesEnrollment, raiseMembershipPaymentOutcome, raisePaymentException, type EntitlementOrder } from "@/lib/finance/reconcile";
import { isShopifyTestNotification, logRejectedShopifyWebhook, recordShopifyWebhookReceipt } from "@/lib/shopifyWebhookReceipt";

interface ShopifyOrder {
    id?: number | string;
    note_attributes?: { name: string; value: string }[];
    line_items?: { variant_id?: number | string; quantity?: number }[];
    financial_status?: string | null;
    cancelled_at?: string | null;
    /** Coupons applied at checkout — the program member-code entitlement check below. */
    discount_codes?: { code?: string }[];
}

/**
 * Verify the Shopify HMAC over the EXACT raw bytes. Config-not-set is a server
 * error (500); missing/wrong signature is unauthorized (401). Must run on the raw
 * body before it is parsed — re-serializing JSON would change the bytes.
 *
 * A rejected delivery writes nothing: it gets a rate-limited log line only.
 */
function verifyShopifyHmac(req: Request, rawBody: string): { ok: true } | { ok: false; status: number; error: string } {
    const secret = config.shopifyWebhookSecret();
    if (!secret) {
        logger.error("Shopify webhook received but SHOPIFY_WEBHOOK_SECRET is not configured.");
        return { ok: false, status: 500, error: "Configuration Error" };
    }

    const headerSignature = req.headers.get("x-shopify-hmac-sha256");
    if (!headerSignature) {
        logRejectedShopifyWebhook("missing signature");
        return { ok: false, status: 401, error: "Missing signature" };
    }

    const generatedSignature = crypto
        .createHmac("sha256", secret)
        .update(rawBody, "utf8")
        .digest("base64");

    // Hash both signatures to a fixed length before comparison to prevent timing attacks
    // and avoid leaking the expected signature length, then use crypto.timingSafeEqual.
    const generatedBuffer = crypto.createHash('sha256').update(generatedSignature).digest();
    const headerBuffer = crypto.createHash('sha256').update(headerSignature).digest();

    if (!crypto.timingSafeEqual(generatedBuffer, headerBuffer)) {
        logRejectedShopifyWebhook("signature mismatch");
        return { ok: false, status: 401, error: "Invalid signature" };
    }

    return { ok: true };
}

// Shopify Webhook for `orders/paid`.
// Verifies HMAC signature, extracts custom attributes, and marks user as ACTIVE.
//
// ENV: this handler runs in ALL environments — dev/prod receive it from the real
// Shopify store; local receives it from the self-fired mock (/api/dev/shopify/orders-paid).
// The HMAC secret differs per env (config.shopifyWebhookSecret). The only env-branched
// logic is the synthetic dev-mock variant fallback, gated on config.shopifyMockActive()
// (⇔ CHECKIN_ENV=local) inside membershipVariantIdSet.
export const POST = withWebhook({ provider: "shopify", verify: verifyShopifyHmac }, async (req, order: ShopifyOrder) => {
        // Only a paid, unreversed orders/paid delivery moves anything. A reversed one is
        // left to the reconciler, which raises it against the pending record.
        // A refund moves financial_status off "paid", so no refund total is needed here.
        const facts: EntitlementOrder = {
            legacyId: order.id ? String(order.id) : null,
            financialStatus: order.financial_status ?? null,
            cancelledAt: order.cancelled_at ? new Date(order.cancelled_at) : null,
            totalRefundedCents: 0,
            lines: (order.line_items ?? []).map((li) => ({ variantId: String(li.variant_id), quantity: li.quantity ?? 1 })),
        };
        const topic = req.headers.get("x-shopify-topic");
        if (topic !== "orders/paid" || !isPaid(facts)) {
            const outcome = `topic ${topic ?? "missing"}, financial_status ${order.financial_status ?? "missing"} — ignored`;
            logger.info(`[SHOPIFY WEBHOOK] order ${order.id ?? "?"}: ${outcome}`);
            await recordShopifyWebhookReceipt(req, order, { hmacValid: true, outcome });
            return NextResponse.json({ success: true });
        }

        // Iterate through line items to find CheckMeIn_Account_ID and Program_ID
        // We set these custom attributes in the permalink URL:
        // https://[store].myshopify.com/cart/[VariantID]:1?attributes[CheckMeIn_Account_ID]=123&attributes[Program_ID]=456
        
        let accountIdStr = null;
        let programIdStr = null;
        let membershipProcessIdStr = null;

        // Custom attributes in Cart Permalinks are usually mapped to `note_attributes` on the Order
        if (order.note_attributes && Array.isArray(order.note_attributes)) {
            for (const attr of order.note_attributes) {
                if (attr.name === "CheckMeIn_Account_ID") accountIdStr = attr.value;
                if (attr.name === "Program_ID") programIdStr = attr.value;
                if (attr.name === "Membership_Process_ID") membershipProcessIdStr = attr.value;
            }
        }

        // Membership payment → settle the application. activateByProcessId checks
        // the order CONTAINS the membership product (by variant id, the id the
        // checkout link is built from), never by total. Every outcome other than
        // settling or a redelivery is raised for the board.
        //
        // TODO(#278) still open: we still trust the customer-controlled
        // Membership_Process_ID cart attribute for WHICH process to credit (no
        // per-process checkout token yet), and the volunteer discount code is still
        // a self-serve code on a public cart link rather than gated to a Shopify
        // customer segment. Neither enables over-activation on its own now that the
        // membership item is checked, but both remain honor-system until a real
        // token / Shopify-side segment exists.
        let membershipOutcome: string | null = null;
        if (membershipProcessIdStr) {
            const processId = parseInt(membershipProcessIdStr, 10);
            const orderId = order.id ? String(order.id) : "";
            // Receipt outcome for the delivery log (settings → Shopify Webhook).
            let outcome = "invalid Membership_Process_ID — ignored";
            if (isShopifyTestNotification(order)) {
                // A test-mode order moves no money; it never settles a membership.
                outcome = `test order for process ${membershipProcessIdStr} — ignored`;
                logger.info(`[SHOPIFY WEBHOOK] Test order ${orderId || "?"} for membership process ${membershipProcessIdStr} — ignored`);
            } else if (!isNaN(processId)) {
                const settings = await prisma.boardSettings.findUnique({ where: { id: 1 } });
                const hasMembershipItem = (order.line_items ?? []).some((li) => membershipVariantIdSet(settings).has(String(li.variant_id)));
                const result = await activateByProcessId(processId, orderId, hasMembershipItem);
                await raiseMembershipPaymentOutcome(result.outcome, { shopifyOrderId: orderId || null, processId });
                outcome = `process ${processId}: ${result.outcome}`;
                logger.info(`[SHOPIFY WEBHOOK] Membership payment for process ${processId}: ${result.outcome}`);
            }
            membershipOutcome = outcome;
            // A mixed cart also carries program seats; fall through to settle them too.
            if (!(accountIdStr && programIdStr)) {
                await recordShopifyWebhookReceipt(req, order, { hmacValid: true, outcome });
                return NextResponse.json({ success: true });
            }
        }

        // Receipt outcome for the delivery log — the default also covers Shopify's
        // "Send test notification" sample order, which carries no cart attributes.
        let outcome = "no membership or program attributes — ignored";

        if (accountIdStr && programIdStr) {
            const participantIds = accountIdStr.split(',').map((id: string) => parseInt(id.trim(), 10)).filter((id: number) => !isNaN(id));
            const programId = parseInt(programIdStr, 10);
            outcome = "invalid CheckMeIn_Account_ID or Program_ID — ignored";

            if (participantIds.length > 0 && !isNaN(programId)) {
                // note_attributes are customer-controlled (set from the public cart
                // permalink), so the order itself must prove it pays for THIS program
                // and for every person it names — the same check the reconciler makes.
                const orderId = order.id ? String(order.id) : null;
                const entitlement = await orderEntitlesEnrollment(facts, programId, participantIds);

                // Member-code entitlement, judged HERE because this is the money event:
                // the order check proves the order pays for these seats, this proves the
                // family was allowed the price it paid. Never re-asked later.
                const codes = (order.discount_codes ?? []).map((d) => String(d.code ?? ""));
                // Seats this order paid for beyond the pending enrollments go to the board,
                // whatever happens to the rest of the order.
                if (entitlement.ok && entitlement.surplus) {
                    await raisePaymentException(entitlement.surplus.kind, { shopifyOrderId: orderId, programId, personId: entitlement.surplus.personId ?? participantIds[0] ?? null });
                }
                if (!entitlement.ok) {
                    logger.warn(`[SHOPIFY WEBHOOK] order ${orderId ?? "?"} does not entitle program ${programId} (${entitlement.kind}) — NOT activated`);
                    if (entitlement.kind) await raisePaymentException(entitlement.kind, { shopifyOrderId: orderId, programId, personId: entitlement.personId ?? participantIds[0] ?? null });
                    outcome = entitlement.kind
                        ? `program ${programId}: ${entitlement.kind} — flagged, not activated`
                        : `program ${programId}: ${"nothingAwaiting" in entitlement ? "nothing awaiting payment" : "not paid"} — not activated`;
                } else if (await unentitledMemberCodeUse(programId, participantIds, codes, orderId)) {
                    logger.warn(`[SHOPIFY WEBHOOK] Program member discount code on a non-member order ${orderId ?? "?"} (program ${programId}) — flagged, NOT activated`);
                    await raisePaymentException("DISCOUNT_UNAUTHORIZED", { shopifyOrderId: orderId, programId, personId: participantIds[0] ?? null });
                    outcome = `program ${programId}: unentitled member discount code — flagged, not activated`;
                } else {
                    // Shared choke point — same path the reconciler uses to recover a
                    // MISSED webhook (lib/programs/activateEnrollment). Idempotent; the
                    // inventory side effects are non-fatal (Shopify retries on a non-2xx).
                    const { activatedCount } = await activateProgramEnrollment({
                        programId,
                        personIds: participantIds,
                        shopifyOrderId: orderId ?? "",
                        lines: facts.lines,
                    });

                    outcome = `program ${programId}: activated ${activatedCount} of ${participantIds.length} participant(s)${entitlement.surplus ? `; ${entitlement.surplus.kind} flagged` : ""}`;
                }
            }
        } else {
             logger.info(`[SHOPIFY WEBHOOK] Payload received but missing CheckMeIn_Account_ID or Program_ID attributes. Ignoring.`);
        }

        if (membershipOutcome) outcome = `${membershipOutcome}; ${outcome}`;

        // Always return 200 OK to Shopify to acknowledge receipt, even if missing attributes.
        await recordShopifyWebhookReceipt(req, order, { hmacValid: true, outcome });
        return NextResponse.json({ success: true });
});
