import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { config } from "@/lib/config";
import { normalizeAuditData } from "@/lib/auditPayload";
import { SHOPIFY_WEBHOOK_RECEIPT_TABLE, type ShopifyWebhookReceipt } from "@/lib/shopifyWebhookReceipt";

export const dynamic = "force-dynamic";

// Older receipts carry no delivery-id fields; report them as null.
function toReceipt(id: number, newData: unknown): ShopifyWebhookReceipt & { id: number } {
    const receipt = normalizeAuditData(newData) as ShopifyWebhookReceipt;
    return { id, ...receipt, deliveryId: receipt.deliveryId ?? null, triggeredAt: receipt.triggeredAt ?? null, retry: receipt.retry ?? null };
}

/**
 * GET /api/settings/shopify-webhook — webhook-wiring status for the Shopify
 * Webhook settings tab. Returns:
 *   - webhookUrl: where this environment expects the store's orders/paid
 *     webhook to point (same config.baseUrl() the app builds links from),
 *   - storeDomain: for the deep link into the store's notification settings,
 *   - receipts: the latest deliveries the inbound webhook route recorded as
 *     ShopifyWebhookReceipt audit rows — INCLUDING deliveries whose signature
 *     failed, which is the secret-mismatch diagnostic the tab exists for.
 * Board + sysadmin, same as the sibling settings routes.
 */
export const GET = withAuth({ roles: ["isSysadmin", "isBoardMember"] }, async () => {
    const rows = await prisma.auditLog.findMany({
        where: { tableName: SHOPIFY_WEBHOOK_RECEIPT_TABLE },
        orderBy: { id: "desc" },
        take: 20,
    });
    return NextResponse.json({
        webhookUrl: `${config.baseUrl()}/api/webhooks/shopify`,
        storeDomain: config.shopifyStoreDomain(),
        // normalizeAuditData tolerates legacy string-encoded newData; receipts are
        // written as raw objects, so this is belt-and-suspenders.
        receipts: rows.map((r) => toReceipt(r.id, r.newData)),
    });
});
