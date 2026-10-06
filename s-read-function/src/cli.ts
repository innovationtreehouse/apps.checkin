/**
 * Local dev entry. Runs the exact same orchestrators the Lambda handler calls, so
 * the whole pipeline is exercised locally before deployment.
 *
 *   npm run sync:incremental
 *   npm run sync:backfill
 *   INJECT_ALLOW=1 npm run inject -- <fixture.json> --reason "<why>" [--test]
 */
import os from "node:os";
import {
  prisma,
  loadDbConfig,
  loadShopifyConfig,
  injectFile,
  logger,
  withSyncRun,
  SyncKind,
  PROD_STORE_DOMAIN,
} from "@inventory/s-ingest-core";
import { handler, armSyncDeadline } from "./handler.js";
import { createShopifyClient } from "./shopify/client.js";
import {
  SHOP_PING_QUERY,
  ORDERS_PROBE_QUERY,
  PAYOUTS_PROBE_QUERY,
  BALANCE_TXNS_PROBE_QUERY,
} from "./shopify/queries.js";

/** Mask an email for log output: keep first char + domain, e.g. j***@example.com. */
function maskEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const [local, domain] = email.split("@");
  if (!domain) return "***";
  return `${local.slice(0, 1)}***@${domain}`;
}

/** Parse `--limit N` or `--limit=N` from argv, clamped to >= 1. */
function parseLimit(args: string[], fallback: number): number {
  const eq = args.find((a) => a.startsWith("--limit="));
  if (eq) return Math.max(1, Number(eq.split("=")[1]) || fallback);
  const i = args.indexOf("--limit");
  if (i >= 0 && args[i + 1]) return Math.max(1, Number(args[i + 1]) || fallback);
  return fallback;
}

