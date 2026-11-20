// The expense library's half of a gift's capital decision: the threshold test at accept and the
// register. The decision itself lives on the gift's lines, in bulk-donation.
import { db } from "../db";
import { assertOrg } from "../runtime";
import { classifyCapital } from "../lib/expense-rules";
import { registerAssets, unitCosts, unitsOf } from "../lib/capital-register";
import { SYSTEM_ACTOR } from "../lib/system-actor";
import { readExpenseSettings } from "./settingsService";

/** A gift line as the threshold test and the register take it: what it books at, and how many units. */
export interface GiftCapitalLine {
  costCents: number;
  quantity: number;
}

/** Whether an accepted gift goes to capital review, by the same test as a purchase. */
export async function giftCapitalReviewNeeded(orgId: string, gift: { totalCents: number; lines: GiftCapitalLine[] }): Promise<boolean> {
  await assertOrg(orgId);
  const settings = await readExpenseSettings(db, orgId);
  return classifyCapital(gift.totalCents, gift.lines.map((l) => unitCosts(l.costCents, unitsOf(l.quantity))[0]), settings);
}

export interface GiftAssetLine extends GiftCapitalLine {
  giftSource: "receipt" | "manual";
  giftId: number;
  giftLineId: number;
  description: string;
  acquisitionDate: string | null;
  depreciationYears: number;
}

/** Mints one asset per unit of a gift's capital line; a repeat for the same line returns the same numbers. */
export async function registerGiftLineAssets(orgId: string, line: GiftAssetLine): Promise<string[]> {
  await assertOrg(orgId);
  const units = unitCosts(line.costCents, unitsOf(line.quantity)).map((costCents) => ({
    costCents, acquisitionDate: line.acquisitionDate, depreciationYears: line.depreciationYears, description: line.description,
  }));
  const source = { kind: "gift_line" as const, giftSource: line.giftSource, giftId: line.giftId, giftLineId: line.giftLineId };
  return db.$transaction((tx) => registerAssets(tx, SYSTEM_ACTOR, orgId, source, units));
}
