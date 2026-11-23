/** A gift meets the capital thresholds as a purchase does, and its capital lines mint into the one register. */
import { it, expect } from "vitest";
import { describeDb } from "../helpers/db";
import { db } from "../../db";
import { ORG } from "../helpers/seed";
import { giftCapitalReviewNeeded, registerGiftLineAssets } from "../../services/giftCapitalService";

async function thresholds() {
  await db.expenseOrgSettings.create({ data: { orgId: ORG, capitalTotalThresholdCents: 250_000, capitalLineItemThresholdCents: 100_000 } });
}

describeDb("gift capital", () => {
  it("six $450 chairs as six lines go to review on their $2,700 total, as the same purchase would", async () => {
    await thresholds();
    const chairs = Array.from({ length: 6 }, () => ({ costCents: 45_000, quantity: 1 }));
    expect(await giftCapitalReviewNeeded(ORG, { totalCents: 270_000, lines: chairs })).toBe(true);
    expect(await giftCapitalReviewNeeded(ORG, { totalCents: 90_000, lines: chairs.slice(0, 2) })).toBe(false);
  });

  it("a unit's cost is its share of what the line books at", async () => {
    await thresholds();
    expect(await giftCapitalReviewNeeded(ORG, { totalCents: 113_000, lines: [{ costCents: 113_000, quantity: 1 }] })).toBe(true);
    expect(await giftCapitalReviewNeeded(ORG, { totalCents: 113_000, lines: [{ costCents: 113_000, quantity: 2 }] })).toBe(false);
  });

  it("registers one asset per unit, linked to the gift line, and a repeat returns the same numbers", async () => {
    const line = { giftSource: "manual" as const, giftId: 9, giftLineId: 31, description: "Chair", costCents: 90_001, quantity: 2, acquisitionDate: "2026-11-01", depreciationYears: 5 };
    const numbers = await registerGiftLineAssets(ORG, line);
    expect(numbers).toHaveLength(2);
    expect(await registerGiftLineAssets(ORG, line)).toEqual(numbers);
    const assets = await db.capitalAsset.findMany({ where: { orgId: ORG }, orderBy: { unitIndex: "asc" } });
    expect(assets.map((a) => [a.assetNumber, a.sourceKind, a.sourceGiftSource, a.sourceGiftId, a.sourceGiftLineId, a.sourceDonatedLineId, a.unitIndex, a.costCents])).toEqual([
      [numbers[0], "gift_line", "manual", 9, 31, null, 0, 45_001],
      [numbers[1], "gift_line", "manual", 9, 31, null, 1, 45_000],
    ]);
    expect(await db.expenseOrgAuditLog.count({ where: { orgId: ORG, action: "capital_asset_registered" } })).toBe(2);
  });
});
