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
  orderGid, variantId, title: "item", sku: null, quantity, currentQuantity: quantity, priceCents, discountCents,
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

  it("splits a refund with no unit change across the order's lines by amount", () => {
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

  it("books a refund to the line that lost its units, leaving the charge on full amounts", () => {
    const lines = buildDepositLines({
      payoutNetCents: 10000 - 4000,
      txns: [txn("charge", "O1", 10000), txn("refund", "O1", -4000)],
      orderLines: [line("O1", "V-camp", 6000), { ...line("O1", "V-shirt", 4000), currentQuantity: 0 }],
      categories,
    });
    expect(find(lines, "income", 9)).toBe(6000);
    expect(find(lines, "income", 7)).toBeUndefined();
    expect(sum(lines)).toBe(6000);
  });

  it("weights a partly refunded line by the value of its refunded units", () => {
    // Shirt 3 × $10 − $3 discount, one unit back = $9.00. Camp untouched. $1.00 of refunded tax.
    const lines = buildDepositLines({
      payoutNetCents: -1000,
      txns: [txn("refund", "O1", -1000)],
      orderLines: [{ ...line("O1", "V-shirt", 1000, 3, 300), currentQuantity: 2 }, line("O1", "V-camp", 5000)],
      categories,
    });
    expect(find(lines, "income", 7)).toBe(-900);
    expect(find(lines, "income", 9)).toBeUndefined();
    expect(find(lines, "charge_remainder")).toBe(-100);
    expect(sum(lines)).toBe(-1000);
  });

  it("weights refunded lines by value, not by unit count", () => {
    const lines = buildDepositLines({
      payoutNetCents: -3000,
      txns: [txn("refund", "O1", -3000)],
      orderLines: [{ ...line("O1", "V-camp", 5000), currentQuantity: 0 }, { ...line("O1", "V-shirt", 1000), currentQuantity: 0 }],
      categories,
    });
    expect(find(lines, "income", 9)).toBe(-2500);
    expect(find(lines, "income", 7)).toBe(-500);
    expect(sum(lines)).toBe(-3000);
  });

  it("falls back to line amounts when only free lines lost units", () => {
    const lines = buildDepositLines({
      payoutNetCents: -1000,
      txns: [txn("refund", "O1", -1000)],
      orderLines: [{ ...line("O1", "V-camp", 0), currentQuantity: 0 }, line("O1", "V-shirt", 2000)],
      categories,
    });
    expect(find(lines, "income", 7)).toBe(-1000);
    expect(find(lines, "income", 9)).toBeUndefined();
    expect(sum(lines)).toBe(-1000);
  });

  it.each([
    { unitsLeft: 2, weight: 33 },
    { unitsLeft: 1, weight: 67 },
  ])("rounds a 100-cent line of 3 units to $weight cents with $unitsLeft left", ({ unitsLeft, weight }) => {
    const lines = buildDepositLines({
      payoutNetCents: -100,
      txns: [txn("refund", "O1", -100)],
      orderLines: [{ ...line("O1", "V-shirt", 100, 3, 200), currentQuantity: unitsLeft }],
      categories,
    });
    expect(find(lines, "income", 7)).toBe(-weight);
    expect(find(lines, "charge_remainder")).toBe(-(100 - weight));
  });

  it("gives no refund weight to a mirror row with more units now than sold", () => {
    const lines = buildDepositLines({
      payoutNetCents: -2000,
      txns: [txn("refund", "O1", -2000)],
      orderLines: [{ ...line("O1", "V-shirt", 1000, 3), currentQuantity: 5 }, { ...line("O1", "V-camp", 2000), currentQuantity: 0 }],
      categories,
    });
    expect(find(lines, "income", 9)).toBe(-2000);
    expect(find(lines, "income", 7)).toBeUndefined();
    expect(sum(lines)).toBe(-2000);
  });

  it("gives no refund weight to a mirror row of quantity 0", () => {
    const lines = buildDepositLines({
      payoutNetCents: -2000,
      txns: [txn("refund", "O1", -2000)],
      orderLines: [line("O1", "V-shirt", 1000, 0), { ...line("O1", "V-camp", 2000), currentQuantity: 0 }],
      categories,
    });
    expect(find(lines, "income", 9)).toBe(-2000);
    expect(find(lines, "income", 7)).toBeUndefined();
    expect(sum(lines)).toBe(-2000);
  });

  it("leaves refund rounding at org level so the lines sum exactly to the refund", () => {
    const lines = buildDepositLines({
      payoutNetCents: -1000,
      txns: [txn("refund", "O1", -1000)],
      orderLines: [
        { ...line("O1", "V-shirt", 1000), currentQuantity: 0 },
        { ...line("O1", "V-camp", 1000), currentQuantity: 0 },
        { ...line("O1", "V-mug", 1000), currentQuantity: 0 },
      ],
      categories,
    });
    expect(find(lines, "income", 7)).toBe(-333);
    expect(find(lines, "income", 9)).toBe(-333);
    expect(find(lines, "income", null)).toBe(-333);
    expect(find(lines, "charge_remainder")).toBe(-1);
    expect(sum(lines)).toBe(-1000);
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
