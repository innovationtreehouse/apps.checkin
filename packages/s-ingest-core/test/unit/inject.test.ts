/**
 * futureStampedGids: the inject guard that refuses a fixture stamped later than now, since
 * a future `updatedAt` would win newest-wins against every later hand-made correction of that GID.
 */
import { it, expect } from "vitest";
import { futureStampedGids } from "../../src/ingest/inject.js";
import { ObjectType } from "../../src/generated/prisma/client.js";

const now = new Date("2026-06-01T12:00:00Z");
const order = (id: string, updatedAt: string) => ({
  objectType: ObjectType.ORDER,
  node: { id, updatedAt, createdAt: "2026-01-01T00:00:00Z" },
});

it("names each fixture stamped after now", () => {
  const fixtures = [
    order("gid://shopify/Order/1", "2026-06-01T12:00:01Z"),
    order("gid://shopify/Order/2", "2026-06-01T12:00:00Z"),
    order("gid://shopify/Order/3", "2025-12-31T00:00:00Z"),
  ];
  expect(futureStampedGids(fixtures, now)).toEqual(["gid://shopify/Order/1"]);
});

it("accepts a node with no timestamp", () => {
  const payout = { objectType: ObjectType.PAYOUT, node: { id: "gid://shopify/ShopifyPaymentsPayout/1" } };
  expect(futureStampedGids([payout], now)).toEqual([]);
});
