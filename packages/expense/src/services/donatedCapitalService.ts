// Capital review of donated equipment (docs/rules/expenses.md, Receipts): a gift line at or over the capital thresholds
// is reviewed by finance like a purchased line, and an asset line mints into the one register.
import { z } from "zod";
import { db } from "../db";
import type { ExpensePrincipal } from "../contract";
import { getOrgId } from "../runtime";
import { actorOf, callerId } from "../lib/caller";
import { writeOrgAudit } from "../lib/audit";
import { classifyCapital } from "../lib/expense-rules";
import { formatItfa, fullyDepreciatedDate, nextItfaSeq } from "../lib/capital-register";
import { requireFinance, requireLiveBuckets } from "./approvalService";
import { ServiceError } from "@checkin/component-kit";

/** One accepted gift line, valued with its share of the receipt's tax and shipping. */
export interface DonatedLine {
  giftSource: "receipt" | "manual";
  giftId: number;
  giftLineId: number;
  description: string;
  quantity: number;
  costCents: number;
  acquisitionDate: string | null;
  budgetOwnerId: number;
}

/** What finance's screen reads: the line and its review. */
const VIEW_SELECT = {
  id: true,
  orgId: true,
  giftSource: true,
  giftId: true,
  giftLineId: true,
  description: true,
  quantity: true,
  costCents: true,
  acquisitionDate: true,
  budgetOwnerId: true,
  isCapital: true,
  depreciationYears: true,
  reviewedByUserId: true,
  reviewedAt: true,
} as const;

const unitsOf = (quantity: number) => Math.max(1, Math.round(quantity));

/** Each unit's share of the line's cost; the shares sum to the cost exactly, the first units taking the odd cents. */
export function unitCosts(costCents: number, units: number): number[] {
  const base = Math.floor(costCents / units);
  const extra = costCents - base * units;
  return Array.from({ length: units }, (_, u) => base + (u < extra ? 1 : 0));
}

/** Keeps the lines at or over the org's capital thresholds for review. A resend does nothing. */
export async function submitDonatedLines(orgId: string, lines: DonatedLine[]): Promise<void> {
  const settings = await db.expenseOrgSettings.findFirst({ where: { orgId } });
  const candidates = lines.filter((l) =>
    classifyCapital(l.costCents, [{ unitPriceCents: unitCosts(l.costCents, unitsOf(l.quantity))[0] }], settings),
  );
  if (candidates.length === 0) return;
  await db.donatedCapitalLine.createMany({ data: candidates.map((l) => ({ orgId, ...l })), skipDuplicates: true });
}

/** The gifts with a line still waiting on capital review. */
export async function giftsAwaitingCapitalReview(orgId: string): Promise<{ giftSource: string; giftId: number }[]> {
  return db.donatedCapitalLine.findMany({
    where: { orgId, isCapital: null },
    select: { giftSource: true, giftId: true },
    distinct: ["giftSource", "giftId"],
  });
}

/** The gift's lines finance's review made assets. */
export async function donatedAssetLineIds(orgId: string, gift: { giftSource: "receipt" | "manual"; giftId: number }): Promise<number[]> {
  const rows = await db.donatedCapitalLine.findMany({ where: { orgId, ...gift, isCapital: true }, select: { giftLineId: true } });
  return rows.map((r) => r.giftLineId);
}

/** Finance and the board read the lines waiting on review; only finance reviews them. */
export async function listDonatedCapital(principal: ExpensePrincipal) {
  callerId(principal);
  if (!principal.isFinance && !principal.isBoard) throw new ServiceError(403, "Only finance or the board can see donated equipment");
  return db.donatedCapitalLine.findMany({ where: { orgId: await getOrgId(), isCapital: null }, select: VIEW_SELECT, orderBy: { id: "asc" } });
}

export const DonatedCapitalReviewSchema = z.discriminatedUnion("isCapital", [
  z.object({ isCapital: z.literal(false) }).strict(),
  z.object({
    isCapital: z.literal(true),
    ownerId: z.number().int().positive(),
    depreciationYears: z.number().int().positive(),
  }).strict(),
]);

/** Records finance's decision on one line once; an asset mints one register entry per unit. */
export async function reviewDonatedLine(
  principal: ExpensePrincipal,
  id: number,
  input: z.infer<typeof DonatedCapitalReviewSchema>,
) {
  requireFinance(principal);
  const actor = actorOf(principal);
  const orgId = await getOrgId();
  if (input.isCapital) await requireLiveBuckets([input.ownerId]);

  return db.$transaction(async (tx) => {
    const line = await tx.donatedCapitalLine.findFirst({ where: { id, orgId } });
    if (!line) throw new ServiceError(404, "Donated line not found");
    const reviewed = await tx.donatedCapitalLine.updateMany({
      where: { id, isCapital: null },
      data: {
        isCapital: input.isCapital,
        depreciationYears: input.isCapital ? input.depreciationYears : null,
        budgetOwnerId: input.isCapital ? input.ownerId : line.budgetOwnerId,
        reviewedByUserId: actor.userId,
        reviewedAt: new Date(),
      },
    });
    if (reviewed.count === 0) throw new ServiceError(409, "This line is already reviewed");

    if (input.isCapital) {
      const costs = unitCosts(line.costCents, unitsOf(line.quantity));
      const fdd = fullyDepreciatedDate(line.acquisitionDate, input.depreciationYears);
      let seq = await nextItfaSeq(tx, orgId);
      for (const costCents of costs) {
        await tx.capitalAsset.create({
          data: {
            orgId,
            assetNumber: formatItfa(seq++),
            description: line.description,
            acquisitionDate: line.acquisitionDate,
            costCents,
            depreciationYears: input.depreciationYears,
            fullyDepreciatedDate: fdd,
            status: "tracked",
            sourceDonatedLineId: line.id,
            seeded: false,
          },
        });
      }
    }
    await writeOrgAudit(tx, orgId, actor, {
      entityType: "donated_capital_line",
      entityId: line.id,
      action: "capital_review_submitted",
      after: input,
    });
    return tx.donatedCapitalLine.findFirstOrThrow({ where: { id }, select: VIEW_SELECT });
  });
}
