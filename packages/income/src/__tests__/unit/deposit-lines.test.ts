import { describe, it, expect } from "vitest";
import { buildDepositLines, type DepositLine } from "../../lib/deposit-lines";
import type { MirrorBalanceTxn, MirrorOrderLine } from "../../contract";

const txn = (type: string, orderGid: string | null, amountCents: number, feeCents = 0): MirrorBalanceTxn => ({
  txnGid: `${type}-${orderGid}-${amountCents}`,
  type,
  orderGid,
  orderName: null,
  amountCents,
  feeCents,
  netCents: amountCents - feeCents,
  source: "api",
});

const line = (orderGid: string, variantId: string | null, priceCents: number, quantity = 1, discountCents = 0): MirrorOrderLine => ({
  orderGid, variantId, title: "item", sku: null, quantity, priceCents, discountCents,
});

const sum = (lines: DepositLine[]) => lines.reduce((s, l) => s + l.amountCents, 0);
const find = (lines: DepositLine[], account: string, bucket: number | null = null) =>
  lines.find((l) => l.account === account && l.budgetOwnerId === bucket)?.amountCents;

const categories = new Map([["V-shirt", 7], ["V-camp", 9]]);

describe("buildDepositLines", () => {
  it("books each charge line to its bucket, tax and shipping to org level, the fee to fees", () => {
    // Shirt 2 × $10 − $1 discount = 1900, camp 5000, unmapped mug 1000; +800 tax/shipping.
    const lines = buildDepositLines({
      payoutNetCents: 8700 - 282,
      txns: [txn("charge", "O1", 8700, 282)],
      orderLines: [line("O1", "V-shirt", 1000, 2, 100), line("O1", "V-camp", 5000), line("O1", "V-mug", 1000)],
      categories,
    });
    expect(find(lines, "income", 7)).toBe(1900);
    expect(find(lines, "income", 9)).toBe(5000);
    expect(find(lines, "income", null)).toBe(1000);
    expect(find(lines, "charge_remainder")).toBe(800);
    expect(find(lines, "fees")).toBe(-282);
    expect(sum(lines)).toBe(8418);
  });

  it("splits a charge smaller than its lines proportionally, rounding left at org level", () => {
    const lines = buildDepositLines({
      payoutNetCents: 1000,
      txns: [txn("charge", "O1", 1000)],
      orderLines: [line("O1", "V-shirt", 1000), line("O1", "V-camp", 1000), line("O1", "V-mug", 1000)],
      categories,
    });
    expect(find(lines, "income", 7)).toBe(333);
    expect(find(lines, "income", 9)).toBe(333);
    expect(find(lines, "income", null)).toBe(333);
    expect(find(lines, "charge_remainder")).toBe(1);
    expect(sum(lines)).toBe(1000);
  });

  it("books a refund as negative lines against the same order's buckets", () => {
    const lines = buildDepositLines({
      payoutNetCents: 6000 - 3000,
      txns: [txn("charge", "O1", 6000), txn("refund", "O1", -3000)],
      orderLines: [line("O1", "V-shirt", 1000), line("O1", "V-camp", 5000)],
      categories,
    });
    expect(find(lines, "income", 7)).toBe(1000 - 500);
    expect(find(lines, "income", 9)).toBe(5000 - 2500);
    expect(sum(lines)).toBe(3000);
  });

  it("books adjustments and other types whole to adjustments", () => {
    const lines = buildDepositLines({
      payoutNetCents: 500 - 120,
      txns: [txn("charge", null, 500), txn("ADJUSTMENT", null, -120)],
      orderLines: [],
      categories,
    });
    expect(find(lines, "income", null)).toBe(500);
    expect(find(lines, "adjustments")).toBe(-120);
    expect(sum(lines)).toBe(380);
  });

  it("books a charge with no order lines whole to org-level income", () => {
    const lines = buildDepositLines({ payoutNetCents: 700, txns: [txn("charge", "O9", 700)], orderLines: [], categories });
    expect(lines).toEqual([{ account: "income", budgetOwnerId: null, amountCents: 700 }]);
  });

  it("aggregates lines across charges per bucket", () => {
    const lines = buildDepositLines({
      payoutNetCents: 2000,
      txns: [txn("charge", "O1", 1000), txn("charge", "O2", 1000)],
      orderLines: [line("O1", "V-shirt", 1000), line("O2", "V-shirt", 1000)],
      categories,
    });
    expect(lines).toEqual([{ account: "income", budgetOwnerId: 7, amountCents: 2000 }]);
  });

  it("refuses to build when the transactions do not sum to the payout net", () => {
    expect(() =>
      buildDepositLines({ payoutNetCents: 999, txns: [txn("charge", null, 1000)], orderLines: [], categories }),
    ).toThrow(/sum to 1000, payout net is 999/);
  });

  it("carries no buyer identity: every line is account, bucket and amount only", () => {
    const lines = buildDepositLines({
      payoutNetCents: 1000,
      txns: [{ ...txn("charge", "O1", 1000), orderName: "#1001 Jane Buyer" }],
      orderLines: [line("O1", "V-shirt", 1000)],
      categories,
    });
    for (const l of lines) expect(Object.keys(l).sort()).toEqual(["account", "amountCents", "budgetOwnerId"]);
  });
});
