/** Donated equipment: thresholds pick the lines, a resend does nothing, review mints into the register. */
import { describe, it, expect } from "vitest";
import { describeDb } from "../helpers/db";
import { db } from "../../db";
import { principal, ORG } from "../helpers/seed";
import {
  giftsAwaitingCapitalReview,
  listDonatedCapital,
  reviewDonatedLine,
  submitDonatedLines,
  type DonatedLine,
} from "../../services/donatedCapitalService";

const FINANCE = principal(3, { isFinance: true });

const line = (giftLineId: number, costCents: number, quantity = 1): DonatedLine => ({
  giftSource: "receipt",
  giftId: 41,
  giftLineId,
  description: `item-${giftLineId}`,
  quantity,
  costCents,
  acquisitionDate: "2026-05-01",
  budgetOwnerId: 7,
});

async function thresholds(lineCents: number) {
  await db.expenseOrgSettings.create({ data: { orgId: ORG, capitalTotalThresholdCents: lineCents, capitalLineItemThresholdCents: lineCents } });
}

describe("donated capital — guards", () => {
  it("only FINANCE lists or reviews", async () => {
    await expect(listDonatedCapital(principal(9))).rejects.toMatchObject({ status: 403 });
    await expect(reviewDonatedLine(principal(9), 1, { isCapital: false })).rejects.toMatchObject({ status: 403 });
  });
});

describeDb("donated capital", () => {
  it("keeps only lines over the thresholds, once per gift line", async () => {
    await thresholds(100_000);
    await submitDonatedLines(ORG, [line(1, 250_000), line(2, 5_000)]);
    await submitDonatedLines(ORG, [line(1, 250_000), line(2, 5_000)]);

    const rows = await listDonatedCapital(FINANCE);
    expect(rows.map((r) => r.giftLineId)).toEqual([1]);
    expect(rows[0]).not.toHaveProperty("createdAt");
    expect(await giftsAwaitingCapitalReview(ORG)).toEqual([{ giftSource: "receipt", giftId: 41 }]);
  });

  it("stores nothing for an org with no thresholds row", async () => {
    await submitDonatedLines(ORG, [line(1, 250_000)]);
    expect(await db.donatedCapitalLine.count()).toBe(0);
  });

  it("an asset mints one register entry per unit with the gift line as its source", async () => {
    await thresholds(100_000);
    await submitDonatedLines(ORG, [line(1, 300_001, 2)]);
    const [row] = await listDonatedCapital(FINANCE);

    const view = await reviewDonatedLine(FINANCE, row.id, { isCapital: true, ownerId: 100, depreciationYears: 5 });
    expect(view).toMatchObject({ isCapital: true, budgetOwnerId: 100, depreciationYears: 5, reviewedByUserId: 3 });

    const assets = await db.capitalAsset.findMany({ orderBy: { id: "asc" } });
    expect(assets).toHaveLength(2);
    expect(assets[0]).toMatchObject({
      costCents: 150_001,
      acquisitionDate: "2026-05-01",
      fullyDepreciatedDate: "2031-05-01",
      sourceDonatedLineId: row.id,
      sourceExpenseId: null,
    });
    expect(new Set(assets.map((a) => a.assetNumber)).size).toBe(2);
    expect(await giftsAwaitingCapitalReview(ORG)).toEqual([]);
    await expect(reviewDonatedLine(FINANCE, row.id, { isCapital: false })).rejects.toMatchObject({ status: 409 });
  });

  it("a non-asset line mints nothing; an archived bucket is refused", async () => {
    await thresholds(100_000);
    await submitDonatedLines(ORG, [line(1, 250_000), line(2, 250_000)]);
    const [a, b] = await listDonatedCapital(FINANCE);

    await reviewDonatedLine(FINANCE, a.id, { isCapital: false });
    await expect(reviewDonatedLine(FINANCE, b.id, { isCapital: true, ownerId: 999, depreciationYears: 3 })).rejects.toMatchObject({ status: 400 });
    expect(await db.capitalAsset.count()).toBe(0);
    expect(await db.expenseOrgAuditLog.count({ where: { entityType: "donated_capital_line" } })).toBe(1);
  });
});
