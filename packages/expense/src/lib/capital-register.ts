// Capital asset register — this app is the system of record for ITFANN fixed-asset numbers
// (Innovation Treehouse Fixed Asset, e.g. "ITFA23"; 2-digit zero-pad, no space/dash). ONE ROW PER
// PHYSICAL ASSET. Assets are only ever added: `registerAssets` mints them, and historical numbers
// hand-typed in QuickBooks are loaded via the seed endpoint (seeded=true).
import type { PrismaClient, Prisma } from "../generated/prisma/client";
import type { Actor } from "./workflow-engine";
import { writeOrgAudit } from "./audit";

type Db = PrismaClient | Prisma.TransactionClient;

const PREFIX = "ITFA";
const PAD = 2;

/** Canonical form: `ITFA` + zero-padded (min 2) sequence, no space/dash. e.g. 23 -> "ITFA23". */
export function formatItfa(seq: number): string {
  return PREFIX + String(seq).padStart(PAD, "0");
}

/** Parse the numeric sequence out of any ITFA token (tolerant of padding); null if not one. */
export function parseItfa(raw: string): number | null {
  const m = /^ITFA0*(\d+)$/i.exec(raw.trim());
  return m ? Number(m[1]) : null;
}

/**
 * Date after which the asset is fully depreciated and need not be tracked: acquisition + years.
 * Dates are stored as strings; returns YYYY-MM-DD, or null if either input is missing/unparseable.
 */
export function fullyDepreciatedDate(acquisitionDate: string | null | undefined, years: number | null | undefined): string | null {
  if (!acquisitionDate || !years) return null;
  const d = new Date(acquisitionDate);
  if (Number.isNaN(d.getTime())) return null;
  d.setFullYear(d.getFullYear() + years);
  return d.toISOString().slice(0, 10);
}

/** Highest ITFA sequence on the register for an org, seeded numbers included; 0 when none. */
async function registerMax(db: Db, orgId: string): Promise<number> {
  const rows = await db.capitalAsset.findMany({ where: { orgId }, select: { assetNumber: true } });
  let max = 0;
  for (const r of rows) {
    const n = parseItfa(r.assetNumber);
    if (n !== null && n > max) max = n;
  }
  return max;
}

/**
 * Locks the org's high-water mark for the rest of the transaction and returns it. The first call
 * for an org starts the mark at the register's highest number. The lock serialises mints.
 */
async function lockHighestIssued(tx: Prisma.TransactionClient, orgId: string): Promise<number> {
  const start = await registerMax(tx, orgId);
  await tx.$executeRaw`INSERT INTO capital_asset_sequences (org_id, highest_issued) VALUES (${orgId}, ${start}) ON CONFLICT (org_id) DO NOTHING`;
  const [row] = await tx.$queryRaw<{ highest_issued: number }[]>`SELECT highest_issued FROM capital_asset_sequences WHERE org_id = ${orgId} FOR UPDATE`;
  return row.highest_issued;
}

/** Raises the org's high-water mark to a seeded number above it; a mark not yet started is left to start from the register. */
export async function raiseHighestIssued(tx: Prisma.TransactionClient, orgId: string, seq: number): Promise<void> {
  await tx.$executeRaw`UPDATE capital_asset_sequences SET highest_issued = GREATEST(highest_issued, ${seq}) WHERE org_id = ${orgId}`;
}

export type AssetSource =
  | { kind: "expense_line"; expenseId: string; lineItemId: number }
  | { kind: "gift_line"; giftSource: "receipt" | "manual"; giftId: number; giftLineId: number; donatedLineId: number };

export interface AssetUnit {
  costCents: number;
  acquisitionDate: string | null;
  depreciationYears: number;
  description: string;
}

function sourceColumns(source: AssetSource) {
  return source.kind === "expense_line"
    ? { sourceKind: source.kind, sourceExpenseId: source.expenseId, sourceLineItemId: source.lineItemId, sourceReceiptId: source.expenseId }
    : { sourceKind: source.kind, sourceGiftSource: source.giftSource, sourceGiftId: source.giftId, sourceGiftLineId: source.giftLineId, sourceDonatedLineId: source.donatedLineId };
}

function sourceWhere(orgId: string, source: AssetSource): Prisma.CapitalAssetWhereInput {
  return source.kind === "expense_line"
    ? { orgId, sourceLineItemId: source.lineItemId, unitIndex: { not: null } }
    : { orgId, sourceGiftSource: source.giftSource, sourceGiftLineId: source.giftLineId, unitIndex: { not: null } };
}

/**
 * Mints one asset per unit for the line, each numbered from the org's high-water mark, and audits
 * each. A repeat for the same line mints nothing and returns the same numbers, in unit order.
 */
export async function registerAssets(
  tx: Prisma.TransactionClient,
  actor: Actor,
  orgId: string,
  source: AssetSource,
  units: AssetUnit[],
): Promise<string[]> {
  let highest = await lockHighestIssued(tx, orgId);
  const existing = await tx.capitalAsset.findMany({ where: sourceWhere(orgId, source), select: { unitIndex: true, assetNumber: true } });
  const numbers = new Map(existing.map((a) => [a.unitIndex!, a.assetNumber]));
  const columns = sourceColumns(source);
  for (const [unitIndex, unit] of units.entries()) {
    if (numbers.has(unitIndex)) continue;
    const assetNumber = formatItfa(++highest);
    await tx.capitalAsset.create({
      data: {
        orgId,
        assetNumber,
        description: unit.description,
        acquisitionDate: unit.acquisitionDate,
        costCents: unit.costCents,
        depreciationYears: unit.depreciationYears,
        fullyDepreciatedDate: fullyDepreciatedDate(unit.acquisitionDate, unit.depreciationYears),
        status: "tracked",
        ...columns,
        unitIndex,
        seeded: false,
      },
    });
    await writeOrgAudit(tx, orgId, actor, {
      entityType: "capital_asset",
      entityId: assetNumber,
      action: "capital_asset_registered",
      after: { source, unitIndex, costCents: unit.costCents },
    });
    numbers.set(unitIndex, assetNumber);
  }
  await tx.$executeRaw`UPDATE capital_asset_sequences SET highest_issued = ${highest} WHERE org_id = ${orgId}`;
  return units.map((_, unitIndex) => numbers.get(unitIndex)!);
}
