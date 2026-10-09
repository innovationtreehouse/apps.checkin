/**
 * Negative / validation tests for the Zod schemas and the dispatch helpers. The schemas
 * are the system's input boundary — a malformed node must throw at parse time, not project
 * a half-formed row. The "Unsupported object type" guards are the dispatch backstop.
 */
import { describe, it, expect } from "vitest";
import {
  orderNodeSchema,
  refundSchemaWithOrder,
  normalizeStandaloneRefund,
  rawMetaForNode,
} from "../../src/shopify/schemas.js";
import { projectNode } from "../../src/loader/index.js";
import { EventSource, ObjectType } from "../../src/generated/prisma/client.js";

describe("schema validation (negative)", () => {
  it("rejects an order node missing its required id", () => {
    expect(() => orderNodeSchema.parse({ name: "#1001" })).toThrow();
  });

  it("rejects a standalone refund that does not name its order", () => {
    // refundSchemaWithOrder extends refund with a REQUIRED orderGid.
    expect(() => refundSchemaWithOrder.parse({ id: "gid://shopify/Refund/8001" })).toThrow();
  });

  it("accepts and normalizes a standalone refund that names its order", () => {
    const r = normalizeStandaloneRefund(
      refundSchemaWithOrder.parse({
        id: "gid://shopify/Refund/8001",
        orderGid: "gid://shopify/Order/1001",
        createdAt: "2026-02-02T00:00:00Z",
        totalRefundedSet: { shopMoney: { amount: "25.00" } },
      }),
    );
    expect(r.refundGid).toBe("gid://shopify/Refund/8001");
    expect(r.orderGid).toBe("gid://shopify/Order/1001");
    expect(r.totalRefundedCents).toBe(2500);
  });
});

describe("dispatch backstops (Unsupported object type)", () => {
  it("rawMetaForNode throws on an unknown object type", () => {
    expect(() => rawMetaForNode("WIDGET" as ObjectType, { id: "x" })).toThrow(/Unsupported object type/);
  });

  it("rawMetaForNode(REFUND, …) requires orderGid via the schema", () => {
    expect(() => rawMetaForNode(ObjectType.REFUND, { id: "gid://shopify/Refund/8001" })).toThrow();
  });

  it("projectNode throws on an unknown object type before touching the db", async () => {
    // The default branch throws before the (here unused) db client is dereferenced.
    const fakeDb = {} as Parameters<typeof projectNode>[0];
    await expect(projectNode(fakeDb, "store", "WIDGET" as ObjectType, { id: "x" }, EventSource.TEST_LOADED)).rejects.toThrow(
      /Unsupported object type/,
    );
  });
});