/** Value of `--name=value` or `--name value`; undefined when the flag is absent. */
function parseFlag(args: string[], name: string): string | undefined {
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  switch (command) {
    case "ping": {
      // Connectivity/auth smoke test only — no DB, no data pull.
      const cfg = loadShopifyConfig();
      const client = createShopifyClient(cfg);
      const data = await client.request<{
        shop: { name: string; myshopifyDomain: string; currencyCode: string; ianaTimezone: string };
      }>(SHOP_PING_QUERY);
      logger.info("shopify ping ok", { endpoint: cfg.endpoint, apiVersion: cfg.apiVersion, shop: data.shop });
      break;
    }
    case "read-orders": {
      // Read-only probe: fetch up to --limit orders (no DB writes). Verifies the
      // read_orders scope and surfaces any protected-customer-data (PII) gate.
      const cfg = loadShopifyConfig();
      const client = createShopifyClient(cfg);
      const limit = parseLimit(rest, 1);
      const data = await client.request<{
        orders: {
          edges: {
            node: {
              id: string;
              name?: string;
              email?: string | null;
              customer?: { email?: string | null; displayName?: string | null } | null;
              displayFinancialStatus?: string;
              displayFulfillmentStatus?: string;
              currentTotalPriceSet?: { shopMoney?: { amount?: string; currencyCode?: string } } | null;
              lineItems?: { nodes?: unknown[] } | null;
            };
          }[];
        };
      }>(ORDERS_PROBE_QUERY, { first: limit, query: "status:any" });

      const orders = data.orders.edges.map((e) => e.node);
      logger.info("read orders ok", {
        requested: limit,
        returned: orders.length,
        orders: orders.map((o) => ({
          id: o.id,
          name: o.name ?? null,
          financialStatus: o.displayFinancialStatus ?? null,
          fulfillmentStatus: o.displayFulfillmentStatus ?? null,
          total: o.currentTotalPriceSet?.shopMoney?.amount ?? null,
          currency: o.currentTotalPriceSet?.shopMoney?.currencyCode ?? null,
          lineItemCount: o.lineItems?.nodes?.length ?? 0,
          customerEmail: maskEmail(o.customer?.email ?? o.email ?? null),
          customerNamePresent: Boolean(o.customer?.displayName),
        })),
      });
      break;
    }
    case "read-payouts": {
      // Read-only probe: confirms read_shopify_payments_accounts + _payouts. No DB writes.
      const cfg = loadShopifyConfig();
      const client = createShopifyClient(cfg);
      const limit = parseLimit(rest, 1);
      const data = await client.request<{
        shopifyPaymentsAccount: {
          payouts: {
            edges: {
              node: {
                id: string;
                legacyResourceId?: string | number | null;
                issuedAt?: string | null;
                status?: string | null;
                net?: { amount?: string; currencyCode?: string } | null;
              };
            }[];
          };
        } | null;
      }>(PAYOUTS_PROBE_QUERY, { first: limit });

      const account = data.shopifyPaymentsAccount;
      if (!account) {
        logger.warn("read payouts: no shopifyPaymentsAccount (store may not use Shopify Payments)", {});
        break;
      }
      const payouts = account.payouts.edges.map((e) => e.node);
      logger.info("read payouts ok", {
        requested: limit,
        returned: payouts.length,
        payouts: payouts.map((p) => ({
          id: p.id,
          issuedAt: p.issuedAt ?? null,
          status: p.status ?? null,
          net: p.net?.amount ?? null,
          currency: p.net?.currencyCode ?? null,
        })),
      });
      break;
    }
    case "read-balance-txns": {
      // Read-only probe: validates the payout<->order bridge fields. No DB writes.
      const cfg = loadShopifyConfig();
      const client = createShopifyClient(cfg);
      const limit = parseLimit(rest, 5);
      const data = await client.request<{
        shopifyPaymentsAccount: {
          balanceTransactions: {
            edges: {
              node: {
                id: string;
                type?: string;
                amount?: { amount?: string; currencyCode?: string } | null;
                net?: { amount?: string } | null;
                transactionDate?: string | null;
                sourceOrderTransactionId?: string | null;
                associatedPayout?: { id?: string | null } | null;
                associatedOrder?: { id?: string | null; name?: string | null } | null;
              };
            }[];
          };
        } | null;
      }>(BALANCE_TXNS_PROBE_QUERY, { first: limit });

      const account = data.shopifyPaymentsAccount;
      if (!account) {
        logger.warn("read balance txns: no shopifyPaymentsAccount", {});
        break;
      }
      const txns = account.balanceTransactions.edges.map((e) => e.node);
      logger.info("read balance txns ok", {
        requested: limit,
        returned: txns.length,
        withOrder: txns.filter((t) => t.associatedOrder?.id).length,
        txns: txns.map((t) => ({
          id: t.id,
          type: t.type ?? null,
          amount: t.amount?.amount ?? null,
          net: t.net?.amount ?? null,
          currency: t.amount?.currencyCode ?? null,
          payoutId: t.associatedPayout?.id ?? null,
          orderId: t.associatedOrder?.id ?? null,
          orderName: t.associatedOrder?.name ?? null,
          sourceOrderTransactionId: t.sourceOrderTransactionId ?? null,
        })),
      });
      break;
    }
    case "incremental": {
      armSyncDeadline("incremental");
      const result = await handler({ mode: "incremental" });
      logger.info("incremental sync done", result);
      break;
    }
    case "backfill": {
      armSyncDeadline("backfill");
      const result = await handler({ mode: "backfill" });
      logger.info("backfill step done", result);
      break;
    }
    case "inject": {
      // Injected rows land in the same live tables checkin reconciles memberships and
      // payments from, so every inject is deliberate, attributed, and never test data in prod.
      const test = rest.includes("--test");
      const reason = parseFlag(rest, "reason")?.trim();
      const file = rest.find((a, i) => !a.startsWith("--") && rest[i - 1] !== "--reason");
      if (!file) throw new Error('Usage: INJECT_ALLOW=1 inject <fixture.json> --reason "<why>" [--test]');
      if (process.env.INJECT_ALLOW !== "1") throw new Error("inject refused: set INJECT_ALLOW=1 to write to the mirror");
      if (!reason) throw new Error("inject refused: --reason is required (recorded on the ADMIN sync_run)");
      const { storeId } = loadDbConfig();
      if (test) {
        const prodHere = await prisma.store.findUnique({ where: { myshopifyDomain: PROD_STORE_DOMAIN } });
        if (storeId === PROD_STORE_DOMAIN || prodHere) {
          throw new Error(`inject refused: --test fixtures may not be loaded into the ${PROD_STORE_DOMAIN} mirror`);
        }
      }
      const source = test ? "TEST_LOADED" : "HAND_LOADED";
      const actor = `cli:${os.userInfo().username}`;
      const summary = await withSyncRun(
        prisma,
        storeId,
        SyncKind.ADMIN,
        "inject",
        async (syncRunId) => {
          const results = await injectFile(prisma, file, { storeId, test, syncRunId });
          return {
            file,
            source,
            count: results.length,
            inserted: results.filter((r) => r.inserted).length,
            gids: results.map((r) => r.shopifyGid),
          };
        },
        { actor, reason },
      );
      logger.info("inject done", { ...summary, actor, reason });
      break;
    }
    default:
      throw new Error(
        `Unknown command: ${command ?? "(none)"}. Use ping | read-orders | read-payouts | read-balance-txns | incremental | backfill | inject.`,
      );
  }
}

main()
  .catch((err) => {
    logger.error("cli failed", { err });
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
