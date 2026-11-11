/**
 * Pure unit tests for the bulk-export reassembly (no DB). `reassembleOrders` is the
 * trickiest pure function in the package — it merges INLINE children with `__parentId`
 * flattened children across `{nodes}` / `{edges}` / bare-array shapes, and must NOT
 * double-count a child returned in both representations (the explicit design goal in
 * bulkOrders.ts).
 */
import { describe, it, expect } from "vitest";
import { parseBulkJsonl, reassembleOrders, ingestBulkOrders } from "../../src/ingest/bulkOrders.js";
import { normalizeOrder, orderNodeSchema } from "../../src/shopify/schemas.js";
import { EventSource } from "../../src/generated/prisma/client.js";

const orderId = "gid://shopify/Order/7001";

describe("parseBulkJsonl", () => {
  it("parses one record per non-blank line", () => {
    const text = ['{"id":"a"}', "", "   ", '{"id":"b"}', ""].join("\n");
    expect(parseBulkJsonl(text)).toEqual({ records: [{ id: "a" }, { id: "b" }], badLines: [] });
  });

  it("returns no records for an empty or whitespace-only blob", () => {
    expect(parseBulkJsonl("")).toEqual({ records: [], badLines: [] });
    expect(parseBulkJsonl("\n   \n")).toEqual({ records: [], badLines: [] });
  });

  it("skips a malformed line, keeps the good ones, and records the bad one (no throw)", () => {
    const text = ['{"id":"a"}', "{not json}", '{"id":"b"}'].join("\n");
    const { records, badLines } = parseBulkJsonl(text);
    expect(records).toEqual([{ id: "a" }, { id: "b" }]);
    expect(badLines).toHaveLength(1);
    expect(badLines[0]).toMatchObject({ line: 2, raw: "{not json}" });
    expect(badLines[0].error).toBeTruthy();
  });

  it("collects every bad line for an all-garbage / truncated blob", () => {
    const { records, badLines } = parseBulkJsonl("{oops\n}also bad\n{trunc");
    expect(records).toEqual([]);
    expect(badLines.map((b) => b.line)).toEqual([1, 2, 3]);
  });
});

describe("ingestBulkOrders failure policy", () => {
  // Minimal fake: only shopifyBulkExport.create is reachable before the loud-fail throw.
  const fakePrisma = (capture: { jsonl?: string } = {}) =>
    ({
      shopifyBulkExport: {
        create: async ({ data }: { data: { jsonl: string } }) => {
          capture.jsonl = data.jsonl;
          return { id: 1n };
        },
      },
    }) as unknown as Parameters<typeof ingestBulkOrders>[0];

  it("fails loudly on a mostly-broken export, AFTER persisting the raw payload", async () => {
    const jsonl = ["{bad1}", "{bad2}", '{"id":"gid://shopify/Order/1"}'].join("\n"); // 2/3 bad > 10%
    const capture: { jsonl?: string } = {};
    await expect(
      ingestBulkOrders(fakePrisma(capture), {
        storeId: "s",
        jsonl,
        bulkOperationId: "op",
        source: EventSource.BACKFILL,
      }),
    ).rejects.toThrow(/unparseable/);
    expect(capture.jsonl).toBe(jsonl); // raw payload captured before the throw → replayable
  });
});

