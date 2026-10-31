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

const line = (orderGid: string, variantId: string | null): MirrorOrderLine => ({
  orderGid, variantId, title: "item", sku: null, quantity: 1, priceCents: 1000, discountCents: 0,
});

const noProblem = () => undefined;
const gap = (txns: MirrorBalanceTxn[], orderLines: MirrorOrderLine[] = [], categories = new Map<string, number | null>()) =>
  mappingGap({ txns, orderLines, categories }, noProblem);

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
});
