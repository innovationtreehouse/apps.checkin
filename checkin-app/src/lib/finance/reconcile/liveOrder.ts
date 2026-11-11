import prisma from "@/lib/prisma";
import { config } from "@/lib/config";
import { logger } from "@/lib/logger";
import { getAccessToken, shopifyFetch, SHOPIFY_API_VERSION } from "@/lib/shopify/client";
import { recordReversal, type PaymentExceptionKind } from "./exceptions";
import { isReversed } from "./orderStatus";

/** Audit table standing in for Shopify's order state on CHECKIN_ENV=local, written by /api/dev/shopify/orders-paid. */
export const DEV_SHOPIFY_REFUND_TABLE = "DevShopifyRefund";

const ORDER_STATE_QUERY = `query OrderState($id: ID!) {
  order(id: $id) {
    displayFinancialStatus
    cancelledAt
    totalRefundedSet { shopMoney { amount } }
  }
}`;

interface OrderStateBody {
    data?: {
        order: {
            displayFinancialStatus: string | null;
            cancelledAt: string | null;
            totalRefundedSet: { shopMoney: { amount: string } };
        } | null;
    };
    errors?: { message?: string }[];
}

async function readLiveReversal(shopifyOrderId: string): Promise<PaymentExceptionKind | null> {
    if (config.shopifyMockActive()) {
        const row = await prisma.auditLog.findFirst({
            where: { tableName: DEV_SHOPIFY_REFUND_TABLE, newData: { path: ["shopifyOrderId"], equals: shopifyOrderId } },
            select: { id: true },
        });
        return row ? "REFUND" : null;
    }
    const storeDomain = config.shopifyStoreDomain();
    if (!storeDomain || !config.shopifyClientId() || !config.shopifyClientSecret()) return null;
    const token = await getAccessToken();
    if (!token) throw new Error(`No Shopify token to read order ${shopifyOrderId}`);

    const res = await shopifyFetch(
        `https://${storeDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
            body: JSON.stringify({ query: ORDER_STATE_QUERY, variables: { id: `gid://shopify/Order/${shopifyOrderId}` } }),
        },
        "Shopify read order state",
    );
    if (!res.ok) throw new Error(`Shopify order ${shopifyOrderId} read responded with status: ${res.status}`);
    const body = (await res.json()) as OrderStateBody;
    if (body.errors?.length) throw new Error(`Shopify order ${shopifyOrderId} read failed: ${body.errors[0].message ?? "unknown error"}`);
    const order = body.data?.order;
    if (!order) {
        // Shopify hides orders past the app's read window, and such an order has nothing left to say.
        logger.warn(`[reconcile] Shopify returned no order ${shopifyOrderId}; judged on the app's ledger alone`);
        return null;
    }
    const state = {
        financialStatus: order.displayFinancialStatus,
        cancelledAt: order.cancelledAt ? new Date(order.cancelledAt) : null,
        totalRefundedCents: Math.round(Number(order.totalRefundedSet.shopMoney.amount) * 100),
    };
    if (state.cancelledAt) return "CANCELLED";
    return isReversed(state) ? "REFUND" : null;
}

/**
 * Asks Shopify whether this order's money went back and records it in the reversal
 * ledger, so an activation refuses a refund whose webhook has not arrived. Runs
 * before the activation's transaction, since it waits on the network. Throws when
 * Shopify can't answer: the webhook retries and reconcile tries again next pass.
 */
export async function recordUnreportedReversal(shopifyOrderId: string): Promise<void> {
    const kind = await readLiveReversal(shopifyOrderId);
    if (kind) await recordReversal(shopifyOrderId, kind);
}

/** The same check for a paid application about to clear, on the order it was paid with. */
export async function recordUnreportedReversalOnProcess(processId: number): Promise<void> {
    const process = await prisma.orgMembershipProcess.findUnique({ where: { id: processId }, select: { paidAt: true, shopifyOrderId: true } });
    if (process?.paidAt && process.shopifyOrderId) await recordUnreportedReversal(process.shopifyOrderId);
}