describe("reassembleOrders", () => {
  it("attaches a __parentId-flattened line item to its order", () => {
    const orders = reassembleOrders([
      { id: orderId, name: "#7001" },
      { id: "gid://shopify/LineItem/9001", __parentId: orderId, sku: "WIDGET-1", quantity: 2 },
    ]);
    expect(orders).toHaveLength(1);
    const n = normalizeOrder(orders[0]);
    expect(n.lines).toHaveLength(1);
    expect(n.lines[0].sku).toBe("WIDGET-1");
  });

  it("seeds children from an INLINE array on the order", () => {
    const orders = reassembleOrders([
      {
        id: orderId,
        lineItems: [{ id: "gid://shopify/LineItem/9001", sku: "INLINE", quantity: 1 }],
        refunds: [{ id: "gid://shopify/Refund/8001", totalRefundedSet: { shopMoney: { amount: "5.00" } } }],
      },
    ]);
    const n = normalizeOrder(orders[0]);
    expect(n.lines[0].sku).toBe("INLINE");
    expect(n.refunds).toHaveLength(1);
  });

  it("reads inline children from a {nodes} connection shape", () => {
    const orders = reassembleOrders([
      { id: orderId, lineItems: { nodes: [{ id: "gid://shopify/LineItem/9001", sku: "NODES", quantity: 1 }] } },
    ]);
    expect(normalizeOrder(orders[0]).lines[0].sku).toBe("NODES");
  });

  it("reads inline children from an {edges:[{node}]} connection shape", () => {
    const orders = reassembleOrders([
      { id: orderId, lineItems: { edges: [{ node: { id: "gid://shopify/LineItem/9001", sku: "EDGES", quantity: 1 } }] } },
    ]);
    expect(normalizeOrder(orders[0]).lines[0].sku).toBe("EDGES");
  });

  it("does NOT double-count a child returned BOTH inline and flattened (same GID)", () => {
    const orders = reassembleOrders([
      { id: orderId, lineItems: { nodes: [{ id: "gid://shopify/LineItem/9001", sku: "WIDGET-1", quantity: 1 }] } },
      // The SAME line also arrives as a flattened __parentId record — must be de-duped by GID.
      { id: "gid://shopify/LineItem/9001", __parentId: orderId, sku: "WIDGET-1", quantity: 1 },
    ]);
    expect(normalizeOrder(orders[0]).lines).toHaveLength(1);
  });

  it("attaches a flattened refund and ignores unrelated child types", () => {
    const orders = reassembleOrders([
      { id: orderId },
      { id: "gid://shopify/Refund/8001", __parentId: orderId, totalRefundedSet: { shopMoney: { amount: "9.00" } } },
      { id: "gid://shopify/Fulfillment/3001", __parentId: orderId }, // not part of the projection
    ]);
    const n = normalizeOrder(orders[0]);
    expect(n.refunds).toHaveLength(1);
    expect(n.lines).toHaveLength(0);
  });

  it("drops an orphan __parentId line whose parent order is absent", () => {
    const orders = reassembleOrders([
      { id: "gid://shopify/LineItem/9001", __parentId: "gid://shopify/Order/DOES-NOT-EXIST", sku: "X", quantity: 1 },
    ]);
    expect(orders).toHaveLength(0);
  });

  it("derives legacyResourceId from the GID when absent in bulk output", () => {
    const [order] = reassembleOrders([{ id: orderId, name: "#7001" }]);
    expect(normalizeOrder(order).legacyId).toBe("7001");
  });

  it("treats the lines as complete by default", () => {
    const [order] = reassembleOrders([{ id: orderId }]);
    expect(normalizeOrder(order).linesComplete).toBe(true);
  });

  it("marks every order's lines incomplete when the export lost a record, and the mark survives a re-parse", () => {
    const [order] = reassembleOrders([{ id: orderId }], { lostRecords: true });
    expect(normalizeOrder(order).linesComplete).toBe(false);
    expect(normalizeOrder(orderNodeSchema.parse(JSON.parse(JSON.stringify(order)))).linesComplete).toBe(false);
  });

  it("marks lines incomplete when the connection says more pages exist", () => {
    const node = { id: orderId, lineItems: { nodes: [], pageInfo: { hasNextPage: true } } };
    expect(normalizeOrder(orderNodeSchema.parse(node)).linesComplete).toBe(false);
    const last = { id: orderId, lineItems: { nodes: [], pageInfo: { hasNextPage: false } } };
    expect(normalizeOrder(orderNodeSchema.parse(last)).linesComplete).toBe(true);
  });

  it("keeps an explicit legacyResourceId when present", () => {
    const [order] = reassembleOrders([{ id: orderId, legacyResourceId: "EXPLICIT" }]);
    expect(normalizeOrder(order).legacyId).toBe("EXPLICIT");
  });
});
