import { describe, it, expect } from "vitest";
import { mappingGap } from "../../lib/outbox";
import type { MirrorBalanceTxn, MirrorOrderLine } from "../../contract";

const txn = (type: string, orderGid: string | null, n = 1): MirrorBalanceTxn => ({
  txnGid: `T${n}`,
  type,
  orderGid,
  orderName: "#1001 Jane Buyer",
  amountCents: 1000,
  feeCents: 0,
  netCents: 1000,
  source: "api",
});

const line = (orderGid: string, variantId: string | null, patch: Partial<MirrorOrderLine> = {}): MirrorOrderLine => ({
  orderGid, variantId, title: "item", sku: null, quantity: 1, currentQuantity: 1, priceCents: 1000, discountCents: 0, ...patch,
});

const noProblem = () => undefined;
const gap = (
  txns: MirrorBalanceTxn[],
  orderLines: MirrorOrderLine[] = [],
  categories = new Map<string, number | null>(),
  subtotals: Record<string, number> = {},
) => mappingGap({ txns, orderLines, categories, subtotals: new Map(Object.entries(subtotals)) }, noProblem);
const custom = (patch: Partial<MirrorOrderLine> = {}) => line("O1", null, patch);
const noDecisions = new Map<string, number | null>();

describe("mappingGap", () => {
  it.each(["charge", "CHARGE", "refund"])("names an order with no lines for a %s", (type) => {
    expect(gap([txn(type, "O1")])).toBe("orders with no lines: O1");
  });

  it("names each order once, sorted, so a retried hold keeps its reason", () => {
    expect(gap([txn("charge", "O2", 1), txn("refund", "O1", 2), txn("charge", "O2", 3)])).toBe("orders with no lines: O1, O2");
  });

  it("names a charge or refund with no order by its transaction", () => {
    expect(gap([txn("charge", null, 2), txn("refund", null, 1)])).toBe("transactions with no order: T1, T2");
  });

  it("never carries the order name, which can hold a buyer's name", () => {
    expect(gap([txn("charge", "O1", 1), txn("charge", null, 2)])).not.toContain("Jane");
  });

  it("does not hold a transaction that isn't a sale", () => {
    expect(gap([txn("adjustment", null), txn("payout", "O1")])).toBeNull();
  });

  it("does not hold an order whose lines are custom items or decided", () => {
    const decided = new Map<string, number | null>([["V1", null]]);
    expect(gap([txn("charge", "O1"), txn("charge", "O2", 2)], [line("O1", null), line("O2", "V1")], decided)).toBeNull();
  });

  it("names every gap together, so a later run's reason shows what is left", () => {
    expect(gap([txn("charge", "O1"), txn("charge", "O2", 2), txn("charge", null, 3)], [line("O1", "V1")])).toBe(
      "undecided items: V1; orders with no lines: O2; transactions with no order: T3",
    );
  });

  it.each(["charge", "refund"])("names an order whose lines fall short of its subtotal for a %s", (type) => {
    expect(gap([txn(type, "O1")], [custom()], noDecisions, { O1: 2000 })).toBe("orders with missing lines: O1");
  });

  it("holds a lost line beside a refunded one, which no longer counts toward the subtotal", () => {
    const refunded = custom({ priceCents: 5000, currentQuantity: 0 });
    expect(gap([txn("charge", "O1")], [refunded], noDecisions, { O1: 5000 })).toBe("orders with missing lines: O1");
  });

  it("does not hold lines that reach the subtotal after their discount", () => {
    expect(gap([txn("charge", "O1")], [custom({ quantity: 2, currentQuantity: 2, discountCents: 100 })], noDecisions, { O1: 1900 })).toBeNull();
  });

  it("prorates a discount over a partial refund, allowing a cent of rounding per line", () => {
    const line = custom({ quantity: 2, currentQuantity: 1, discountCents: 101 });
    expect(gap([txn("charge", "O1")], [line], noDecisions, { O1: 950 })).toBeNull();
    expect(gap([txn("charge", "O1")], [line], noDecisions, { O1: 952 })).toBe("orders with missing lines: O1");
  });

  it("does not hold lines above the subtotal, or an order with no subtotal row", () => {
    expect(gap([txn("charge", "O1")], [custom()], noDecisions, { O1: 500 })).toBeNull();
    expect(gap([txn("charge", "O1")], [custom()])).toBeNull();
  });

  it("does not hold an order that only a non-sale transaction names", () => {
    expect(gap([txn("adjustment", "O1")], [custom()], noDecisions, { O1: 2000 })).toBeNull();
  });

  it("names an order with no lines once, as having none", () => {
    expect(gap([txn("charge", "O1")], [], noDecisions, { O1: 2000 })).toBe("orders with no lines: O1");
  });
});
