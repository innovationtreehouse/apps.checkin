/**
 * Cursor-paginated fetchers over the Admin GraphQL API. Each is an async
 * generator that yields raw nodes; the caller validates/normalizes them. Used by
 * the incremental sync, and by the backfill for payouts/balance transactions
 * (which are not bulk-exportable because they hang off a singleton account).
 */
import type { ShopifyClient } from "./client.js";
import { ORDERS_QUERY, ORDER_LINES_QUERY, PAYOUTS_QUERY, BALANCE_TRANSACTIONS_QUERY } from "./queries.js";

interface Connection<T> {
  edges: { node: T }[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

const ORDERS_PAGE = 50; // smaller page: each order expands line items
const PAYMENTS_PAGE = 100;

async function* paginate<T>(
  client: ShopifyClient,
  query: string,
  pickConnection: (data: unknown) => Connection<T> | null | undefined,
  pageSize: number,
  queryFilter?: string,
): AsyncGenerator<T> {
  let after: string | null = null;

  while (true) {
    const data = await client.request<unknown>(query, { first: pageSize, after, query: queryFilter });
    const conn = pickConnection(data);
    if (!conn) return;
    for (const edge of conn.edges) yield edge.node;
    if (!conn.pageInfo.hasNextPage || !conn.pageInfo.endCursor) return;
    after = conn.pageInfo.endCursor;
  }
}

interface LineItemsPage {
  nodes: unknown[];
  pageInfo?: { hasNextPage?: boolean | null; endCursor?: string | null } | null;
}

/**
 * Fetch the rest of an order's line items so the node carries every line. If the order
 * disappears mid-walk, the node keeps hasNextPage true and is projected as incomplete.
 */
async function withAllLines(client: ShopifyClient, order: unknown): Promise<unknown> {
  const node = order as { id?: string; lineItems?: LineItemsPage | null };
  const first = node.lineItems;
  if (!node.id || !first?.pageInfo?.hasNextPage) return order;

  const nodes = [...first.nodes];
  let pageInfo: LineItemsPage["pageInfo"] = first.pageInfo;
  while (pageInfo?.hasNextPage && pageInfo.endCursor) {
    const data: { order?: { lineItems?: LineItemsPage | null } | null } = await client.request(ORDER_LINES_QUERY, {
      id: node.id,
      after: pageInfo.endCursor,
    });
    const page: LineItemsPage | null | undefined = data.order?.lineItems;
    if (!page) break;
    nodes.push(...page.nodes);
    pageInfo = page.pageInfo;
  }
  return { ...node, lineItems: { nodes, pageInfo } };
}

export async function* fetchOrders(client: ShopifyClient, queryFilter: string): AsyncGenerator<unknown> {
  const orders = paginate(client, ORDERS_QUERY, (d) => (d as { orders?: Connection<unknown> }).orders, ORDERS_PAGE, queryFilter);
  for await (const order of orders) yield await withAllLines(client, order);
}

export function fetchPayouts(client: ShopifyClient, queryFilter: string): AsyncGenerator<unknown> {
  return paginate(
    client,
    PAYOUTS_QUERY,
    (d) => (d as { shopifyPaymentsAccount?: { payouts?: Connection<unknown> } }).shopifyPaymentsAccount?.payouts,
    PAYMENTS_PAGE,
    queryFilter,
  );
}

export function fetchBalanceTransactions(client: ShopifyClient, queryFilter: string): AsyncGenerator<unknown> {
  return paginate(
    client,
    BALANCE_TRANSACTIONS_QUERY,
    (d) =>
      (d as { shopifyPaymentsAccount?: { balanceTransactions?: Connection<unknown> } }).shopifyPaymentsAccount
        ?.balanceTransactions,
    PAYMENTS_PAGE,
    queryFilter,
  );
}
